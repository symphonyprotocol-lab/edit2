import {
  EditorState,
  EditorSelection,
  type Extension,
  type StateEffect,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import {
  editorExtensions,
  languageSlot,
  extrasSlot,
  wrapSlot,
  wrapExtension,
  readOnlySlot,
  readOnlyExtension,
} from "./editor";
import { ENCODINGS, encodingName, formatSize, LARGE_FILE } from "./encodings";
import {
  allFormats,
  formatById,
  formatFor,
  isKnownFile,
  SyntaxProblem,
  type Formatter,
  type FormatPlugin,
  type Mode,
  type PreviewContext,
  type PreviewRenderer,
  type RenderResult,
  type BinaryFile,
} from "./formats";
import { host, inTauri, isMac, TooLargeError, UnmappableError, type DialogFilter, type FileData } from "./host";
import { TabBar, type TabBarHandlers } from "./tabs";
import { FolderTree } from "./sidebar";
import { showMenu, closeMenu, type MenuEntry } from "./popup";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const nameEl = $("doc-name");
const dirEl = $("doc-dir");
const posEl = $("st-pos");
const countEl = $("st-count");
const saveEl = $("st-save");
const formatEl = $("st-format");
const encodingEl = $("st-encoding");
const toastEl = $("toast");
const panesEl = $("panes");
const sidebarEl = $("sidebar");
const sbNameEl = $("sb-name");
const sbMoreEl = $("sb-more");
const sidebarBtn = $("btn-sidebar");

// ---------- persisted preferences ----------

/**
 * Preferences live in settings.json, kept by the backend; each window holds a
 * copy and hears about changes from other windows. In a plain browser
 * (development) they fall back to localStorage.
 */
const settings: Record<string, unknown> = {};

const prefs = {
  get<T>(key: string, fallback: T): T {
    return key in settings ? (settings[key] as T) : fallback;
  },
  set(key: string, value: unknown) {
    settings[key] = value;
    if (inTauri) host.setSetting(key, value).catch(() => {});
    else localStorage.setItem(`edit2.${key}`, JSON.stringify(value));
  },
  /** Load the settings; the first time, take over what mdit kept in localStorage. */
  async load() {
    const stored = inTauri ? await host.loadSettings().catch(() => ({})) : {};
    if (Object.keys(stored).length) return void Object.assign(settings, stored);
    for (const prefix of inTauri ? ["mdit."] : ["mdit.", "edit2."]) {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i)!;
        if (!name.startsWith(prefix)) continue;
        try {
          const value = JSON.parse(localStorage.getItem(name)!);
          settings[name.slice(prefix.length)] = value;
          if (inTauri) await host.setSetting(name.slice(prefix.length), value);
        } catch {
          /* skip a broken entry */
        }
      }
    }
  },
};

// ---------- tabs & document state ----------

/** One open document. Each column shows one of its tabs at a time in its editor. */
interface Tab {
  id: number;
  /** The real file, once there is one. */
  path: string | null;
  /** Staging-area file auto-saving an untitled document. */
  draft: string | null;
  mtime: number | null;
  /** Content as last persisted (to `path`, or to `draft`). */
  saved: Text;
  eol: string;
  /** False only for the launch-screen tab before anything happens in it. */
  started: boolean;
  /** The file disappeared from disk. */
  missing: boolean;
  /** Edits not yet persisted (auto-save pending). */
  dirty: boolean;
  /** The last write failed; the user has to act. */
  failed: boolean;
  /** Writes in flight, chained so they land in order. */
  queue: Promise<unknown>;
  busy: number;
  autosaveTimer: number;
  /** Editor state while in the background (the view owns it while active). */
  state: EditorState;
  editorScroll: StateEffect<unknown> | null;
  previewTop: number;
  /** How the document is highlighted, previewed and counted. */
  format: FormatPlugin;
  /** Soft-wrap long lines. */
  wrap: boolean;
  /** Encoding the file is written in, and whether it has a byte order mark. */
  encoding: string;
  bom: boolean;
  /** The encoding was detected from little evidence. */
  guessed: boolean;
  /** The text cannot be written in `encoding`; auto-save is on hold. */
  unmappable: boolean;
  /** Big enough that preview and counting only run on request. */
  large: boolean;
  /** Too big to edit: opened read-only. */
  readOnly: boolean;
  /**
   * Some bytes did not decode in `encoding` and show as U+FFFD. Writing the
   * text back would destroy them, so the tab is read-only and never saved
   * over its file until it is reopened in an encoding that fits.
   */
  lossy: boolean;
  /** For a large file, the user asked for the preview / counts. */
  previewWanted: boolean;
  /** Size of the file on disk when it was read, in bytes. */
  size: number;
  /** The editor's share of the split view; every new tab starts at half and half. */
  split: number;
  /** Binary formats: status bar text the viewer reports (position, summary). */
  viewerStatus: [string, string];
  /** The view picked for it while the window has two columns (they start in Read view). */
  columnMode: Mode | null;
}

const AUTOSAVE_DELAY = 800;

let mode: Mode = "write";
let fontSize = 15;
let draftsDir = "";
let nextTabId = 1;

// ---------- formats ----------

/** Formats the user picked by hand for particular files (path → format id). */
const overrides = (): Record<string, string> => prefs.get("formatOverrides", {});

/** The format a file is shown as: the user's choice, else by its extension. */
function formatOf(path: string | null): FormatPlugin {
  const byName = formatFor(path);
  // A binary file is only ever shown by its viewer; text never as a binary format.
  if (byName.binary) return byName;
  const id = path ? overrides()[path] : undefined;
  const chosen = id ? formatById(id) : undefined;
  return chosen && !chosen.binary ? chosen : byName;
}

function rememberOverride(path: string, format: FormatPlugin | null) {
  const all = overrides();
  if (format) all[path] = format.id;
  else delete all[path];
  prefs.set("formatOverrides", all);
}

/** Editor languages that have finished loading, by format id. */
const languages = new Map<string, Extension>();
const languageLoads = new Map<string, Promise<void>>();

/** Kick off loading a format's language; tabs using it are updated when it lands. */
function loadLanguage(format: FormatPlugin): Promise<void> {
  if (!format.language || languages.has(format.id)) return Promise.resolve();
  let load = languageLoads.get(format.id);
  if (!load) {
    const result = format.language();
    if (!(result instanceof Promise)) {
      languages.set(format.id, result);
      return Promise.resolve();
    }
    load = result.then(
      (ext) => {
        languages.set(format.id, ext);
        for (const tab of allTabs()) if (tab.format === format) reconfigure(tab);
      },
      () => {
        languageLoads.delete(format.id); // try again next time
      },
    );
    languageLoads.set(format.id, load);
  }
  return load;
}

const formatEffects = (format: FormatPlugin) => [
  languageSlot.reconfigure(languages.get(format.id) ?? []),
  extrasSlot.reconfigure(format.editorExtras ?? []),
];

/** Reconfigure a tab's editor, on screen or not. */
function dispatchTo(tab: Tab, effects: StateEffect<unknown> | StateEffect<unknown>[]) {
  const pane = paneShowing(tab);
  if (pane) pane.view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
}

/** Bring a tab's editor in line with its format. */
function reconfigure(tab: Tab) {
  dispatchTo(tab, formatEffects(tab.format));
}

/** Show a tab as another format (status bar choice, or a renamed file). */
function setFormat(tab: Tab, format: FormatPlugin) {
  if (tab.format === format || tab.format.binary || format.binary) return;
  tab.format = format;
  tab.columnMode = null;
  loadLanguage(format);
  reconfigure(tab);
  const pane = paneShowing(tab);
  if (pane) inPane(pane, showDocument);
}

function createTab(text = "", started = true, format = formatOf(null)): Tab {
  const state = makeState(text, format, true);
  return {
    id: nextTabId++,
    path: null,
    draft: null,
    mtime: null,
    saved: state.doc,
    eol: eolOf(text),
    started,
    missing: false,
    dirty: false,
    failed: false,
    queue: Promise.resolve(),
    busy: 0,
    autosaveTimer: 0,
    state,
    editorScroll: null,
    previewTop: 0,
    format,
    wrap: true,
    encoding: "UTF-8",
    bom: false,
    guessed: false,
    unmappable: false,
    large: false,
    readOnly: false,
    lossy: false,
    previewWanted: false,
    size: 0,
    split: 0.5,
    viewerStatus: ["", ""],
    columnMode: null,
  };
}

/** The line break most lines of `text` end with (the editor keeps one kind per document). */
function eolOf(text: string): string {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Not to be edited: too large, or decoded with losses. */
const locked = (tab: Tab) => tab.readOnly || tab.lossy;

/** Bring a tab's editor in line with whether it may be edited. */
function applyReadOnly(tab: Tab) {
  dispatchTo(tab, readOnlySlot.reconfigure(readOnlyExtension(locked(tab))));
}

function makeState(text: string, format: FormatPlugin, wrap: boolean, readOnly = false) {
  loadLanguage(format);
  return EditorState.create({
    doc: text,
    extensions: editorExtensions(EditorView.updateListener.of(onUpdate), {
      language: languages.get(format.id) ?? [],
      extras: format.editorExtras ?? [],
      wrap,
      readOnly,
    }),
  });
}

// ---------- columns ----------

/**
 * What a column shows and how. The code below works on one column at a time
 * through module variables of the same names (`doc`, `view`, `mode`,
 * `preview`, …): `switchTo` stores them in the column they belong to and loads
 * another's. So while a column is the current one, its copy here is stale;
 * `tabsOf` and `docOf` read either.
 */
interface PaneState {
  tabs: Tab[];
  /** The tab on screen. */
  doc: Tab;
  mode: Mode;
  previewTimer: number;
  previewStale: boolean;
  anchors: Anchor[];
  anchorsMeasured: boolean;
  previewFormat: FormatPlugin | null;
  renderSeq: number;
  syncSource: "editor" | "preview" | null;
  syncTimer: number;
  headings: Heading[];
  outlineTimer: number;
  outlineItems: HTMLButtonElement[];
  outlineKey: string;
  activeHeading: number;
  pickedHeading: number;
  pickedAt: number;
}

/** A column: a tab strip over an editor and a preview. The window has one, or two side by side. */
interface Pane extends PaneState {
  el: HTMLElement;
  editorEl: HTMLElement;
  previewScroll: HTMLElement;
  preview: HTMLElement;
  previewErrorEl: HTMLElement;
  divider: HTMLElement;
  outlineList: HTMLElement;
  outlineBtn: HTMLButtonElement;
  view: EditorView;
  tabBar: TabBar;
  /** Loaded preview renderers, by format id: each column has its own. */
  renderers: Map<string, PreviewRenderer>;
}

/** Block elements in the preview keyed by their source line, for scroll sync. */
type Anchor = { line: number; el: HTMLElement; top: number };

function createPane(firstTabs: Tab[], shown: Tab): Pane {
  const el = $<HTMLTemplateElement>("column-tpl").content.firstElementChild!.cloneNode(true) as HTMLElement;
  const part = <T extends HTMLElement = HTMLElement>(selector: string) => el.querySelector<T>(selector)!;
  const editorEl = part(".editor-pane");
  const pane: Pane = {
    el,
    editorEl,
    previewScroll: part(".preview-pane"),
    preview: part(".preview"),
    previewErrorEl: part(".preview-error"),
    divider: part(".split-divider"),
    outlineList: part(".ol-list"),
    outlineBtn: part<HTMLButtonElement>(".outline-toggle"),
    view: new EditorView({ parent: editorEl, state: shown.state }),
    tabBar: new TabBar(part(".tab-list"), part(".tab-new"), tabHandlers(() => pane)),
    renderers: new Map(),
    tabs: firstTabs,
    doc: shown,
    mode: "write",
    previewTimer: 0,
    previewStale: true,
    anchors: [],
    anchorsMeasured: false,
    previewFormat: null,
    renderSeq: 0,
    syncSource: null,
    syncTimer: 0,
    headings: [],
    outlineTimer: 0,
    outlineItems: [],
    outlineKey: "",
    activeHeading: -1,
    pickedHeading: -1,
    pickedAt: 0,
  };
  return pane;
}

let tabs: Tab[] = [createTab("", false)];
/** The tab on screen. */
let doc: Tab = tabs[0];
const panes: Pane[] = [createPane(tabs, doc)];
panesEl.append(panes[0].el);
/** The column the variables here belong to right now. */
let cur = panes[0];
/** The column the user is in: the title bar, status bar and commands are about it. */
let focused = cur;
let { el: colEl, editorEl, previewScroll, preview, previewErrorEl, divider, outlineList, outlineBtn, view, renderers } = cur;

const isSplit = () => panes.length > 1;
const tabsOf = (pane: Pane) => (pane === cur ? tabs : pane.tabs);
const docOf = (pane: Pane) => (pane === cur ? doc : pane.doc);
const allTabs = () => panes.flatMap(tabsOf);
const paneShowing = (tab: Tab) => panes.find((p) => docOf(p) === tab);
const paneHolding = (tab: Tab) => panes.find((p) => tabsOf(p).includes(tab));

/** Make `pane` the one the module variables stand for. */
function switchTo(pane: Pane) {
  if (pane === cur) return;
  const state: PaneState = {
    tabs, doc, mode, previewTimer, previewStale, anchors, anchorsMeasured, previewFormat, renderSeq,
    syncSource, syncTimer, headings, outlineTimer, outlineItems, outlineKey, activeHeading, pickedHeading, pickedAt,
  };
  Object.assign(cur, state);
  cur = pane;
  ({
    tabs, doc, mode, previewTimer, previewStale, anchors, anchorsMeasured, previewFormat, renderSeq,
    syncSource, syncTimer, headings, outlineTimer, outlineItems, outlineKey, activeHeading, pickedHeading, pickedAt,
  } = pane);
  ({ el: colEl, editorEl, previewScroll, preview, previewErrorEl, divider, outlineList, outlineBtn, view, renderers } = pane);
}

let borrowed = 0;
/**
 * Run `fn` with `pane` as the current column, whichever the user is in: for
 * events, timers and late results that belong to a column. Only what is on
 * that column changes; the title bar and status bar stay with the focused one.
 */
function inPane<T>(pane: Pane, fn: () => T): T {
  if (pane === cur) return fn();
  const before = cur;
  switchTo(pane);
  borrowed++;
  try {
    return fn();
  } finally {
    // Back to where we were; from the outermost call that is the focused column,
    // even if `fn` moved the focus.
    switchTo(--borrowed ? before : focused);
  }
}

/** `fn` as an event listener or callback that runs in `pane`. */
const within = <A extends unknown[], R>(pane: Pane, fn: (...args: A) => R) => (...args: A) =>
  panes.includes(pane) ? inPane(pane, () => fn(...args)) : (undefined as R);

const eachPane = (fn: () => void) => panes.forEach((p) => inPane(p, fn));

/** Listeners every column gets on its own elements (added to as the sections below define them). */
const wiring: ((pane: Pane) => void)[] = [];

/** The user moved to this column (a click or the keyboard focus landing in it). */
function focusPane(pane: Pane) {
  if (pane === focused && pane === cur) return;
  const left = focused;
  switchTo(pane);
  focused = pane;
  if (left !== pane && panes.includes(left)) autosave(docOf(left));
  for (const p of panes) p.el.classList.toggle("focused", p === pane);
  app.dataset.mode = mode;
  app.classList.toggle("narrow", colEl.classList.contains("narrow"));
  syncModeButtons();
  refreshChrome();
  updatePos();
  updateCount();
  checkDisk();
}

wiring.push((pane) => {
  pane.el.addEventListener("pointerdown", () => focusPane(pane), true);
  pane.el.addEventListener("focusin", () => focusPane(pane));
});

/** Current text of a tab, whether it is on screen or not. */
const textOf = (tab: Tab) => paneShowing(tab)?.view.state.doc ?? tab.state.doc;

function onUpdate(u: ViewUpdate) {
  const pane = panes.find((p) => p.view === u.view);
  if (pane) inPane(pane, () => onDocUpdate(u));
}

function onDocUpdate(u: ViewUpdate) {
  if (u.docChanged) {
    if (!doc.started) doc.started = true;
    doc.dirty = !u.state.doc.eq(doc.saved);
    if (doc.dirty) scheduleAutosave(doc);
    // Back to the saved text, which its encoding could hold.
    else doc.unmappable = false;
    refreshChrome();
    schedulePreview();
    scheduleCount();
    scheduleOutline();
  } else if (u.selectionSet) {
    scheduleCount();
  }
  if (u.docChanged || u.selectionSet) updatePos();
}

// ---------- paths ----------

const sepOf = (p: string) => (p.includes("\\") && !p.includes("/") ? "\\" : "/");
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || sepOf(p);
const tildify = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, "~");

function resolvePath(base: string, rel: string): string {
  const sep = sepOf(base);
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) return rel;
  const parts = base.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "..") parts.length > 1 && parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join(sep);
}

/** A tab's label: the file name, or for a draft its first line of text. */
function tabName(tab: Tab): string {
  if (tab.path) return basename(tab.path);
  const head = textOf(tab).sliceString(0, 400);
  const line = head
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").trim())
    .find(Boolean);
  return line ? (line.length > 32 ? `${line.slice(0, 32)}…` : line) : "未命名";
}

// ---------- chrome: title, tabs, status ----------

/** An untouched, untitled tab that an opened file may take over. */
function isPristine(tab = doc) {
  return !tab.path && !tab.draft && textOf(tab).length === 0;
}

/** Something the user must deal with: a failed save or a deleted file. */
function needsAttention(tab: Tab) {
  return tab.failed || tab.missing || tab.unmappable;
}

let reported = "";
/**
 * Until boot has asked the backend what to open, say nothing: an early report
 * of "no tabs, no folder" would overwrite what a reloaded page gets back.
 */
let initialized = false;
/** Tell the backend what this window holds (for file routing and quit). */
function syncBackend(force = false): Promise<void> {
  if (!initialized) return Promise.resolve();
  const paths = allTabs().map((t) => t.path ?? t.draft).filter((p): p is string => !!p);
  const unsaved = allTabs().some((t) => t.dirty || needsAttention(t));
  const state = JSON.stringify([paths, unsaved, folder]);
  if (!force && state === reported) return Promise.resolve();
  reported = state;
  return host.reportState(paths, unsaved, folder);
}

/** What a tab strip does with the tabs of `pane`'s column. */
function tabHandlers(pane: () => Pane): TabBarHandlers {
  return {
    activate: (id) => withTab(id, activate),
    close: (id) => withTab(id, closeTab),
    move: (id, to) =>
      withTab(id, (tab) => {
        focusPane(pane());
        tabs.splice(tabs.indexOf(tab), 1);
        tabs.splice(to, 0, tab);
        refreshChrome();
      }),
    create: () => {
      focusPane(pane());
      newTab();
    },
    menu: (id, x, y) => withTab(id, (tab) => showMenu(pane().el, tabMenu(tab), { x, y })),
  };
}

/** The strip in the title bar: the only column's tabs. With two columns, each shows its own. */
const titleTabs = new TabBar($("tab-list"), $("tab-new"), tabHandlers(() => panes[0]));

function withTab(id: number, fn: (tab: Tab) => unknown) {
  const tab = allTabs().find((t) => t.id === id);
  if (tab) fn(tab);
}

function renderTabs() {
  // The strip (and its + button) is always there once a document is open.
  app.classList.toggle("has-tabs", !isSplit() && doc.started);
  const names = tabs.map(tabName);
  const items = tabs.map((tab, i) => {
      // Two tabs called README.md: say which folder each one is in.
      const clash = tab.path && names.filter((n) => n === names[i]).length > 1;
      return {
        id: tab.id,
        name: clash ? `${names[i]} — ${basename(dirname(tab.path!))}` : names[i],
        title: tab.path ? tildify(tab.path) : "草稿（自动保存在暂存区）",
        unsaved: needsAttention(tab),
        draft: !tab.path,
      };
  });
  cur.tabBar.render(items, doc.id);
  if (!isSplit()) titleTabs.render(items, doc.id);
}

function refreshChrome() {
  renderTabs();
  // The rest is about the column the user is in.
  if (cur !== focused) return;
  app.classList.toggle("is-empty", !doc.started);
  app.classList.toggle("is-dirty", needsAttention(doc));

  const name = tabName(doc);
  nameEl.textContent = name;
  dirEl.textContent = doc.path ? `— ${basename(dirname(doc.path))}` : doc.draft ? "— 草稿" : "";
  dirEl.title = doc.path ? tildify(doc.path) : "";
  const title = doc.draft ? `${name}（草稿）` : name;
  if (document.title !== title) {
    document.title = title;
    host.window?.setTitle(title);
  }

  saveEl.className = "";
  saveEl.title = "";
  if (doc.format.binary) {
    saveEl.textContent = "只读";
    saveEl.title = "这个文件只能查看，edit2 不会写入它";
  } else if (doc.lossy) {
    saveEl.textContent = `只读 · 不是有效的 ${encodingName(doc.encoding, doc.bom)}`;
    saveEl.className = "warn";
    saveEl.title = "有些内容无法按这个编码解码（显示为 \uFFFD）。为免写坏文件，这里不会保存它：请在右侧的编码菜单里换一种编码重新打开";
  } else if (doc.readOnly) {
    saveEl.textContent = "只读 · 文件过大";
  } else if (doc.unmappable) {
    saveEl.textContent = `无法用 ${encodingName(doc.encoding, doc.bom)} 保存`;
    saveEl.className = "warn";
    saveEl.title = "有字符无法用这个编码表示：删掉它们，或在右侧的编码菜单里改用 UTF-8";
  } else if (doc.missing) {
    saveEl.textContent = "文件已被移除";
    saveEl.className = "warn";
  } else if (doc.failed) {
    saveEl.textContent = "自动保存失败";
    saveEl.className = "warn";
  } else if (doc.dirty) {
    saveEl.textContent = "自动保存中…";
  } else if (doc.path) {
    saveEl.textContent = "已保存";
    saveEl.className = "ok";
  } else if (doc.draft) {
    saveEl.textContent = "草稿 · 已暂存";
    saveEl.className = "ok";
  } else {
    saveEl.textContent = "新文件";
  }

  formatEl.textContent = doc.format.label;
  syncFormatMenu();
  // Binary files have no encoding: the button empties and hides.
  encodingEl.textContent = doc.format.binary ? "" : encodingName(doc.encoding, doc.bom) + (doc.guessed ? "?" : "");
  encodingEl.title = doc.guessed ? "编码是根据很少的内容推测的，乱码时可换一种编码重新打开" : "文件编码";
  app.classList.toggle("no-preview", !doc.format.preview);

  tree.setActive(doc.path);
  syncFolderMenu();
  syncBackend();
}

function updatePos() {
  if (cur !== focused) return;
  if (doc.format.binary) {
    posEl.textContent = doc.viewerStatus[0];
    return;
  }
  if (mode === "read") {
    posEl.textContent = "";
    return;
  }
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  posEl.textContent = `行 ${line.number}，列 ${head - line.from + 1}`;
}

let countTimer = 0;
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCount, view.state.doc.length > 200_000 ? 400 : 80);
}

function updateCount() {
  if (cur !== focused) return;
  if (doc.format.binary) {
    countEl.classList.remove("clickable");
    countEl.textContent = doc.viewerStatus[1];
    return;
  }
  countEl.classList.toggle("clickable", doc.large && !doc.previewWanted);
  if (doc.large && !doc.previewWanted) {
    countEl.textContent = doc.readOnly ? "只读大文件 · 点击统计" : "大文件，预览已暂停 · 点击统计";
    return;
  }
  const sel = view.state.selection.main;
  const picked = mode !== "read" && !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : null;
  const tab = doc;
  const seq = ++countSeq;
  const stats = tab.format.stats(view.state.doc.toString(), picked, mode === "read");
  if (typeof stats === "string") countEl.textContent = stats;
  else stats.then((text) => seq === countSeq && doc === tab && (countEl.textContent = text));
}
let countSeq = 0;

let toastTimer = 0;
function toast(text: string, ms = 1800) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
}

// ---------- preview ----------

let previewTimer = 0;
let previewStale = true;
/** Block elements in the preview keyed by their source line, for scroll sync. */
let anchors: Anchor[] = [];
/** Whether `anchors[].top` reflects the current layout. */
let anchorsMeasured = false;
/** Local files the backend has already been asked to expose. */
const allowedAssets = new Set<string>();
/** Format whose output the preview element currently holds. */
let previewFormat: FormatPlugin | null = null;
/** Bumped by every render; a render finishing late compares against it. */
let renderSeq = 0;

function schedulePreview() {
  previewStale = true;
  if (mode === "write") return;
  if (doc.large) return void showLargeNotice();
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(within(cur, renderPreview), view.state.doc.length > 200_000 ? 400 : 90);
}

/** Absolute path of a local file referenced from the document, or null. */
function localPath(ref: string): string | null {
  if (!ref || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) return null;
  let local = ref.replace(/[?#].*$/, "");
  try {
    local = decodeURIComponent(local);
  } catch {
    /* keep raw */
  }
  if (!local) return null;
  if (doc.path) return resolvePath(dirname(doc.path), local);
  return /^([a-zA-Z]:)?[\\/]/.test(local) ? local : null;
}

async function assetUrls(paths: string[]): Promise<string[]> {
  const fresh = [...new Set(paths)].filter((p) => !allowedAssets.has(p));
  if (fresh.length) {
    fresh.forEach((p) => allowedAssets.add(p));
    await host.allowAssets(fresh).catch(() => {});
  }
  return paths.map((p) => host.assetUrl(p));
}

/** Follow a link clicked in the preview. */
function openLink(href: string, scope: ParentNode = preview) {
  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    const hit =
      scope.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`) ??
      [...scope.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].find(
        (h) => slug(h.textContent ?? "") === slug(id),
      );
    if (!hit) return;
    // Inside a preview frame (HTML), smooth scrolling does not reach the pane: scroll it here.
    const frame = hit.ownerDocument.defaultView?.frameElement;
    if (!frame) return hit.scrollIntoView({ block: "start", behavior: "smooth" });
    const top =
      frame.getBoundingClientRect().top + hit.getBoundingClientRect().top - previewScroll.getBoundingClientRect().top;
    previewScroll.scrollTo({ top: previewScroll.scrollTop + top - 8, behavior: "smooth" });
  } else if (/^(https?|mailto|tel):/i.test(href)) {
    host.openUrl(href);
  } else {
    const abs = localPath(href);
    if (!abs) return;
    if (isKnownFile(abs)) openPath(abs);
    else host.reveal(abs);
  }
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function goToLine(line: number) {
  const n = Math.min(view.state.doc.lines, Math.max(1, line + 1));
  const at = view.state.doc.line(n).from;
  if (mode === "read") setMode("split");
  view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
  view.focus();
}

function revealLine(line: number) {
  if (mode !== "split") return;
  const n = Math.min(view.state.doc.lines, Math.max(1, line + 1));
  const at = view.state.doc.line(n).from;
  // The preview is where the user is looking: keep scroll sync from moving it.
  syncSource = null;
  claimSync("preview");
  view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
}

/** Per document, the token its page is published under for the script preview. */
const pageTokens = new Map<string, string>();

async function publishPage(tab: Tab, html: string): Promise<string | null> {
  if (!inTauri) return null;
  const key = tab.path ?? `tab-${tab.id}`;
  let token = pageTokens.get(key);
  if (!token) pageTokens.set(key, (token = crypto.randomUUID()));
  return `${host.previewOrigin}/${await host.servePreview(token, tab.path, html)}`;
}

function previewContext(seq: number, tab: Tab): PreviewContext {
  // A renderer calls back whenever it likes: each call runs in the column it rendered for.
  const pane = cur;
  const here = <A extends unknown[], R>(fn: (...args: A) => R) => within(pane, fn);
  return {
    container: preview,
    path: tab.path,
    localPath: here(localPath),
    assetUrls,
    openLink: here((href: string, scope?: ParentNode) => openLink(href, scope)),
    editSource: here((fn: (doc: Text) => { from: number; to: number; insert: string } | null) => {
      if (doc !== tab || tab.format.binary) return;
      const change = fn(view.state.doc);
      if (!change) return;
      view.dispatch({ changes: change, userEvent: "input" });
      renderPreview();
    }),
    goToLine: here(goToLine),
    revealLine: here(revealLine),
    publishPage: (html) => publishPage(tab, html),
    layoutChanged: here(() => void (anchorsMeasured = false)),
    isCurrent: here(() => seq === renderSeq && doc === tab),
    file: tab.format.binary && tab.path ? binaryFile(tab.path, tab) : undefined,
    setStatus: here((position: string, summary: string) => {
      tab.viewerStatus = [position, summary];
      if (doc !== tab) return;
      updatePos();
      updateCount();
    }),
  };
}

/** A binary file as the viewer reads it, at the size and time it had when last checked. */
function binaryFile(path: string, tab: Tab): BinaryFile {
  return {
    size: tab.size,
    version: `${tab.mtime}:${tab.size}`,
    read: (offset, length) => host.readBytes(path, offset, length),
    systemPreview: () => host.systemPreview(path),
    openInApp: () => void host.openInDefaultApp(path).catch((err) => host.alert("无法用其他程序打开", String(err))),
  };
}

function showPreviewError(error: RenderResult["error"]) {
  delete previewErrorEl.dataset.action;
  previewErrorEl.hidden = !error;
  if (!error) return;
  previewErrorEl.textContent = error.line ? `第 ${error.line} 行：${error.message}` : error.message;
  previewErrorEl.dataset.line = error.line ? String(error.line - 1) : "";
  previewErrorEl.title = error.line ? "点击跳到这一行" : "";
}

wiring.push((pane) =>
  pane.previewErrorEl.addEventListener("click", within(pane, () => {
    if (previewErrorEl.dataset.action === "render") {
      const tab = doc;
      tab.previewWanted = true;
      renderPreview().then(() => {
        // Later edits do not re-render on their own.
        if (tab.large) tab.previewWanted = false;
      });
      return;
    }
    const line = previewErrorEl.dataset.line;
    if (line) goToLine(Number(line));
  })),
);

countEl.addEventListener("click", () => {
  if (!doc.large || doc.previewWanted) return;
  doc.previewWanted = true;
  updateCount();
  doc.previewWanted = false;
  countEl.classList.remove("clickable");
});

function setAnchors(list: { line: number; el: HTMLElement }[]) {
  anchors = list.map((a) => ({ ...a, top: 0 })).sort((a, b) => a.line - b.line);
  anchorsMeasured = false;
  if (mode === "read") buildOutline();
}

/** The current column's renderer for a format, made on first use. */
function loadRenderer(format: FormatPlugin): PreviewRenderer | Promise<PreviewRenderer> {
  const own = renderers;
  return (
    own.get(format.id) ??
    format.preview!().then((r) => {
      // Two renders may have asked at once: the column keeps one renderer per format.
      const first = own.get(format.id) ?? r;
      own.set(format.id, first);
      return first;
    })
  );
}

/** Large files: say the preview is paused and offer to render it (read-only ones get none). */
function showLargeNotice() {
  if (doc.readOnly) {
    return showPreviewError({ message: `文件过大（${formatSize(doc.size)}），以只读方式打开，不提供预览。` });
  }
  const empty = !preview.childElementCount;
  showPreviewError({
    message: empty
      ? `文件较大（${formatSize(doc.size)}），预览已暂停。点击这里渲染预览。`
      : "大文件的预览不随编辑自动更新。点击这里刷新。",
  });
  previewErrorEl.dataset.action = "render";
}

async function renderPreview() {
  clearTimeout(previewTimer);
  const pane = cur;
  const seq = ++renderSeq;
  const tab = doc;
  const format = tab.format;
  if (tab.large && !tab.previewWanted && format.preview) {
    if (previewFormat !== format) {
      previewFormat = format;
      preview.replaceChildren();
      preview.className = `preview fmt-${format.id}`;
      setAnchors([]);
    }
    return showLargeNotice();
  }
  previewStale = false;

  if (previewFormat !== format) {
    if (previewFormat) renderers.get(previewFormat.id)?.reset?.();
    previewFormat = format;
    preview.replaceChildren();
    preview.className = `preview fmt-${format.id}`;
    setAnchors([]);
    showPreviewError(null);
  }
  if (!format.preview) return;

  // After each wait another column may be the current one: check and act in this one.
  const latest = () => panes.includes(pane) && inPane(pane, () => seq === renderSeq);
  try {
    let renderer = loadRenderer(format);
    if (renderer instanceof Promise) renderer = await renderer;
    if (!latest()) return;
    const ready = renderer;
    let result = inPane(pane, () => ready.render(view.state.doc.toString(), previewContext(seq, tab)));
    if (result instanceof Promise) result = await result;
    if (!latest()) return;
    const done = result;
    inPane(pane, () => {
      showPreviewError(done.error);
      // A failed parse leaves the last good output (and its anchors) on screen.
      if (done.anchors || !done.error) setAnchors(done.anchors ?? []);
    });
  } catch (err) {
    if (latest()) inPane(pane, () => showPreviewError({ message: `预览失败：${err}` }));
  }
}

// Previews follow the palette: redraw them when it flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
  eachPane(() => {
    for (const r of renderers.values()) r.themeChanged?.();
    previewStale = true;
    if (mode !== "write") renderPreview();
  }),
);

/** Read every anchor's offset in one layout pass instead of per scroll event. */
function measureAnchors() {
  if (anchorsMeasured) return;
  const base = previewScroll.getBoundingClientRect().top - previewScroll.scrollTop;
  for (const a of anchors) a.top = a.el.getBoundingClientRect().top - base;
  anchorsMeasured = true;
}

// Layout shifts (images arriving, resizing) invalidate the measured offsets.
wiring.push((pane) => pane.preview.addEventListener("load", within(pane, () => void (anchorsMeasured = false)), true));
window.addEventListener("resize", () => eachPane(() => (anchorsMeasured = false)));

wiring.push((pane) =>
  pane.preview.addEventListener("click", within(pane, (e: MouseEvent) => {
    const renderer = previewFormat && renderers.get(previewFormat.id);
    const handled = renderer?.click?.(e, previewContext(renderSeq, doc));
    if (handled === "rerender") renderPreview();
    if (handled) return;
    if (e.defaultPrevented) return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    openLink(a.getAttribute("href") ?? "");
  })),
);

// ---------- scroll sync (split mode) ----------

let syncSource: "editor" | "preview" | null = null;
let syncTimer = 0;
function claimSync(src: "editor" | "preview") {
  if (syncSource && syncSource !== src) return false;
  syncSource = src;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(within(cur, () => void (syncSource = null)), 120);
  return true;
}

const PREVIEW_PAD = 28;

/** Fractional source line at the top of the editor viewport. */
function editorTopLine(): number {
  const h = view.scrollDOM.scrollTop - view.documentPadding.top;
  if (h <= 0) return 0;
  const block = view.lineBlockAtHeight(h);
  const line = view.state.doc.lineAt(block.from).number - 1;
  return line + Math.min(1, Math.max(0, (h - block.top) / Math.max(1, block.height)));
}

/** Scroll `to` to the same relative position as `from` (previews without anchors). */
function syncByRatio(from: HTMLElement, to: HTMLElement) {
  const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
  to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
}

function syncPreviewFromEditor() {
  if (mode !== "split" || !claimSync("editor")) return;
  const s = view.scrollDOM;
  if (!anchors.length) return syncByRatio(s, previewScroll);
  if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) {
    previewScroll.scrollTop = previewScroll.scrollHeight;
    return;
  }
  measureAnchors();
  const line = editorTopLine();
  let i = anchors.findIndex((a) => a.line > line);
  if (i === -1) i = anchors.length;
  const prev = anchors[i - 1];
  const next = anchors[i];
  let y: number;
  if (!prev) y = 0;
  else {
    const top = prev.top;
    const end = next ? next.top : top + prev.el.offsetHeight;
    const span = (next ? next.line : view.state.doc.lines) - prev.line;
    y = top + (end - top) * Math.min(1, (line - prev.line) / Math.max(1, span)) - PREVIEW_PAD;
  }
  previewScroll.scrollTop = Math.max(0, y);
}

function syncEditorFromPreview() {
  if (mode !== "split" || !claimSync("preview")) return;
  const p = previewScroll;
  if (!anchors.length) return syncByRatio(p, view.scrollDOM);
  if (p.scrollTop + p.clientHeight >= p.scrollHeight - 2) {
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    return;
  }
  measureAnchors();
  const y = p.scrollTop + PREVIEW_PAD;
  let i = anchors.findIndex((a) => a.top > y);
  if (i === -1) i = anchors.length;
  const prev = anchors[i - 1];
  const next = anchors[i];
  let line = 0;
  if (prev) {
    const top = prev.top;
    const end = next ? next.top : top + prev.el.offsetHeight;
    const span = (next ? next.line : view.state.doc.lines) - prev.line;
    line = prev.line + span * Math.min(1, Math.max(0, (y - top) / Math.max(1, end - top)));
  }
  const whole = Math.min(view.state.doc.lines, Math.floor(line) + 1);
  const block = view.lineBlockAt(view.state.doc.line(whole).from);
  view.scrollDOM.scrollTop = block.top + (line % 1) * block.height + view.documentPadding.top;
}

wiring.push((pane) => {
  pane.view.scrollDOM.addEventListener("scroll", within(pane, syncPreviewFromEditor), { passive: true });
  pane.previewScroll.addEventListener("scroll", within(pane, syncEditorFromPreview), { passive: true });
});

// ---------- split divider ----------

/**
 * Each tab keeps its own divider position (`Tab.split`, a fraction so it
 * survives window resizes); a new tab starts at half and half. It is not
 * saved: after a restart every tab starts at half and half again.
 */
/** Matches the panes' min-width in split mode (styles.css). */
const SPLIT_MIN_PX = 200;

/** Width the two panes share, and where it starts. */
function splitSpan() {
  const left = editorEl.getBoundingClientRect().left;
  const width = previewScroll.getBoundingClientRect().right - left - divider.offsetWidth;
  return { left, width };
}

function clampRatio(r: number, width = splitSpan().width): number {
  const min = width > 0 ? Math.min(0.5, SPLIT_MIN_PX / width) : 0.15;
  return Math.min(1 - min, Math.max(min, r));
}

/** Lay the panes out at the active tab's ratio (on every layout change). */
function layoutSplit() {
  colEl.style.setProperty("--split", String(doc.split));
  divider.setAttribute("aria-valuenow", String(Math.round(doc.split * 100)));
}

/** Move the active tab's divider. */
function applySplit(r: number) {
  doc.split = r;
  layoutSplit();
  if (mode !== "split") return;
  // Wrapping changes on both sides: re-measure, then line the preview up again.
  anchorsMeasured = false;
  view.requestMeasure();
  requestAnimationFrame(within(cur, () => {
    syncSource = null;
    syncPreviewFromEditor();
  }));
}

// The handlers below run in their column: pressing the divider put the focus there.
wiring.push(({ divider }) => {
divider.setAttribute("aria-valuemin", "0");
divider.setAttribute("aria-valuemax", "100");

divider.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  divider.focus({ preventScroll: true });
  divider.setPointerCapture(e.pointerId);
  // The overlay class also keeps preview iframes from swallowing the pointer.
  app.classList.add("is-resizing");
  const { left, width } = splitSpan();
  let next = doc.split;
  let frame = 0;
  const move = (ev: PointerEvent) => {
    next = clampRatio((ev.clientX - left - divider.offsetWidth / 2) / width, width);
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), applySplit(next)));
  };
  const end = () => {
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", end);
    divider.removeEventListener("pointercancel", end);
    divider.removeEventListener("lostpointercapture", end);
    if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId);
    cancelAnimationFrame(frame);
    app.classList.remove("is-resizing");
    if (next !== doc.split) applySplit(next);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
  divider.addEventListener("lostpointercapture", end);
});

divider.addEventListener("dblclick", () => applySplit(0.5));

divider.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 0.1 : 0.02;
  const target = (
    {
      ArrowLeft: doc.split - step,
      ArrowRight: doc.split + step,
      Home: 0,
      End: 1,
      Enter: 0.5,
    } as Record<string, number>
  )[e.key];
  if (target === undefined) return;
  e.preventDefault();
  applySplit(e.key === "Enter" ? 0.5 : clampRatio(target));
});
});

// ---------- outline (Markdown) ----------

/**
 * In Read view the outline lists the headings in the preview and scrolls it.
 * In Write and Split view it lists the headings in the text and scrolls the
 * editor (in Split view the preview follows by scroll sync).
 */

/** Below this width the panes cannot hold the outline beside a readable column. */
const OUTLINE_ROOM = 860;

interface Heading {
  level: number;
  text: string;
  /** 0-based source line. */
  line: number;
  /** The heading in the preview (Read view only). */
  el: HTMLElement | null;
}

/** Headings in document order, and their outline entries. */
let headings: Heading[] = [];
let outlineTimer = 0;
let outlineItems: HTMLButtonElement[] = [];
/** What the entries were built from, so rebuilds with the same headings keep them. */
let outlineKey = "";
let activeHeading = -1;
/** A heading picked in the outline stays highlighted while it is in view. */
let pickedHeading = -1;
let pickedAt = 0;

const outlineWanted = () => prefs.get("outline", true);
const outlineShown = () =>
  colEl.classList.contains("has-outline") && outlineWanted() && !colEl.classList.contains("outline-cramped");

/** The headings in the preview (Read view). */
function previewHeadings(): Heading[] {
  return [...preview.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].map((el) => ({
    level: Number(el.tagName[1]),
    text: (el.textContent ?? "").trim(),
    line: Number(el.dataset.line ?? -1),
    el,
  }));
}

/** Heading text without its Markdown: what the preview would show. */
function plainHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)(.*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .trim();
}

/**
 * The headings in the text: ATX (`## Title`) and setext (a line underlined
 * with === or ---), outside fenced code blocks, as CommonMark reads them.
 */
function sourceHeadings(text: Text): Heading[] {
  const out: Heading[] = [];
  let fence: { char: string; size: number } | null = null;
  /** The previous line, if it could be the text of a setext heading. */
  let para: { text: string; line: number } | null = null;
  let n = -1;
  for (const raw of text.iterLines()) {
    n++;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (open && open[1][0] === fence.char && open[1].length >= fence.size && !raw.slice(open[0].length).trim()) fence = null;
      continue;
    }
    if (open && !(open[1][0] === "`" && raw.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], size: open[1].length };
      para = null;
      continue;
    }
    // A heading may sit in a block quote (`> ## Title`).
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(raw.replace(/^(?: {0,3}>[ \t]?)+/, ""));
    if (atx) {
      out.push({ level: atx[1].length, text: plainHeading(atx[2] ?? ""), line: n, el: null });
      para = null;
      continue;
    }
    const under = /^ {0,3}(=+|-+)[ \t]*$/.exec(raw);
    if (under && para) {
      out.push({ level: under[1][0] === "=" ? 1 : 2, text: plainHeading(para.text), line: para.line, el: null });
      para = null;
      continue;
    }
    // A paragraph line: the text of a setext heading if an underline follows.
    const plain = raw.trim() && !/^ {4}|^\t|^ {0,3}(?:[-*+]\s|\d+[.)]\s|>|<|\||-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(raw);
    if (!plain) para = null;
    else if (para) para.text += ` ${raw.trim()}`;
    else para = { text: raw, line: n };
  }
  return out;
}

/** Rebuild the outline from the preview (Read view) or the text (Write and Split view). */
function buildOutline() {
  clearTimeout(outlineTimer);
  if (mode === "read") headings = previewFormat?.id === "markdown" ? previewHeadings() : [];
  else headings = doc.format.id === "markdown" ? sourceHeadings(view.state.doc) : [];
  const entries = headings.map((h) => ({ level: h.level, text: h.text }));
  const key = JSON.stringify(entries);
  if (key !== outlineKey) {
    outlineKey = key;
    const top = Math.min(...entries.map((e) => e.level));
    outlineItems = entries.map((e, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ol-item";
      item.dataset.index = String(i);
      item.dataset.depth = String(e.level - top);
      item.style.setProperty("--depth", String(e.level - top));
      item.textContent = item.title = e.text || "（无标题）";
      return item;
    });
    outlineList.replaceChildren(...outlineItems);
    activeHeading = pickedHeading = -1;
  }
  syncOutline();
}

/** Typing in Write or Split view: rebuild the outline once the typing pauses. */
function scheduleOutline() {
  if (mode === "read" || doc.format.id !== "markdown") return;
  clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(within(cur, buildOutline), view.state.doc.length > 200_000 ? 500 : 150);
}

/** Show or hide the outline for the current tab and view. */
function syncOutline() {
  const markdown = doc.started && doc.format.id === "markdown";
  const before = outlineShown();
  colEl.classList.toggle("has-outline", markdown && headings.length > 0);
  colEl.classList.toggle("outline-on", outlineWanted());
  const on = outlineWanted();
  const keys = isMac ? "⇧⌘D" : "Ctrl+Shift+D";
  outlineBtn.setAttribute("aria-pressed", String(on));
  outlineBtn.setAttribute("aria-label", on ? "隐藏大纲" : "显示大纲");
  outlineBtn.title = `${on ? "隐藏大纲" : "显示大纲"} ${keys}`;
  if (outlineShown() !== before) {
    anchorsMeasured = false;
    if (mode !== "read") view.requestMeasure();
  }
  updateActiveHeading();
}

function toggleOutline() {
  if (!doc.started) return;
  if (doc.format.id !== "markdown") return toast("只有 Markdown 文档有大纲");
  const on = !outlineWanted();
  prefs.set("outline", on);
  eachPane(syncOutline);
  // Say so when nothing visibly changes.
  if (on && !headings.length) toast("大纲已打开，这篇文档没有标题");
  else if (on && colEl.classList.contains("outline-cramped")) toast(isSplit() ? "大纲已打开，这一栏放宽后显示" : "大纲已打开，窗口放宽后显示");
}

/** Where a heading is in the editor: its top and bottom, in scroller coordinates. */
function editorSpan(h: Heading) {
  const doc = view.state.doc;
  const block = view.lineBlockAt(doc.line(Math.min(doc.lines, h.line + 1)).from);
  const pad = view.documentPadding.top;
  return { top: block.top + pad, bottom: block.bottom + pad };
}

/** Highlight the section being read: the last heading above a line near the top of the pane. */
function updateActiveHeading() {
  if (!outlineShown()) return;
  const reading = mode === "read";
  const scroller = reading ? previewScroll : view.scrollDOM;
  const box = scroller.getBoundingClientRect();
  // Heading positions relative to the top of the pane.
  const topOf = reading
    ? (h: Heading) => {
        const r = h.el!.getBoundingClientRect();
        return r.height ? r.top - box.top : null; // inside a closed <details>
      }
    : (h: Heading) => editorSpan(h).top - scroller.scrollTop;
  const visible = (h: Heading) => {
    if (reading && !h.el?.isConnected) return false;
    const top = topOf(h);
    return top !== null && top >= -1 && top < box.height;
  };
  if (pickedHeading >= 0) {
    // While the picked heading is being scrolled to, or is still in view, it wins.
    const h = headings[pickedHeading];
    if (h && (performance.now() - pickedAt < 1000 || visible(h))) return setActiveHeading(pickedHeading);
    pickedHeading = -1;
  }
  const line = Math.min(80, box.height / 4);
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  let index = -1;
  for (let i = 0; i < headings.length; i++) {
    const top = topOf(headings[i]);
    if (top === null) continue;
    if (top <= line || (atEnd && top < box.height)) index = i;
    else break;
  }
  setActiveHeading(index);
}

function setActiveHeading(index: number) {
  if (index === activeHeading && outlineItems[index]?.classList.contains("active")) return;
  outlineItems[activeHeading]?.classList.remove("active");
  outlineItems[activeHeading]?.removeAttribute("aria-current");
  activeHeading = index;
  const item = outlineItems[index];
  if (!item) return;
  item.classList.add("active");
  item.setAttribute("aria-current", "location");
  // Keep it in sight in the outline (by hand: scrollIntoView would move the window too).
  const list = outlineList;
  if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop - 8;
  else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight + 8;
  }
}

function goToHeading(index: number) {
  const h = headings[index];
  if (!h) return;
  if (mode === "read") {
    if (!h.el?.isConnected) return;
    pickedHeading = index;
    pickedAt = performance.now();
    setActiveHeading(index);
    const top = previewScroll.scrollTop + h.el.getBoundingClientRect().top - previewScroll.getBoundingClientRect().top - 16;
    previewScroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return;
  }
  // Writing: put the cursor at the heading, near the top of the editor.
  const text = view.state.doc;
  if (h.line >= text.lines) return;
  pickedHeading = index;
  pickedAt = performance.now();
  setActiveHeading(index);
  const at = text.line(h.line + 1).to;
  const anchor = anchors.find((a) => a.line === h.line);
  if (mode === "split" && anchor?.el.isConnected && !colEl.classList.contains("narrow")) {
    // Split view: bring the heading to the top of the preview and let the editor follow it
    // (scroll sync maps the editor to the preview only roughly; this way the preview is exact).
    view.dispatch({ selection: EditorSelection.cursor(at) });
    syncSource = null;
    claimSync("preview");
    const top = previewScroll.scrollTop + anchor.el.getBoundingClientRect().top - previewScroll.getBoundingClientRect().top - 16;
    previewScroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  } else {
    view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 16 }) });
  }
  view.focus();
}

wiring.push((pane) => {
const { outlineList, outlineBtn, previewScroll } = pane;
outlineList.addEventListener("click", within(pane, (e: MouseEvent) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".ol-item");
  if (item) goToHeading(Number(item.dataset.index));
}));

// ↑ / ↓ move between entries, Home / End to the first and last (the focus is in this column).
outlineList.addEventListener("keydown", (e) => {
  const at = outlineItems.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const next = ({ ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: outlineItems.length - 1 } as Record<string, number>)[
    e.key
  ];
  if (next === undefined) return;
  e.preventDefault();
  outlineItems[Math.max(0, Math.min(outlineItems.length - 1, next))].focus();
});

outlineBtn.addEventListener("click", within(pane, toggleOutline));

// Scroll events already come at most once a frame.
previewScroll.addEventListener("scroll", within(pane, updateActiveHeading), { passive: true });
pane.view.scrollDOM.addEventListener("scroll", within(pane, updateActiveHeading), { passive: true });
});

// ---------- view modes & font size ----------

/** View last used for each format (format id → mode). */
const modePrefs = (): Record<string, Mode> => prefs.get("modes", {});

function preferredMode(format: FormatPlugin): Mode {
  if (!format.preview) return "write";
  if (format.binary) return "read";
  // Markdown keeps the single view setting from before formats existed.
  const legacy = format.id === "markdown" ? prefs.get<Mode | null>("mode", null) : null;
  return modePrefs()[format.id] ?? legacy ?? format.defaultMode;
}

/**
 * The view a tab opens in. With two columns that is Read view (they are for
 * looking at documents side by side), until the user picks another for the tab.
 */
function initialMode(tab: Tab): Mode {
  if (!isSplit()) return preferredMode(tab.format);
  if (tab.columnMode) return tab.columnMode;
  // Nothing to read in an empty document.
  return tab.format.preview && (tab.format.binary || textOf(tab).length > 0) ? "read" : "write";
}

/** Switch the layout without remembering it as a preference. */
function applyMode(next: Mode) {
  if (!doc.format.preview) next = "write";
  if (doc.format.binary) next = "read";
  mode = next;
  colEl.dataset.mode = next;
  layoutSplit();
  anchorsMeasured = false;
  if (cur === focused) {
    app.dataset.mode = next;
    syncModeButtons();
  }
  // The outline's headings come from the preview in Read view, from the text otherwise.
  buildOutline();
}

/** The title bar's view buttons show the focused column's view. */
function syncModeButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    b.disabled = doc.format.binary ? b.dataset.mode !== "read" : !doc.format.preview && b.dataset.mode !== "write";
  }
}

function setMode(next: Mode) {
  if (!doc.format.preview && next !== "write") {
    toast(`${doc.format.label}没有预览`);
    return;
  }
  if (doc.format.binary && next !== "read") {
    if (doc.started) toast("这个文件只能在阅读视图中查看");
    return;
  }
  const line = mode === "read" ? null : editorTopLine();
  applyMode(next);
  // With two columns the choice is the tab's own; the remembered views stay as they were.
  if (isSplit()) doc.columnMode = next;
  else prefs.set("modes", { ...modePrefs(), [doc.format.id]: next });
  if (next !== "write" && previewStale) renderPreview();
  if (next !== "read") view.requestMeasure();
  updatePos();
  updateCount();
  if (next === "split" && line !== null) {
    requestAnimationFrame(within(cur, () => {
      syncSource = null;
      syncPreviewFromEditor();
    }));
  }
  if (doc.started) {
    if (next === "read") focusPreview();
    else view.focus();
  }
}

/** Focus what scrolls in Read view: the pane, or a viewer's own scroller (PDF). */
function focusPreview() {
  (preview.querySelector<HTMLElement>("[data-preview-focus]") ?? previewScroll).focus({ preventScroll: true });
}

/** ⌘= / ⌘- / ⌘0: a preview that zooms itself (PDF) takes them in Read view; else the font size. */
function zoom(step: 1 | -1 | 0) {
  const renderer = mode === "read" && previewFormat === doc.format ? renderers.get(doc.format.id) : undefined;
  if (renderer?.zoom?.(step)) return;
  if (doc.format.binary) return;
  applyFont(step === 0 ? 15 : fontSize + step);
}

function applyFont(px: number) {
  fontSize = Math.min(26, Math.max(11, px));
  document.documentElement.style.setProperty("--fs", `${fontSize}px`);
  prefs.set("fontSize", fontSize);
  eachPane(() => {
    anchorsMeasured = false;
    view.requestMeasure();
  });
}

// ---------- recent files ----------

function recentFiles(): string[] {
  return prefs.get<string[]>("recent", []);
}

function rememberRecent(path: string) {
  prefs.set("recent", [path, ...recentFiles().filter((p) => p !== path)].slice(0, 10));
  renderRecent();
}

function forgetRecent(path: string) {
  prefs.set("recent", recentFiles().filter((p) => p !== path));
  renderRecent();
}

function renderRecent() {
  const list = $("recent-list");
  const files = recentFiles().slice(0, 5);
  $("recent").hidden = files.length === 0;
  list.replaceChildren(
    ...files.map((p) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = p;
      const name = document.createElement("span");
      name.className = "r-name";
      name.textContent = basename(p);
      const dir = document.createElement("span");
      dir.className = "r-dir";
      dir.textContent = `\u200e${tildify(dirname(p))}\u200e`; // keep RTL ellipsis from moving the slash
      btn.append(name, dir);
      btn.addEventListener("click", () => openPath(p));
      li.append(btn);
      return li;
    }),
  );
}



// ---------- status bar: format menu ----------

function formatMenu(): MenuEntry[] {
  const tab = doc;
  const key = tab.path ?? tab.draft;
  const byExtension = formatFor(tab.path);
  const overridden = !!key && overrides()[key] !== undefined;
  if (tab.format.binary) return [{ heading: `${tab.format.label}：只能查看，不能换成其他格式显示` }];
  const entries: MenuEntry[] = [{ heading: "显示为" }];
  const item = (format: FormatPlugin): MenuEntry => ({
    label: format.label,
    checked: tab.format === format,
    run: () => {
      if (key) rememberOverride(key, format === byExtension && tab.path ? null : format);
      setFormat(tab, format);
    },
  });
  // A group (the code languages) is one entry here that opens its own list.
  const groups = new Map<string, FormatPlugin[]>();
  for (const format of allFormats()) {
    if (format.binary) continue;
    if (!format.group) {
      entries.push(item(format));
      continue;
    }
    const members = groups.get(format.group);
    if (members) {
      members.push(format);
      continue;
    }
    const list = [format];
    groups.set(format.group, list);
    const current = tab.format.group === format.group;
    entries.push("-", {
      label: current ? `${format.group}（${tab.format.label}）…` : `${format.group}…`,
      checked: current,
      run: () => showMenu(formatEl, [{ heading: `${format.group}：显示为` }, ...list.map(item)]),
    });
  }
  if (overridden && tab.path) {
    entries.push("-", {
      label: `按扩展名识别（${byExtension.label}）`,
      run: () => {
        rememberOverride(key!, null);
        setFormat(tab, byExtension);
      },
    });
  }
  entries.push(
    "-",
    { label: "格式化文档", hint: "⇧⌥F", disabled: !tab.format.canFormat || locked(tab), run: () => runFormatter("format") },
    { label: "压缩", disabled: !tab.format.canMinify || locked(tab), run: () => runFormatter("minify") },
  );
  if (tab.format.canFormat) {
    entries.push({ heading: "格式化缩进（文件没有缩进时）" });
    for (const [label, indent] of [["2 个空格", "  "], ["4 个空格", "    "], ["制表符", "\t"]]) {
      entries.push({ label, checked: indentPref() === indent, run: () => prefs.set("indent", indent) });
    }
  }
  entries.push("-", { label: "自动换行", checked: tab.wrap, hint: "⌥Z", run: toggleWrap });
  return entries;
}

// ---------- formatting ----------

const indentPref = () => prefs.get<string>("indent", "  ");

/** The file's own indent unit if it has a consistent one, else the preference. */
function indentFor(text: string): string {
  let tabs = 0;
  const spaces: number[] = [];
  for (const line of text.split("\n", 5000)) {
    const m = /^( +|\t+)\S/.exec(line);
    if (!m) continue;
    if (m[1][0] === "\t") tabs++;
    else spaces.push(m[1].length);
  }
  if (tabs > spaces.length) return "\t";
  if (spaces.length >= 2) {
    const unit = Math.min(...spaces);
    if (unit === 2 || unit === 4) return " ".repeat(unit);
  }
  return indentPref();
}

/** Position in `text` after `count` non-whitespace characters. */
function afterSolid(text: string, count: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (seen === count) return i;
    if (!/\s/.test(text[i])) seen++;
  }
  return text.length;
}

const solidBefore = (text: string, pos: number) => text.slice(0, pos).replace(/\s+/g, "").length;

const formatters = new Map<string, Formatter>();

async function runFormatter(kind: "format" | "minify") {
  const tab = doc;
  const format = tab.format;
  if (!tab.started) return;
  const supported = kind === "format" ? format.canFormat : format.canMinify;
  if (!supported || !format.formatter) return toast(`${format.label}不支持${kind === "format" ? "格式化" : "压缩"}`);
  if (locked(tab)) return toast("文件是只读的");

  const text = view.state.doc.toString();
  let out: string;
  try {
    let f = formatters.get(format.id);
    if (!f) formatters.set(format.id, (f = await format.formatter()));
    out = kind === "format" ? await f.format!(text, { indent: indentFor(text) }) : await f.minify!(text);
  } catch (err) {
    if (!(err instanceof SyntaxProblem)) return host.alert(kind === "format" ? "格式化失败" : "压缩失败", String(err));
    toast(err.line ? `第 ${err.line} 行有语法错误，未${kind === "format" ? "格式化" : "压缩"}` : `有语法错误：${err.message}`);
    if (err.line && doc === tab) goToLine(err.line - 1);
    return;
  }
  // Typing or a tab switch meanwhile: do not apply a stale result.
  if (doc !== tab || view.state.doc.toString() !== text) return;
  // Keep whether the file ends with a line break. Only one break is added or
  // removed: more may be content (a YAML `|+` block at the end of the file).
  if (text.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  else if (!text.endsWith("\n") && out.endsWith("\n") && !out.endsWith("\n\n")) out = out.slice(0, -1);
  if (out === text) return toast(kind === "format" ? "已经是格式化后的样子" : "已经是压缩后的样子");

  // One undoable step; the cursor stays next to the same character.
  const head = afterSolid(out, solidBefore(text, view.state.selection.main.head));
  replaceContent(out, {
    selection: EditorSelection.cursor(head),
    annotations: isolateHistory.of("full"),
    userEvent: kind === "format" ? "input.format" : "input.minify",
    scrollIntoView: true,
  });
}

let formatMenuState = "";
/** Keep the native menu's format items in step with the front tab. */
function syncFormatMenu() {
  if (!document.hasFocus() && formatMenuState) return;
  const state = `${!!doc.format.canFormat && !locked(doc)}/${!!doc.format.canMinify && !locked(doc)}`;
  if (state === formatMenuState) return;
  formatMenuState = state;
  host.setFormatMenu(state.startsWith("true"), state.endsWith("true"));
}
window.addEventListener("focus", () => {
  formatMenuState = "";
  syncFormatMenu();
  folderMenuState = null;
  syncFolderMenu();
});

formatEl.addEventListener("click", () => showMenu(formatEl, formatMenu()));

function encodingMenu(): MenuEntry[] {
  const tab = doc;
  if (tab.format.binary) return [];
  const entries: MenuEntry[] = [{ heading: "用其他编码重新打开" }];
  for (const e of ENCODINGS.filter((e) => !e.bom || e.encoding !== "UTF-8")) {
    entries.push({
      label: e.label,
      disabled: !tab.path,
      checked: tab.encoding.toLowerCase() === e.encoding.toLowerCase(),
      run: () => reopenWithEncoding(tab, e.encoding),
    });
  }
  entries.push("-", { heading: "以其他编码保存" });
  for (const e of ENCODINGS) {
    entries.push({
      label: e.label,
      disabled: locked(tab),
      checked: tab.encoding.toLowerCase() === e.encoding.toLowerCase() && tab.bom === e.bom,
      run: () => saveWithEncoding(tab, e.encoding, e.bom),
    });
  }
  return entries;
}

encodingEl.addEventListener("click", () => showMenu(encodingEl, encodingMenu()));

/** Read the file again, decoding it as `encoding` (detection guessed wrong). */
async function reopenWithEncoding(tab: Tab, encoding: string) {
  if (!tab.path || tab.format.binary) return;
  await autosave(tab);
  if (tab.dirty && !(await host.ask(`用 ${encoding} 重新打开“${tabName(tab)}”？`, "未保存的修改会丢失。", "重新打开"))) {
    return;
  }
  let data: FileData;
  try {
    data = await host.readFile(tab.path, { encoding, force: tab.readOnly });
  } catch (err) {
    return host.alert("无法重新打开", `${tab.path}\n\n${err}`);
  }
  if (tab !== doc) activate(tab);
  clearTimeout(tab.autosaveTimer);
  // A fresh editor state: undo must not lead back to the text of the other decoding.
  view.setState(makeState(data.content, tab.format, tab.wrap, tab.readOnly || data.lossy));
  takeFileData(tab, data);
  tab.saved = view.state.doc;
  tab.dirty = tab.failed = tab.unmappable = false;
  refreshChrome();
  updatePos();
  scheduleCount();
  buildOutline();
  previewStale = true;
  if (mode !== "write") renderPreview();
  noteLossy(tab);
}

/** Say why a tab opened read-only when its bytes did not fit the encoding. */
function noteLossy(tab: Tab) {
  if (!tab.lossy) return;
  toast(`有些内容不是有效的 ${encodingName(tab.encoding, tab.bom)}，已设为只读。请换一种编码重新打开`, 5000);
}

/** Write the file in another encoding from now on. */
async function saveWithEncoding(tab: Tab, encoding: string, bom: boolean) {
  if (tab.format.binary || tab.lossy) return;
  const before = [tab.encoding, tab.bom] as const;
  tab.encoding = encoding;
  tab.bom = bom;
  tab.guessed = false;
  if (!tab.path) return refreshChrome(); // used when the draft is saved as a file
  try {
    tab.mtime = (await writeTo(tab, tab.path)).mtime;
    tab.unmappable = false;
    toast(`已用 ${encodingName(encoding, bom)} 保存`);
  } catch (err) {
    [tab.encoding, tab.bom] = before;
    const why = err instanceof UnmappableError ? `有字符无法用 ${encodingName(encoding, bom)} 表示。` : String(err);
    await host.alert("无法改用这个编码", why);
  } finally {
    refreshChrome();
  }
}

function toggleWrap() {
  if (doc.format.binary) return;
  doc.wrap = !doc.wrap;
  view.dispatch({ effects: wrapSlot.reconfigure(wrapExtension(doc.wrap)) });
  anchorsMeasured = false;
}

// ---------- tab switching ----------

/** Remember where the on-screen tab was, before another one takes the view. */
function stashActive() {
  doc.state = view.state;
  doc.editorScroll = view.scrollSnapshot();
  doc.previewTop = previewScroll.scrollTop;
}

/** Bring the preview, status bar and focus in line with the active tab. */
function showDocument() {
  closeMenu();
  if (previewFormat) renderers.get(previewFormat.id)?.reset?.();
  previewFormat = null; // a fresh document: start the preview from scratch
  applyMode(initialMode(doc));
  previewStale = true;
  if (mode !== "write") renderPreview();
  previewScroll.scrollTop = doc.previewTop;
  refreshChrome();
  updatePos();
  updateCount();
  if (!doc.started) return;
  if (mode === "read") focusPreview();
  else view.focus();
}

function activate(tab: Tab) {
  // A tab in the other column: go there.
  const pane = paneHolding(tab);
  if (!pane) return;
  focusPane(pane);
  if (tab === doc) return;
  const previous = doc;
  stashActive();
  doc = tab;
  view.setState(tab.state);
  if (tab.editorScroll) view.dispatch({ effects: tab.editorScroll });
  showDocument();
  autosave(previous);
  checkDisk();
}

function cycleTab(step: number) {
  if (tabs.length < 2) return;
  activate(tabs[(tabs.indexOf(doc) + step + tabs.length) % tabs.length]);
}

/** A new untitled tab at the end, every time (on the launch screen: start writing there). */
function newTab() {
  if (!doc.started) return startNew();
  const tab = createTab();
  tabs.push(tab);
  activate(tab);
}

function startNew() {
  doc.started = true;
  refreshChrome();
  if (mode === "read") setMode("write");
  view.focus();
}

/** Close a tab, asking first if its content would otherwise be lost. */
async function closeTab(tab = doc): Promise<boolean> {
  await autosave(tab);
  if (!tab.path && textOf(tab).length > 0) {
    activate(tab);
    const choice = await host.confirmDraft(tabName(tab));
    if (choice === "cancel" || (choice === "save" && !(await save()))) return false;
    if (choice === "discard" && tab.draft) await host.deleteDraft(tab.draft).catch(() => {});
  } else if (tab.dirty || needsAttention(tab)) {
    activate(tab);
    const choice = await host.confirmDiscard(tabName(tab));
    if (choice === "cancel" || (choice === "save" && !(await save()))) return false;
  }

  clearTimeout(tab.autosaveTimer);
  const pane = paneHolding(tab);
  if (!pane) return true;
  focusPane(pane);
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (!tabs.length && isSplit()) {
    // A column with nothing left in it closes: the other one takes the window.
    unsplit(panes.find((p) => p !== pane));
    return true;
  }
  // Last tab gone: the window stays and shows the start screen (⇧⌘W closes it).
  if (!tabs.length) tabs.push(createTab("", false));
  if (tab === doc || !tabs.includes(doc)) {
    doc = tabs[Math.min(i, tabs.length - 1)];
    view.setState(doc.state);
    if (doc.editorScroll) view.dispatch({ effects: doc.editorScroll });
    showDocument();
  } else {
    refreshChrome();
  }
  return true;
}

// ---------- two columns ----------

const COLUMN_MIN_PX = 240;
let columnDivider: HTMLElement | null = null;

/**
 * Move a tab to the other column, opening it (to the right) if the window has
 * one column so far. Both columns then show their documents in Read view.
 */
function moveAcross(tab: Tab) {
  const from = paneHolding(tab);
  if (!from) return;
  focusPane(from);
  if (tabs.length < 2) {
    // The column would be left empty: with two, that is going back to one.
    if (isSplit()) {
      activate(tab);
      unsplit(from);
    }
    return;
  }
  // The neighbour takes this column's view (which also stores the tab's editor state).
  if (tab === doc) activate(tabs[tabs.indexOf(tab) + 1] ?? tabs[tabs.indexOf(tab) - 1]);
  tabs.splice(tabs.indexOf(tab), 1);

  let to = panes.find((p) => p !== from);
  if (to) {
    refreshChrome();
    focusPane(to);
    tabs.push(tab);
    activate(tab);
    return;
  }
  to = createPane([tab], tab);
  columnDivider = makeColumnDivider();
  panesEl.append(columnDivider, to.el);
  wiring.forEach((wire) => wire(to));
  panes.push(to);
  app.classList.add("is-split");
  // What stays on the left starts over in Read view, as a column does.
  showDocument();
  focusPane(to);
  if (tab.editorScroll) view.dispatch({ effects: tab.editorScroll });
  showDocument();
}

/** Back to one column holding every tab; `keep`'s document stays on screen. */
function unsplit(keep: Pane = focused) {
  if (!isSplit()) return;
  const [first, second] = panes;
  const shown = docOf(keep);
  for (const p of panes) inPane(p, stashActive);
  const merged = [...tabsOf(first), ...tabsOf(second)];

  switchTo(first);
  focused = first;
  clearTimeout(second.previewTimer);
  clearTimeout(second.syncTimer);
  for (const r of second.renderers.values()) r.reset?.();
  second.view.destroy();
  second.el.remove();
  columnDivider?.remove();
  columnDivider = null;
  panes.length = 1;
  app.classList.remove("is-split");
  first.el.classList.remove("focused");
  panesEl.style.removeProperty("--cols");

  tabs = merged;
  for (const t of tabs) t.columnMode = null;
  doc = shown;
  view.setState(doc.state);
  if (doc.editorScroll) view.dispatch({ effects: doc.editorScroll });
  showDocument();
}

/** The line between the columns: drag to resize, double-click for half and half. */
function makeColumnDivider(): HTMLElement {
  const el = document.createElement("div");
  el.className = "split-divider col-divider";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.setAttribute("aria-label", "调整两栏的宽度");
  el.title = "拖动调整宽度，双击恢复对半";
  const set = (ratio: number) => {
    panesEl.style.setProperty("--cols", String(ratio));
    eachPane(() => {
      anchorsMeasured = false;
      view.requestMeasure();
    });
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    app.classList.add("is-resizing");
    const box = panesEl.getBoundingClientRect();
    const min = Math.min(0.5, COLUMN_MIN_PX / Math.max(1, box.width));
    const move = (ev: PointerEvent) => set(Math.min(1 - min, Math.max(min, (ev.clientX - box.left) / box.width)));
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      app.classList.remove("is-resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  });
  el.addEventListener("dblclick", () => set(0.5));
  return el;
}

/** Right-click on a tab. */
function tabMenu(tab: Tab): MenuEntry[] {
  const from = paneHolding(tab);
  const alone = !!from && tabsOf(from).length < 2;
  const entries: MenuEntry[] = [];
  if (!isSplit()) {
    entries.push({ label: "在右侧分栏显示", disabled: alone, hint: alone ? "需要两个标签页" : undefined, run: () => moveAcross(tab) });
  } else {
    entries.push(
      { label: from === panes[0] ? "移到右栏" : "移到左栏", run: () => moveAcross(tab) },
      { label: "合并为一栏", run: () => unsplit(from) },
    );
  }
  if (tab.path) {
    const path = tab.path;
    entries.push("-", { label: isMac ? "在访达中显示" : "在资源管理器中显示", run: () => host.reveal(path) });
  }
  entries.push("-", { label: "关闭标签页", run: () => closeTab(tab) });
  return entries;
}

// ---------- opening ----------

const tabFor = (path: string) => allTabs().find((t) => t.path === path || t.draft === path);
const inDrafts = (path: string) => !!draftsDir && dirname(path) === draftsDir;
const opening = new Set<string>();

/**
 * Open a file in a tab, or switch to the tab that already has it, here or in
 * another window (one file is edited in one place). New tabs go last.
 */
async function openPath(path: string) {
  const open = tabFor(path);
  if (open) return activate(open);
  if (opening.has(path)) return;
  if (await host.focusIfOpen(path)) return;
  opening.add(path);
  try {
    let data: FileData;
    let readOnly = false;
    try {
      if (formatOf(path).binary) {
        // Checked and sized only: the viewer reads the bytes itself, nothing decodes them as text.
        const info = await host.openBinary(path);
        data = { path: info.path, content: "", mtime: info.mtime, encoding: "UTF-8", bom: false, guessed: false, lossy: false, size: info.size };
        readOnly = true;
      } else try {
        data = await host.readFile(path);
      } catch (err) {
        if (!(err instanceof TooLargeError)) throw err;
        if (!(await host.confirmLarge(basename(path), formatSize(err.size)))) return;
        data = await host.readFile(path, { force: true });
        readOnly = true;
      }
    } catch (err) {
      forgetRecent(path);
      await host.alert("无法打开文件", `${path}\n\n${err}`);
      return;
    }
    const again = tabFor(data.path);
    if (again) return activate(again);

    const draft = inDrafts(data.path);
    const format = formatOf(data.path);
    await loadLanguage(format);
    const state = makeState(data.content, format, true, readOnly || data.lossy);
    const fill = (tab: Tab) => {
      tab.path = draft ? null : data.path;
      tab.draft = draft ? data.path : null;
      tab.state = state;
      tab.saved = state.doc;
      tab.started = true;
      tab.missing = tab.dirty = tab.failed = false;
      tab.editorScroll = null;
      tab.previewTop = 0;
      tab.split = 0.5;
      tab.columnMode = null;
      tab.format = format;
      tab.wrap = true;
      takeFileData(tab, data);
      tab.readOnly = readOnly;
      tab.unmappable = false;
      tab.viewerStatus = ["", ""];
    };

    if (isPristine()) {
      fill(doc);
      view.setState(state);
      showDocument();
    } else {
      const tab = createTab();
      fill(tab);
      tabs.push(tab);
      activate(tab);
    }
    if (!draft) rememberRecent(data.path);
    noteLossy(doc);
  } finally {
    opening.delete(path);
  }
}

/** Encoding and size facts that come with a read. */
function takeFileData(tab: Tab, data: FileData) {
  tab.mtime = data.mtime;
  tab.eol = eolOf(data.content);
  tab.encoding = data.encoding;
  tab.bom = data.bom;
  tab.guessed = data.guessed;
  tab.lossy = data.lossy;
  tab.size = data.size;
  // A viewer (PDF) pages through big files on its own.
  tab.large = data.size >= LARGE_FILE && !tab.format.binary;
  tab.previewWanted = false;
}

/** Dialog filters: every supported format first (the default), then each one. */
function dialogFilters(first?: FormatPlugin): DialogFilter[] {
  // Saving (`first` given) never offers a binary format: text is not written as one.
  const formats = [...allFormats()].filter((f) => !first || !f.binary).sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  const each: DialogFilter[] = [];
  for (const f of formats) {
    const name = f.group ?? f.label;
    const same = f.group ? each.find((e) => e.name === name) : undefined;
    if (same) same.extensions.push(...f.extensions);
    else each.push({ name, extensions: [...f.extensions] });
  }
  if (first) return each;
  return [{ name: "所有支持的文件", extensions: formats.flatMap((f) => f.extensions) }, ...each];
}

async function openViaDialog() {
  // macOS has one panel for files and folders. Elsewhere the dialog picks files
  // only (Open Folder picks folders), with every format's extensions as filters.
  if (isMac && inTauri) {
    const path = await host.pickFileOrFolder();
    if (!path) return;
    const info = await host.statPath(path).catch(() => null);
    return info?.dir ? openPickedFolder(info.path) : openPickedFile(path);
  }
  const path = await host.pickFile([...dialogFilters(), { name: "所有文件", extensions: ["*"] }]);
  if (path) await openPickedFile(path);
}

async function openPickedFile(path: string) {
  // A window showing a folder keeps to it: other files get a window of their own.
  if (folder && inTauri) await host.openInNewWindow(path);
  else await openPath(path);
}

// ---------- folder sidebar ----------

/** The folder shown in the sidebar (canonical path), if any. */
let folder: string | null = null;

const tree = new FolderTree($("sb-tree"), {
  list: (path, showHidden) => host.listDir(path, showHidden),
  openFile: (path) => openPath(path),
});

const SIDEBAR_WIDTH = 240;
const clampSidebar = (px: number) => Math.round(Math.max(160, Math.min(px, 600, window.innerWidth - 320)));

function applySidebarWidth(px: number) {
  app.style.setProperty("--sidebar-w", `${clampSidebar(px)}px`);
}

/** Show a folder in the sidebar. Quiet: the folder came from settings, not the user. */
async function openFolder(path: string, quiet = false): Promise<boolean> {
  const info = await host.statPath(path).catch(() => null);
  if (!info?.dir) {
    if (!quiet) await host.alert("无法打开文件夹", `${path}\n\n${info ? "这不是文件夹" : "文件夹不存在"}`);
    return false;
  }
  try {
    await tree.open(info.path);
  } catch (err) {
    if (!quiet) await host.alert("无法打开文件夹", `${info.path}\n\n${err}`);
    return false;
  }
  folder = info.path;
  sbNameEl.textContent = basename(folder);
  sbNameEl.title = tildify(folder);
  app.classList.add("has-folder");
  setSidebarHidden(false);
  // In the app the backend remembers every window's folder (via syncBackend).
  if (!inTauri) prefs.set("folder", folder);
  refreshChrome();
  tree.setActive(doc.path);
  // On the launch screen the tree is the natural next stop.
  if (!doc.started) tree.focus();
  return true;
}

function closeFolder() {
  if (!folder) return;
  if (!inTauri) prefs.set("folder", null);
  folder = null;
  tree.close();
  app.classList.remove("has-folder");
  refreshChrome();
  if (doc.started && mode !== "read") view.focus();
}

async function openFolderViaDialog() {
  const path = await host.pickFolder();
  if (path) await openPickedFolder(path);
}

async function openPickedFolder(path: string) {
  // Each window keeps its folder: another one opens in a new window.
  if (folder && inTauri) await host.openInNewWindow(path);
  else await openFolder(path);
}

function setSidebarHidden(hidden: boolean, remember = false) {
  app.classList.toggle("sidebar-hidden", hidden);
  sidebarBtn.setAttribute("aria-expanded", String(!hidden));
  sidebarBtn.title = hidden ? "显示边栏" : "隐藏边栏";
  if (remember) prefs.set("sidebarHidden", hidden);
}

function toggleSidebar() {
  if (!folder) return toast("没有打开的文件夹");
  const hide = !app.classList.contains("sidebar-hidden");
  setSidebarHidden(hide, true);
  if (!hide) tree.focus();
  else if (doc.started && mode !== "read") view.focus();
}

function folderMenu(): MenuEntry[] {
  return [
    { label: "刷新", run: () => tree.refresh() },
    {
      label: "显示隐藏文件",
      checked: tree.showHidden,
      run: () => {
        tree.setShowHidden(!tree.showHidden);
        prefs.set("showHidden", tree.showHidden);
      },
    },
    { label: isMac ? "在访达中显示" : "在资源管理器中显示", run: () => folder && host.reveal(folder) },
    "-",
    { label: "关闭文件夹", run: closeFolder },
  ];
}

let folderMenuState: boolean | null = null;
/** Keep the native menu's folder items in step with this window. */
function syncFolderMenu() {
  if (!document.hasFocus() && folderMenuState !== null) return;
  if (folderMenuState === !!folder) return;
  folderMenuState = !!folder;
  host.setFolderMenu(folderMenuState);
}

sbMoreEl.addEventListener("click", () => showMenu(sbMoreEl, folderMenu()));
$("sb-close").addEventListener("click", closeFolder);
sidebarBtn.addEventListener("click", toggleSidebar);

// Drag the right edge to resize; double-click for the default width.
const resizer = $("sb-resizer");
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarEl.getBoundingClientRect().width;
  let width = startW;
  resizer.setPointerCapture(e.pointerId);
  sidebarEl.classList.add("resizing");
  app.classList.add("resizing-sidebar");
  const move = (ev: PointerEvent) => {
    width = clampSidebar(startW + ev.clientX - startX);
    applySidebarWidth(width);
  };
  const end = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", end);
    resizer.removeEventListener("pointercancel", end);
    sidebarEl.classList.remove("resizing");
    app.classList.remove("resizing-sidebar");
    if (width !== startW) prefs.set("sidebarWidth", width);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", end);
  resizer.addEventListener("pointercancel", end);
});
resizer.addEventListener("dblclick", () => {
  applySidebarWidth(SIDEBAR_WIDTH);
  prefs.set("sidebarWidth", SIDEBAR_WIDTH);
});

// Split view needs room for two panes: judge by the area beside the sidebar,
// which is the whole window when there is none (760px, as before folders).
// Beside the sidebar, panes may be a little narrower, so that the default
// 920px window with a 240px sidebar still splits.
// Each column is judged by its own width.
wiring.push((pane) => {
  const observer = new ResizeObserver(([entry]) => {
    if (!panes.includes(pane)) return observer.disconnect();
    inPane(pane, () => {
      const sidebar = app.classList.contains("has-folder") && !app.classList.contains("sidebar-hidden");
      const narrow = entry.contentRect.width < (sidebar || isSplit() ? 640 : 760);
      colEl.classList.toggle("narrow", narrow);
      if (cur === focused) app.classList.toggle("narrow", narrow);
      colEl.classList.toggle("outline-cramped", entry.contentRect.width < OUTLINE_ROOM);
      anchorsMeasured = false;
      syncOutline();
    });
  });
  observer.observe(pane.el);
});

/**
 * A path dropped on the window: files open here as tabs; a folder goes to
 * this window's sidebar, or to a new window if this one already shows another.
 */
async function openAny(path: string) {
  const info = await host.statPath(path).catch(() => null);
  if (!info?.dir) return openPath(path);
  if (folder && inTauri && info.path !== folder) await host.openInNewWindow(info.path);
  else await openFolder(info.path);
}

// ---------- saving ----------

/** Run writes for one tab strictly one after another. */
function serial<T>(tab: Tab, job: () => Promise<T>): Promise<T> {
  tab.busy++;
  const run = tab.queue.then(job);
  tab.queue = run.catch(() => {});
  return run.finally(() => tab.busy--);
}

/** Write the tab's current text to `target`; marks what was written as saved. */
async function writeNow(tab: Tab, target: string) {
  // Last line of defence: a binary file's tab has no text worth writing over it.
  if (tab.format.binary) throw new Error(`${basename(tab.path ?? target)} 是只读的`);
  if (formatFor(target).binary) throw new Error(`不能把文本保存为${formatFor(target).label}：${basename(target)}`);
  // What could not be decoded would be written back as U+FFFD: never over the file itself.
  if (tab.lossy && target === tab.path) throw new Error(`${basename(target)} 没有按正确的编码打开，保存会损坏它。请先换一种编码重新打开`);
  const snapshot = textOf(tab);
  try {
    const written = await host.writeFile(target, snapshot.sliceString(0, snapshot.length, tab.eol), tab.encoding, tab.bom);
    tab.saved = snapshot;
    tab.failed = false;
    tab.dirty = !textOf(tab).eq(snapshot);
    return written;
  } catch (err) {
    if (err instanceof UnmappableError) tab.unmappable = true;
    else tab.failed = true;
    throw err;
  } finally {
    refreshChrome();
  }
}

const writeTo = (tab: Tab, target: string) => serial(tab, () => writeNow(tab, target));

function scheduleAutosave(tab: Tab) {
  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = window.setTimeout(() => autosave(tab), AUTOSAVE_DELAY);
}

function newDraftPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${draftsDir}${sepOf(draftsDir)}${stamp}-${rand}.md`;
}

/**
 * Persist pending edits: files go to their own path, untitled documents to
 * the staging area. Returns whether the tab is now fully persisted.
 */
async function autosave(tab: Tab): Promise<boolean> {
  clearTimeout(tab.autosaveTimer);
  if (!tab.dirty || locked(tab)) return true;
  try {
    if (tab.path) {
      // Never resurrect a deleted file or overwrite someone else's edits
      // silently; checkDisk asks the user about those. The check runs in the
      // write queue so it sees the mtime of our own previous write.
      if (tab.missing) return false;
      const path = tab.path;
      const conflict = await serial(tab, async () => {
        const onDisk = await host.fileMtime(path);
        if (onDisk === null || (tab.mtime !== null && onDisk !== tab.mtime)) return true;
        tab.mtime = (await writeNow(tab, path)).mtime;
        return false;
      });
      if (conflict) {
        if (tab === doc) checkDisk();
        return false;
      }
    } else if (textOf(tab).length === 0) {
      // Nothing worth keeping.
      if (tab.draft) await host.deleteDraft(tab.draft).catch(() => {});
      tab.draft = null;
      tab.saved = textOf(tab);
      tab.dirty = false;
    } else {
      tab.draft ??= newDraftPath();
      await writeTo(tab, tab.draft);
    }
    tab.unmappable = false;
    return !tab.dirty;
  } catch (err) {
    if (err instanceof UnmappableError) offerUtf8(tab);
    return false;
  } finally {
    refreshChrome();
  }
}

/** Auto-save hit characters the encoding lacks: ask once, then hold off quietly. */
const offeredUtf8 = new WeakSet<Tab>();
async function offerUtf8(tab: Tab) {
  if (offeredUtf8.has(tab)) return;
  offeredUtf8.add(tab);
  if ((await host.confirmUnmappable(tabName(tab), encodingName(tab.encoding, tab.bom))) === "utf8") {
    tab.encoding = "UTF-8";
    tab.bom = false;
    tab.guessed = false;
    tab.unmappable = false;
    autosave(tab);
  }
}

function suggestName(tab: Tab) {
  const name = tabName(tab).replace(/[\\/:*?"<>|#…]+/g, " ").trim().slice(0, 60);
  return `${name || "未命名"}.${tab.format.extensions[0] ?? "txt"}`;
}

/** Explicit save (⌘S / ⇧⌘S). A draft becomes a real file and leaves staging. */
async function save(as = false): Promise<boolean> {
  const tab = doc;
  if (tab.format.binary) {
    toast("这个文件只能查看，不能保存");
    return false;
  }
  const before = tab.path ?? tab.draft ?? "";
  clearTimeout(tab.autosaveTimer);
  let target = tab.path;
  if (!target || as) {
    // As when opening: macOS would only allow the listed extensions, so a file of
    // an unlisted kind (.conf, .env, …) could not keep its own name there.
    target = await host.pickSavePath(tab.path ?? suggestName(tab), isMac ? [] : dialogFilters(tab.format));
    if (!target) return false;
    const kind = formatFor(target);
    if (kind.binary) {
      await host.alert("无法保存", `edit2 不会把文本写成${kind.label}：${basename(target)}`);
      return false;
    }
  }
  let written;
  try {
    written = await writeTo(tab, target);
  } catch (err) {
    if (!(err instanceof UnmappableError)) {
      await host.alert("保存失败", `${target}\n\n${err}`);
      return false;
    }
    if ((await host.confirmUnmappable(tabName(tab), encodingName(tab.encoding, tab.bom))) === "keep") return false;
    tab.encoding = "UTF-8";
    tab.bom = false;
    tab.unmappable = false;
    return save(as);
  }
  const renamed = written.path !== tab.path;
  const draft = tab.draft;
  tab.path = written.path;
  tab.mtime = written.mtime;
  tab.draft = null;
  tab.started = true;
  tab.missing = false;
  if (tab.lossy) {
    // Saved elsewhere as the text shown: that file is exactly this text.
    tab.lossy = false;
    applyReadOnly(tab);
  }
  if (draft) await host.deleteDraft(draft).catch(() => {});
  rememberRecent(written.path);
  refreshChrome();
  if (renamed) {
    toast(`已保存为 ${basename(written.path)}`);
    // A new name may mean another format; otherwise relative paths may now resolve.
    const format = formatFor(written.path) === formatFor(before) ? tab.format : formatOf(written.path);
    if (format !== tab.format) setFormat(tab, format);
    else if (tab === doc && mode !== "write") renderPreview();
  }
  return true;
}

let checking = false;
/** Pick up edits made to the active tab's file by other programs. */
async function checkDisk() {
  const tab = doc;
  // While a write is in flight, the file on disk is changing because of us.
  if (!tab.path || checking || tab.busy) return;
  checking = true;
  try {
    const path = tab.path;
    const mtime = await host.fileMtime(path);
    if (doc !== tab) return;
    if (mtime === null) {
      if (!tab.missing) {
        tab.missing = true;
        refreshChrome();
      }
      return;
    }
    if (mtime === tab.mtime && !tab.missing) return;
    if (tab.missing) {
      tab.missing = false;
      refreshChrome();
    }
    if (tab.path !== path || tab.busy) return;
    if (tab.format.binary) {
      // Nothing is edited here: just show the new version.
      const info = await host.openBinary(path);
      if (doc !== tab || tab.path !== path) return;
      tab.mtime = info.mtime;
      tab.size = info.size;
      refreshChrome();
      if (mode !== "write") renderPreview();
      return;
    }
    if (tab.dirty && !(await host.confirmReload(tabName(tab)))) {
      // Keep mine: the next auto-save writes over the other version.
      tab.mtime = mtime;
      scheduleAutosave(tab);
      refreshChrome();
      return;
    }
    const before = view.state.doc;
    const data = await rereadFile(tab, path);
    // Give up if anything moved meanwhile: another tab, a write, or typing
    // (the next check will then ask instead of overwriting).
    if (doc !== tab || tab.path !== path || tab.busy || !view.state.doc.eq(before)) return;
    clearTimeout(tab.autosaveTimer);
    replaceContent(data.content);
    // The other program may have changed the line breaks, the encoding or the BOM too.
    takeFileData(tab, data);
    applyReadOnly(tab);
    tab.saved = view.state.doc;
    tab.dirty = tab.failed = tab.unmappable = false;
    refreshChrome();
    if (mode !== "write") renderPreview();
    noteLossy(tab);
  } catch {
    /* transient I/O error; try again next time */
  } finally {
    checking = false;
  }
}

/**
 * Read a file that changed on disk. It keeps the tab's encoding (which the
 * user may have picked by hand) unless the file has plainly become another
 * one: it now has a BOM or is valid non-ASCII UTF-8, or no longer decodes.
 */
async function rereadFile(tab: Tab, path: string): Promise<FileData> {
  const force = tab.readOnly;
  const detected = await host.readFile(path, { force }).catch(() => null);
  if (detected) {
    if (detected.encoding.toLowerCase() === tab.encoding.toLowerCase()) return detected;
    const certain =
      !detected.lossy &&
      !detected.guessed &&
      (detected.bom || (detected.encoding === "UTF-8" && /[^\x00-\x7f]/.test(detected.content)));
    if (certain) return detected;
  }
  const kept = await host.readFile(path, { encoding: tab.encoding, force });
  return kept.lossy && detected && !detected.lossy ? detected : kept;
}

/** Replace the editor text, changing only the span that differs so the cursor and scroll stay put. */
function replaceContent(next: string, extra: Omit<TransactionSpec, "changes"> = {}) {
  const current = view.state.doc.toString();
  if (next === current) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < current.length - start && end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) end++;
  view.dispatch({
    changes: { from: start, to: current.length - end, insert: next.slice(start, next.length - end) },
    ...extra,
  });
}

/**
 * Window is closing: flush every tab. Drafts stay staged (and come back next
 * launch); only content that could not be persisted needs a decision.
 */
async function prepareToClose(): Promise<boolean> {
  await Promise.all(allTabs().map(autosave));
  for (const tab of allTabs()) {
    if (!tab.dirty && !needsAttention(tab)) continue;
    activate(tab);
    const choice = tab.path ? await host.confirmDiscard(tabName(tab)) : await host.confirmDraft(tabName(tab));
    if (choice === "cancel" || (choice === "save" && !(await save()))) return false;
  }
  return true;
}

// ---------- commands ----------

const commands: Record<string, () => unknown> = {
  new: newTab,
  new_tab: newTab,
  open: openViaDialog,
  open_folder: openFolderViaDialog,
  close_folder: closeFolder,
  toggle_sidebar: toggleSidebar,
  save: () => doc.started && save(false),
  save_as: () => doc.started && save(true),
  reveal: () => doc.path && host.reveal(doc.path),
  close: () => closeTab(),
  close_window: () => host.window?.close(),
  next_tab: () => cycleTab(1),
  prev_tab: () => cycleTab(-1),
  quit: () => host.quit(),
  undo: () => mode !== "read" && undo(view),
  redo: () => mode !== "read" && redo(view),
  find: () => {
    if (!doc.started) return;
    if (doc.format.binary) return toast(`${doc.format.label}暂不支持查找`);
    if (mode === "read") setMode("write");
    openSearchPanel(view);
  },
  mode_write: () => setMode("write"),
  mode_split: () => setMode("split"),
  mode_read: () => setMode("read"),
  toggle_preview: () => setMode(mode === "write" ? "split" : "write"),
  zoom_in: () => zoom(1),
  zoom_out: () => zoom(-1),
  zoom_reset: () => zoom(0),
  toggle_wrap: () => doc.started && toggleWrap(),
  toggle_outline: toggleOutline,
  format_doc: () => runFormatter("format"),
  minify_doc: () => runFormatter("minify"),
};

// On macOS the native menu owns these shortcuts; elsewhere we handle them here.
const handleShortcutsInPage = !(isMac && inTauri);

window.addEventListener(
  "keydown",
  (e) => {
    // ⌃Tab / ⌃⇧Tab switch tabs everywhere (no menu item carries them).
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (handleShortcutsInPage && e.altKey && !mod && !e.shiftKey && e.code === "KeyZ") {
      e.preventDefault();
      commands.toggle_wrap();
      return;
    }
    if (handleShortcutsInPage && e.altKey && e.shiftKey && !mod && e.code === "KeyF") {
      e.preventDefault();
      commands.format_doc();
      return;
    }
    if (mod && handleShortcutsInPage && !e.altKey) {
      const k = e.key.toLowerCase();
      const id = e.shiftKey
        ? ({ s: "save_as", r: "reveal", w: "close_window", o: "open_folder", e: "toggle_sidebar", d: "toggle_outline" } as Record<string, string>)[k] ??
          ({ BracketLeft: "prev_tab", BracketRight: "next_tab" } as Record<string, string>)[e.code]
        : ({
            n: "new", t: "new_tab", o: "open", s: "save", w: "close", q: "quit",
            "1": "mode_write", "2": "mode_split", "3": "mode_read", "\\": "toggle_preview",
            "=": "zoom_in", "+": "zoom_in", "-": "zoom_out", "0": "zoom_reset",
          } as Record<string, string>)[k];
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        commands[id]();
        return;
      }
    }
    // On the launch screen, typing anything starts a new document (not while
    // moving around the folder tree).
    if (
      !doc.started &&
      !sidebarEl.contains(e.target as Node) &&
      !mod && !e.ctrlKey && !e.altKey &&
      e.key.length === 1 &&
      !(e.target instanceof HTMLButtonElement && e.key === " ")
    ) {
      startNew();
    }
  },
  true,
);

// ---------- wiring ----------

for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
$("btn-new").addEventListener("click", startNew);
$("btn-open").addEventListener("click", openViaDialog);
$("btn-open-folder").addEventListener("click", openFolderViaDialog);
for (const k of document.querySelectorAll<HTMLElement>("kbd[data-key]")) {
  k.textContent = isMac ? `⌘${k.dataset.key}` : `Ctrl+${k.dataset.key}`;
}
wiring.forEach((wire) => wire(panes[0]));

window.addEventListener("focus", checkDisk);
// Pick up files added or removed while the window was in the background.
window.addEventListener("focus", () => tree.refresh());
// Leaving the window is a natural moment to have everything on disk.
window.addEventListener("blur", () => panes.forEach((p) => autosave(docOf(p))));
setInterval(() => document.hasFocus() && checkDisk(), 2500);

async function boot() {
  app.classList.add(isMac && inTauri ? "platform-mac" : "platform-other");
  await prefs.load();
  applyFont(prefs.get("fontSize", 15));
  applyMode(initialMode(doc));
  applySidebarWidth(prefs.get("sidebarWidth", SIDEBAR_WIDTH));
  setSidebarHidden(prefs.get("sidebarHidden", false));
  tree.showHidden = prefs.get("showHidden", false);
  renderRecent();
  refreshChrome();

  const win = host.window;
  if (win) {
    await host.listen<string>("menu", (id) => commands[id]?.());
    await host.listen<string>("open-path", (path) => openPath(path));
    await host.listen<string>("open-folder", (path) => openFolder(path));
    // Another window changed a preference.
    await host.listen<{ key: string; value: unknown }>("setting-changed", ({ key, value }) => {
      if (value === null) delete settings[key];
      else settings[key] = value;
      if (key === "recent") renderRecent();
      if (key === "outline") eachPane(syncOutline);
      if (key === "sidebarWidth" && typeof value === "number") applySidebarWidth(value);
    });

    await win.onCloseRequested(async (e) => {
      if (await prepareToClose()) return;
      e.preventDefault();
      // If this was part of quitting edit2, the quit is off.
      host.closeCancelled();
    });

    await win.onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") app.classList.add("is-dropping");
      else app.classList.remove("is-dropping");
      if (p.type === "drop") {
        for (const path of p.paths) await openAny(path);
      }
    });
  }

  // Listeners are live, so the backend may now route files to this window.
  const init = await host.initWindow();
  initialized = true;
  draftsDir = init.draftsDir;
  if (init.notice) toast(init.notice, 6000);
  // In a plain browser there is no backend to remember the folder: use the setting.
  const startFolder = inTauri ? init.folder : prefs.get<string | null>("folder", null);
  if (startFolder && !(await openFolder(startFolder, true)) && !inTauri) prefs.set("folder", null);
  for (const path of init.files) await openPath(path);
  await syncBackend(true);
  await win?.show();
  await win?.setFocus();
}

boot();

// Dev only, in a plain browser: open files from the console, e.g. edit2.open("/abs/path.json").
if (import.meta.env.DEV && !inTauri) Object.assign(window, { edit2: { open: openPath, openFolder, commands, get view() { return view; } } });

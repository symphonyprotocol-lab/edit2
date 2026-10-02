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
} from "./editor";
import { ENCODINGS, encodingName, formatSize, LARGE_FILE } from "./encodings";
import {
  allFormats,
  extensionOf,
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
} from "./formats";
import { host, inTauri, isMac, TooLargeError, UnmappableError, type DialogFilter, type FileData } from "./host";
import { TabBar } from "./tabs";
import { showMenu, closeMenu, type MenuEntry } from "./popup";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const editorEl = $("editor");
const previewScroll = $("preview-scroll");
const preview = $("preview");
const nameEl = $("doc-name");
const dirEl = $("doc-dir");
const posEl = $("st-pos");
const countEl = $("st-count");
const saveEl = $("st-save");
const formatEl = $("st-format");
const encodingEl = $("st-encoding");
const previewErrorEl = $("preview-error");
const toastEl = $("toast");

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

/** One open document. The window shows one tab at a time in a shared editor. */
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
  /** For a large file, the user asked for the preview / counts. */
  previewWanted: boolean;
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
  const id = path ? overrides()[path] : undefined;
  return (id && formatById(id)) || formatFor(path);
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
        for (const tab of tabs) if (tab.format === format) reconfigure(tab);
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

/** Bring a tab's editor in line with its format. */
function reconfigure(tab: Tab) {
  const effects = formatEffects(tab.format);
  if (tab === doc) view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
}

/** Show a tab as another format (status bar choice, or a renamed file). */
function setFormat(tab: Tab, format: FormatPlugin) {
  if (tab.format === format) return;
  tab.format = format;
  loadLanguage(format);
  reconfigure(tab);
  if (tab === doc) {
    applyMode(preferredMode(format));
    showDocument();
  }
}

function createTab(text = "", started = true, format = formatOf(null)): Tab {
  const state = makeState(text, format, true);
  return {
    id: nextTabId++,
    path: null,
    draft: null,
    mtime: null,
    saved: state.doc,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
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
    previewWanted: false,
  };
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

let tabs: Tab[] = [createTab("", false)];
/** The tab on screen. */
let doc: Tab = tabs[0];
const view = new EditorView({ parent: editorEl, state: doc.state });

/** Current text of a tab, whether it is on screen or not. */
const textOf = (tab: Tab) => (tab === doc ? view.state.doc : tab.state.doc);

function onUpdate(u: ViewUpdate) {
  if (u.docChanged) {
    if (!doc.started) doc.started = true;
    doc.dirty = !u.state.doc.eq(doc.saved);
    if (doc.dirty) scheduleAutosave(doc);
    refreshChrome();
    schedulePreview();
    scheduleCount();
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
/** Tell the backend what this window holds (for file routing and quit). */
function syncBackend(force = false): Promise<void> {
  const paths = tabs.map((t) => t.path ?? t.draft).filter((p): p is string => !!p);
  const unsaved = tabs.some((t) => t.dirty || needsAttention(t));
  const state = JSON.stringify([paths, unsaved]);
  if (!force && state === reported) return Promise.resolve();
  reported = state;
  return host.reportState(paths, unsaved);
}

const tabBar = new TabBar($("tab-list"), $("tab-new"), {
  activate: (id) => withTab(id, activate),
  close: (id) => withTab(id, closeTab),
  move: (id, to) =>
    withTab(id, (tab) => {
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(to, 0, tab);
      refreshChrome();
    }),
  create: () => newTab(),
});

function withTab(id: number, fn: (tab: Tab) => unknown) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) fn(tab);
}

function renderTabs() {
  // The strip (and its + button) is always there once a document is open.
  app.classList.toggle("has-tabs", doc.started);
  const names = tabs.map(tabName);
  tabBar.render(
    tabs.map((tab, i) => {
      // Two tabs called README.md: say which folder each one is in.
      const clash = tab.path && names.filter((n) => n === names[i]).length > 1;
      return {
        id: tab.id,
        name: clash ? `${names[i]} — ${basename(dirname(tab.path!))}` : names[i],
        title: tab.path ? tildify(tab.path) : "草稿（自动保存在暂存区）",
        unsaved: needsAttention(tab),
        draft: !tab.path,
      };
    }),
    doc.id,
  );
}

function refreshChrome() {
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
  if (doc.readOnly) {
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
  encodingEl.textContent = encodingName(doc.encoding, doc.bom) + (doc.guessed ? "?" : "");
  encodingEl.title = doc.guessed ? "编码是根据很少的内容推测的，乱码时可换一种编码重新打开" : "文件编码";
  app.classList.toggle("no-preview", !doc.format.preview);

  renderTabs();
  syncBackend();
}

function updatePos() {
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
  countEl.classList.toggle("clickable", doc.large && !doc.previewWanted);
  if (doc.large && !doc.previewWanted) {
    countEl.textContent = "大文件 · 点击统计";
    return;
  }
  const sel = view.state.selection.main;
  const picked = mode !== "read" && !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : null;
  const tab = doc;
  const seq = ++countSeq;
  const stats = tab.format.stats(view.state.doc.toString(), picked);
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
let anchors: { line: number; el: HTMLElement; top: number }[] = [];
/** Whether `anchors[].top` reflects the current layout. */
let anchorsMeasured = false;
/** Local files the backend has already been asked to expose. */
const allowedAssets = new Set<string>();
/** Loaded preview renderers, by format id. */
const renderers = new Map<string, PreviewRenderer>();
/** Format whose output the preview element currently holds. */
let previewFormat: FormatPlugin | null = null;
/** Bumped by every render; a render finishing late compares against it. */
let renderSeq = 0;

function schedulePreview() {
  previewStale = true;
  if (mode === "write") return;
  if (doc.large) return void showLargeNotice();
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, view.state.doc.length > 200_000 ? 400 : 90);
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
  view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
}

/** Per document, the token its page is published under for the script preview. */
const pageTokens = new Map<string, string>();

async function publishPage(tab: Tab, html: string): Promise<string | null> {
  if (!inTauri) return null;
  const key = tab.path ?? `tab-${tab.id}`;
  let token = pageTokens.get(key);
  if (!token) pageTokens.set(key, (token = crypto.randomUUID()));
  await host.servePreview(token, tab.path, html);
  const name = tab.path ? basename(tab.path) : "index.html";
  return `${host.previewOrigin}/${token}/${encodeURIComponent(name)}`;
}

function previewContext(seq: number, tab: Tab): PreviewContext {
  return {
    container: preview,
    path: tab.path,
    localPath,
    assetUrls,
    openLink,
    editSource(fn) {
      if (doc !== tab) return;
      const change = fn(view.state.doc);
      if (!change) return;
      view.dispatch({ changes: change, userEvent: "input" });
      renderPreview();
    },
    goToLine,
    revealLine,
    publishPage: (html) => publishPage(tab, html),
    layoutChanged: () => (anchorsMeasured = false),
    isCurrent: () => seq === renderSeq && doc === tab,
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

previewErrorEl.addEventListener("click", () => {
  if (previewErrorEl.dataset.action === "render") {
    doc.previewWanted = true;
    renderPreview().then(() => {
      // Later edits do not re-render on their own.
      if (doc.large) doc.previewWanted = false;
    });
    return;
  }
  const line = previewErrorEl.dataset.line;
  if (line) goToLine(Number(line));
});

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
}

function loadRenderer(format: FormatPlugin): PreviewRenderer | Promise<PreviewRenderer> {
  return (
    renderers.get(format.id) ??
    format.preview!().then((r) => {
      renderers.set(format.id, r);
      return r;
    })
  );
}

/** Large files: say the preview is paused and offer to render it. */
function showLargeNotice() {
  const empty = !preview.childElementCount;
  showPreviewError({
    message: empty
      ? `文件较大（${formatSize(doc.large ? textOf(doc).length : 0)}），预览已暂停。点击这里渲染预览。`
      : "大文件的预览不随编辑自动更新。点击这里刷新。",
  });
  previewErrorEl.dataset.action = "render";
}

async function renderPreview() {
  clearTimeout(previewTimer);
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

  try {
    let renderer = loadRenderer(format);
    if (renderer instanceof Promise) renderer = await renderer;
    if (seq !== renderSeq) return;
    let result = renderer.render(view.state.doc.toString(), previewContext(seq, tab));
    if (result instanceof Promise) result = await result;
    if (seq !== renderSeq) return;
    showPreviewError(result.error);
    // A failed parse leaves the last good output (and its anchors) on screen.
    if (result.anchors || !result.error) setAnchors(result.anchors ?? []);
  } catch (err) {
    if (seq === renderSeq) showPreviewError({ message: `预览失败：${err}` });
  }
}

// Previews follow the palette: redraw them when it flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const r of renderers.values()) r.themeChanged?.();
  previewStale = true;
  if (mode !== "write") renderPreview();
});

/** Read every anchor's offset in one layout pass instead of per scroll event. */
function measureAnchors() {
  if (anchorsMeasured) return;
  const base = previewScroll.getBoundingClientRect().top - previewScroll.scrollTop;
  for (const a of anchors) a.top = a.el.getBoundingClientRect().top - base;
  anchorsMeasured = true;
}

// Layout shifts (images arriving, resizing) invalidate the measured offsets.
preview.addEventListener("load", () => (anchorsMeasured = false), true);
window.addEventListener("resize", () => (anchorsMeasured = false));

preview.addEventListener("click", (e) => {
  const renderer = previewFormat && renderers.get(previewFormat.id);
  if (renderer?.click?.(e, previewContext(renderSeq, doc))) return;
  if (e.defaultPrevented) return;
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  openLink(a.getAttribute("href") ?? "");
});

// ---------- scroll sync (split mode) ----------

let syncSource: "editor" | "preview" | null = null;
let syncTimer = 0;
function claimSync(src: "editor" | "preview") {
  if (syncSource && syncSource !== src) return false;
  syncSource = src;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => (syncSource = null), 120);
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

view.scrollDOM.addEventListener("scroll", syncPreviewFromEditor, { passive: true });
previewScroll.addEventListener("scroll", syncEditorFromPreview, { passive: true });

// ---------- view modes & font size ----------

/** View last used for each format (format id → mode). */
const modePrefs = (): Record<string, Mode> => prefs.get("modes", {});

function preferredMode(format: FormatPlugin): Mode {
  if (!format.preview) return "write";
  // Markdown keeps the single view setting from before formats existed.
  const legacy = format.id === "markdown" ? prefs.get<Mode | null>("mode", null) : null;
  return modePrefs()[format.id] ?? legacy ?? format.defaultMode;
}

/** Switch the layout without remembering it as a preference. */
function applyMode(next: Mode) {
  if (!doc.format.preview) next = "write";
  mode = next;
  app.dataset.mode = next;
  anchorsMeasured = false;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === next));
    b.disabled = !doc.format.preview && b.dataset.mode !== "write";
  }
}

function setMode(next: Mode) {
  if (!doc.format.preview && next !== "write") {
    toast(`${doc.format.label}没有预览`);
    return;
  }
  const line = mode === "read" ? null : editorTopLine();
  applyMode(next);
  prefs.set("modes", { ...modePrefs(), [doc.format.id]: next });
  if (next !== "write" && previewStale) renderPreview();
  if (next !== "read") view.requestMeasure();
  updatePos();
  updateCount();
  if (next === "split" && line !== null) {
    requestAnimationFrame(() => {
      syncSource = null;
      syncPreviewFromEditor();
    });
  }
  if (doc.started) {
    if (next === "read") previewScroll.focus({ preventScroll: true });
    else view.focus();
  }
}

function applyFont(px: number) {
  fontSize = Math.min(26, Math.max(11, px));
  document.documentElement.style.setProperty("--fs", `${fontSize}px`);
  prefs.set("fontSize", fontSize);
  anchorsMeasured = false;
  view.requestMeasure();
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
  const entries: MenuEntry[] = [{ heading: "显示为" }];
  for (const format of allFormats()) {
    entries.push({
      label: format.label,
      checked: tab.format === format,
      run: () => {
        if (key) rememberOverride(key, format === byExtension && tab.path ? null : format);
        setFormat(tab, format);
      },
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
    { label: "格式化文档", hint: "⇧⌥F", disabled: !tab.format.canFormat || tab.readOnly, run: () => runFormatter("format") },
    { label: "压缩", disabled: !tab.format.canMinify || tab.readOnly, run: () => runFormatter("minify") },
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
  if (tab.readOnly) return toast("文件是只读的");

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
  out = out.replace(/\s+$/, "") + (text.endsWith("\n") ? "\n" : "");
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
  const state = `${!!doc.format.canFormat && !doc.readOnly}/${!!doc.format.canMinify && !doc.readOnly}`;
  if (state === formatMenuState) return;
  formatMenuState = state;
  host.setFormatMenu(state.startsWith("true"), state.endsWith("true"));
}
window.addEventListener("focus", () => {
  formatMenuState = "";
  syncFormatMenu();
});

formatEl.addEventListener("click", () => showMenu(formatEl, formatMenu()));

function encodingMenu(): MenuEntry[] {
  const tab = doc;
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
      disabled: tab.readOnly,
      checked: tab.encoding.toLowerCase() === e.encoding.toLowerCase() && tab.bom === e.bom,
      run: () => saveWithEncoding(tab, e.encoding, e.bom),
    });
  }
  return entries;
}

encodingEl.addEventListener("click", () => showMenu(encodingEl, encodingMenu()));

/** Read the file again, decoding it as `encoding` (detection guessed wrong). */
async function reopenWithEncoding(tab: Tab, encoding: string) {
  if (!tab.path) return;
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
  replaceContent(data.content);
  takeFileData(tab, data);
  tab.saved = view.state.doc;
  tab.dirty = tab.failed = tab.unmappable = false;
  refreshChrome();
  if (mode !== "write") renderPreview();
}

/** Write the file in another encoding from now on. */
async function saveWithEncoding(tab: Tab, encoding: string, bom: boolean) {
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
  applyMode(preferredMode(doc.format));
  previewStale = true;
  if (mode !== "write") renderPreview();
  previewScroll.scrollTop = doc.previewTop;
  refreshChrome();
  updatePos();
  updateCount();
  if (!doc.started) return;
  if (mode === "read") previewScroll.focus({ preventScroll: true });
  else view.focus();
}

function activate(tab: Tab) {
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
  const i = tabs.indexOf(tab);
  if (i < 0) return true;
  tabs.splice(i, 1);
  if (!tabs.length) {
    // Last tab gone: the window goes with it (nothing is left to ask about).
    if (host.window) {
      await syncBackend(true);
      await host.window.destroy();
      return true;
    }
    tabs = [createTab("", false)];
  }
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

// ---------- opening ----------

const tabFor = (path: string) => tabs.find((t) => t.path === path || t.draft === path);
const inDrafts = (path: string) => !!draftsDir && dirname(path) === draftsDir;
const opening = new Set<string>();

/** Open a file in a tab, or switch to the tab that already has it. New tabs go last. */
async function openPath(path: string) {
  const open = tabFor(path);
  if (open) return activate(open);
  if (opening.has(path)) return;
  opening.add(path);
  try {
    let data: FileData;
    let readOnly = false;
    try {
      try {
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
    const state = makeState(data.content, format, true, readOnly);
    const fill = (tab: Tab) => {
      tab.path = draft ? null : data.path;
      tab.draft = draft ? data.path : null;
      tab.state = state;
      tab.saved = state.doc;
      tab.started = true;
      tab.missing = tab.dirty = tab.failed = false;
      tab.editorScroll = null;
      tab.previewTop = 0;
      tab.format = format;
      tab.wrap = true;
      takeFileData(tab, data);
      tab.readOnly = readOnly;
      tab.unmappable = false;
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
  } finally {
    opening.delete(path);
  }
}

/** Encoding and size facts that come with a read. */
function takeFileData(tab: Tab, data: FileData) {
  tab.mtime = data.mtime;
  tab.eol = data.content.includes("\r\n") ? "\r\n" : "\n";
  tab.encoding = data.encoding;
  tab.bom = data.bom;
  tab.guessed = data.guessed;
  tab.large = data.size >= LARGE_FILE;
  tab.previewWanted = false;
}

/** Dialog filters: every supported format first (the default), then each one. */
function dialogFilters(first?: FormatPlugin): DialogFilter[] {
  const formats = [...allFormats()].sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
  const each = formats.map((f) => ({ name: f.label, extensions: f.extensions }));
  if (first) return each;
  return [{ name: "所有支持的文件", extensions: formats.flatMap((f) => f.extensions) }, ...each];
}

async function openViaDialog() {
  // macOS merges filters into one allow-list (no "all files" choice), which
  // would hide text files without a known extension: offer every file there.
  const path = await host.pickFile(isMac ? [] : [...dialogFilters(), { name: "所有文件", extensions: ["*"] }]);
  if (path) await openPath(path);
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
  if (!tab.dirty || tab.readOnly) return true;
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
  const before = tab.path ?? tab.draft ?? "";
  clearTimeout(tab.autosaveTimer);
  let target = tab.path;
  if (!target || as) {
    target = await host.pickSavePath(tab.path ?? suggestName(tab), dialogFilters(tab.format));
    if (!target) return false;
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
  if (draft) await host.deleteDraft(draft).catch(() => {});
  rememberRecent(written.path);
  refreshChrome();
  if (renamed) {
    toast(`已保存为 ${basename(written.path)}`);
    // A new extension may mean another format; otherwise relative paths may now resolve.
    const format = extensionOf(written.path) === extensionOf(before) ? tab.format : formatOf(written.path);
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
    if (tab.dirty && !(await host.confirmReload(tabName(tab)))) {
      // Keep mine: the next auto-save writes over the other version.
      tab.mtime = mtime;
      scheduleAutosave(tab);
      refreshChrome();
      return;
    }
    const before = view.state.doc;
    const data = await host.readFile(path, { encoding: tab.encoding, force: tab.readOnly });
    // Give up if anything moved meanwhile: another tab, a write, or typing
    // (the next check will then ask instead of overwriting).
    if (doc !== tab || tab.path !== path || tab.busy || !view.state.doc.eq(before)) return;
    clearTimeout(tab.autosaveTimer);
    replaceContent(data.content);
    tab.saved = view.state.doc;
    tab.mtime = data.mtime;
    tab.dirty = tab.failed = tab.unmappable = false;
    refreshChrome();
    if (mode !== "write") renderPreview();
  } catch {
    /* transient I/O error; try again next time */
  } finally {
    checking = false;
  }
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
  await Promise.all(tabs.map(autosave));
  for (const tab of [...tabs]) {
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
    if (mode === "read") setMode("write");
    openSearchPanel(view);
  },
  mode_write: () => setMode("write"),
  mode_split: () => setMode("split"),
  mode_read: () => setMode("read"),
  toggle_preview: () => setMode(mode === "write" ? "split" : "write"),
  zoom_in: () => applyFont(fontSize + 1),
  zoom_out: () => applyFont(fontSize - 1),
  zoom_reset: () => applyFont(15),
  toggle_wrap: () => doc.started && toggleWrap(),
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
        ? ({ s: "save_as", r: "reveal", w: "close_window" } as Record<string, string>)[k] ??
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
    // On the launch screen, typing anything starts a new document.
    if (
      !doc.started &&
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
for (const k of document.querySelectorAll<HTMLElement>("kbd[data-key]")) {
  k.textContent = isMac ? `⌘${k.dataset.key}` : `Ctrl+${k.dataset.key}`;
}
previewScroll.tabIndex = -1;

window.addEventListener("focus", checkDisk);
// Leaving the window is a natural moment to have everything on disk.
window.addEventListener("blur", () => autosave(doc));
setInterval(() => document.hasFocus() && checkDisk(), 2500);

async function boot() {
  app.classList.add(isMac && inTauri ? "platform-mac" : "platform-other");
  await prefs.load();
  applyFont(prefs.get("fontSize", 15));
  applyMode(preferredMode(doc.format));
  renderRecent();
  refreshChrome();

  const win = host.window;
  if (win) {
    await host.listen<string>("menu", (id) => commands[id]?.());
    await host.listen<string>("open-path", (path) => openPath(path));
    // Another window changed a preference.
    await host.listen<{ key: string; value: unknown }>("setting-changed", ({ key, value }) => {
      if (value === null) delete settings[key];
      else settings[key] = value;
      if (key === "recent") renderRecent();
    });

    await win.onCloseRequested(async (e) => {
      if (!(await prepareToClose())) e.preventDefault();
    });

    await win.onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") app.classList.add("is-dropping");
      else app.classList.remove("is-dropping");
      if (p.type === "drop") {
        for (const path of p.paths) await openPath(path);
      }
    });
  }

  // Listeners are live, so the backend may now route files to this window.
  const init = await host.initWindow();
  draftsDir = init.draftsDir;
  if (init.notice) toast(init.notice, 6000);
  for (const path of init.files) await openPath(path);
  await win?.show();
  await win?.setFocus();
}

boot();

// Dev only, in a plain browser: open files from the console, e.g. edit2.open("/abs/path.json").
if (import.meta.env.DEV && !inTauri) Object.assign(window, { edit2: { open: openPath, view, commands } });

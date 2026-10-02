import { EditorState, type StateEffect, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { editorExtensions } from "./editor";
import { renderMarkdown, countWords } from "./preview";
import { cachedDiagram, renderDiagram, onThemeChange } from "./mermaid";
import { host, inTauri, isMac } from "./host";
import { TabBar } from "./tabs";

type Mode = "write" | "split" | "read";

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
const toastEl = $("toast");

// ---------- persisted preferences ----------

const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`mdit.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`mdit.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
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
}

const AUTOSAVE_DELAY = 800;

let mode: Mode = prefs.get<Mode>("mode", "write");
let fontSize = prefs.get<number>("fontSize", 15);
let draftsDir = "";
let nextTabId = 1;

function createTab(text = "", started = true): Tab {
  const state = makeState(text);
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
  };
}

function makeState(text: string) {
  return EditorState.create({
    doc: text,
    extensions: editorExtensions(EditorView.updateListener.of(onUpdate)),
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
  return tab.failed || tab.missing;
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
  if (doc.missing) {
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
  const { words, minutes } = countWords(view.state.doc.toString());
  if (mode === "read") {
    countEl.textContent = words ? `${words.toLocaleString()} 字 · 约 ${minutes} 分钟` : "0 字";
    return;
  }
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const picked = countWords(view.state.sliceDoc(sel.from, sel.to)).words;
    countEl.textContent = `已选 ${picked.toLocaleString()} / ${words.toLocaleString()} 字`;
  } else {
    countEl.textContent = `${words.toLocaleString()} 字`;
  }
}

let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---------- preview ----------

let previewTimer = 0;
let previewStale = true;
/** Block elements in the preview keyed by their source line, for scroll sync. */
let anchors: { line: number; el: HTMLElement; top: number }[] = [];
/** Whether `anchors[].top` reflects the current layout. */
let anchorsMeasured = false;
/** Local image files the backend has already been asked to expose. */
const allowedAssets = new Set<string>();

function schedulePreview() {
  previewStale = true;
  if (mode === "write") return;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, view.state.doc.length > 200_000 ? 400 : 90);
}

function renderPreview() {
  clearTimeout(previewTimer);
  previewStale = false;
  preview.innerHTML = renderMarkdown(view.state.doc.toString());

  // Local images: only the exact files referenced are exposed to the webview.
  const images: [HTMLImageElement, string][] = [];
  for (const img of preview.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) continue;
    let local: string;
    try {
      local = decodeURIComponent(src);
    } catch {
      local = src;
    }
    if (doc.path) images.push([img, resolvePath(dirname(doc.path), local)]);
    else if (/^\//.test(local)) images.push([img, local]);
  }
  if (images.length) {
    const show = () => images.forEach(([img, path]) => (img.src = host.assetUrl(path)));
    const fresh = [...new Set(images.map(([, path]) => path))].filter((p) => !allowedAssets.has(p));
    if (fresh.length) {
      fresh.forEach((p) => allowedAssets.add(p));
      host.allowAssets(fresh).then(show, show);
    } else {
      show();
    }
  }

  renderDiagrams();

  const seen = new Set<number>();
  anchors = [];
  anchorsMeasured = false;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(el.dataset.line);
    if (seen.has(line)) continue;
    seen.add(line);
    anchors.push({ line, el, top: 0 });
  }
  anchors.sort((a, b) => a.line - b.line);
}

/** Last diagram shown at each position, kept on screen while an edit re-renders. */
let shownDiagrams: string[] = [];

function renderDiagrams() {
  const blocks = [...preview.querySelectorAll<HTMLElement>(".mermaid-block")];
  const previous = shownDiagrams;
  shownDiagrams = [];

  blocks.forEach((block, i) => {
    const source = block.textContent ?? "";
    const show = (svg: string | undefined, error?: string) => {
      let figure = block.querySelector<HTMLElement>(".mermaid-svg");
      if (svg) {
        if (!figure) {
          figure = document.createElement("div");
          figure.className = "mermaid-svg";
          block.prepend(figure);
        }
        figure.innerHTML = svg;
        shownDiagrams[i] = svg;
      }
      block.classList.toggle("has-diagram", !!figure);
      block.querySelector(".mermaid-error")?.remove();
      if (error) {
        const note = document.createElement("div");
        note.className = "mermaid-error";
        note.textContent = `图表语法有误：${error}`;
        block.append(note);
      }
      anchorsMeasured = false;
    };

    const ready = cachedDiagram(source);
    if (ready) return show(ready);
    if (previous[i]) show(previous[i]);
    renderDiagram(source).then(
      (svg) => block.isConnected && show(svg),
      (err) => block.isConnected && show(undefined, String(err?.message ?? err).trim()),
    );
  });
}

// Diagrams are themed from the palette, so redraw them when it flips.
onThemeChange(() => {
  shownDiagrams = [];
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
  const target = e.target as HTMLElement;

  const box = target.closest<HTMLInputElement>("input.task-box");
  if (box) {
    // The source is the truth: the box only changes via a re-render.
    e.preventDefault();
    toggleTask(Number(box.dataset.taskLine));
    return;
  }

  const a = target.closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    const hit =
      document.getElementById(id) ??
      [...preview.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].find(
        (h) => slug(h.textContent ?? "") === slug(id),
      );
    hit?.scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (/^(https?|mailto|tel):/i.test(href)) {
    host.openUrl(href);
  } else if (doc.path && href) {
    let rel = href.split("#")[0];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* keep raw */
    }
    const abs = resolvePath(dirname(doc.path), rel);
    if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(abs)) openPath(abs);
    else host.reveal(abs);
  }
});

const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

function toggleTask(line: number) {
  if (line < 0 || line >= view.state.doc.lines) return;
  const l = view.state.doc.line(line + 1);
  const m = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(l.text);
  if (!m) return;
  const from = l.from + m[1].length;
  view.dispatch({
    changes: { from, to: from + 1, insert: m[2] === " " ? "x" : " " },
    userEvent: "input",
  });
  renderPreview();
}

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

function syncPreviewFromEditor() {
  if (mode !== "split" || !anchors.length || !claimSync("editor")) return;
  const s = view.scrollDOM;
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
  if (mode !== "split" || !anchors.length || !claimSync("preview")) return;
  const p = previewScroll;
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

function setMode(next: Mode) {
  const line = mode === "read" ? null : editorTopLine();
  mode = next;
  app.dataset.mode = next;
  anchorsMeasured = false;
  prefs.set("mode", next);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === next));
  }
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

window.addEventListener("storage", (e) => {
  if (e.key === "mdit.recent") renderRecent();
});

// ---------- tab switching ----------

/** Remember where the on-screen tab was, before another one takes the view. */
function stashActive() {
  doc.state = view.state;
  doc.editorScroll = view.scrollSnapshot();
  doc.previewTop = previewScroll.scrollTop;
}

/** Bring the preview, status bar and focus in line with the active tab. */
function showDocument() {
  shownDiagrams = [];
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
    let data;
    try {
      data = await host.readFile(path);
    } catch (err) {
      forgetRecent(path);
      await host.alert("无法打开文件", `${path}\n\n${err}`);
      return;
    }
    const again = tabFor(data.path);
    if (again) return activate(again);

    const draft = inDrafts(data.path);
    const state = makeState(data.content);
    const fill = (tab: Tab) => {
      tab.path = draft ? null : data.path;
      tab.draft = draft ? data.path : null;
      tab.mtime = data.mtime;
      tab.state = state;
      tab.saved = state.doc;
      tab.eol = data.content.includes("\r\n") ? "\r\n" : "\n";
      tab.started = true;
      tab.missing = tab.dirty = tab.failed = false;
      tab.editorScroll = null;
      tab.previewTop = 0;
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

async function openViaDialog() {
  const path = await host.pickFile();
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
    const written = await host.writeFile(target, snapshot.sliceString(0, snapshot.length, tab.eol));
    tab.saved = snapshot;
    tab.failed = false;
    tab.dirty = !textOf(tab).eq(snapshot);
    return written;
  } catch (err) {
    tab.failed = true;
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
  if (!tab.dirty) return true;
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
    return !tab.dirty;
  } catch {
    return false;
  } finally {
    refreshChrome();
  }
}

function suggestName(tab: Tab) {
  const name = tabName(tab).replace(/[\\/:*?"<>|#…]+/g, " ").trim().slice(0, 60);
  return `${name || "未命名"}.md`;
}

/** Explicit save (⌘S / ⇧⌘S). A draft becomes a real file and leaves staging. */
async function save(as = false): Promise<boolean> {
  const tab = doc;
  clearTimeout(tab.autosaveTimer);
  let target = tab.path;
  if (!target || as) {
    target = await host.pickSavePath(tab.path ?? suggestName(tab));
    if (!target) return false;
  }
  let written;
  try {
    written = await writeTo(tab, target);
  } catch (err) {
    await host.alert("保存失败", `${target}\n\n${err}`);
    return false;
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
    if (tab === doc && mode !== "write") renderPreview(); // relative image paths may now resolve
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
    const data = await host.readFile(path);
    // Give up if anything moved meanwhile: another tab, a write, or typing
    // (the next check will then ask instead of overwriting).
    if (doc !== tab || tab.path !== path || tab.busy || !view.state.doc.eq(before)) return;
    clearTimeout(tab.autosaveTimer);
    const current = before.toString();
    if (data.content !== current) {
      // Replace only the span that differs so the cursor and scroll stay put.
      const next = data.content;
      let start = 0;
      while (start < current.length && start < next.length && current[start] === next[start]) start++;
      let end = 0;
      while (
        end < current.length - start && end < next.length - start &&
        current[current.length - 1 - end] === next[next.length - 1 - end]
      ) end++;
      view.dispatch({
        changes: { from: start, to: current.length - end, insert: next.slice(start, next.length - end) },
      });
    }
    tab.saved = view.state.doc;
    tab.mtime = data.mtime;
    tab.dirty = tab.failed = false;
    refreshChrome();
    if (mode !== "write") renderPreview();
  } catch {
    /* transient I/O error; try again next time */
  } finally {
    checking = false;
  }
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
  applyFont(fontSize);
  setMode(mode);
  renderRecent();
  refreshChrome();

  const win = host.window;
  if (win) {
    await host.listen<string>("menu", (id) => commands[id]?.());
    await host.listen<string>("open-path", (path) => openPath(path));

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
  for (const path of init.files) await openPath(path);
  await win?.show();
  await win?.setFocus();
}

boot();

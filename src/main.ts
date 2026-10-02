import { EditorState, Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { editorExtensions } from "./editor";
import { renderMarkdown, countWords } from "./preview";
import { host, inTauri, isMac } from "./host";

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

// ---------- document state ----------

const doc = {
  path: null as string | null,
  mtime: null as number | null,
  /** Content as last written to / read from disk. */
  saved: Text.empty,
  eol: "\n",
  /** False while the launch screen is showing. */
  started: false,
  /** The file disappeared from disk. */
  missing: false,
};
let dirty = false;
let mode: Mode = prefs.get<Mode>("mode", "write");
let fontSize = prefs.get<number>("fontSize", 15);

const view = new EditorView({ parent: editorEl, state: makeState("") });

function makeState(text: string) {
  return EditorState.create({
    doc: text,
    extensions: editorExtensions(EditorView.updateListener.of(onUpdate)),
  });
}

function onUpdate(u: ViewUpdate) {
  if (u.docChanged) {
    if (!doc.started) doc.started = true;
    dirty = !u.state.doc.eq(doc.saved);
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

function displayName() {
  return doc.path ? basename(doc.path) : "未命名";
}

// ---------- chrome: title, status ----------

function isPristine() {
  return !doc.path && view.state.doc.length === 0;
}

/** Content exists only in this window: edited, or its file was deleted. */
function hasUnsaved() {
  return dirty || doc.missing;
}

let reported = "";
/** Tell the backend what this window holds (for file routing and quit). */
function syncBackend(force = false): Promise<void> {
  const state = JSON.stringify([doc.path, isPristine(), hasUnsaved()]);
  if (!force && state === reported) return Promise.resolve();
  reported = state;
  return host.reportState(doc.path, isPristine(), hasUnsaved());
}

function refreshChrome() {
  app.classList.toggle("is-empty", !doc.started);
  app.classList.toggle("is-dirty", hasUnsaved());

  const name = displayName();
  nameEl.textContent = name;
  dirEl.textContent = doc.path ? `— ${basename(dirname(doc.path))}` : "";
  dirEl.title = doc.path ? tildify(doc.path) : "";
  const title = dirty ? `${name} — 已编辑` : name;
  if (document.title !== title) {
    document.title = title;
    host.window?.setTitle(title);
  }

  saveEl.className = "";
  if (doc.missing) {
    saveEl.textContent = "文件已被移除";
    saveEl.className = "warn";
  } else if (dirty) {
    saveEl.textContent = "未保存";
    saveEl.className = "dirty";
  } else if (doc.path) {
    saveEl.textContent = "已保存";
    saveEl.className = "ok";
  } else {
    saveEl.textContent = "新文件";
  }

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
    if (/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(abs)) host.openPath(abs);
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
      btn.addEventListener("click", () => host.openPath(p));
      li.append(btn);
      return li;
    }),
  );
}

window.addEventListener("storage", (e) => {
  if (e.key === "mdit.recent") renderRecent();
});

// ---------- file operations ----------

function startNew() {
  doc.started = true;
  refreshChrome();
  if (mode === "read") setMode("write");
  view.focus();
}

async function loadFile(path: string) {
  let data;
  try {
    data = await host.readFile(path);
  } catch (err) {
    forgetRecent(path);
    refreshChrome();
    await syncBackend(true); // the backend assumed this window now shows `path`
    await host.alert("无法打开文件", `${path}\n\n${err}`);
    return;
  }
  view.setState(makeState(data.content));
  doc.path = path;
  doc.mtime = data.mtime;
  doc.saved = view.state.doc;
  doc.eol = data.content.includes("\r\n") ? "\r\n" : "\n";
  doc.started = true;
  doc.missing = false;
  dirty = false;
  rememberRecent(path);
  refreshChrome();
  updatePos();
  updateCount();
  previewStale = true;
  if (mode !== "write") renderPreview();
  previewScroll.scrollTop = 0;
  if (mode === "read") previewScroll.focus({ preventScroll: true });
  else view.focus();
}

async function openViaDialog() {
  const path = await host.pickFile();
  if (path) await host.openPath(path);
}

function suggestName() {
  const m = /^#{1,6}\s+(.+)$/m.exec(view.state.doc.toString().slice(0, 2000));
  const base = m ? m[1].replace(/[\\/:*?"<>|#]+/g, " ").trim().slice(0, 60) : "";
  return `${base || "未命名"}.md`;
}

let saving = false;

async function save(as = false): Promise<boolean> {
  if (saving) return false;
  saving = true;
  try {
    return await writeDoc(as);
  } finally {
    saving = false;
  }
}

async function writeDoc(as: boolean): Promise<boolean> {
  let target = doc.path;
  if (!target || as) {
    target = await host.pickSavePath(doc.path ?? suggestName());
    if (!target) return false;
  }
  const snapshot = view.state.doc;
  try {
    doc.mtime = await host.writeFile(target, snapshot.sliceString(0, snapshot.length, doc.eol));
  } catch (err) {
    await host.alert("保存失败", `${target}\n\n${err}`);
    return false;
  }
  const renamed = target !== doc.path;
  doc.path = target;
  doc.saved = snapshot;
  doc.started = true;
  doc.missing = false;
  dirty = !view.state.doc.eq(snapshot);
  rememberRecent(target);
  refreshChrome();
  if (renamed) {
    toast(`已保存为 ${basename(target)}`);
    if (mode !== "write") renderPreview(); // relative image paths may now resolve
  }
  return true;
}

let checking = false;
/** Pick up edits made to the file by other programs. */
async function checkDisk() {
  // While saving, the file on disk is changing because of us.
  if (!doc.path || checking || saving) return;
  checking = true;
  try {
    const path = doc.path;
    const mtime = await host.fileMtime(path);
    if (mtime === null) {
      if (!doc.missing) {
        doc.missing = true;
        refreshChrome();
      }
      return;
    }
    if (mtime === doc.mtime && !doc.missing) return;
    if (doc.missing) {
      doc.missing = false;
      refreshChrome();
    }
    if (doc.path !== path || saving) return;
    if (dirty && !(await host.confirmReload(displayName()))) {
      doc.mtime = mtime;
      refreshChrome();
      return;
    }
    const before = view.state.doc;
    const data = await host.readFile(path);
    // Give up if anything moved meanwhile: another file was loaded, a save
    // started, or the user typed (the next check will then ask, not overwrite).
    if (doc.path !== path || saving || !view.state.doc.eq(before)) return;
    const current = view.state.doc.toString();
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
    doc.saved = view.state.doc;
    doc.mtime = data.mtime;
    dirty = false;
    refreshChrome();
    if (mode !== "write") renderPreview();
  } catch {
    /* transient I/O error; try again next time */
  } finally {
    checking = false;
  }
}

// ---------- commands ----------

const commands: Record<string, () => unknown> = {
  new: () => (isPristine() ? startNew() : host.newWindow()),
  open: openViaDialog,
  save: () => doc.started && save(false),
  save_as: () => doc.started && save(true),
  reveal: () => doc.path && host.reveal(doc.path),
  close: () => (host.window ? host.window.close() : window.close()),
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
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && handleShortcutsInPage && !e.altKey) {
      const k = e.key.toLowerCase();
      const id =
        k === "s" ? (e.shiftKey ? "save_as" : "save")
        : e.shiftKey ? (k === "r" ? "reveal" : undefined)
        : ({
            n: "new", o: "open", w: "close", q: "quit",
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
    await host.listen<string>("open-path", async (path) => {
      if (isPristine()) return loadFile(path);
      // The user started typing before the backend heard about it: correct the
      // record, then let the backend route the file to another window.
      await syncBackend(true);
      await host.openPath(path);
    });

    await win.onCloseRequested(async (e) => {
      if (!hasUnsaved()) return;
      const choice = await host.confirmDiscard(displayName());
      if (choice === "cancel" || (choice === "save" && !(await save()))) e.preventDefault();
    });

    await win.onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") app.classList.add("is-dropping");
      else app.classList.remove("is-dropping");
      if (p.type === "drop") {
        for (const path of p.paths) await host.openPath(path);
      }
    });
  }

  // Listeners are live, so the backend may now route files to this window.
  const initial = await host.initWindow();
  if (initial) await loadFile(initial);
  await win?.show();
  await win?.setFocus();
}

boot();

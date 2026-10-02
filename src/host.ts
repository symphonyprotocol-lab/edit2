/**
 * Thin wrapper over the Tauri backend. When the page runs in a plain browser
 * (vite dev server without Tauri) it falls back to harmless stubs so the UI
 * can still be inspected.
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog, message, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export const inTauri = "__TAURI_INTERNALS__" in window;
export const isMac = /Mac/i.test(navigator.userAgent);

export interface FileData {
  /** Canonical path of the file that was read. */
  path: string;
  content: string;
  mtime: number | null;
  /** Encoding it was decoded with (encoding_rs name, e.g. "UTF-8", "GBK"). */
  encoding: string;
  /** It starts with a byte order mark. */
  bom: boolean;
  /** The encoding was detected from little evidence. */
  guessed: boolean;
  size: number;
}

/** A write refused because the encoding cannot represent some characters. */
export class UnmappableError extends Error {}

/** A read refused because the file is very large; retry with `force`. */
export class TooLargeError extends Error {
  constructor(public size: number) {
    super("too large");
  }
}

export interface InitData {
  /** Files to open as tabs, in order (restored drafts first). */
  files: string[];
  /** Staging area where untitled documents are auto-saved. */
  draftsDir: string;
  /** Tell the user once (e.g. data migrated from mdit). */
  notice?: string | null;
}

export interface Written {
  /** Canonical path of the file that was written. */
  path: string;
  mtime: number | null;
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

/**
 * Dev only, in a plain browser: read files through the vite server so the UI
 * can be exercised with real documents.
 */
async function devRead(path: string): Promise<FileData> {
  if (!import.meta.env.DEV) throw new Error("需要在 Tauri 中运行");
  const res = await fetch(`/@fs${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const content = await res.text();
  return { path, content, mtime: 0, encoding: "UTF-8", bom: false, guessed: false, size: content.length };
}

export const host = {
  /** What this window should open as tabs when it boots. */
  initWindow: (): Promise<InitData> =>
    inTauri ? invoke("init_window") : Promise.resolve({ files: [], draftsDir: "/drafts" }),

  reportState: (paths: string[], unsaved: boolean): Promise<void> =>
    inTauri ? invoke("report_state", { paths, unsaved }) : Promise.resolve(),

  setFormatMenu: (format: boolean, minify: boolean): Promise<void> =>
    inTauri ? invoke("set_format_menu", { format, minify }) : Promise.resolve(),

  servePreview: (token: string, path: string | null, html: string): Promise<void> =>
    inTauri ? invoke("serve_preview", { token, path, html }) : Promise.resolve(),

  /** Origin of the backend's `preview:` protocol (Windows maps custom schemes to http). */
  previewOrigin: /Windows/i.test(navigator.userAgent) ? "http://preview.localhost" : "preview://localhost",

  loadSettings: (): Promise<Record<string, unknown>> => invoke("load_settings"),

  setSetting: (key: string, value: unknown): Promise<void> => invoke("set_setting", { key, value }),

  allowAssets: (paths: string[]): Promise<void> =>
    inTauri ? invoke("allow_assets", { paths }) : Promise.resolve(),

  /** Read a text file; `encoding` skips detection, `force` opens a very large file. */
  async readFile(path: string, opts: { encoding?: string; force?: boolean } = {}): Promise<FileData> {
    if (!inTauri) return devRead(path);
    try {
      return await invoke<FileData>("read_file", { path, encoding: opts.encoding ?? null, force: opts.force ?? false });
    } catch (err) {
      const m = /^TOO_LARGE:(\d+)$/.exec(String(err));
      throw m ? new TooLargeError(Number(m[1])) : err;
    }
  },

  async writeFile(path: string, content: string, encoding = "UTF-8", bom = false): Promise<Written> {
    if (!inTauri) return { path, mtime: null };
    try {
      return await invoke<Written>("write_file", { path, content, encoding, bom });
    } catch (err) {
      throw String(err) === "UNMAPPABLE" ? new UnmappableError("unmappable") : err;
    }
  },

  deleteDraft: (path: string): Promise<void> =>
    inTauri ? invoke("delete_draft", { path }) : Promise.resolve(),

  fileMtime: (path: string): Promise<number | null> =>
    inTauri ? invoke("file_mtime", { path }) : Promise.resolve(import.meta.env.DEV ? 0 : null),

  quit: () => (inTauri ? invoke("quit") : Promise.resolve()),

  async pickFile(filters: DialogFilter[]): Promise<string | null> {
    if (!inTauri) return null;
    const picked = await openDialog({ multiple: false, directory: false, filters });
    return typeof picked === "string" ? picked : null;
  },

  async pickSavePath(defaultPath: string, filters: DialogFilter[]): Promise<string | null> {
    if (!inTauri) return null;
    return saveDialog({ defaultPath, filters });
  },

  /** Ask what to do with unsaved changes. */
  async confirmDiscard(name: string): Promise<"save" | "discard" | "cancel"> {
    if (!inTauri) return confirm(`放弃对“${name}”的修改？`) ? "discard" : "cancel";
    const r = await message(`如果不保存，你的修改将会丢失。`, {
      title: `要保存对“${name}”的修改吗？`,
      kind: "warning",
      buttons: { yes: "保存", no: "不保存", cancel: "取消" },
    });
    if (r === "保存" || r === "Yes") return "save";
    if (r === "不保存" || r === "No") return "discard";
    return "cancel";
  },

  /** Closing a draft tab: keep it as a real file, or throw it away. */
  async confirmDraft(name: string): Promise<"save" | "discard" | "cancel"> {
    if (!inTauri) return confirm(`删除草稿“${name}”？`) ? "discard" : "cancel";
    const r = await message("草稿目前只保存在暂存区。删除后无法恢复。", {
      title: `要将“${name}”保存为文件吗？`,
      kind: "warning",
      buttons: { yes: "保存…", no: "删除草稿", cancel: "取消" },
    });
    if (r === "保存…" || r === "Yes") return "save";
    if (r === "删除草稿" || r === "No") return "discard";
    return "cancel";
  },

  /** The file changed on disk while there are edits here: 好 = reload, 取消 = keep mine. */
  async confirmReload(name: string): Promise<boolean> {
    if (!inTauri) return confirm(`“${name}”已在外部修改，重新载入？`);
    return confirmDialog("点“好”载入磁盘上的新版本，并丢弃你在这里未保存的修改；点“取消”保留你的版本。", {
      title: `“${name}”已在其他地方被修改`,
      kind: "warning",
      okLabel: "好",
      cancelLabel: "取消",
    });
  },

  async confirmLarge(name: string, size: string): Promise<boolean> {
    if (!inTauri) return confirm(`“${name}”有 ${size}，以只读方式打开？`);
    return confirmDialog("文件很大，为避免卡顿将以只读方式打开：不能编辑，也不显示预览。", {
      title: `“${name}”有 ${size}`,
      kind: "warning",
      okLabel: "以只读方式打开",
      cancelLabel: "取消",
    });
  },

  /** Some characters cannot be written in the file's encoding. */
  async confirmUnmappable(name: string, encoding: string): Promise<"utf8" | "keep"> {
    if (!inTauri) return confirm(`“${name}”有 ${encoding} 无法表示的字符，改存为 UTF-8？`) ? "utf8" : "keep";
    const ok = await confirmDialog(
      `文件里有 ${encoding} 无法表示的字符（例如 emoji），按原编码保存会丢失它们。改存为 UTF-8，或者继续编辑并删掉这些字符。`,
      { title: `“${name}”无法用 ${encoding} 保存`, kind: "warning", okLabel: "改存为 UTF-8", cancelLabel: "继续编辑" },
    );
    return ok ? "utf8" : "keep";
  },

  async ask(title: string, body: string, okLabel: string): Promise<boolean> {
    if (!inTauri) return confirm(`${title}\n${body}`);
    return confirmDialog(body, { title, kind: "warning", okLabel, cancelLabel: "取消" });
  },

  async alert(title: string, body: string) {
    if (!inTauri) return void window.alert(`${title}\n${body}`);
    await message(body, { title, kind: "error" });
  },

  openUrl: (url: string) => (inTauri ? openUrl(url) : void window.open(url, "_blank")),

  reveal: (path: string) => (inTauri ? revealItemInDir(path) : Promise.resolve()),

  assetUrl: (path: string) => (inTauri ? convertFileSrc(path) : path),

  async listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
    if (!inTauri) return () => {};
    // Events are targeted at a single window with `emit_to`.
    return getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload));
  },

  window: inTauri ? getCurrentWebviewWindow() : null,
};


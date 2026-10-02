/**
 * Thin wrapper over the Tauri backend. When the page runs in a plain browser
 * (vite dev server without Tauri) it falls back to harmless stubs so the UI
 * can still be inspected.
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog, message, ask } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export const inTauri = "__TAURI_INTERNALS__" in window;
export const isMac = /Mac/i.test(navigator.userAgent);

export interface FileData {
  content: string;
  mtime: number | null;
}

const MD_FILTER = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx", "txt"] }];

export const host = {
  initWindow: (): Promise<string | null> => (inTauri ? invoke("init_window") : Promise.resolve(null)),

  reportState: (path: string | null, pristine: boolean, unsaved: boolean): Promise<void> =>
    inTauri ? invoke("report_state", { path, pristine, unsaved }) : Promise.resolve(),

  allowAssets: (paths: string[]): Promise<void> =>
    inTauri ? invoke("allow_assets", { paths }) : Promise.resolve(),

  openPath: (path: string) => (inTauri ? invoke("open_path", { path }) : Promise.resolve()),

  newWindow: () => (inTauri ? invoke("new_window") : Promise.resolve()),

  readFile: (path: string): Promise<FileData> =>
    inTauri ? invoke("read_file", { path }) : Promise.reject(new Error("需要在 Tauri 中运行")),

  writeFile: (path: string, content: string): Promise<number | null> =>
    inTauri ? invoke("write_file", { path, content }) : Promise.resolve(null),

  fileMtime: (path: string): Promise<number | null> =>
    inTauri ? invoke("file_mtime", { path }) : Promise.resolve(null),

  quit: () => (inTauri ? invoke("quit") : Promise.resolve()),

  async pickFile(): Promise<string | null> {
    if (!inTauri) return null;
    const picked = await openDialog({ multiple: false, directory: false, filters: MD_FILTER });
    return typeof picked === "string" ? picked : null;
  },

  async pickSavePath(defaultPath: string): Promise<string | null> {
    if (!inTauri) return null;
    return saveDialog({ defaultPath, filters: MD_FILTER });
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

  async confirmReload(name: string): Promise<boolean> {
    if (!inTauri) return confirm(`“${name}”已在外部修改，重新载入？`);
    return ask("重新载入会丢弃你在这里未保存的修改。", {
      title: `“${name}”已在其他地方被修改`,
      kind: "warning",
      okLabel: "重新载入",
      cancelLabel: "保留我的版本",
    });
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


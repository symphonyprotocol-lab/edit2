/** Pieces shared by the Office viewers. */
import type { PreviewContext } from "../types";

export const extOf = (path: string) => (/\.([^./\\]+)$/.exec(path)?.[1] ?? "").toLowerCase();

/** A bar along the top of a viewer: a note, and a button to open the file in its own app. */
export function toolbar(ctx: PreviewContext, note: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pv-toolbar office-bar";
  const text = document.createElement("span");
  text.className = "office-note";
  text.textContent = note;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn small";
  open.textContent = "用默认程序打开";
  open.addEventListener("click", () => ctx.file?.openInApp());
  bar.append(text, open);
  return bar;
}

/** Old binary formats (.doc, .xls, .ppt): say so, and offer the system app. */
export function legacyCard(ctx: PreviewContext, kind: string, ext: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "office-legacy";
  const title = document.createElement("p");
  title.className = "office-legacy-title";
  title.textContent = `这是旧版 ${kind} 格式（.${ext}），edit2 无法显示它的内容。`;
  const hint = document.createElement("p");
  hint.textContent = `可以用 ${kind} 或其他程序打开它，另存为 .${ext}x 后就能在这里查看。`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn primary";
  open.textContent = "用默认程序打开";
  open.addEventListener("click", () => ctx.file?.openInApp());
  card.append(title, hint, open);
  return card;
}

/** A user-facing reason a document could not be shown. */
export function describe(kind: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/zip|central directory|end of data|corrupt/i.test(msg)) return `无法打开 ${kind} 文件：文件已损坏，或者不是 ${kind} 文件。`;
  return `无法显示这个 ${kind} 文件：${msg}`;
}

/** Serif families Office documents use; the rest fall back to a sans-serif. */
const SERIF = /cambria|times|georgia|garamond|book antiqua|palatino|baskerville|song|宋|仿宋|楷|mincho|明朝|batang|serif/i;
const GENERIC = /\b(?:sans-serif|serif|monospace|cursive|fantasy|system-ui)\b/i;

/** A font list with a fallback, so a missing Office font (Calibri, Cambria…) does not become Times. */
export function withFallback(list: string): string {
  if (!list.trim() || GENERIC.test(list)) return list;
  return `${list.trim()}, ${SERIF.test(list) ? "Songti SC, serif" : "-apple-system, PingFang SC, sans-serif"}`;
}

/** `withFallback` for every font-family in a page or style sheet (no quotes added: safe in style attributes). */
export function addFontFallback(html: string): string {
  return html.replace(/(font-family\s*:\s*)((?:"[^"]*"|'[^']*'|[^;}"'<>])+)/gi, (_m, head: string, list: string) => head + withFallback(list));
}

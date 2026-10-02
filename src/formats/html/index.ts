import type { FormatPlugin } from "../types";
import { wordStats } from "../shared/count";

/** Visible text, roughly: markup, scripts and styles removed. */
const visibleText = (html: string) =>
  html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<[^>]*>/gi, " ").replace(/&[a-z]+;|&#\d+;/gi, " ");

export const html: FormatPlugin = {
  id: "html",
  label: "HTML",
  extensions: ["html", "htm"],
  language: () => import("@codemirror/lang-html").then((m) => m.html()),
  preview: () => import("./preview").then((m) => m.htmlPreview),
  formatter: () => import("./format").then((m) => m.htmlFormatter),
  canFormat: true,
  stats: (text, selection) => wordStats(visibleText(text), selection && visibleText(selection)),
  defaultMode: "split",
};

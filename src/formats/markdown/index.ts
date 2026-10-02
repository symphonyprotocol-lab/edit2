import type { FormatPlugin } from "../types";
import { wordStats } from "../shared/count";
import { formatKeymap, markdownLanguageSupport } from "./editor";

export const markdown: FormatPlugin = {
  id: "markdown",
  label: "Markdown",
  extensions: ["md", "markdown", "mdown", "mkd", "mdx"],
  language: markdownLanguageSupport,
  editorExtras: formatKeymap,
  preview: () => import("./preview").then((m) => m.markdownPreview),
  stats: wordStats,
  defaultMode: "split",
};

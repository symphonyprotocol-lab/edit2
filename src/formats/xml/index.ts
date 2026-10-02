import type { FormatPlugin } from "../types";
import { lineCount } from "../shared/count";

export const xml: FormatPlugin = {
  id: "xml",
  label: "XML",
  extensions: ["xml", "svg", "plist", "xsd", "xsl", "xslt", "rss", "atom", "xhtml"],
  language: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  preview: () => import("./preview").then((m) => m.xmlPreview),
  formatter: () => import("./format").then((m) => m.xmlFormatter),
  canFormat: true,
  canMinify: true,
  async stats(text) {
    const { firstProblem } = await import("./parse");
    const problem = text.trim() ? firstProblem(text) : null;
    return `${lineCount(text).toLocaleString()} 行 · ${problem ? `第 ${problem.line ?? "?"} 行有错误` : "有效"}`;
  },
  defaultMode: "split",
};

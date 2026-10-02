import type { FormatPlugin } from "../types";
import { lineCount } from "../shared/count";

export const json: FormatPlugin = {
  id: "json",
  label: "JSON",
  extensions: ["json", "jsonc", "json5", "geojson", "webmanifest"],
  language: () => import("@codemirror/lang-json").then((m) => m.json()),
  preview: () => import("./preview").then((m) => m.jsonPreview),
  formatter: () => import("./format").then((m) => m.jsonFormatter),
  canFormat: true,
  canMinify: true,
  async stats(text) {
    const { firstProblem } = await import("./parse");
    const problem = text.trim() ? firstProblem(text) : null;
    return `${lineCount(text).toLocaleString()} 行 · ${problem ? `第 ${problem.line} 行有错误` : "有效"}`;
  },
  defaultMode: "split",
};

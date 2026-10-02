import type { FormatPlugin } from "../types";
import { lineCount } from "../shared/count";

export const yaml: FormatPlugin = {
  id: "yaml",
  label: "YAML",
  extensions: ["yaml", "yml"],
  language: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  preview: () => import("./preview").then((m) => m.yamlPreview),
  formatter: () => import("./format").then((m) => m.yamlFormatter),
  canFormat: true,
  async stats(text) {
    const { firstProblem } = await import("./parse");
    const problem = text.trim() ? firstProblem(text) : null;
    return `${lineCount(text).toLocaleString()} 行 · ${problem ? `第 ${problem.line ?? "?"} 行有错误` : "有效"}`;
  },
  defaultMode: "write",
};

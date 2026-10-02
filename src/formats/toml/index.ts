import type { FormatPlugin } from "../types";
import { lineCount } from "../shared/count";

export const toml: FormatPlugin = {
  id: "toml",
  label: "TOML",
  extensions: ["toml"],
  language: async () => {
    const [{ StreamLanguage }, { toml }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/toml"),
    ]);
    return StreamLanguage.define(toml);
  },
  preview: () => import("./preview").then((m) => m.tomlPreview),
  formatter: () => import("./format").then((m) => m.tomlFormatter),
  canFormat: true,
  async stats(text) {
    const { firstProblem } = await import("./parse");
    const problem = text.trim() ? firstProblem(text) : null;
    return `${lineCount(text).toLocaleString()} 行 · ${problem ? `第 ${problem.line ?? "?"} 行有错误` : "有效"}`;
  },
  defaultMode: "write",
};

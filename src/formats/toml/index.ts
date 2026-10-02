import type { FormatPlugin } from "../types";
import { validityStats } from "../shared/validity";

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
  stats: validityStats(() => import("./parse").then((m) => m.parseToml)),
  defaultMode: "write",
};

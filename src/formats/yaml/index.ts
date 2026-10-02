import type { FormatPlugin } from "../types";
import { validityStats } from "../shared/validity";

export const yaml: FormatPlugin = {
  id: "yaml",
  label: "YAML",
  extensions: ["yaml", "yml"],
  language: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  preview: () => import("./preview").then((m) => m.yamlPreview),
  formatter: () => import("./format").then((m) => m.yamlFormatter),
  canFormat: true,
  stats: validityStats(() => import("./parse").then((m) => m.parseYaml)),
  defaultMode: "write",
};

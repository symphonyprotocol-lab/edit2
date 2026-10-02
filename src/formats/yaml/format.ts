import type { Formatter } from "../types";
import { parseYaml } from "./parse";

export const yamlFormatter: Formatter = {
  format(text, opts) {
    const docs = parseYaml(text);
    // YAML does not allow tabs for indentation.
    const indent = opts.indent === "\t" ? 2 : opts.indent.length;
    return docs.map((doc) => doc.toString({ indent, lineWidth: 0 })).join("");
  },
};

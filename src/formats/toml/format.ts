import type { Formatter } from "../types";
import { parseToml } from "./parse";
import { assignmentAt, newScanState, scanValue } from "./scan";

/**
 * Tidy TOML without losing anything: indentation and trailing spaces go,
 * `key=value` gets spaces around `=`, blank runs collapse to one, and each
 * table header gets a blank line before it (and before its comments).
 * Strings and values spanning lines are left exactly as they are.
 */
export function tidyToml(text: string): string {
  parseToml(text); // only well-formed input
  const out: string[] = [];
  const state = newScanState();
  for (const raw of text.split("\n")) {
    if (state.multi || state.depth) {
      out.push(raw);
      scanValue(raw, state);
      continue;
    }
    const line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
    } else if (line.startsWith("#")) {
      out.push(line);
    } else if (line.startsWith("[")) {
      let start = out.length;
      while (start > 0 && out[start - 1].startsWith("#")) start--;
      if (start > 0 && out[start - 1] !== "") out.splice(start, 0, "");
      out.push(line.replace(/^\[(\[?)\s*(.*?)\s*(\]\]?)/, "[$1$2$3"));
    } else {
      const eq = assignmentAt(line);
      if (eq <= 0) {
        out.push(line);
        continue;
      }
      const value = line.slice(eq + 1).trimStart();
      out.push(`${line.slice(0, eq).trimEnd()} = ${value}`);
      scanValue(value, state);
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export const tomlFormatter: Formatter = {
  format: (text) => tidyToml(text),
};

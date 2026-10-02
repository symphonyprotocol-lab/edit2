import { parse, TomlDate, TomlError } from "smol-toml";
import { SyntaxProblem } from "../types";
import type { TreeNode } from "../shared/tree";
import { lineIndex } from "./scan";

export function parseToml(text: string): Record<string, unknown> {
  try {
    return parse(text, { integersAsBigInt: "asNeeded" });
  } catch (err) {
    if (err instanceof TomlError) {
      const message = err.message.split("\n")[0].replace(/^Invalid TOML document:\s*/, "");
      throw new SyntaxProblem(message, err.line);
    }
    throw err;
  }
}

export function firstProblem(text: string): SyntaxProblem | null {
  try {
    parseToml(text);
    return null;
  } catch (err) {
    if (err instanceof SyntaxProblem) return err;
    throw err;
  }
}

export function tomlTree(text: string, data: Record<string, unknown>): TreeNode {
  const lines = lineIndex(text);
  const convert = (value: unknown, path: string[], key?: string): TreeNode => {
    const line = lines.get(path.join("\0"));
    if (value instanceof TomlDate) return { key, kind: "date", value: value.toISOString(), line };
    if (Array.isArray(value)) {
      return { key, kind: "array", line, children: value.map((v, i) => convert(v, [...path, String(i)], String(i))) };
    }
    if (value && typeof value === "object") {
      return {
        key,
        kind: "object",
        line,
        children: Object.entries(value).map(([k, v]) => convert(v, [...path, k], k)),
      };
    }
    if (typeof value === "string") return { key, kind: "string", value, line };
    if (typeof value === "boolean") return { key, kind: "boolean", value: String(value), line };
    return { key, kind: "number", value: String(value), line };
  };
  return convert(data, []);
}

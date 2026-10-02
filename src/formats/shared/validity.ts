import type { FormatPlugin } from "../types";
import { SyntaxProblem } from "../types";
import { lineCount } from "./count";

/**
 * Remember the last result (or error) of `fn`. The status bar check and the
 * preview parse the same text after each edit; this makes that one parse.
 */
export function memoLast<T>(fn: (text: string) => T): (text: string) => T {
  let last: string | null = null;
  let result: { value: T } | { error: unknown } = { error: null };
  return (text) => {
    if (text !== last) {
      last = text;
      try {
        result = { value: fn(text) };
      } catch (error) {
        result = { error };
      }
    }
    if ("error" in result) throw result.error;
    return result.value;
  };
}

/** The syntax error `parse` reports for `text`, or null. */
export function problemOf(parse: (text: string) => unknown, text: string): SyntaxProblem | null {
  try {
    parse(text);
    return null;
  } catch (err) {
    if (err instanceof SyntaxProblem) return err;
    throw err;
  }
}

/** Status bar summary for a checkable format: "12 行 · 有效" or "12 行 · 第 3 行有错误". */
export function validityStats(load: () => Promise<(text: string) => unknown>): FormatPlugin["stats"] {
  return async (text) => {
    const parse = await load();
    const problem = text.trim() ? problemOf(parse, text) : null;
    return `${lineCount(text).toLocaleString()} 行 · ${problem ? `第 ${problem.line ?? "?"} 行有错误` : "有效"}`;
  };
}

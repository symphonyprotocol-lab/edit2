import { applyEdits, createScanner, format } from "jsonc-parser";
import type { Formatter } from "../types";
import { problemOf } from "../shared/validity";
import { parseJson } from "./parse";

// jsonc-parser's SyntaxKind is a const enum, which isolated modules cannot read.
const LINE_COMMENT = 12;
const LINE_BREAK = 14;
const TRIVIA = 15;
const EOF = 17;

function check(text: string) {
  const problem = problemOf(parseJson, text);
  if (problem) throw problem;
}

export const jsonFormatter: Formatter = {
  format(text, opts) {
    check(text);
    const tab = opts.indent === "\t";
    const edits = format(text, undefined, {
      tabSize: tab ? 1 : opts.indent.length,
      insertSpaces: !tab,
      eol: "\n",
      keepLines: false,
    });
    return applyEdits(text, edits);
  },

  /** Drop whitespace between tokens; line comments become block comments so nothing is lost. */
  minify(text) {
    check(text);
    const scanner = createScanner(text, false);
    let out = "";
    for (let kind: number = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
      if (kind === TRIVIA || kind === LINE_BREAK) continue;
      const raw = text.substr(scanner.getTokenOffset(), scanner.getTokenLength());
      out += kind === LINE_COMMENT ? `/*${raw.slice(2).replace(/\*\//g, "* /")} */` : raw;
    }
    return out;
  },
};

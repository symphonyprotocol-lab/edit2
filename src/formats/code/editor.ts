import type { Extension, Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { foldGutter, foldKeymap, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

/**
 * The indent a file already uses: a tab, or 2/4/8 spaces. Null when it has
 * too few indented lines to tell. Looks at the first 2,000 lines only.
 */
export function detectIndent(doc: Text): string | null {
  let tabs = 0;
  let spaced = 0;
  let unit = 0;
  for (const line of doc.iterLines(1, Math.min(doc.lines, 2000) + 1)) {
    const m = /^( +|\t+)\S/.exec(line);
    if (!m) continue;
    if (m[1][0] === "\t") {
      tabs++;
      continue;
    }
    const width = m[1].length;
    // Skip one-space continuations such as the " * " inside block comments.
    if (width < 2 || line[width] === "*") continue;
    spaced++;
    if (width % 2 === 0 && (unit === 0 || width < unit)) unit = width;
  }
  if (tabs + spaced < 3) return null;
  if (tabs > spaced) return "\t";
  if (unit === 2 || unit === 4 || unit === 8) return " ".repeat(unit);
  return null;
}

const theme = EditorView.theme({
  // Code reads best left-aligned at full width, with line numbers beside it.
  "&.cm-editor .cm-content": {
    maxWidth: "none",
    margin: "0",
    paddingLeft: "14px !important",
    paddingRight: "24px !important",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--ink-3)",
    border: "none",
    fontFamily: "var(--mono)",
    fontSize: "0.85em",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 16px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 6px 0 2px", cursor: "pointer" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--hover)",
    border: "1px solid var(--line)",
    color: "var(--ink-3)",
    borderRadius: "4px",
    padding: "0 4px",
  },
});

/** Editor additions for source code: line numbers, folding, auto-closed brackets, the file's own indent. */
export function codeEditor(defaultIndent: string): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter({ openText: "⌄", closedText: "›" }),
    closeBrackets(),
    keymap.of([...closeBracketsKeymap, ...foldKeymap]),
    indentUnit.compute(["doc"], (state) => detectIndent(state.doc) ?? defaultIndent),
    theme,
  ];
}

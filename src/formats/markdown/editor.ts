import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t, styleTags } from "@lezer/highlight";

/** Wrap the selection in `mark`, or unwrap it if it is already wrapped. */
function toggleWrap(mark: string) {
  return (view: EditorView) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - mark.length, range.from);
      const after = state.sliceDoc(range.to, range.to + mark.length);
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length },
          ],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

function insertLink(view: EditorView) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    // Cursor goes inside the () when text is selected, otherwise inside the [].
    const cursor = text ? range.from + insert.length - 1 : range.from + 1;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(cursor),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

export const formatKeymap = keymap.of([
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("*") },
  { key: "Mod-Shift-x", run: toggleWrap("~~") },
  { key: "Mod-e", run: toggleWrap("`") },
  { key: "Mod-k", run: insertLink },
]);

export const markdownLanguageSupport = (): Extension =>
  markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    extensions: { props: [styleTags({ TaskMarker: t.processingInstruction })] },
  });

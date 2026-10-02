import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightSpecialChars,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": {
    color: "var(--ink)",
    backgroundColor: "var(--bg)",
    fontSize: "var(--fs)",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.75",
  },
  ".cm-content": {
    maxWidth: "var(--col)",
    margin: "0 auto",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--sel) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-placeholder": { color: "var(--ink-3)" },
  ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--ink)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-search": { fontFamily: "var(--sans)", fontSize: "12px", padding: "6px 10px" },
  ".cm-search input, .cm-search button, .cm-search label": { fontSize: "12px" },
  ".cm-textfield": {
    border: "1px solid var(--line)",
    borderRadius: "5px",
    background: "var(--bg)",
    color: "var(--ink)",
    padding: "3px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    background: "var(--hover)",
    border: "1px solid var(--line)",
    borderRadius: "5px",
    color: "var(--ink)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--sel)", outline: "1px solid var(--accent)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.4em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.22em" },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.08em" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.processingInstruction, color: "var(--ink-3)", fontWeight: "400", fontStyle: "normal" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--ink-2)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--ink-3)" },
  { tag: t.monospace, color: "var(--code-ink)" },
  { tag: t.quote, color: "var(--ink-2)" },
  { tag: t.contentSeparator, color: "var(--ink-3)" },
  { tag: [t.meta, t.labelName], color: "var(--ink-3)" },
  // fenced code
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-fn)" },
  { tag: [t.attributeValue], color: "var(--syn-string)" },
  { tag: [t.angleBracket, t.separator, t.punctuation, t.bracket], color: "var(--ink-3)" },
  { tag: [t.invalid], color: "var(--warn)" },
]);

/** Per-tab parts of the editor that change with the document's format. */
export const languageSlot = new Compartment();
export const extrasSlot = new Compartment();
export const wrapSlot = new Compartment();
export const readOnlySlot = new Compartment();

export interface EditorSetup {
  language: Extension;
  extras: Extension;
  wrap: boolean;
  readOnly: boolean;
}

export const wrapExtension = (on: boolean) => (on ? EditorView.lineWrapping : []);
export const readOnlyExtension = (on: boolean) => (on ? [EditorState.readOnly.of(true)] : []);

export function editorExtensions(onUpdate: Extension, setup: EditorSetup): Extension[] {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    wrapSlot.of(wrapExtension(setup.wrap)),
    readOnlySlot.of(readOnlyExtension(setup.readOnly)),
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
    languageSlot.of(setup.language),
    syntaxHighlighting(highlight),
    theme,
    placeholder("开始写作…"),
    extrasSlot.of(setup.extras),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    onUpdate,
  ];
}

import { StreamLanguage } from "@codemirror/language";
import { detectDelimiter } from "./parse";

/** Token styles cycled across columns so each column reads as one colour. */
const COLUMN_STYLES = ["variableName", "string", "number", "keyword", "propertyName", "typeName"];

interface State {
  delimiter: string | null;
  column: number;
  /** Inside a quoted field that continues on the next line. */
  quoted: boolean;
}

/** Column-coloured CSV/TSV; the delimiter is detected from the first line. */
export const csvLanguage = StreamLanguage.define<State>({
  name: "csv",
  startState: () => ({ delimiter: null, column: 0, quoted: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.delimiter === null) state.delimiter = detectDelimiter(stream.string);
    if (stream.sol() && !state.quoted) state.column = 0;
    const style = COLUMN_STYLES[state.column % COLUMN_STYLES.length];

    if (state.quoted) {
      while (!stream.eol()) {
        if (stream.next() === '"') {
          if (stream.peek() === '"') stream.next();
          else {
            state.quoted = false;
            break;
          }
        }
      }
      return style;
    }
    if (stream.peek() === state.delimiter) {
      stream.next();
      state.column++;
      return "punctuation";
    }
    if (stream.peek() === '"') {
      stream.next();
      state.quoted = true;
      return style;
    }
    while (!stream.eol() && stream.peek() !== state.delimiter) stream.next();
    return style;
  },
});

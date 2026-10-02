import type { FormatPlugin } from "../types";
import { countWords, lineCount } from "../shared/count";

/** Plain text, and the fallback for any text file no other plugin claims. */
export const plainText: FormatPlugin = {
  id: "text",
  label: "纯文本",
  extensions: ["txt", "text", "log"],
  stats(text, selection) {
    const lines = lineCount(text).toLocaleString();
    if (selection) return `已选 ${countWords(selection).words.toLocaleString()} 字 · ${lines} 行`;
    return `${lines} 行 · ${countWords(text).words.toLocaleString()} 字`;
  },
  defaultMode: "write",
};

import xmlFormat from "xml-formatter";
import type { Formatter } from "../types";
import { parseXml } from "./parse";

const options = (indentation: string) => ({
  indentation,
  collapseContent: true,
  lineSeparator: "\n",
  throwOnFailure: true,
});

export const xmlFormatter: Formatter = {
  format(text, opts) {
    parseXml(text); // xml-formatter accepts some malformed input: check first
    return xmlFormat(text, options(opts.indent));
  },
  minify(text) {
    parseXml(text);
    return xmlFormat.minify(text, options(""));
  },
};

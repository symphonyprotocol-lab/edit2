import beautify from "js-beautify";
import type { Formatter } from "../types";

export const htmlFormatter: Formatter = {
  format(text, opts) {
    const tabs = opts.indent === "\t";
    return beautify.html(text, {
      indent_size: tabs ? 1 : opts.indent.length,
      indent_char: tabs ? "\t" : " ",
      indent_with_tabs: tabs,
      wrap_line_length: 0,
      preserve_newlines: true,
      max_preserve_newlines: 1,
      end_with_newline: false,
      indent_inner_html: false,
      extra_liners: [],
    });
  },
};

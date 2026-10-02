import type { FormatPlugin } from "../types";
import { parseCsv } from "./parse";

export const csv: FormatPlugin = {
  id: "csv",
  label: "CSV",
  extensions: ["csv", "tsv", "tab"],
  language: () => import("./language").then((m) => m.csvLanguage),
  preview: () => import("./preview").then((m) => m.csvPreview),
  stats(text) {
    const { rows, columns } = parseCsv(text);
    return `${rows.length.toLocaleString()} 行 × ${columns} 列`;
  },
  defaultMode: "read",
};

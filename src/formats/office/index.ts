import type { FormatPlugin } from "../types";

/**
 * Office documents, read-only like PDFs. Each viewer and its library load the
 * first time a file of that kind opens. Old Word and PowerPoint files (.doc,
 * .ppt) only get a button to open them in the system's app; old Excel files
 * (.xls) open like the others.
 */
export const word: FormatPlugin = {
  id: "word",
  label: "Word",
  extensions: ["docx", "doc"],
  preview: () => import("./word").then((m) => m.wordPreview),
  stats: () => "",
  defaultMode: "read",
  binary: true,
};

export const excel: FormatPlugin = {
  id: "excel",
  label: "Excel",
  extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"],
  preview: () => import("./excel").then((m) => m.excelPreview),
  stats: () => "",
  defaultMode: "read",
  binary: true,
};

export const powerpoint: FormatPlugin = {
  id: "powerpoint",
  label: "PowerPoint",
  extensions: ["pptx", "ppt"],
  preview: () => import("./powerpoint").then((m) => m.powerpointPreview),
  stats: () => "",
  defaultMode: "read",
  binary: true,
};

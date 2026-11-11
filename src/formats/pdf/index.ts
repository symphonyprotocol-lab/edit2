import type { FormatPlugin } from "../types";

/**
 * pdf.js needs a recent web view (Safari 18 / WebKit on macOS 13 and later;
 * WebView2 on Windows is always current). On an older one, say so instead of
 * failing inside the library.
 */
const supported = () =>
  typeof (Promise as { withResolvers?: unknown }).withResolvers === "function" &&
  typeof (URL as { parse?: unknown }).parse === "function";

/** PDF: a read-only viewer (pdf.js), loaded the first time a PDF opens. */
export const pdf: FormatPlugin = {
  id: "pdf",
  label: "PDF",
  extensions: ["pdf"],
  preview: () =>
    supported()
      ? import("./preview").then((m) => m.pdfPreview())
      : Promise.reject(new Error("查看 PDF 需要 macOS 13 或更高版本，并装有 Safari 18 或更高版本")),
  stats: () => "",
  defaultMode: "read",
  binary: true,
};

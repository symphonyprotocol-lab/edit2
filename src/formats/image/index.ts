import type { FormatPlugin } from "../types";

/**
 * Images: a read-only viewer. SVG is not here: it opens as XML, with the
 * picture in its preview. TIFF and HEIC show where the web view can decode
 * them (WebKit on macOS; not WebView2 on Windows).
 */
export const image: FormatPlugin = {
  id: "image",
  label: "图片",
  extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "avif", "tif", "tiff", "heic", "heif"],
  preview: () => import("./preview").then((m) => m.imagePreview()),
  stats: () => "",
  defaultMode: "read",
  binary: true,
};

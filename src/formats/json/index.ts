import type { FormatPlugin } from "../types";
import { validityStats } from "../shared/validity";

export const json: FormatPlugin = {
  id: "json",
  label: "JSON",
  extensions: ["json", "jsonc", "json5", "geojson", "webmanifest"],
  language: () => import("@codemirror/lang-json").then((m) => m.json()),
  preview: () => import("./preview").then((m) => m.jsonPreview),
  formatter: () => import("./format").then((m) => m.jsonFormatter),
  canFormat: true,
  canMinify: true,
  stats: validityStats(() => import("./parse").then((m) => m.parseJson)),
  defaultMode: "split",
};

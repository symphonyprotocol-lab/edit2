import type { FormatPlugin } from "../types";
import { validityStats } from "../shared/validity";

export const xml: FormatPlugin = {
  id: "xml",
  label: "XML",
  extensions: ["xml", "svg", "plist", "xsd", "xsl", "xslt", "rss", "atom"],
  language: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  preview: () => import("./preview").then((m) => m.xmlPreview),
  formatter: () => import("./format").then((m) => m.xmlFormatter),
  canFormat: true,
  canMinify: true,
  stats: validityStats(() => import("./parse").then((m) => m.parseXml)),
  defaultMode: "split",
};

import type { FormatPlugin } from "./types";

const plugins: FormatPlugin[] = [];
const byExt = new Map<string, FormatPlugin>();
let fallback: FormatPlugin | null = null;
let untitled: FormatPlugin | null = null;

export function register(plugin: FormatPlugin, role?: { fallback?: boolean; untitled?: boolean }) {
  plugins.push(plugin);
  for (const ext of plugin.extensions) byExt.set(ext.toLowerCase(), plugin);
  if (role?.fallback) fallback = plugin;
  if (role?.untitled) untitled = plugin;
}

export const allFormats = (): readonly FormatPlugin[] => plugins;

export const formatById = (id: string): FormatPlugin | undefined => plugins.find((p) => p.id === id);

/** Lower-case extension of a path, or "" when it has none. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether some plugin claims this path's extension. */
export const isKnownFile = (path: string) => byExt.has(extensionOf(path));

/** The plugin for a file; untitled documents get the default format. */
export function formatFor(path: string | null): FormatPlugin {
  if (path === null) return untitled!;
  return byExt.get(extensionOf(path)) ?? fallback!;
}

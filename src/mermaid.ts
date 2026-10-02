/**
 * Mermaid diagrams in the preview. Mermaid is large, so it is only loaded the
 * first time a document contains a ```mermaid block.
 */
import type { Mermaid } from "mermaid";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

let loader: Promise<Mermaid> | null = null;
/** Theme the loaded instance was last initialized with. */
let configuredTheme = "";
let seq = 0;

/** Rendered SVG by theme + source, so unchanged diagrams never re-render. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 64;

const themeKey = () => (darkQuery.matches ? "dark" : "light");
const cacheKey = (source: string) => `${themeKey()}\n${source}`;

/** Mermaid derives shades from these, so they must be concrete colors, not var(). */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: darkQuery.matches,
    fontFamily: v("--sans"),
    fontSize: "14px",
    background: v("--bg"),
    primaryColor: v("--code-bg"),
    primaryTextColor: v("--ink"),
    primaryBorderColor: v("--ink-3"),
    secondaryColor: v("--hover"),
    tertiaryColor: v("--bg"),
    mainBkg: v("--code-bg"),
    textColor: v("--ink"),
    lineColor: v("--ink-2"),
    noteBkgColor: v("--hover"),
    noteBorderColor: v("--ink-3"),
    noteTextColor: v("--ink"),
    edgeLabelBackground: v("--bg"),
    clusterBkg: v("--bg"),
    clusterBorder: v("--line"),
  };
}

async function load(): Promise<Mermaid> {
  loader ??= import("mermaid").then((m) => m.default);
  const mermaid = await loader;
  if (configuredTheme !== themeKey()) {
    configuredTheme = themeKey();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Throw on bad syntax instead of drawing mermaid's own error graphic.
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: themeVariables(),
    });
  }
  return mermaid;
}

/** Already-rendered SVG for `source`, if any (lets re-renders avoid a flash). */
export function cachedDiagram(source: string): string | undefined {
  return cache.get(cacheKey(source));
}

/** Render `source` to an SVG string. Rejects with mermaid's error on bad syntax. */
export async function renderDiagram(source: string): Promise<string> {
  const key = cacheKey(source);
  const hit = cache.get(key);
  if (hit) return hit;
  const mermaid = await load();
  const { svg } = await mermaid.render(`mdit-mermaid-${++seq}`, source);
  cache.set(key, svg);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return svg;
}

/** Run `cb` when the system switches between light and dark. */
export function onThemeChange(cb: () => void) {
  darkQuery.addEventListener("change", cb);
}

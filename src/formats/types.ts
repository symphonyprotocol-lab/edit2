/**
 * The contract between the app and a format plugin. The app owns tabs, files,
 * saving and the editor; a plugin says how one kind of text file is
 * highlighted, previewed, counted and formatted.
 */
import type { Extension, Text } from "@codemirror/state";

export type Mode = "write" | "split" | "read";

export interface FormatPlugin {
  /** Stable id, used in preferences and CSS (`.fmt-<id>`). */
  id: string;
  /** Shown in the status bar and the open dialog. */
  label: string;
  /** Lower-case extensions without the dot. */
  extensions: string[];
  /** Editor language; may load lazily the first time a file of this format opens. */
  language?: () => Extension | Promise<Extension>;
  /** Format-specific editor behaviour (key bindings and the like). */
  editorExtras?: Extension;
  /** Preview renderer, loaded on first use. Without one the format is edit-only. */
  preview?: () => Promise<PreviewRenderer>;
  /** Status bar summary, e.g. "1,204 字" or "120 行 × 6 列". */
  stats(text: string, selection: string | null): string | Promise<string>;
  /** Pretty-printing and minifying, loaded on first use. */
  formatter?: () => Promise<Formatter>;
  /** Whether the formatter can format / minify, known before it is loaded (for menus). */
  canFormat?: boolean;
  canMinify?: boolean;
  /** View used the first time a file of this format is opened. */
  defaultMode: Mode;
}

export interface PreviewRenderer {
  /**
   * Render `source` into `ctx.container`. On a parse error a renderer should
   * leave the last good output in place and report the error instead.
   */
  render(source: string, ctx: PreviewContext): RenderResult | Promise<RenderResult>;
  /**
   * A click inside the preview: true if handled, "rerender" if handled and the
   * preview should be rendered again (e.g. a view option changed). Unhandled
   * link clicks fall back to `ctx.openLink`.
   */
  click?(e: MouseEvent, ctx: PreviewContext): boolean | "rerender" | void;
  /** Another document is about to be shown: drop per-document state. */
  reset?(): void;
  /** The system switched between light and dark. */
  themeChanged?(): void;
}

export interface RenderResult {
  /** Elements keyed by the 0-based source line they start on, for scroll sync. */
  anchors?: { line: number; el: HTMLElement }[];
  /** A parse error; the preview keeps the last good render beneath it. */
  error?: { message: string; line?: number } | null;
}

export interface PreviewContext {
  container: HTMLElement;
  /** The document's file, if it has one. */
  path: string | null;
  /** Absolute local path for a reference in the document, or null if it is not a local file. */
  localPath(ref: string): string | null;
  /** Make local files loadable in the preview; returns their URLs in order. */
  assetUrls(paths: string[]): Promise<string[]>;
  /** Follow a link: in-document anchors, the browser, or another file. */
  openLink(href: string, scope?: ParentNode): void;
  /** Change the source (e.g. ticking a task box). `fn` returns null to do nothing. */
  editSource(fn: (doc: Text) => { from: number; to: number; insert: string } | null): void;
  /** Put the editor on a 0-based line (switching to split view from read). */
  goToLine(line: number): void;
  /** In split view, move the editor to a 0-based line without taking focus. */
  revealLine(line: number): void;
  /**
   * Serve an HTML page from its own origin (for running its scripts in a
   * sandbox); resolves to the URL to load, or null where that is unavailable.
   */
  publishPage(html: string): Promise<string | null>;
  /** Layout changed after rendering (images, diagrams): offsets must be re-measured. */
  layoutChanged(): void;
  /** False once a newer render or another document has taken over. */
  isCurrent(): boolean;
}

export interface FormatOptions {
  /** One indent level: spaces or a tab. */
  indent: string;
}

export interface Formatter {
  format?(text: string, opts: FormatOptions): string | Promise<string>;
  minify?(text: string): string | Promise<string>;
}

/** Thrown by parsers and formatters for invalid input. `line` is 1-based. */
export class SyntaxProblem extends Error {
  constructor(message: string, public line?: number) {
    super(message);
  }
}

/** Offsets where each line starts, for repeated offset → line lookups. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 0-based line of `offset`, given `lineStarts(text)`. */
export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

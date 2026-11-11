/**
 * Word viewer: docx-preview lays the document out as pages (splitting where
 * Word last paginated it, and at explicit breaks), with its styles, lists,
 * tables, pictures, headers and footers. Pictures are inlined as data: URIs.
 * Read-only; .doc gets a card offering the system app.
 */
import "./office.css";
import { renderAsync } from "docx-preview";
import { currentIndex, keepPoint, mountStage, onPinchZoom } from "../shared/viewer";
import { addFontFallback, describe, extOf, legacyCard, toolbar, withFallback } from "./common";
import type { PreviewContext, PreviewRenderer } from "../types";

const MIN = 0.25;
const MAX = 4;
const STEP = 1.15;

/**
 * List bullets Word draws from the Symbol and Wingdings fonts, as private-use
 * code points that other fonts show as boxes: their Unicode look-alikes.
 */
const BULLETS: Record<string, string> = {
  "\uf0b7": "•", "\uf0a7": "▪", "\uf0a8": "◦", "\uf06e": "■", "\uf06c": "●", "\uf071": "❑", "\uf075": "◆",
  "\uf076": "❖", "\uf0d8": "➢", "\uf0fc": "✓", "\uf0e0": "➢", "\uf0de": "➢", "\uf0a4": "●", "\uf02d": "–",
};
/** After docx-preview: real bullets, and fonts that fall back sensibly when Office's are missing. */
const tidy = (styles: HTMLElement, body: HTMLElement) => {
  for (const el of styles.querySelectorAll("style")) {
    let css = el.textContent ?? "";
    if (/[\uf000-\uf0ff]/.test(css)) css = css.replace(/[\uf000-\uf0ff]/g, (c) => BULLETS[c] ?? "•");
    el.textContent = addFontFallback(css);
  }
  for (const el of body.querySelectorAll<HTMLElement>("[style*='font-family']")) {
    el.style.fontFamily = withFallback(el.style.fontFamily);
  }
};

interface Place {
  scale: number | null;
  top: number;
}
const places = new Map<string, Place>();

interface Shown {
  path: string;
  version: string;
  stage: HTMLDivElement;
  wrapper: HTMLElement | null;
  pages: HTMLElement[];
  scale: number | null;
  ctx: PreviewContext;
  stop: AbortController;
}
let shown: Shown | null = null;

function fit(s: Shown): number {
  const page = s.pages[0];
  if (!page) return 1;
  const width = page.offsetWidth + 32;
  return Math.min(1, Math.max(MIN, (s.stage.clientWidth - 8) / width));
}
const scaleOf = (s: Shown) => s.scale ?? fit(s);

function apply(s: Shown) {
  if (s.wrapper) s.wrapper.style.zoom = String(scaleOf(s));
}

function pushStatus() {
  if (!shown) return;
  const s = shown;
  if (!s.pages.length) return s.ctx.setStatus("", "Word");
  const page = currentIndex(s.stage, s.pages) + 1;
  s.ctx.setStatus(`第 ${page} / ${s.pages.length} 页`, `Word · ${Math.round(scaleOf(s) * 100)}%`);
}

function remember(s: Shown) {
  places.set(s.path, { scale: s.scale, top: s.stage.scrollTop / Math.max(1, s.stage.scrollHeight) });
}

function teardown() {
  if (!shown) return;
  remember(shown);
  shown.stop.abort();
  shown.stage.remove();
  shown = null;
}

function setScale(s: Shown, next: number | null, x?: number, y?: number) {
  if (!s.wrapper) return;
  keepPoint(s.stage, s.wrapper, () => {
    s.scale = next === null ? null : Math.min(MAX, Math.max(MIN, next));
    apply(s);
  }, x, y);
  remember(s);
  pushStatus();
}

async function render(_source: string, ctx: PreviewContext) {
  const file = ctx.file;
  const path = ctx.path;
  if (!file || !path) return { error: { message: "没有可显示的 Word 文件" } };
  if (shown && shown.path === path && shown.version === file.version && shown.stage.isConnected) {
    pushStatus();
    return {};
  }
  const legacy = extOf(path) === "doc";

  // Lay the document out off-screen first: a reload keeps the old version up until then.
  const body = document.createElement("div");
  const styles = document.createElement("div");
  if (!legacy) {
    try {
      const bytes = await file.read(0, file.size);
      if (!ctx.isCurrent()) return {};
      await renderAsync(bytes, body, styles, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
        experimental: false,
      });
      tidy(styles, body);
    } catch (err) {
      return ctx.isCurrent() ? { error: { message: describe("Word", err) } } : {};
    }
    if (!ctx.isCurrent()) return {};
  }

  const hadFocus = !!shown?.stage.contains(document.activeElement);
  teardown();
  const stage = mountStage(ctx, "office-stage word-stage", hadFocus);
  const stop = new AbortController();
  const { signal } = stop;
  if (legacy) {
    stage.append(legacyCard(ctx, "Word", "doc"));
    shown = { path, version: file.version, stage, wrapper: null, pages: [], scale: null, ctx, stop };
    ctx.setStatus("", "Word · 旧版格式");
    return {};
  }
  stage.append(toolbar(ctx, "只读 · 版式由 docx-preview 绘制，可能与 Word 略有出入"), styles, body);
  const wrapper = body.querySelector<HTMLElement>(".docx-wrapper") ?? body;
  const pages = [...wrapper.querySelectorAll<HTMLElement>(":scope > section.docx")];
  const place = places.get(path);
  const s: Shown = { path, version: file.version, stage, wrapper, pages, scale: place?.scale ?? null, ctx, stop };
  shown = s;
  apply(s);
  if (place) stage.scrollTop = place.top * stage.scrollHeight;
  pushStatus();

  const resize = new ResizeObserver(() => {
    if (shown !== s || s.scale !== null) return;
    apply(s);
    pushStatus();
  });
  resize.observe(stage);
  signal.addEventListener("abort", () => resize.disconnect());
  stage.addEventListener("scroll", () => {
    if (shown !== s) return;
    remember(s);
    pushStatus();
  }, { passive: true, signal });
  onPinchZoom(stage, signal, (factor, x, y) => setScale(s, scaleOf(s) * factor, x, y));
  return {};
}

function zoom(step: 1 | -1 | 0): boolean {
  if (!shown?.wrapper) return false;
  const s = shown;
  setScale(s, step === 0 ? null : step > 0 ? scaleOf(s) * STEP : scaleOf(s) / STEP);
  return true;
}

export const wordPreview: PreviewRenderer = { render, zoom, reset: teardown };

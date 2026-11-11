/**
 * PowerPoint viewer. On macOS, Quick Look draws the slides (Apple's Office
 * importer: layout, themes, pictures, tables, charts), returned as one HTML
 * page that is shown in a sandboxed frame without scripts and scaled to the
 * width. Elsewhere, an outline of each slide's text, pictures, tables and
 * notes. Read-only; .ppt gets a card offering the system app.
 */
import "./office.css";
import { keepPoint, mountStage, onPinchZoom } from "../shared/viewer";
import { addFontFallback, describe, extOf, legacyCard, toolbar } from "./common";
import { outlineElement, readOutline } from "./outline";
import type { PreviewContext, PreviewRenderer } from "../types";

const MIN = 0.2;
const MAX = 4;
const STEP = 1.15;

interface Place {
  scale: number | null;
  top: number;
}
const places = new Map<string, Place>();

interface Shown {
  path: string;
  version: string;
  stage: HTMLDivElement;
  /** What zooms: the box holding the slides frame, or the outline. */
  target: HTMLElement | null;
  /** Natural width of what zooms. */
  width: number;
  apply: (scale: number) => void;
  slides: () => { top: number }[];
  scale: number | null;
  ctx: PreviewContext;
  stop: AbortController;
  mode: string;
}
let shown: Shown | null = null;

const fit = (s: Shown) => Math.min(MAX, Math.max(MIN, (s.stage.clientWidth - 32) / Math.max(1, s.width)));
const scaleOf = (s: Shown) => s.scale ?? fit(s);

function pushStatus() {
  if (!shown) return;
  const s = shown;
  const slides = s.slides();
  if (!slides.length) return s.ctx.setStatus("", `PowerPoint · ${s.mode}`);
  const line = s.stage.getBoundingClientRect().top + s.stage.clientHeight * 0.3;
  let at = 0;
  slides.forEach((sl, i) => sl.top <= line && (at = i));
  s.ctx.setStatus(`第 ${at + 1} / ${slides.length} 张幻灯片`, `PowerPoint · ${s.mode} · ${Math.round(scaleOf(s) * 100)}%`);
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
  if (!s.target) return;
  keepPoint(s.stage, s.target, () => {
    s.scale = next === null ? null : Math.min(MAX, Math.max(MIN, next));
    s.apply(scaleOf(s));
  }, x, y);
  remember(s);
  pushStatus();
}

/**
 * Quick Look writes lengths without units (`width:720`), which only quirks
 * mode accepts; a frame's srcdoc never is in quirks mode. Give them pixels.
 */
export function addPixelUnits(html: string): string {
  const props = "width|height|top|left|right|bottom|font-size|text-indent|letter-spacing|(?:min|max)-(?:width|height)|(?:margin|padding)(?:-top|-right|-bottom|-left)?|border(?:-top|-right|-bottom|-left)?-width";
  const decl = new RegExp(`((?:^|[\\s;{"'])(?:${props})\\s*:\\s*)(-?\\d*\\.?\\d+)(?=\\s*(?:[;}"']|!important|$))`, "gim");
  return html.replace(decl, (_m, head: string, n: string) => `${head}${n}${Number(n) === 0 ? "" : "px"}`);
}


interface Slides {
  frame: HTMLIFrameElement;
  doc: Document;
  width: number;
  height: number;
  slides: HTMLElement[];
}

/**
 * Quick Look's page in a frame inside `box`, which must already be in the
 * page (moving a frame reloads it): no scripts, transparent background,
 * slides down the left edge; measured at its natural size once loaded.
 */
function loadSlides(html: string, box: HTMLElement, signal: AbortSignal): Promise<Slides> {
  const frame = document.createElement("iframe");
  frame.title = "幻灯片";
  // Same origin only so the editor can measure it and catch link clicks; nothing in it runs.
  frame.setAttribute("sandbox", "allow-same-origin");
  const style =
    "<style>html,body{background:transparent!important;margin:0!important;padding:0!important}" +
    "div.slide{margin:0 0 16px!important;box-shadow:0 1px 4px rgba(0,0,0,.25)!important}</style>";
  const page = addFontFallback(addPixelUnits(html));
  frame.srcdoc = page.includes("</head>") ? page.replace("</head>", `${style}</head>`) : style + page;
  frame.style.cssText = "width:2000px;height:100px";
  box.append(frame);
  return new Promise((resolve, reject) => {
    frame.addEventListener("load", () => {
      const doc = frame.contentDocument;
      if (!doc) return reject(new Error("系统预览无法载入"));
      const slides = [...doc.querySelectorAll<HTMLElement>("div.slide")];
      const width = Math.max(320, ...slides.map((el) => el.offsetLeft + el.offsetWidth));
      frame.style.width = `${width}px`;
      const height = doc.documentElement.scrollHeight;
      frame.style.height = `${height}px`;
      resolve({ frame, doc, width, height, slides });
    }, { once: true, signal });
    frame.addEventListener("error", () => reject(new Error("系统预览无法载入")), { once: true, signal });
  });
}

async function render(_source: string, ctx: PreviewContext) {
  const file = ctx.file;
  const path = ctx.path;
  if (!file || !path) return { error: { message: "没有可显示的 PowerPoint 文件" } };
  if (shown && shown.path === path && shown.version === file.version && shown.stage.isConnected) {
    pushStatus();
    return {};
  }
  const stop = new AbortController();
  const { signal } = stop;
  const legacy = extOf(path) === "ppt";

  let html: string | null = null;
  let outline: HTMLElement | null = null;
  if (!legacy) {
    try {
      html = await file.systemPreview().catch(() => null);
      if (!html) outline = outlineElement(await readOutline(await file.read(0, file.size)));
    } catch (err) {
      return ctx.isCurrent() ? { error: { message: describe("PowerPoint", err) } } : {};
    }
    if (!ctx.isCurrent()) return {};
  }

  const hadFocus = !!shown?.stage.contains(document.activeElement);
  teardown();
  const stage = mountStage(ctx, "office-stage ppt-stage", hadFocus);
  const place = places.get(path);
  const base = { path, version: file.version, stage, ctx, stop, scale: place?.scale ?? null };

  if (legacy) {
    stage.append(legacyCard(ctx, "PowerPoint", "ppt"));
    shown = { ...base, target: null, width: 1, apply: () => {}, slides: () => [], mode: "旧版格式" };
    pushStatus();
    return {};
  }

  let s: Shown;
  if (html) {
    const box = document.createElement("div");
    box.className = "slides-box";
    box.style.visibility = "hidden";
    stage.append(toolbar(ctx, "只读 · 幻灯片由 macOS 快速查看绘制"), box);
    ctx.setStatus("正在绘制幻灯片…", "PowerPoint");
    let loaded: Slides;
    try {
      loaded = await loadSlides(html, box, signal);
    } catch (err) {
      return ctx.isCurrent() && box.isConnected ? { error: { message: describe("PowerPoint", err) } } : {};
    }
    // Another document or a newer version took over while it loaded.
    if (!ctx.isCurrent() || !box.isConnected) return {};
    box.style.visibility = "";
    const { frame, doc, width, height, slides } = loaded;
    s = {
      ...base,
      target: box,
      width,
      mode: "快速查看",
      apply: (z) => {
        box.style.width = `${width * z}px`;
        box.style.height = `${height * z}px`;
        frame.style.transform = `scale(${z})`;
      },
      slides: () => {
        const top = box.getBoundingClientRect().top;
        const z = scaleOf(s);
        return slides.map((el) => ({ top: top + el.offsetTop * z }));
      },
    };
    // Links leave through the editor; ⌘-wheel over the slides zooms like elsewhere.
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      ctx.openLink(a.getAttribute("href")!, doc);
    }, { capture: true, signal });
    doc.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      const z = scaleOf(s);
      setScale(s, z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), r.left + e.clientX * z, r.top + e.clientY * z);
    }, { passive: false, signal });
  } else {
    const list = outline!;
    stage.append(toolbar(ctx, "只读 · 大纲：只显示文字、图片、表格和备注，不绘制版式和图表"), list);
    s = {
      ...base,
      target: list,
      width: 820,
      mode: "大纲",
      apply: (z) => (list.style.zoom = String(z)),
      slides: () => [...list.querySelectorAll(".ppt-slide")].map((el) => ({ top: el.getBoundingClientRect().top })),
    };
  }
  shown = s;
  // The outline is readable at its own size: only the slides fit the width.
  if (!html && s.scale === null) s.scale = 1;
  s.apply(scaleOf(s));
  if (place) stage.scrollTop = place.top * stage.scrollHeight;
  pushStatus();

  const resize = new ResizeObserver(() => {
    if (shown !== s || s.scale !== null) return;
    s.apply(scaleOf(s));
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
  if (!shown?.target) return false;
  const s = shown;
  const outline = s.mode === "大纲";
  setScale(s, step === 0 ? (outline ? 1 : null) : step > 0 ? scaleOf(s) * STEP : scaleOf(s) / STEP);
  return true;
}

export const powerpointPreview: PreviewRenderer = { render, zoom, reset: teardown };

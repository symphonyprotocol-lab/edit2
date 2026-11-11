/**
 * Image viewer. The picture loads straight from disk through the asset
 * protocol (only that file is exposed), so animated GIFs play and nothing big
 * passes through JS. ICNS, which no web view decodes, is the exception: its
 * largest embedded PNG is read out and shown from a blob.
 *
 * Fits the window by default (never enlarging); ⌘= / ⌘- / ⌘0, pinch or
 * ⌘-wheel zoom; drag or scroll to pan; double-click toggles fit and 100%.
 */
import "./image.css";
import { mountStage, onPinchZoom } from "../shared/viewer";
import { formatSize } from "../../encodings";
import type { PreviewContext, PreviewRenderer } from "../types";

const MIN = 0.02;
const MAX = 32;
const STEP = 1.25;
/** The stage's padding on each side (image.css). */
const PAD = 16;

const extOf = (path: string) => (/\.([^./\\]+)$/.exec(path)?.[1] ?? "").toLowerCase();
const TYPE_NAMES: Record<string, string> = { jpg: "JPEG", jpeg: "JPEG", tif: "TIFF", heif: "HEIC" };
const typeName = (ext: string) => TYPE_NAMES[ext] ?? ext.toUpperCase();

/** The largest PNG inside an .icns file, or null (older icons store raw bitmaps only). */
export function icnsPng(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 8 || tag(0) !== "icns") return null;
  const end = Math.min(bytes.length, view.getUint32(4));
  let best: Uint8Array | null = null;
  for (let at = 8; at + 8 <= end; ) {
    const len = view.getUint32(at + 4);
    if (len < 8 || at + len > end) break;
    const data = bytes.subarray(at + 8, at + len);
    const png = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    if (png && (!best || data.length > best.length)) best = data;
    at += len;
  }
  return best;
}

/** Where each file was being looked at: zoom (null = fitted) and scroll. */
interface Place {
  scale: number | null;
  left: number;
  top: number;
}
const places = new Map<string, Place>();

interface Shown {
  path: string;
  version: string;
  stage: HTMLDivElement;
  box: HTMLDivElement;
  img: HTMLImageElement;
  width: number;
  height: number;
  /** Null while fitted to the window. */
  scale: number | null;
  ctx: PreviewContext;
  stop: AbortController;
  type: string;
  size: number;
  revoke: (() => void) | null;
}
let shown: Shown | null = null;

function fitScale(s: Shown): number {
  const w = s.stage.clientWidth - 2 * PAD;
  const h = s.stage.clientHeight - 2 * PAD;
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1, w / s.width, h / s.height);
}

const scaleOf = (s: Shown) => s.scale ?? fitScale(s);

function layout(s: Shown) {
  const scale = scaleOf(s);
  s.box.style.width = `${Math.max(1, Math.round(s.width * scale))}px`;
  s.box.style.height = `${Math.max(1, Math.round(s.height * scale))}px`;
  s.box.classList.toggle("pixels", scale >= 3);
  s.stage.classList.toggle(
    "pannable",
    s.stage.scrollWidth > s.stage.clientWidth + 1 || s.stage.scrollHeight > s.stage.clientHeight + 1,
  );
}

function pushStatus() {
  if (!shown) return;
  const s = shown;
  s.ctx.setStatus(
    `${s.width} × ${s.height} 像素`,
    `${s.type} · ${formatSize(s.size)} · ${Math.round(scaleOf(s) * 100)}%`,
  );
}

function remember(s: Shown) {
  places.set(s.path, { scale: s.scale, left: s.stage.scrollLeft, top: s.stage.scrollTop });
}

/** Zoom to `next` (null = fit), keeping the picture's point under (x, y) in place. */
function setScale(s: Shown, next: number | null, x?: number, y?: number) {
  const before = s.box.getBoundingClientRect();
  const stageBox = s.stage.getBoundingClientRect();
  x ??= stageBox.left + stageBox.width / 2;
  y ??= stageBox.top + stageBox.height / 2;
  const old = scaleOf(s);
  const px = (x - before.left) / old;
  const py = (y - before.top) / old;
  s.scale = next === null ? null : Math.min(MAX, Math.max(MIN, next));
  layout(s);
  const after = s.box.getBoundingClientRect();
  const now = scaleOf(s);
  s.stage.scrollLeft += after.left + px * now - x;
  s.stage.scrollTop += after.top + py * now - y;
  layout(s); // scrolling may have changed whether it can be panned
  remember(s);
  pushStatus();
}

function teardown() {
  if (!shown) return;
  remember(shown);
  shown.stop.abort();
  shown.revoke?.();
  shown.stage.remove();
  shown = null;
}

async function source(path: string, ctx: PreviewContext): Promise<{ url: string; revoke: (() => void) | null }> {
  const file = ctx.file!;
  if (extOf(path) === "icns") {
    const png = icnsPng(await file.read(0, file.size));
    if (!png) throw new Error("这个 ICNS 文件里没有 PNG 图像，无法显示");
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  const [url] = await ctx.assetUrls([path]);
  // A new version of the file must not come from the cache.
  return { url: `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(file.version)}`, revoke: null };
}

function failure(path: string, err: unknown): string {
  const ext = extOf(path);
  if (err instanceof Error && err.message.startsWith("这个 ICNS")) return err.message;
  // Only WebKit (macOS) decodes these; Chromium-based web views (WebView2 on Windows) do not.
  const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
  if (["tif", "tiff", "heic", "heif"].includes(ext) && !webkit) {
    return `这个系统的 WebView 不能显示 ${typeName(ext)} 图片（在 macOS 上可以）。`;
  }
  return `无法显示这张图片：文件已损坏，或者是 ${typeName(ext)} 的一种不受支持的变体。`;
}

async function render(_source: string, ctx: PreviewContext) {
  const file = ctx.file;
  const path = ctx.path;
  if (!file || !path) return { error: { message: "没有可显示的图片文件" } };
  if (shown && shown.path === path && shown.version === file.version && shown.stage.isConnected) {
    pushStatus();
    return {};
  }

  let src: { url: string; revoke: (() => void) | null };
  const img = new Image();
  img.alt = "";
  img.draggable = false;
  try {
    src = await source(path, ctx);
    img.src = src.url;
    await img.decode();
  } catch (err) {
    if (!ctx.isCurrent()) return {};
    return { error: { message: failure(path, err) } };
  }
  if (!ctx.isCurrent()) {
    src.revoke?.();
    return {};
  }

  // A reload keeps the old picture on screen until the new one is ready, and its zoom and scroll.
  const hadFocus = !!shown?.stage.contains(document.activeElement);
  teardown();
  const stage = mountStage(ctx, "image-stage", hadFocus);
  const box = document.createElement("div");
  box.className = "image-box";
  box.append(img);
  stage.append(box);

  const stop = new AbortController();
  const { signal } = stop;
  const place = places.get(path);
  const s: Shown = {
    path,
    version: file.version,
    stage,
    box,
    img,
    width: img.naturalWidth || 1,
    height: img.naturalHeight || 1,
    scale: place?.scale ?? null,
    ctx,
    stop,
    type: typeName(extOf(path)),
    size: file.size,
    revoke: src.revoke,
  };
  shown = s;
  layout(s);
  if (place) {
    stage.scrollLeft = place.left;
    stage.scrollTop = place.top;
  }
  pushStatus();

  // Fitted: follow the window. Zoomed: keep the scale.
  const fit = new ResizeObserver(() => {
    if (shown !== s) return;
    layout(s);
    if (s.scale === null) pushStatus();
  });
  fit.observe(stage);
  signal.addEventListener("abort", () => fit.disconnect());
  stage.addEventListener("scroll", () => shown === s && remember(s), { passive: true, signal });

  onPinchZoom(stage, signal, (factor, x, y) => setScale(s, scaleOf(s) * factor, x, y));

  // Double-click: fit ↔ actual pixels, around the pointer.
  stage.addEventListener("dblclick", (e) => setScale(s, s.scale === null ? 1 : null, e.clientX, e.clientY), { signal });

  // Drag to pan when the picture is bigger than the window.
  stage.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !stage.classList.contains("pannable")) return;
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("panning");
      let lastX = e.clientX;
      let lastY = e.clientY;
      const move = (ev: PointerEvent) => {
        stage.scrollLeft -= ev.clientX - lastX;
        stage.scrollTop -= ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
      };
      const end = () => {
        stage.classList.remove("panning");
        stage.removeEventListener("pointermove", move);
        stage.removeEventListener("pointerup", end);
        stage.removeEventListener("pointercancel", end);
      };
      stage.addEventListener("pointermove", move);
      stage.addEventListener("pointerup", end);
      stage.addEventListener("pointercancel", end);
    },
    { signal },
  );
  return {};
}

function zoom(step: 1 | -1 | 0): boolean {
  if (!shown) return false;
  const s = shown;
  if (step === 0) setScale(s, null);
  else setScale(s, step > 0 ? scaleOf(s) * STEP : scaleOf(s) / STEP);
  return true;
}

export const imagePreview: PreviewRenderer = {
  render,
  zoom,
  reset: teardown,
};

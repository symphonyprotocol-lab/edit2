/**
 * PDF viewer: pdf.js's PDFViewer on the shared viewer stage (a scroller of
 * its own over the preview pane). Pages are laid out at once but only those in view are rendered;
 * large files are read from disk in ranges as pages need them. Each page has
 * a text layer (selectable, copyable) and its links: internal ones scroll
 * here, the rest go through `ctx.openLink` like links in other previews.
 *
 * Read-only: nothing here can change the document, and form fields are drawn
 * but not editable.
 */
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf.css";
import { mountStage, onPinchZoom } from "../shared/viewer";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BinaryFile, PreviewContext, PreviewRenderer } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
// The viewer components read the library from here when they load.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
const viewerLib = import("pdfjs-dist/web/pdf_viewer.mjs");

type Viewer = InstanceType<Awaited<typeof viewerLib>["PDFViewer"]>;

/** Files up to this size are read whole; larger ones in ranges as pages need them. */
const WHOLE_FILE = 16 * 1024 * 1024;
const RANGE_CHUNK = 512 * 1024;
/** Documents kept parsed for switching back to a tab, most recent last. */
const KEEP = 3;
const FIT = "page-width";

/** Data files shipped next to the app (see `pdfjsData` in vite.config.ts). */
const dataUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

// ---------- documents ----------

interface Loaded {
  path: string;
  version: string;
  doc: Promise<PDFDocumentProxy>;
  task?: PDFDocumentLoadingTask;
  dropped?: boolean;
}

const loaded: Loaded[] = [];

/** Serves pdf.js the byte ranges it asks for. */
class FileRange extends pdfjs.PDFDataRangeTransport {
  constructor(
    private file: BinaryFile,
    initial: Uint8Array,
  ) {
    super(file.size, initial);
  }

  requestDataRange(begin: number, end: number) {
    this.file.read(begin, end - begin).then(
      (chunk) => this.onDataRange(begin, chunk),
      (err) => console.warn("PDF: reading bytes failed", err),
    );
  }
}

async function openDocument(file: BinaryFile, entry: Loaded): Promise<PDFDocumentProxy> {
  const params: Parameters<typeof pdfjs.getDocument>[0] & object = {
    cMapUrl: dataUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: dataUrl("standard_fonts"),
    wasmUrl: dataUrl("wasm"),
    iccUrl: dataUrl("iccs"),
    // Data files come through the page (its CSP allows 'self'), the same on every platform.
    useWorkerFetch: false,
    enableXfa: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  };
  if (file.size <= WHOLE_FILE) {
    params.data = await file.read(0, file.size);
  } else {
    params.range = new FileRange(file, await file.read(0, RANGE_CHUNK));
    params.rangeChunkSize = RANGE_CHUNK;
    // Only what the visible pages need.
    params.disableAutoFetch = true;
    params.disableStream = true;
  }
  if (entry.dropped) throw new Error("cancelled");
  entry.task = pdfjs.getDocument(params);
  return entry.task.promise;
}

function drop(entry: Loaded) {
  entry.dropped = true;
  const i = loaded.indexOf(entry);
  if (i >= 0) loaded.splice(i, 1);
  entry.task?.destroy();
}

/** The parsed document for this version of the file, reusing a recent one. */
function load(path: string, file: BinaryFile): Loaded {
  const hit = loaded.find((l) => l.path === path && l.version === file.version);
  if (hit) {
    loaded.splice(loaded.indexOf(hit), 1);
    loaded.push(hit);
    return hit;
  }
  for (const old of loaded.filter((l) => l.path === path)) drop(old);
  const entry = { path, version: file.version } as Loaded;
  entry.doc = openDocument(file, entry);
  entry.doc.catch(() => drop(entry));
  loaded.push(entry);
  while (loaded.length > KEEP) drop(loaded[0]);
  return entry;
}

function describe(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "PasswordException") return "这个 PDF 有密码保护，edit2 暂时不能打开。";
  if (name === "InvalidPDFException") return "无法打开 PDF：文件已损坏，或者不是 PDF。";
  return `无法打开 PDF：${err instanceof Error ? err.message : String(err)}`;
}

// ---------- the viewer on screen ----------

/** Where each file was being read: zoom, page and the point at the top left. */
interface Place {
  scale: string;
  page: number;
  left: number;
  top: number;
}
const places = new Map<string, Place>();

interface Shown {
  path: string;
  version: string;
  stage: HTMLDivElement;
  viewer: Viewer;
  ctx: PreviewContext;
  stop: AbortController;
}

/** A renderer of its own for each column: what it shows is kept per instance. */
export function pdfPreview(): PreviewRenderer {
  let shown: Shown | null = null;

  function teardown() {
    if (!shown) return;
    shown.stop.abort();
    shown.viewer.setDocument(null as never);
    shown.stage.remove();
    shown = null;
  }

  function pushStatus() {
    if (!shown) return;
    const v = shown.viewer;
    if (!v.pagesCount) return;
    shown.ctx.setStatus(`第 ${v.currentPageNumber} / ${v.pagesCount} 页`, `${Math.round(v.currentScale * 100)}%`);
  }

  async function render(_source: string, ctx: PreviewContext) {
    const file = ctx.file;
    const path = ctx.path ?? "";
    if (!file) return { error: { message: "没有可显示的 PDF 文件" } };
    // Already showing this version (a theme change, a repeated render).
    if (shown && shown.path === path && shown.version === file.version && shown.stage.isConnected) {
      pushStatus();
      return {};
    }

    if (!shown) ctx.setStatus("正在打开…", "");
    let doc: PDFDocumentProxy;
    let lib: Awaited<typeof viewerLib>;
    try {
      [doc, lib] = await Promise.all([load(path, file).doc, viewerLib]);
    } catch (err) {
      if (ctx.isCurrent() && !shown) ctx.setStatus("", "");
      return ctx.isCurrent() ? { error: { message: describe(err) } } : {};
    }
    if (!ctx.isCurrent()) return {};

    // A reload keeps the old pages on screen until the new version is ready.
    const hadFocus = !!shown?.stage.contains(document.activeElement);
    teardown();

    const stage = mountStage(ctx, "pdf-stage", hadFocus);
    const pages = document.createElement("div");
    pages.className = "pdfViewer";
    stage.append(pages);

    const stop = new AbortController();
    const { signal } = stop;
    const bus = new lib.EventBus();
    const links = new lib.PDFLinkService({
      eventBus: bus,
      externalLinkTarget: lib.LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    const options: ConstructorParameters<typeof lib.PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container: stage,
      viewer: pages,
      eventBus: bus,
      linkService: links,
      // Annotations and form fields drawn as they look, none of them editable.
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      // Stops its scroll and resize listeners (not in the published types).
      abortSignal: signal,
    };
    const viewer = new lib.PDFViewer(options);
    links.setViewer(viewer);
    const current: Shown = { path, version: file.version, stage, viewer, ctx, stop };
    shown = current;

    bus.on("pagesinit", () => {
      const place = places.get(path);
      viewer.currentScaleValue = place?.scale ?? FIT;
      if (place) {
        viewer.scrollPageIntoView({
          pageNumber: Math.min(place.page, viewer.pagesCount),
          destArray: [null, { name: "XYZ" }, place.left, place.top, null],
          allowNegativeOffset: true,
        });
      }
      pushStatus();
    });
    bus.on("pagechanging", pushStatus);
    bus.on("scalechanging", pushStatus);
    bus.on("updateviewarea", ({ location }: { location?: { pageNumber: number; left: number; top: number } }) => {
      if (!location || shown !== current) return;
      places.set(path, { scale: String(viewer.currentScaleValue), page: location.pageNumber, left: location.left, top: location.top });
    });

    // Fitted to the width: keep fitting as the pane is resized (or first gets a size).
    let width = -1;
    let frame = 0;
    const fit = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w === width) return;
      width = w;
      if (!w || viewer.currentScaleValue !== FIT) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => shown === current && (viewer.currentScaleValue = FIT));
    });
    fit.observe(stage);
    signal.addEventListener("abort", () => {
      fit.disconnect();
      cancelAnimationFrame(frame);
    });

    // Pinch (or ⌘/Ctrl + wheel) zooms around the pointer.
    onPinchZoom(stage, signal, (factor, x, y) =>
      viewer.updateScale({ scaleFactor: factor, origin: [x, y], drawingDelay: 250 }),
    );

    viewer.setDocument(doc);
    links.setDocument(doc);
    return {};
  }

  function zoom(step: 1 | -1 | 0): boolean {
    if (!shown?.viewer.pagesCount) return false;
    const v = shown.viewer;
    if (step === 0) v.currentScaleValue = FIT;
    else if (step > 0) v.increaseScale();
    else v.decreaseScale();
    return true;
  }

  return {
    render,
    zoom,
    reset: teardown,
  };
}

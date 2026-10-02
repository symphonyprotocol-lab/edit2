/**
 * HTML preview in a sandboxed iframe, in one of two modes.
 *
 * Default: no scripts. The page comes from `srcdoc` with only
 * `allow-same-origin`, so nothing in it runs, while the editor can still
 * size the frame to its content, catch link clicks and sync scrolling.
 * Local images, styles and fonts it references are exposed one by one.
 *
 * Scripts allowed (per document, off by default): the page is served by the
 * backend's `preview:` protocol into a frame with only `allow-scripts`, i.e.
 * an opaque origin that cannot touch the editor or its IPC. The two sandbox
 * flags are never given together.
 */
import type { PreviewContext, PreviewRenderer } from "../types";

/** Documents whose scripts the user allowed (path, or "" for untitled). Not saved. */
const scriptsOn = new Set<string>();
let lastSource = "";
let version = 0;

const keyOf = (ctx: PreviewContext) => ctx.path ?? "";

/** Toolbar and frame holder, built once per mode so re-renders do not flash. */
function stage(ctx: PreviewContext, live: boolean): HTMLElement {
  const existing = ctx.container.querySelector<HTMLElement>(":scope > .html-stage");
  if (existing && existing.dataset.live === String(live)) return existing;

  const bar = document.createElement("div");
  bar.className = "pv-toolbar html-toolbar";
  const note = document.createElement("span");
  note.className = "html-note";
  note.textContent = live ? "脚本已启用 · 页面在沙箱中运行，链接在预览内不可用" : "脚本已禁用";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn small";
  toggle.dataset.htmlScripts = live ? "off" : "on";
  toggle.textContent = live ? "禁用脚本" : "允许脚本";
  toggle.title = live ? "" : "在隔离的沙箱中运行页面脚本，并加载外部的脚本、样式和字体";
  bar.append(note, toggle);

  const holder = document.createElement("div");
  holder.className = "html-stage";
  holder.dataset.live = String(live);
  ctx.container.classList.toggle("html-live", live);
  ctx.container.replaceChildren(bar, holder);
  return holder;
}

/** Swap in `next` once it has loaded, so edits do not flash an empty frame. */
function mount(holder: HTMLElement, next: HTMLIFrameElement, ctx: PreviewContext, onReady?: () => void) {
  const shown = holder.querySelector("iframe");
  if (shown) next.classList.add("pending");
  next.addEventListener(
    "load",
    () => {
      if (!next.isConnected) return;
      if (!ctx.isCurrent() && holder.querySelector("iframe:not(.pending)")) return void next.remove();
      onReady?.();
      for (const f of holder.querySelectorAll("iframe")) if (f !== next) f.remove();
      next.classList.remove("pending");
      ctx.layoutChanged();
    },
    { once: true },
  );
  holder.append(next);
}

const URL_ATTRS: [string, string][] = [
  ["img[src], source[src], video[src], audio[src], track[src], input[type=image][src]", "src"],
  ["video[poster]", "poster"],
  ['link[rel~="stylesheet" i][href], link[rel~="icon" i][href]', "href"],
];

/** The page without active content, local references pointed at exposed files. */
async function safeHtml(source: string, ctx: PreviewContext): Promise<string> {
  const doc = new DOMParser().parseFromString(source, "text/html");
  doc.querySelectorAll("script, base, meta[http-equiv], iframe, frame, frameset, object, embed").forEach((el) => el.remove());

  const refs: { el: Element; attr: string; path: string }[] = [];
  for (const [selector, attr] of URL_ATTRS) {
    for (const el of doc.querySelectorAll(selector)) {
      const path = ctx.localPath(el.getAttribute(attr) ?? "");
      if (path) refs.push({ el, attr, path });
    }
  }
  const srcsets = [...doc.querySelectorAll("img[srcset], source[srcset]")].map((el) => ({
    el,
    parts: (el.getAttribute("srcset") ?? "").split(",").map((c) => {
      const [url, ...rest] = c.trim().split(/\s+/);
      return { url, rest: rest.join(" "), path: ctx.localPath(url ?? "") };
    }),
  }));
  const paths = [...refs.map((r) => r.path), ...srcsets.flatMap((s) => s.parts.flatMap((p) => (p.path ? [p.path] : [])))];
  const urls = paths.length ? await ctx.assetUrls(paths) : [];
  let i = 0;
  for (const r of refs) r.el.setAttribute(r.attr, urls[i++]);
  for (const s of srcsets) {
    s.el.setAttribute("srcset", s.parts.map((p) => [p.path ? urls[i++] : p.url, p.rest].join(" ").trim()).join(", "));
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

async function renderSafe(source: string, ctx: PreviewContext) {
  const html = await safeHtml(source, ctx);
  if (!ctx.isCurrent()) return;
  const holder = stage(ctx, false);
  const frame = document.createElement("iframe");
  frame.className = "html-frame";
  frame.title = "HTML 预览";
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.srcdoc = html;
  mount(holder, frame, ctx, () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => {
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      if (frame.style.height !== `${h}px`) {
        frame.style.height = `${h}px`;
        ctx.layoutChanged();
      }
    };
    fit();
    try {
      new ResizeObserver(fit).observe(doc.documentElement);
    } catch {
      /* observing another document is not supported: sized once */
    }
    doc.addEventListener("load", fit, true); // late images
    doc.addEventListener(
      "click",
      (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        ctx.openLink(a.getAttribute("href")!, doc);
      },
      true,
    );
  });
}

async function renderLive(source: string, ctx: PreviewContext) {
  const url = await ctx.publishPage(source);
  if (!ctx.isCurrent()) return;
  const holder = stage(ctx, true);
  const frame = document.createElement("iframe");
  frame.className = "html-frame";
  frame.title = "HTML 预览（脚本已启用）";
  frame.setAttribute("sandbox", "allow-scripts");
  if (url) frame.src = `${url}?v=${++version}`;
  else frame.srcdoc = source; // plain browser (development): no preview protocol
  mount(holder, frame, ctx);
}

function render(source: string, ctx: PreviewContext) {
  lastSource = source;
  return (scriptsOn.has(keyOf(ctx)) ? renderLive : renderSafe)(source, ctx).then(() => ({}));
}

export const htmlPreview: PreviewRenderer = {
  render,
  click(e, ctx) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-html-scripts]");
    if (!b) return false;
    if (b.dataset.htmlScripts === "on") scriptsOn.add(keyOf(ctx));
    else scriptsOn.delete(keyOf(ctx));
    render(lastSource, ctx);
    return true;
  },
};

import type { PreviewContext, PreviewRenderer } from "../types";
import { extensionOf } from "../registry";
import { newTreeState, renderTree } from "../shared/tree";
import { asRenderError } from "../shared/tree-preview";
import { parseXml, xmlTree } from "./parse";

let state = newTreeState();
/** SVG files: show the picture (true) or the element tree. */
let asImage: boolean | null = null;

function toolbar(image: boolean): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pv-toolbar";
  const seg = document.createElement("div");
  seg.className = "seg";
  seg.setAttribute("role", "radiogroup");
  for (const [value, label] of [["image", "图片"], ["tree", "元素树"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.svgView = value;
    b.setAttribute("aria-checked", String((value === "image") === image));
    b.textContent = label;
    seg.append(b);
  }
  bar.append(seg);
  return bar;
}

function render(source: string, ctx: PreviewContext) {
  let doc: Document;
  try {
    doc = parseXml(source);
  } catch (err) {
    return asRenderError(err);
  }
  const svg = !!ctx.path && extensionOf(ctx.path) === "svg";
  if (!svg) return { anchors: renderTree(ctx.container, xmlTree(source, doc), { state, onPick: ctx.revealLine }) };

  const image = asImage ?? true;
  const body = document.createElement("div");
  let anchors: { line: number; el: HTMLElement }[] = [];
  if (image) {
    // As an <img>, the SVG cannot run scripts or load anything.
    const img = document.createElement("img");
    img.className = "svg-image";
    img.alt = "SVG 图片";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    body.append(img);
  } else {
    anchors = renderTree(body, xmlTree(source, doc), { state, onPick: ctx.revealLine });
  }
  ctx.container.replaceChildren(toolbar(image), body);
  return { anchors };
}

export const xmlPreview: PreviewRenderer = {
  render,
  click(e) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-svg-view]");
    if (!b) return false;
    asImage = b.dataset.svgView === "image";
    return "rerender";
  },
  reset() {
    state = newTreeState();
    asImage = null;
  },
};

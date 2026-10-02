import type { PreviewContext, PreviewRenderer } from "../types";
import { renderMarkdown } from "./render";
import { cachedDiagram, renderDiagram } from "./mermaid";

/** Last diagram shown at each position, kept on screen while an edit re-renders. */
let shownDiagrams: string[] = [];

function renderDiagrams(container: HTMLElement, ctx: PreviewContext) {
  const blocks = [...container.querySelectorAll<HTMLElement>(".mermaid-block")];
  const previous = shownDiagrams;
  shownDiagrams = [];

  blocks.forEach((block, i) => {
    const source = block.textContent ?? "";
    const show = (svg: string | undefined, error?: string) => {
      let figure = block.querySelector<HTMLElement>(".mermaid-svg");
      if (svg) {
        if (!figure) {
          figure = document.createElement("div");
          figure.className = "mermaid-svg";
          block.prepend(figure);
        }
        figure.innerHTML = svg;
        shownDiagrams[i] = svg;
      }
      block.classList.toggle("has-diagram", !!figure);
      block.querySelector(".mermaid-error")?.remove();
      if (error) {
        const note = document.createElement("div");
        note.className = "mermaid-error";
        note.textContent = `图表语法有误：${error}`;
        block.append(note);
      }
      ctx.layoutChanged();
    };

    const ready = cachedDiagram(source);
    if (ready) return show(ready);
    if (previous[i]) show(previous[i]);
    renderDiagram(source).then(
      (svg) => block.isConnected && show(svg),
      (err) => block.isConnected && show(undefined, String(err?.message ?? err).trim()),
    );
  });
}

/** Local images: only the exact files referenced are exposed to the webview. */
function showLocalImages(container: HTMLElement, ctx: PreviewContext) {
  const images: [HTMLImageElement, string][] = [];
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const path = ctx.localPath(src);
    if (path) images.push([img, path]);
  }
  if (!images.length) return;
  ctx.assetUrls(images.map(([, path]) => path)).then((urls) => {
    if (ctx.isCurrent()) images.forEach(([img], i) => (img.src = urls[i]));
  });
}

function toggleTask(ctx: PreviewContext, line: number) {
  ctx.editSource((doc) => {
    if (line < 0 || line >= doc.lines) return null;
    const l = doc.line(line + 1);
    const m = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(l.text);
    if (!m) return null;
    const from = l.from + m[1].length;
    return { from, to: from + 1, insert: m[2] === " " ? "x" : " " };
  });
}

export const markdownPreview: PreviewRenderer = {
  render(source, ctx) {
    const container = ctx.container;
    container.innerHTML = renderMarkdown(source);
    showLocalImages(container, ctx);
    renderDiagrams(container, ctx);

    const seen = new Set<number>();
    const anchors: { line: number; el: HTMLElement }[] = [];
    for (const el of container.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (seen.has(line)) continue;
      seen.add(line);
      anchors.push({ line, el });
    }
    return { anchors };
  },

  click(e, ctx) {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input.task-box");
    if (!box) return false;
    // The source is the truth: the box only changes via a re-render.
    e.preventDefault();
    toggleTask(ctx, Number(box.dataset.taskLine));
    return true;
  },

  reset() {
    shownDiagrams = [];
  },

  themeChanged() {
    // Diagrams are themed from the palette: draw them afresh.
    shownDiagrams = [];
  },
};

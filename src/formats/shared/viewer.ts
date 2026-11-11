/**
 * Plumbing shared by the read-only viewers of binary files (PDF, images): a
 * scroller of their own over the preview pane, which takes keyboard focus, and
 * pinch / ⌘-wheel zoom around the pointer.
 */
import "./viewer.css";
import type { PreviewContext } from "../types";

/**
 * Put a fresh stage into the preview, replacing what was there. Keyboard
 * scrolling goes to it rather than to the pane beneath.
 */
export function mountStage(ctx: PreviewContext, className: string, hadFocus: boolean): HTMLDivElement {
  const pane = ctx.container.parentElement;
  const stage = document.createElement("div");
  stage.className = `viewer-stage ${className}`;
  stage.tabIndex = -1;
  // main.ts focuses this instead of the pane in Read view.
  stage.dataset.previewFocus = "";
  ctx.container.replaceChildren(stage);
  const active = document.activeElement;
  if (hadFocus || !active || active === document.body || active === pane) stage.focus({ preventScroll: true });
  return stage;
}

/**
 * Pinch on a trackpad (WebKit gesture events, or the ⌃-wheel events other
 * engines send for it) and ⌘/Ctrl + wheel zoom by `factor` around a point.
 */
export function onPinchZoom(
  stage: HTMLElement,
  signal: AbortSignal,
  zoom: (factor: number, x: number, y: number) => void,
) {
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), e.clientX, e.clientY);
    },
    { passive: false, signal },
  );
  // Safari-only events: a pinch reports its scale since it began.
  type Gesture = Event & { scale: number; clientX: number; clientY: number };
  let last = 1;
  stage.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    last = 1;
  }, { signal });
  stage.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as Gesture;
    if (!g.scale || g.scale === last) return;
    zoom(g.scale / last, g.clientX, g.clientY);
    last = g.scale;
  }, { signal });
}

/**
 * Run `change` (a zoom) so that the point of `el` under (x, y) stays under it;
 * the stage's centre by default.
 */
export function keepPoint(stage: HTMLElement, el: HTMLElement, change: () => void, x?: number, y?: number) {
  const box = stage.getBoundingClientRect();
  x ??= box.left + box.width / 2;
  y ??= box.top + box.height / 2;
  const before = el.getBoundingClientRect();
  const fx = before.width ? (x - before.left) / before.width : 0;
  const fy = before.height ? (y - before.top) / before.height : 0;
  change();
  const after = el.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - x;
  stage.scrollTop += after.top + fy * after.height - y;
}

/** Index of the last of `items` whose top is above a line 30% down the stage (the one being read). */
export function currentIndex(stage: HTMLElement, items: ArrayLike<Element>, offsetTop = 0): number {
  const line = stage.getBoundingClientRect().top + stage.clientHeight * 0.3;
  let at = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].getBoundingClientRect().top + offsetTop <= line) at = i;
    else break;
  }
  return at;
}

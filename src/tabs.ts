/**
 * The tab strip in the title bar. Purely presentational: it renders what it
 * is given and reports clicks, closes and drag-reorders through callbacks.
 */

export interface TabItem {
  id: number;
  name: string;
  /** Tooltip, usually the full path. */
  title: string;
  /** Needs attention: a failed save or a deleted file. */
  unsaved: boolean;
  /** Untitled document living in the staging area. */
  draft: boolean;
}

export interface TabBarHandlers {
  activate(id: number): void;
  close(id: number): void;
  move(id: number, toIndex: number): void;
  create(): void;
}

const DRAG_THRESHOLD = 4;

export class TabBar {
  private signature = "";

  constructor(
    private list: HTMLElement,
    newButton: HTMLElement,
    private h: TabBarHandlers,
  ) {
    newButton.addEventListener("click", () => h.create());
    list.addEventListener("pointerdown", this.onPointerDown);
    list.addEventListener("click", (e) => {
      const close = (e.target as HTMLElement).closest<HTMLElement>(".tab-close");
      if (close) h.close(Number(close.closest<HTMLElement>(".tab")!.dataset.id));
    });
    // Middle-click closes, as in browsers.
    list.addEventListener("auxclick", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>(".tab");
      if (tab && e.button === 1) h.close(Number(tab.dataset.id));
    });
  }

  render(items: TabItem[], activeId: number) {
    const signature = JSON.stringify([items, activeId]);
    if (signature === this.signature) return;
    this.signature = signature;

    this.list.replaceChildren(
      ...items.map((item) => {
        const tab = document.createElement("div");
        tab.className = "tab";
        tab.classList.toggle("unsaved", item.unsaved);
        tab.classList.toggle("draft", item.draft);
        tab.dataset.id = String(item.id);
        tab.title = item.title;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(item.id === activeId));

        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = item.name;

        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.tabIndex = -1;
        close.setAttribute("aria-label", item.unsaved ? "关闭标签页（有未保存修改）" : "关闭标签页");

        tab.append(name, close);
        return tab;
      }),
    );
    this.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Activate on press; past a few pixels of movement, drag to reorder. */
  private onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest(".tab-close")) return;
    const pressed = target.closest<HTMLElement>(".tab");
    if (!pressed) return;
    const id = Number(pressed.dataset.id);
    this.h.activate(id);

    // Activation may have re-rendered the strip; work with the fresh nodes.
    const tabs = [...this.list.querySelectorAll<HTMLElement>(".tab")];
    const dragged = tabs.find((t) => Number(t.dataset.id) === id);
    if (!dragged) return;
    const from = tabs.indexOf(dragged);
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const width = rects[from].width;
    const startX = e.clientX;
    let to = from;
    let dragging = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        dragged.setPointerCapture(e.pointerId);
        this.list.classList.add("dragging");
        dragged.classList.add("lifted");
      }
      const center = rects[from].left + width / 2 + dx;
      to = rects.filter((r, i) => i !== from && r.left + r.width / 2 < center).length;
      dragged.style.transform = `translateX(${dx}px)`;
      tabs.forEach((t, i) => {
        if (t === dragged) return;
        const shift = from < to && i > from && i <= to ? -width : to < from && i >= to && i < from ? width : 0;
        t.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };

    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!dragging) return;
      this.list.classList.remove("dragging");
      tabs.forEach((t) => {
        t.style.transform = "";
        t.classList.remove("lifted");
      });
      if (to !== from) this.h.move(id, to);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
}

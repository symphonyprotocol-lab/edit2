/**
 * A small menu that pops up from a status bar button. Keyboard: arrows move,
 * Enter picks, Escape closes.
 */

export type MenuEntry =
  | { label: string; run: () => void; checked?: boolean; disabled?: boolean; hint?: string }
  | { heading: string }
  | "-";

let open: { el: HTMLElement; close: () => void } | null = null;

export function closeMenu() {
  open?.close();
}

export function showMenu(anchor: HTMLElement, entries: MenuEntry[]) {
  const wasOpenHere = open?.el.dataset.anchor === anchor.id;
  closeMenu();
  if (wasOpenHere) return; // a second click on the button closes it

  const el = document.createElement("div");
  el.className = "popup";
  el.setAttribute("role", "menu");
  el.dataset.anchor = anchor.id;

  for (const entry of entries) {
    if (entry === "-") {
      el.append(Object.assign(document.createElement("div"), { className: "popup-sep" }));
    } else if ("heading" in entry) {
      el.append(Object.assign(document.createElement("div"), { className: "popup-heading", textContent: entry.heading }));
    } else {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "popup-item";
      item.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (entry.checked !== undefined) item.setAttribute("aria-checked", String(entry.checked));
      item.disabled = !!entry.disabled;
      const label = Object.assign(document.createElement("span"), { className: "popup-label", textContent: entry.label });
      item.append(label);
      if (entry.hint) item.append(Object.assign(document.createElement("span"), { className: "popup-hint", textContent: entry.hint }));
      item.addEventListener("click", () => {
        close();
        entry.run();
      });
      el.append(item);
    }
  }

  document.body.append(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(a.right - r.width, window.innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, a.top - r.height - 6)}px`;
  anchor.setAttribute("aria-expanded", "true");

  const items = () => [...el.querySelectorAll<HTMLButtonElement>(".popup-item:not(:disabled)")];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    }
  };
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  function close() {
    el.remove();
    anchor.setAttribute("aria-expanded", "false");
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("blur", close);
    if (open?.el === el) open = null;
  }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("blur", close);
  open = { el, close };
  (el.querySelector<HTMLButtonElement>('.popup-item[aria-checked="true"]:not(:disabled)') ?? items()[0])?.focus();
}

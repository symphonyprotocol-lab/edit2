/**
 * The folder tree in the sidebar. It lists one level at a time (a folder's
 * children are read when it is expanded, and read again each time) and
 * reports clicks on files through a callback; opening them is main.ts's job.
 */
import type { DirEntry } from "./host";

export interface FolderTreeHandlers {
  /** List one folder, folders first. */
  list(path: string, showHidden: boolean): Promise<DirEntry[]>;
  openFile(path: string): void;
}

type Listing = DirEntry[] | { error: string };

/** One visible line of the tree. */
interface Row {
  entry: DirEntry;
  depth: number;
}

export class FolderTree {
  root: string | null = null;
  showHidden = false;
  /** Folders shown open (the root always is). */
  private expanded = new Set<string>();
  /** Last listing of each folder that has been read. */
  private listings = new Map<string, Listing>();
  /** Folders being read right now. */
  private loading = new Set<string>();
  private rows: Row[] = [];
  private els = new Map<string, HTMLElement>();
  private active: string | null = null;
  /** The row that holds the keyboard focus stop. */
  private focusPath: string | null = null;
  /** Bumped when another folder is opened, to drop late listings of the old one. */
  private generation = 0;

  constructor(
    private el: HTMLElement,
    private h: FolderTreeHandlers,
  ) {
    el.setAttribute("role", "tree");
    el.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ft-row");
      if (row?.dataset.path) this.activateRow(row.dataset.path, true);
    });
    el.addEventListener("keydown", this.onKey);
  }

  /** Show `root`'s contents. Rejects if the folder cannot be read. */
  async open(root: string) {
    this.generation++;
    this.root = root;
    this.expanded = new Set([root]);
    this.listings.clear();
    this.focusPath = null;
    const listing = await this.read(root);
    if ("error" in listing) {
      this.root = null;
      throw new Error(listing.error);
    }
    this.render();
  }

  close() {
    this.generation++;
    this.root = null;
    this.expanded.clear();
    this.listings.clear();
    this.render();
  }

  /** Read every open folder again (e.g. the window came back to the front). */
  async refresh() {
    if (!this.root) return;
    const gen = this.generation;
    const open = [...this.expanded];
    await Promise.all(open.map((p) => this.read(p, false)));
    if (gen !== this.generation) return;
    // Forget folders that are gone, so they do not reopen if they come back.
    for (const p of open) {
      const l = this.listings.get(p);
      if (p !== this.root && l && "error" in l) this.expanded.delete(p);
    }
    this.render();
  }

  setShowHidden(on: boolean) {
    if (this.showHidden === on) return;
    this.showHidden = on;
    this.refresh();
  }

  /** Highlight the file of the active tab, if it is in view. */
  setActive(path: string | null) {
    if (path === this.active) return;
    this.els.get(this.active ?? "")?.classList.remove("active");
    this.active = path;
    const row = this.els.get(path ?? "");
    if (!row) return;
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest" });
  }

  focus() {
    (this.els.get(this.focusPath ?? "") ?? this.el.querySelector<HTMLElement>(".ft-row"))?.focus();
  }

  // ---------- internals ----------

  private async read(path: string, rerender = true): Promise<Listing> {
    const gen = this.generation;
    this.loading.add(path);
    if (rerender && this.listings.has(path)) this.markLoading(path);
    let listing: Listing;
    try {
      listing = await this.h.list(path, this.showHidden);
    } catch (err) {
      listing = { error: String(err) };
    }
    if (gen !== this.generation) return listing;
    this.loading.delete(path);
    this.listings.set(path, listing);
    if (rerender) this.render();
    return listing;
  }

  private markLoading(path: string) {
    this.els.get(path)?.classList.add("loading");
  }

  /** A click or Enter on a row: open a file, expand or collapse a folder. */
  private activateRow(path: string, byPointer: boolean) {
    const row = this.rows.find((r) => r.entry.path === path);
    if (!row) return;
    this.focusPath = path;
    if (!row.entry.dir) return this.h.openFile(path);
    this.setExpanded(path, !this.expanded.has(path));
    if (!byPointer) this.focus();
  }

  private setExpanded(path: string, open: boolean) {
    if (open) {
      this.expanded.add(path);
      // Show what was there last time at once; the fresh read replaces it.
      this.render();
      this.read(path);
    } else {
      this.expanded.delete(path);
      this.render();
    }
  }

  private collectRows(dir: string, depth: number, out: Row[]) {
    const listing = this.listings.get(dir);
    if (!listing || "error" in listing) return;
    for (const entry of listing) {
      out.push({ entry, depth });
      if (entry.dir && this.expanded.has(entry.path)) this.collectRows(entry.path, depth + 1, out);
    }
  }

  private render() {
    const hadFocus = this.el.contains(document.activeElement);
    this.rows = [];
    this.els.clear();
    if (!this.root) {
      this.el.replaceChildren();
      return;
    }
    this.collectRows(this.root, 0, this.rows);
    if (!this.rows.some((r) => r.entry.path === this.focusPath)) this.focusPath = this.rows[0]?.entry.path ?? null;

    const nodes: HTMLElement[] = [];
    for (const { entry, depth } of this.rows) {
      const row = document.createElement("div");
      row.className = entry.dir ? "ft-row dir" : "ft-row file";
      row.dataset.path = entry.path;
      row.title = entry.path;
      row.style.setProperty("--depth", String(depth));
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.tabIndex = entry.path === this.focusPath ? 0 : -1;
      if (entry.path === this.active) row.classList.add("active");
      if (entry.dir) {
        const open = this.expanded.has(entry.path);
        row.setAttribute("aria-expanded", String(open));
        if (open && this.loading.has(entry.path)) row.classList.add("loading");
      }
      const chev = document.createElement("span");
      chev.className = "ft-chev";
      chev.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "ft-name";
      name.textContent = entry.name;
      row.append(chev, name);
      nodes.push(row);
      this.els.set(entry.path, row);

      // A folder that could not be read, or has nothing to show.
      const listing = entry.dir && this.expanded.has(entry.path) ? this.listings.get(entry.path) : undefined;
      if (listing && ("error" in listing || listing.length === 0)) {
        const note = document.createElement("div");
        note.className = "ft-note";
        note.style.setProperty("--depth", String(depth + 1));
        note.textContent = "error" in listing ? "无法读取" : "空文件夹";
        if ("error" in listing) note.title = listing.error;
        nodes.push(note);
      }
    }
    const rootListing = this.listings.get(this.root);
    if (rootListing && !("error" in rootListing) && rootListing.length === 0) {
      nodes.push(Object.assign(document.createElement("div"), { className: "ft-note", textContent: "空文件夹" }));
    }
    this.el.replaceChildren(...nodes);
    if (hadFocus) this.focus();
  }

  private parentRow(i: number): number {
    const depth = this.rows[i].depth;
    for (let j = i - 1; j >= 0; j--) if (this.rows[j].depth < depth) return j;
    return -1;
  }

  private onKey = (e: KeyboardEvent) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>(".ft-row");
    if (!current || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = this.rows.findIndex((r) => r.entry.path === current.dataset.path);
    if (i < 0) return;
    const row = this.rows[i];
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(this.rows.length - 1, i + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, i - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = this.rows.length - 1;
        break;
      case "ArrowRight":
        if (!row.entry.dir) break;
        if (!this.expanded.has(row.entry.path)) this.setExpanded(row.entry.path, true);
        else if (this.rows[i + 1]?.depth === row.depth + 1) next = i + 1;
        break;
      case "ArrowLeft":
        if (row.entry.dir && this.expanded.has(row.entry.path)) this.setExpanded(row.entry.path, false);
        else next = this.parentRow(i);
        break;
      case "Enter":
      case " ":
        this.activateRow(row.entry.path, false);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next < 0) return;
    this.focusPath = this.rows[next].entry.path;
    for (const el of this.els.values()) el.tabIndex = -1;
    const el = this.els.get(this.focusPath)!;
    el.tabIndex = 0;
    el.focus();
  };
}

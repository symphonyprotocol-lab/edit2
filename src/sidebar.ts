/**
 * The folder tree in the sidebar. It lists one level at a time (a folder's
 * children are read when it is expanded, and read again each time) and
 * reports clicks on files through a callback; opening them is main.ts's job.
 * New files and folders are named in an input shown in place in the tree.
 */
import type { DirEntry } from "./host";

export interface FolderTreeHandlers {
  /** List one folder, folders first. */
  list(path: string, showHidden: boolean): Promise<DirEntry[]>;
  openFile(path: string): void;
  /** Make an empty file or folder; resolves to its path. */
  create(parent: string, name: string, dir: boolean): Promise<string>;
  /** Right-click on a row (`path`) or on empty space (null). */
  contextMenu(path: string | null, at: { x: number; y: number }): void;
  /** Something went wrong where there is no place in the tree to say it. */
  error(message: string): void;
}

/** Name offered for a new entry; for a file only the part before the extension is selected. */
const NEW_FILE_NAME = "未命名.md";
const NEW_FOLDER_NAME = "新建文件夹";

/** The new file or folder being named. */
interface Creating {
  parent: string;
  dir: boolean;
  /** Holds the input row and the line under it for errors. */
  box: HTMLElement;
  input: HTMLInputElement;
  errorEl: HTMLElement;
  busy: boolean;
}

type Listing = DirEntry[] | { error: string };

/** One visible line of the tree. */
interface Row {
  entry: DirEntry;
  depth: number;
  /** The folder it is listed in. */
  parent: string;
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
  private creating: Creating | null = null;
  /** Set while the tree's nodes are replaced, when a blur is not the user leaving the input. */
  private rerendering = false;

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
    el.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".ft-create")) return; // the input's own menu
      e.preventDefault();
      const target = e.target as HTMLElement;
      // A row, or the "empty"/"unreadable" note under a folder, meaning that folder.
      const path = target.closest<HTMLElement>(".ft-row")?.dataset.path ?? target.closest<HTMLElement>(".ft-note")?.dataset.folder ?? null;
      if (path && this.els.has(path)) this.moveFocusStop(path);
      this.h.contextMenu(path, { x: e.clientX, y: e.clientY });
    });
  }

  /** Show `root`'s contents. Rejects if the folder cannot be read. */
  async open(root: string) {
    this.generation++;
    this.creating = null;
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
    this.creating = null;
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

  /**
   * Start naming a new file (or folder, with `dir`). It goes into `target`
   * if that is a folder, beside it if it is a file; with no target, next to
   * the row last clicked or moved to, or at the top of the tree.
   */
  startCreate(dir: boolean, target: string | null = this.focusPath) {
    if (!this.root) return;
    const row = target ? this.rows.find((r) => r.entry.path === target) : undefined;
    const parent = row ? (row.entry.dir ? row.entry.path : row.parent) : this.root;
    this.cancelCreate(false);

    const box = document.createElement("div");
    box.className = "ft-create";
    const line = document.createElement("div");
    line.className = dir ? "ft-edit dir" : "ft-edit file";
    const chev = Object.assign(document.createElement("span"), { className: "ft-chev" });
    chev.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.className = "ft-input";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", dir ? "新文件夹的名称" : "新文件的名称（含后缀）");
    input.value = dir ? NEW_FOLDER_NAME : NEW_FILE_NAME;
    line.append(chev, input);
    const errorEl = Object.assign(document.createElement("div"), { className: "ft-note ft-error" });
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;
    box.append(line, errorEl);
    const c: Creating = { parent, dir, box, input, errorEl, busy: false };
    this.creating = c;

    // Enter and Escape are the input's; other keys (app shortcuts) go on as usual.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.commitCreate(c, true);
      } else if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelCreate(true);
      }
    });
    input.addEventListener("input", () => this.showCreateError(c, ""));
    const offered = input.value;
    input.addEventListener("blur", () => {
      if (this.rerendering || this.creating !== c || c.busy) return;
      // The window went to the back: keep the input as it is for when it returns.
      if (!document.hasFocus()) return;
      // Clicking elsewhere keeps a name the user typed, as Enter would; the
      // name we offered is never made without Enter.
      const value = c.input.value.trim();
      if (value && value !== offered) this.commitCreate(c, false);
      else this.cancelCreate(false);
    });

    if (parent !== this.root && !this.expanded.has(parent)) this.setExpanded(parent, true);
    else this.render();
    input.focus();
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dir || dot <= 0 ? input.value.length : dot);
  }

  // ---------- internals ----------

  private cancelCreate(refocus: boolean) {
    if (!this.creating) return;
    this.creating = null;
    this.render();
    if (refocus) this.focus();
  }

  private showCreateError(c: Creating, message: string) {
    c.errorEl.textContent = message;
    c.errorEl.hidden = !message;
    c.input.classList.toggle("invalid", !!message);
  }

  /** Make the entry. After an error, stay in the input if the user pressed Enter, else give up and say why. */
  private async commitCreate(c: Creating, stay: boolean) {
    const name = c.input.value.trim();
    if (!name) {
      if (stay) this.showCreateError(c, "请输入名称");
      else this.cancelCreate(false);
      return;
    }
    const gen = this.generation;
    c.busy = true;
    c.input.readOnly = true;
    let path: string;
    try {
      path = await this.h.create(c.parent, name, c.dir);
    } catch (err) {
      c.busy = false;
      c.input.readOnly = false;
      if (this.creating !== c) return;
      const message = String(err).replace(/^Error:\s*/, "");
      if (stay) {
        this.showCreateError(c, message);
        c.input.focus();
      } else {
        this.cancelCreate(false);
        this.h.error(`无法新建${c.dir ? "文件夹" : "文件"}：${message}`);
      }
      return;
    }
    // Another new entry may be being named by now: then leave the focus with it.
    const superseded = this.creating !== c;
    if (!superseded) this.creating = null;
    if (gen !== this.generation) return;
    const listing = await this.read(c.parent);
    if (gen !== this.generation) return;
    const shown = !("error" in listing) && listing.some((e) => e.path === path);
    if (!shown) this.h.error(`已新建“${name}”。它是隐藏的，打开“显示隐藏文件”才能在边栏看到`);
    if (superseded && this.creating) return;
    if (shown) this.focusPath = path;
    if (!c.dir) this.h.openFile(path);
    else if (shown) this.focus();
  }

  /** Make `path`'s row the one Tab lands on. */
  private moveFocusStop(path: string) {
    this.focusPath = path;
    for (const [p, el] of this.els) el.tabIndex = p === path ? 0 : -1;
  }

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
      out.push({ entry, depth, parent: dir });
      if (entry.dir && this.expanded.has(entry.path)) this.collectRows(entry.path, depth + 1, out);
    }
  }

  private render() {
    const hadFocus = this.el.contains(document.activeElement);
    const creating = this.creating;
    const editing = !!creating && document.activeElement === creating.input;
    const selection = creating && [creating.input.selectionStart, creating.input.selectionEnd, creating.input.selectionDirection] as const;
    this.rows = [];
    this.els.clear();
    if (!this.root) {
      this.el.replaceChildren();
      return;
    }
    this.collectRows(this.root, 0, this.rows);
    if (!this.rows.some((r) => r.entry.path === this.focusPath)) this.focusPath = this.rows[0]?.entry.path ?? null;

    const nodes: HTMLElement[] = [];
    const placeCreate = (depth: number) => {
      creating!.box.style.setProperty("--depth", String(depth));
      nodes.push(creating!.box);
    };
    if (creating?.parent === this.root) placeCreate(0);
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
      if (creating?.parent === entry.path && entry.dir && this.expanded.has(entry.path)) placeCreate(depth + 1);

      // A folder that could not be read, or has nothing to show.
      const listing = entry.dir && this.expanded.has(entry.path) ? this.listings.get(entry.path) : undefined;
      if (listing && ("error" in listing || (listing.length === 0 && creating?.parent !== entry.path))) {
        const note = document.createElement("div");
        note.className = "ft-note";
        note.style.setProperty("--depth", String(depth + 1));
        note.dataset.folder = entry.path;
        note.textContent = "error" in listing ? "无法读取" : "空文件夹";
        if ("error" in listing) note.title = listing.error;
        nodes.push(note);
      }
    }
    const rootListing = this.listings.get(this.root);
    if (rootListing && !("error" in rootListing) && rootListing.length === 0 && creating?.parent !== this.root) {
      nodes.push(Object.assign(document.createElement("div"), { className: "ft-note", textContent: "空文件夹" }));
    }
    // A new entry's folder that is no longer shown (e.g. it was deleted): give up.
    if (creating && !nodes.includes(creating.box)) this.creating = null;
    this.rerendering = true;
    try {
      this.el.replaceChildren(...nodes);
    } finally {
      this.rerendering = false;
    }
    if (this.creating && (editing || !hadFocus)) {
      if (editing) {
        this.creating.input.focus();
        if (selection) this.creating.input.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
      }
    } else if (hadFocus) this.focus();
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
    this.moveFocusStop(this.rows[next].entry.path);
    this.els.get(this.focusPath!)!.focus();
  };
}

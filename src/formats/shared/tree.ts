/**
 * A collapsible tree for structured data (JSON, YAML, TOML, XML). Children are
 * only built when a node is opened, and long child lists are shown in pages,
 * so large documents stay quick. Which nodes are open survives re-renders.
 */

export type TreeKind =
  | "object" | "array" | "string" | "number" | "boolean" | "null" | "date"
  | "element" | "text" | "comment" | "cdata" | "pi" | "doc";

export interface TreeNode {
  /** Property name, array index or element name. */
  key?: string;
  kind: TreeKind;
  /** Display text for leaves (numbers keep their source spelling). */
  value?: string;
  children?: TreeNode[];
  /** XML attributes. */
  attrs?: [string, string][];
  /** 0-based source line, when known. */
  line?: number;
}

const PAGE = 300;
const OPEN_DEPTH = 2;
const MAX_VALUE = 240;

export interface TreeState {
  /** Paths the user opened or closed, overriding the default depth. */
  opened: Set<string>;
  closed: Set<string>;
}

export const newTreeState = (): TreeState => ({ opened: new Set(), closed: new Set() });

export interface TreeOptions {
  state: TreeState;
  /** Called with the source line of a clicked row. */
  onPick?: (line: number) => void;
}

const isBranch = (n: TreeNode) => !!n.children && (n.kind === "object" || n.kind === "array" || n.kind === "element" || n.kind === "doc");

function summary(n: TreeNode): string {
  const count = n.children?.length ?? 0;
  if (n.kind === "array") return `[ ${count} 项 ]`;
  if (n.kind === "object") return `{ ${count} 个键 }`;
  if (n.kind === "doc") return `${count} 项`;
  return "";
}

/**
 * Render `roots` into `container` (replacing its content) and return the rows
 * that carry a source line, for scroll sync.
 */
export function renderTree(container: HTMLElement, roots: TreeNode[], opts: TreeOptions) {
  const anchors: { line: number; el: HTMLElement }[] = [];
  const tree = document.createElement("div");
  tree.className = "tree";
  tree.setAttribute("role", "tree");

  const isOpen = (path: string, depth: number) =>
    opts.state.opened.has(path) || (depth < OPEN_DEPTH && !opts.state.closed.has(path));

  function row(node: TreeNode, path: string, depth: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "tree-item";
    item.setAttribute("role", "treeitem");
    item.dataset.path = path;

    const head = document.createElement("div");
    head.className = "tree-row";
    head.tabIndex = -1;
    head.style.setProperty("--depth", String(depth));
    if (node.line !== undefined) {
      head.dataset.line = String(node.line);
      anchors.push({ line: node.line, el: head });
    }

    const branch = isBranch(node) && node.children!.length > 0;
    const caret = document.createElement("span");
    caret.className = branch ? "tree-caret" : "tree-caret leaf";
    head.append(caret);

    if (node.kind === "element") {
      const tag = document.createElement("span");
      tag.className = "t-tag";
      tag.textContent = `<${node.key}`;
      head.append(tag);
      for (const [name, value] of node.attrs ?? []) {
        const a = document.createElement("span");
        a.className = "t-attr";
        a.append(document.createTextNode(` ${name}=`));
        const v = document.createElement("span");
        v.className = "t-string";
        v.textContent = `"${value}"`;
        a.append(v);
        head.append(a);
      }
      const close = document.createElement("span");
      close.className = "t-tag";
      if (branch || node.value === undefined) {
        close.textContent = branch ? ">" : " />";
        head.append(close);
      } else {
        // <tag>text</tag> on one row
        close.textContent = ">";
        const text = document.createElement("span");
        text.className = "t-text";
        text.textContent = node.value.length > MAX_VALUE ? `${node.value.slice(0, MAX_VALUE)}…` : node.value;
        if (node.value.length > MAX_VALUE) text.title = node.value;
        head.append(close, text, Object.assign(document.createElement("span"), { className: "t-tag", textContent: `</${node.key}>` }));
      }
    } else {
      if (node.key !== undefined) {
        const key = document.createElement("span");
        key.className = /^\d+$/.test(node.key) && depth > 0 ? "t-index" : "t-key";
        key.textContent = node.key;
        head.append(key);
        if (node.kind !== "text" && node.kind !== "comment" && node.kind !== "cdata") {
          head.append(Object.assign(document.createElement("span"), { className: "t-colon", textContent: ": " }));
        }
      }
      if (isBranch(node)) {
        head.append(Object.assign(document.createElement("span"), { className: "t-summary", textContent: summary(node) }));
      } else {
        const v = document.createElement("span");
        v.className = `t-${node.kind}`;
        let text = node.value ?? "";
        if (node.kind === "string") text = JSON.stringify(text);
        if (node.kind === "comment") text = `<!-- ${text} -->`;
        if (node.kind === "cdata") text = `<![CDATA[${text}]]>`;
        if (text.length > MAX_VALUE) {
          v.title = text;
          text = `${text.slice(0, MAX_VALUE)}…`;
        }
        v.textContent = text;
        head.append(v);
      }
    }
    item.append(head);

    if (branch) {
      const open = isOpen(path, depth);
      item.setAttribute("aria-expanded", String(open));
      if (open) item.append(childList(node, path, depth));
    }
    return item;
  }

  function childList(node: TreeNode, path: string, depth: number, from = 0): HTMLElement {
    const group = document.createElement("div");
    group.className = "tree-group";
    group.setAttribute("role", "group");
    appendPage(group, node, path, depth, from);
    return group;
  }

  function appendPage(group: HTMLElement, node: TreeNode, path: string, depth: number, from: number) {
    const kids = node.children!;
    const to = Math.min(kids.length, from + PAGE);
    for (let i = from; i < to; i++) group.append(row(kids[i], `${path}/${i}`, depth + 1));
    if (to < kids.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "tree-more";
      more.style.setProperty("--depth", String(depth + 1));
      more.textContent = `显示更多（还有 ${(kids.length - to).toLocaleString()} 项）`;
      more.addEventListener("click", () => {
        more.remove();
        appendPage(group, node, path, depth, to);
      });
      group.append(more);
    }
  }

  // Rebuild a node's children when it is opened (anchors for them are not
  // tracked; scroll sync re-measures on the next render).
  function toggle(item: HTMLElement, open?: boolean) {
    if (!item.hasAttribute("aria-expanded")) return;
    const now = item.getAttribute("aria-expanded") === "true";
    const next = open ?? !now;
    if (next === now) return;
    const path = item.dataset.path!;
    const depth = path.split("/").length - 2;
    (next ? opts.state.opened : opts.state.closed).add(path);
    (next ? opts.state.closed : opts.state.opened).delete(path);
    item.setAttribute("aria-expanded", String(next));
    if (next) item.append(childList(nodeAt(path)!, path, depth));
    else item.querySelector(":scope > .tree-group")?.remove();
  }

  function nodeAt(path: string): TreeNode | undefined {
    const [, ...steps] = path.split("/");
    let node: TreeNode | undefined = roots[Number(steps.shift())];
    for (const step of steps) node = node?.children?.[Number(step)];
    return node;
  }

  tree.addEventListener("click", (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!head) return;
    const item = head.parentElement!;
    toggle(item);
    head.focus({ preventScroll: true });
    if (head.dataset.line) opts.onPick?.(Number(head.dataset.line));
  });

  tree.addEventListener("keydown", (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!head) return;
    const item = head.parentElement!;
    const rows = [...tree.querySelectorAll<HTMLElement>(".tree-row")];
    const i = rows.indexOf(head);
    const go = (el?: HTMLElement) => {
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") go(rows[i + 1]);
    else if (e.key === "ArrowUp") go(rows[i - 1]);
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (item.getAttribute("aria-expanded") === "false") toggle(item, true);
      else go(item.querySelector<HTMLElement>(":scope > .tree-group .tree-row") ?? undefined);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (item.getAttribute("aria-expanded") === "true") toggle(item, false);
      else go(item.parentElement?.closest(".tree-item")?.querySelector<HTMLElement>(":scope > .tree-row") ?? undefined);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(item);
    }
  });

  roots.forEach((node, i) => tree.append(row(node, `/${i}`, 0)));
  tree.querySelector<HTMLElement>(".tree-row")?.setAttribute("tabindex", "0");
  container.replaceChildren(tree);
  return anchors;
}

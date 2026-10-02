import type { PreviewContext, PreviewRenderer } from "../types";
import { delimiterName, detectDelimiter, parseCsv } from "./parse";

const PAGE = 500;
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;

/** Whether the first row is a header, per file. */
const headers = new Map<string, boolean>();
let shown = PAGE;
let observer: IntersectionObserver | null = null;

function render(source: string, ctx: PreviewContext) {
  observer?.disconnect();
  const delimiter = detectDelimiter(source);
  const { rows, lines, columns } = parseCsv(source, delimiter);
  const key = ctx.path ?? "";
  const header = headers.get(key) ?? true;
  const body = header ? rows.slice(1) : rows;
  const bodyLines = header ? lines.slice(1) : lines;

  const bar = document.createElement("div");
  bar.className = "pv-toolbar csv-toolbar";
  const info = document.createElement("span");
  info.className = "csv-info";
  info.textContent = `${body.length.toLocaleString()} 行${header ? "数据" : ""} × ${columns} 列 · 分隔符：${delimiterName(delimiter)}`;
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = header;
  box.dataset.csvHeader = "";
  label.append(box, "第一行是表头");
  bar.append(info, label);

  const table = document.createElement("table");
  table.className = "csv-table";
  const anchors: { line: number; el: HTMLElement }[] = [];
  if (header && rows.length) {
    const thead = table.createTHead();
    const tr = thead.insertRow();
    tr.dataset.line = String(lines[0]);
    anchors.push({ line: lines[0], el: tr });
    tr.append(Object.assign(document.createElement("th"), { className: "csv-n", textContent: "#" }));
    for (let c = 0; c < columns; c++) {
      tr.append(Object.assign(document.createElement("th"), { textContent: rows[0][c] ?? "" }));
    }
  }
  const tbody = table.createTBody();

  let next = 0;
  const addRows = (count: number) => {
    const end = Math.min(body.length, next + count);
    for (; next < end; next++) {
      const tr = tbody.insertRow();
      tr.dataset.line = String(bodyLines[next]);
      anchors.push({ line: bodyLines[next], el: tr });
      const n = document.createElement("td");
      n.className = "csv-n";
      n.textContent = String(next + 1);
      tr.append(n);
      const cells = body[next];
      for (let c = 0; c < columns; c++) {
        const td = document.createElement("td");
        const text = cells[c] ?? "";
        td.textContent = text;
        if (text.length > 60) td.title = text;
        if (text && NUMBER.test(text.trim())) td.className = "num";
        tr.append(td);
      }
    }
    shown = Math.max(shown, next);
    return next < body.length;
  };
  addRows(shown);

  const wrap = document.createElement("div");
  wrap.className = "csv-wrap";
  wrap.append(table);
  ctx.container.replaceChildren(bar, wrap);

  // Long files: add rows as the end of the table scrolls into view.
  if (next < body.length) {
    const more = document.createElement("div");
    more.className = "csv-more";
    more.textContent = `还有 ${(body.length - next).toLocaleString()} 行…`;
    ctx.container.append(more);
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || !ctx.isCurrent()) return;
      if (addRows(PAGE)) more.textContent = `还有 ${(body.length - next).toLocaleString()} 行…`;
      else {
        more.remove();
        observer?.disconnect();
      }
      ctx.layoutChanged();
    }, { rootMargin: "600px" });
    observer.observe(more);
  }
  return { anchors };
}

export const csvPreview: PreviewRenderer = {
  render,
  click(e, ctx) {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-csv-header]");
    if (!box) return false;
    headers.set(ctx.path ?? "", box.checked);
    return "rerender";
  },
  reset() {
    shown = PAGE;
    observer?.disconnect();
  },
};

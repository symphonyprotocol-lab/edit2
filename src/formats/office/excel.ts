/**
 * Excel viewer: one sheet at a time as a table with column letters and row
 * numbers that stay in view, merged cells spanning, and rows added as you
 * scroll. Values are those saved with the file (formulas are not recomputed).
 * Read-only. Files are read by SheetJS (workbook.ts), loaded with this viewer.
 */
import "./office.css";
import { keepPoint, mountStage, onPinchZoom } from "../shared/viewer";
import { columnName, readWorkbook, type Sheet } from "./workbook";
import { describe, toolbar } from "./common";
import type { PreviewContext, PreviewRenderer } from "../types";

const PAGE = 500;
const MIN = 0.3;
const MAX = 3;
const STEP = 1.15;

/** Per file: the sheet shown and the zoom. */
const places = new Map<string, { sheet: number; scale: number }>();

interface Shown {
  path: string;
  version: string;
  stage: HTMLDivElement;
  sheets: Sheet[];
  sheet: number;
  scale: number;
  wrap: HTMLElement | null;
  tabs: HTMLElement | null;
  bar: HTMLElement | null;
  ctx: PreviewContext;
  stop: AbortController;
  /** Stops the current sheet's lazy rows. */
  more: IntersectionObserver | null;
}

/** A renderer of its own for each column: what it shows is kept per instance. */
export function excelPreview(): PreviewRenderer {
  let shown: Shown | null = null;

  function pushStatus() {
    if (!shown) return;
    const s = shown;
    const sheet = s.sheets[s.sheet];
    const rows = sheet ? sheet.rows.length : 0;
    s.ctx.setStatus(
      `工作表 ${s.sheet + 1} / ${s.sheets.length}${sheet ? ` · ${sheet.name}` : ""}`,
      `${rows.toLocaleString()} 行 × ${sheet?.columns ?? 0} 列 · Excel · ${Math.round(s.scale * 100)}%`,
    );
  }

  function remember(s: Shown) {
    places.set(s.path, { sheet: s.sheet, scale: s.scale });
  }

  function teardown() {
    if (!shown) return;
    remember(shown);
    shown.more?.disconnect();
    shown.stop.abort();
    shown.stage.remove();
    shown = null;
  }

  /** Column letters stick below the bar; lengths inside the zoomed table are zoomed too. */
  function stickBelowBar(s: Shown) {
    s.stage.style.setProperty("--bar-h", `${(s.bar?.offsetHeight ?? 0) / s.scale}px`);
  }

  /** The table for one sheet, its rows added in pages as the end comes into view. */
  function sheetTable(s: Shown, sheet: Sheet): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "xl-wrap";
    if (!sheet.columns) {
      wrap.append(Object.assign(document.createElement("p"), { className: "xl-empty", textContent: "这个工作表是空的" }));
      return wrap;
    }
    // Cells hidden under a merge, and the spans of the merges' first cells.
    const covered = new Set<string>();
    const spans = new Map<string, [number, number]>();
    for (const m of sheet.merges) {
      spans.set(`${m.row}:${m.col}`, [m.rows, m.cols]);
      for (let r = m.row; r < m.row + m.rows; r++)
        for (let c = m.col; c < m.col + m.cols; c++) if (r !== m.row || c !== m.col) covered.add(`${r}:${c}`);
    }

    const table = document.createElement("table");
    table.className = "csv-table xl-table";
    const head = table.createTHead().insertRow();
    head.append(Object.assign(document.createElement("th"), { className: "csv-n" }));
    for (let c = 0; c < sheet.columns; c++) head.append(Object.assign(document.createElement("th"), { textContent: columnName(c) }));
    const body = table.createTBody();
    let next = 0;
    const add = (count: number) => {
      const end = Math.min(sheet.rows.length, next + count);
      for (; next < end; next++) {
        const tr = body.insertRow();
        tr.append(Object.assign(document.createElement("td"), { className: "csv-n", textContent: String(next + 1) }));
        const cells = sheet.rows[next] ?? [];
        for (let c = 0; c < sheet.columns; c++) {
          const key = `${next}:${c}`;
          if (covered.has(key)) continue;
          const td = document.createElement("td");
          const text = cells[c] ?? "";
          td.textContent = text;
          if (text.length > 60) td.title = text;
          if (sheet.numeric.has(key)) td.className = "num";
          const span = spans.get(key);
          if (span) {
            td.rowSpan = span[0];
            td.colSpan = span[1];
            td.classList.add("merged");
          }
          tr.append(td);
        }
      }
      return next < sheet.rows.length;
    };
    add(PAGE);
    wrap.append(table);
    if (next < sheet.rows.length) {
      const more = document.createElement("div");
      more.className = "csv-more";
      const label = () => (more.textContent = `还有 ${(sheet.rows.length - next).toLocaleString()} 行…`);
      label();
      wrap.append(more);
      s.more = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (add(PAGE)) label();
        else {
          more.remove();
          s.more?.disconnect();
        }
      }, { root: s.stage, rootMargin: "600px" });
      s.more.observe(more);
    }
    return wrap;
  }

  function showSheet(s: Shown, index: number) {
    s.more?.disconnect();
    s.more = null;
    s.sheet = Math.max(0, Math.min(s.sheets.length - 1, index));
    const wrap = sheetTable(s, s.sheets[s.sheet]);
    wrap.style.zoom = String(s.scale);
    if (s.wrap) s.wrap.replaceWith(wrap);
    else s.stage.append(wrap);
    s.wrap = wrap;
    stickBelowBar(s);
    s.stage.scrollTo(0, 0);
    s.tabs?.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-selected", String(i === s.sheet)));
    remember(s);
    pushStatus();
  }

  function setScale(s: Shown, next: number, x?: number, y?: number) {
    if (!s.wrap) return;
    const wrap = s.wrap;
    keepPoint(s.stage, wrap, () => {
      s.scale = Math.min(MAX, Math.max(MIN, next));
      wrap.style.zoom = String(s.scale);
      stickBelowBar(s);
    }, x, y);
    remember(s);
    pushStatus();
  }

  async function render(_source: string, ctx: PreviewContext) {
    const file = ctx.file;
    const path = ctx.path;
    if (!file || !path) return { error: { message: "没有可显示的表格文件" } };
    if (shown && shown.path === path && shown.version === file.version && shown.stage.isConnected) {
      pushStatus();
      return {};
    }
    let sheets: Sheet[];
    try {
      sheets = await readWorkbook(await file.read(0, file.size));
    } catch (err) {
      return ctx.isCurrent() ? { error: { message: describe("表格", err) } } : {};
    }
    if (!ctx.isCurrent()) return {};

    const hadFocus = !!shown?.stage.contains(document.activeElement);
    teardown();
    const stage = mountStage(ctx, "office-stage xl-stage", hadFocus);
    const place = places.get(path);
    const s: Shown = {
      path, version: file.version, stage, sheets, sheet: 0, scale: place?.scale ?? 1,
      wrap: null, tabs: null, bar: null, ctx, stop: new AbortController(), more: null,
    };
    shown = s;

    const bar = toolbar(ctx, "只读 · 显示文件里保存的值，公式不会重新计算");
    const tabs = document.createElement("div");
    tabs.className = "xl-tabs";
    tabs.setAttribute("role", "tablist");
    sheets.forEach((sheet, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.textContent = sheet.hidden ? `${sheet.name}（隐藏）` : sheet.name;
      b.classList.toggle("hidden-sheet", sheet.hidden);
      b.addEventListener("click", () => shown === s && showSheet(s, i));
      tabs.append(b);
    });
    bar.prepend(tabs);
    s.tabs = tabs;
    s.bar = bar;
    stage.append(bar);
    const first = sheets.findIndex((sh) => !sh.hidden);
    showSheet(s, Math.min(place?.sheet ?? Math.max(0, first), sheets.length - 1));
    onPinchZoom(stage, s.stop.signal, (factor, x, y) => setScale(s, s.scale * factor, x, y));
    return {};
  }

  function zoom(step: 1 | -1 | 0): boolean {
    if (!shown?.wrap) return false;
    setScale(shown, step === 0 ? 1 : step > 0 ? shown.scale * STEP : shown.scale / STEP);
    return true;
  }

  return { render, zoom, reset: teardown };
}

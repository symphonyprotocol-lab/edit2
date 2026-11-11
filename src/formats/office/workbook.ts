/**
 * Spreadsheets read for display: .xlsx / .xlsm (Office Open XML) and .ods
 * (OpenDocument), with JSZip and the browser's XML parser. Cells come out as
 * the text Excel would show: the value saved with the file (formula results
 * are not recomputed), formatted by its number format for dates, times,
 * percentages and thousands separators. Merged ranges are kept.
 */
import JSZip from "jszip";

export interface Merge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface Sheet {
  name: string;
  /** Display text by row, then column (0-based); missing cells are empty. */
  rows: string[][];
  /** Which cells hold numbers (right-aligned), as "row:col". */
  numeric: Set<string>;
  merges: Merge[];
  columns: number;
  hidden: boolean;
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const els = (root: Element | Document, name: string) => [...root.getElementsByTagNameNS("*", name)];
const kids = (root: Element, name: string) => [...root.children].filter((c) => c.localName === name);

/** "B3" → [row 2, col 1]. */
export function cellRef(ref: string): [number, number] {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref.trim());
  if (!m) return [0, 0];
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, col - 1];
}

/** 0 → "A", 26 → "AA". */
export function columnName(col: number): string {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// ---------- number formats ----------

/** Built-in format ids that are dates or times. */
const BUILTIN_DATES: Record<number, string> = {
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
  20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0",
};
const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;(#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;(#,##0.00)", 49: "@",
  ...BUILTIN_DATES,
};

/** The format without quoted text, escapes and colour / condition brackets. */
const bare = (fmt: string) => fmt.replace(/"[^"]*"|\\.|_.|\*.|\[(?!h\]|m\]|s\])[^\]]*\]/gi, "");

export const isDateFormat = (fmt: string) => /[ymdhs]/i.test(bare(fmt.split(";")[0])) && !/^General$/i.test(fmt);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Excel serial date → its parts (1900 system, with its fictional 29 Feb 1900; or 1904). */
function serialToDate(serial: number, date1904: boolean): Date {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86400000);
  return new Date(ms);
}

function formatDate(serial: number, fmt: string, date1904: boolean): string {
  const d = serialToDate(serial, date1904);
  const [y, mo, day, h, mi, s] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  const f = bare(fmt.split(";")[0]).toLowerCase();
  const ampm = /am\/pm|a\/p/.test(f);
  const hasDate = /[yd]/.test(f) || /m{3,}/.test(f) || (/m/.test(f) && !/[hs]/.test(f));
  const hasTime = /[hs]/.test(f);
  if (/^\[h\]/.test(f)) return `${Math.floor(serial * 24)}:${pad(mi)}:${pad(s)}`;
  const date = /mmm/.test(f) && !/mmmm/.test(f)
    ? `${day}-${MONTHS[mo]}${/y/.test(f) ? `-${String(y).slice(-2)}` : ""}`
    : `${y}-${pad(mo + 1)}-${pad(day)}`;
  const hh = ampm ? ((h + 11) % 12) + 1 : h;
  const time = `${ampm ? hh : pad(hh)}:${pad(mi)}${/s/.test(f) ? `:${pad(s)}` : ""}${ampm ? (h < 12 ? " AM" : " PM") : ""}`;
  if (hasDate && hasTime) return `${date} ${time}`;
  return hasTime ? time : date;
}

function formatNumber(value: number, fmt: string): string {
  const section = fmt.split(";");
  let f = value < 0 && section[1] ? section[1] : section[0];
  const negativeOwn = value < 0 && !!section[1];
  if (value === 0 && section[2]) f = section[2];
  const plain = bare(f);
  if (!plain.trim() || /^General$/i.test(fmt) || /^@$/.test(plain.trim())) return general(value);
  const percent = plain.includes("%");
  let n = percent ? value * 100 : value;
  if (negativeOwn) n = Math.abs(n);
  const sci = /E[+-]/i.test(plain);
  const decimals = (/\.([0#?]+)/.exec(plain)?.[1].length) ?? 0;
  let out: string;
  if (sci) out = n.toExponential(decimals).replace("e", "E");
  else
    out = n.toLocaleString("en-US", {
      minimumFractionDigits: (/\.(0+)/.exec(plain)?.[1].length) ?? 0,
      maximumFractionDigits: decimals,
      useGrouping: plain.includes(","),
    });
  // Literal text around the number ("¥", "元", parentheses).
  const literal = f.replace(/"([^"]*)"|\\(.)/g, "$1$2").replace(/\[[^\]]*\]|_.|\*./g, "");
  const prefix = /^[^0#?.,%]*/.exec(literal)?.[0] ?? "";
  const suffix = /[^0#?.,%]*$/.exec(literal)?.[0] ?? "";
  return `${prefix}${out}${percent ? "%" : ""}${suffix.replace("%", "")}`.trim();
}

/** Excel's General format, close enough: up to 11 significant digits. */
function general(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
  const s = Math.abs(value) >= 1e11 || (Math.abs(value) < 1e-9 && value !== 0) ? value.toExponential(5) : String(Number(value.toPrecision(11)));
  return s.replace("e", "E");
}

export function formatValue(value: number, fmt: string, date1904 = false): string {
  if (isDateFormat(fmt)) return formatDate(value, fmt, date1904);
  return formatNumber(value, fmt);
}

// ---------- xlsx ----------

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const runText = (si: Element) => els(si, "t").filter((t) => !t.closest("rPh")).map((t) => t.textContent ?? "").join("");

async function readXlsx(zip: JSZip): Promise<Sheet[]> {
  const book = xml((await zip.file("xl/workbook.xml")?.async("string")) ?? "");
  const date1904 = els(book, "workbookPr")[0]?.getAttribute("date1904") === "1" || els(book, "workbookPr")[0]?.getAttribute("date1904") === "true";
  const relsDoc = xml((await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "<r/>");
  const rels = new Map(els(relsDoc, "Relationship").map((r) => [r.getAttribute("Id") ?? "", resolve("xl/workbook.xml", r.getAttribute("Target") ?? "")]));

  const sst = await zip.file("xl/sharedStrings.xml")?.async("string");
  const strings = sst ? els(xml(sst), "si").map(runText) : [];

  // Number format of each cell style.
  const stylesText = await zip.file("xl/styles.xml")?.async("string");
  const formats: string[] = [];
  if (stylesText) {
    const styles = xml(stylesText);
    const custom = new Map(els(styles, "numFmt").map((n) => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode") ?? "General"]));
    const xfs = els(styles, "cellXfs")[0];
    for (const xf of xfs ? kids(xfs, "xf") : []) {
      const id = Number(xf.getAttribute("numFmtId") ?? 0);
      formats.push(custom.get(id) ?? BUILTIN[id] ?? (id >= 27 && id <= 36 || id >= 50 && id <= 58 ? "yyyy-mm-dd" : "General"));
    }
  }

  const sheets: Sheet[] = [];
  for (const s of els(book, "sheet")) {
    const id = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? s.getAttribute("r:id") ?? "";
    const part = rels.get(id);
    const text = part && (await zip.file(part)?.async("string"));
    const sheet: Sheet = { name: s.getAttribute("name") ?? "", rows: [], numeric: new Set(), merges: [], columns: 0, hidden: !!s.getAttribute("state") && s.getAttribute("state") !== "visible" };
    sheets.push(sheet);
    if (!text) continue;
    const doc = xml(text);
    for (const c of els(doc, "c")) {
      const [r, col] = cellRef(c.getAttribute("r") ?? "A1");
      const type = c.getAttribute("t") ?? "n";
      const v = kids(c, "v")[0]?.textContent ?? null;
      let out = "";
      let numeric = false;
      if (type === "s") out = strings[Number(v)] ?? "";
      else if (type === "inlineStr") out = kids(c, "is").map(runText).join("");
      else if (type === "str" || type === "e") out = v ?? "";
      else if (type === "b") out = v === "1" ? "TRUE" : "FALSE";
      else if (type === "d") out = (v ?? "").replace("T", " ").replace(/Z$/, "");
      else if (v !== null && v !== "") {
        const fmt = formats[Number(c.getAttribute("s") ?? 0)] ?? "General";
        out = formatValue(Number(v), fmt, date1904);
        numeric = !isDateFormat(fmt);
      }
      if (out === "") continue;
      (sheet.rows[r] ??= [])[col] = out;
      if (numeric) sheet.numeric.add(`${r}:${col}`);
      sheet.columns = Math.max(sheet.columns, col + 1);
    }
    for (const m of els(doc, "mergeCell")) {
      const [a, b] = (m.getAttribute("ref") ?? "").split(":");
      if (!a || !b) continue;
      const [r1, c1] = cellRef(a);
      const [r2, c2] = cellRef(b);
      sheet.merges.push({ row: r1, col: c1, rows: r2 - r1 + 1, cols: c2 - c1 + 1 });
      sheet.columns = Math.max(sheet.columns, c2 + 1);
      sheet.rows.length = Math.max(sheet.rows.length, r2 + 1);
    }
  }
  return sheets;
}

// ---------- ods ----------

/** Rows of one repeated run are capped: trailing formatting often repeats a row a million times. */
const MAX_REPEAT = 1000;

async function readOds(zip: JSZip): Promise<Sheet[]> {
  const doc = xml((await zip.file("content.xml")?.async("string")) ?? "");
  const sheets: Sheet[] = [];
  for (const table of els(doc, "table").filter((t) => t.namespaceURI?.includes("table"))) {
    const sheet: Sheet = { name: table.getAttribute("table:name") ?? "", rows: [], numeric: new Set(), merges: [], columns: 0, hidden: false };
    sheets.push(sheet);
    let r = 0;
    for (const row of els(table, "table-row")) {
      const repeat = Math.min(MAX_REPEAT, Number(row.getAttribute("table:number-rows-repeated") ?? 1));
      const cells: { text: string; numeric: boolean; span: [number, number] }[] = [];
      for (const cell of [...row.children].filter((c) => c.localName === "table-cell" || c.localName === "covered-table-cell")) {
        const n = Math.min(MAX_REPEAT, Number(cell.getAttribute("table:number-columns-repeated") ?? 1));
        const type = cell.getAttribute("office:value-type");
        const text = kids(cell, "p").map((p) => p.textContent ?? "").join("\n");
        const span: [number, number] = [Number(cell.getAttribute("table:number-rows-spanned") ?? 1), Number(cell.getAttribute("table:number-columns-spanned") ?? 1)];
        for (let i = 0; i < n; i++) cells.push({ text, numeric: type === "float" || type === "currency" || type === "percentage", span });
      }
      for (let k = 0; k < repeat; k++, r++) {
        cells.forEach((c, col) => {
          if (c.text) {
            (sheet.rows[r] ??= [])[col] = c.text;
            if (c.numeric) sheet.numeric.add(`${r}:${col}`);
            sheet.columns = Math.max(sheet.columns, col + 1);
          }
          if (k === 0 && (c.span[0] > 1 || c.span[1] > 1)) sheet.merges.push({ row: r, col, rows: c.span[0], cols: c.span[1] });
        });
      }
    }
  }
  return sheets;
}

export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file("xl/workbook.xml")) return readXlsx(zip);
  if (zip.file("content.xml")) return readOds(zip);
  throw new Error("文件里既没有 Excel 工作簿，也没有 OpenDocument 表格");
}

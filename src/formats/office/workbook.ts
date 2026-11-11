/**
 * Spreadsheets read for display with SheetJS (Community Edition 0.20.3,
 * Apache-2.0, installed from the SheetJS CDN: cdn.sheetjs.com): .xlsx, .xlsm,
 * .xlsb, .xls and .ods. Cells come out as the text Excel would show: the
 * value saved with the file (formulas are not recalculated), formatted by its
 * number format. Merged ranges and hidden sheets are kept.
 */
import { read, set_cptable, SSF, utils, type CellObject, type WorkSheet } from "xlsx";

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

/** 0 → "A", 26 → "AA". */
export const columnName = (col: number) => utils.encode_col(col);

// Excel's built-in short date formats follow the system locale (US: 1/15/26);
// show them the same way everywhere, as ISO dates.
SSF.load("yyyy-mm-dd", 14);
SSF.load("yyyy-mm-dd h:mm", 22);

/** Rows past the last one with content are dropped; this many at most are read. */
const MAX_ROWS = 1_048_576;

/** Legacy .xls keeps text in a code page (GBK, Big5, Shift_JIS…): load the tables only for those. */
let codepages: Promise<void> | null = null;
const loadCodepages = () =>
  (codepages ??= import("xlsx/dist/cpexcel.full.mjs").then((cp) => set_cptable(cp)));

/** OLE compound file: .xls (and other BIFF files). */
const isOle = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

function cellText(cell: CellObject): string {
  if (cell.w !== undefined) return cell.w;
  if (cell.v === undefined || cell.v === null) return "";
  if (cell.t === "b") return cell.v ? "TRUE" : "FALSE";
  if (cell.v instanceof Date) return cell.v.toISOString().replace("T", " ").replace(/(:00)?\.000Z$/, "");
  return String(cell.v);
}

function readSheet(name: string, ws: WorkSheet, hidden: boolean): Sheet {
  const sheet: Sheet = { name, rows: [], numeric: new Set(), merges: [], columns: 0, hidden };
  const data = (ws["!data"] ?? []) as (CellObject | undefined)[][];
  for (let r = 0; r < Math.min(data.length, MAX_ROWS); r++) {
    const row = data[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      const text = cellText(cell);
      if (text === "") continue;
      (sheet.rows[r] ??= [])[c] = text;
      if (cell.t === "n" && !(cell.z !== undefined && SSF.is_date(cell.z))) sheet.numeric.add(`${r}:${c}`);
      sheet.columns = Math.max(sheet.columns, c + 1);
    }
  }
  for (const m of ws["!merges"] ?? []) {
    sheet.merges.push({ row: m.s.r, col: m.s.c, rows: m.e.r - m.s.r + 1, cols: m.e.c - m.s.c + 1 });
    sheet.columns = Math.max(sheet.columns, m.e.c + 1);
    sheet.rows.length = Math.max(sheet.rows.length, m.e.r + 1);
  }
  return sheet;
}

export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  if (isOle(bytes)) await loadCodepages();
  const book = read(bytes, {
    type: "array",
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellDates: false,
    cellNF: true,
  });
  const meta = book.Workbook?.Sheets ?? [];
  return book.SheetNames.map((name, i) => readSheet(name, book.Sheets[name], !!meta[i]?.Hidden));
}

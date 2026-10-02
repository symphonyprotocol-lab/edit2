/** RFC 4180 CSV: quoted fields may hold delimiters, quotes ("") and line breaks. */

const CANDIDATES = [",", "\t", ";", "|"];

/** Count candidate delimiters outside quotes on one line. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) n++;
  }
  return n;
}

/** The delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const lines = text.split("\n", 20).filter((l) => l.trim());
  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const min = Math.min(...counts);
    // Prefer a delimiter present on every line, then the most columns.
    const score = min > 0 ? 1000 + min : Math.max(0, ...counts) / 100;
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

export const delimiterName = (d: string) =>
  ({ ",": "逗号", "\t": "制表符", ";": "分号", "|": "竖线" })[d] ?? d;

export interface CsvData {
  rows: string[][];
  /** 0-based source line each row starts on. */
  lines: number[];
  columns: number;
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): CsvData {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 0;
  let rowLine = 0;
  let columns = 0;

  const endRow = () => {
    row.push(field);
    field = "";
    // Blank lines are not records.
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
      lines.push(rowLine);
      if (row.length > columns) columns = row.length;
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) endRow();
  return { rows, lines, columns };
}

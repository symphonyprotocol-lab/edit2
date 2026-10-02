/**
 * A small line scanner for TOML source. smol-toml gives values but no
 * positions, and the formatter must not touch the inside of strings or
 * multi-line arrays, so both need to know where those are.
 */

export interface ScanState {
  /** Delimiter of an open multi-line string (`"""` or `'''`). */
  multi: string | null;
  /** Open `[` / `{` in a value spanning lines. */
  depth: number;
}

export const newScanState = (): ScanState => ({ multi: null, depth: 0 });

/**
 * Advance `state` over `text` (a value or a continuation line). Returns the
 * index where a trailing comment starts, or -1.
 */
export function scanValue(text: string, state: ScanState): number {
  let i = 0;
  while (i < text.length) {
    if (state.multi) {
      const close = text.indexOf(state.multi, i);
      if (close === -1) return -1;
      i = close + 3;
      // """a""""" may end with up to two extra quotes inside the string
      while (text[i] === state.multi[0]) i++;
      state.multi = null;
      continue;
    }
    const c = text[i];
    if (c === "#") return i;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      state.multi = text.slice(i, i + 3);
      i += 3;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
    } else {
      if (c === "[" || c === "{") state.depth++;
      else if (c === "]" || c === "}") state.depth = Math.max(0, state.depth - 1);
      i++;
    }
  }
  return -1;
}

/** Split a dotted key (`a."b.c".d`) into its parts. */
export function keyParts(key: string): string[] {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < key.length && (m = re.exec(key))) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

/** Index of the first `=` that is not inside a quoted key, or -1. */
export function assignmentAt(line: string): number {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "=") return i;
    else if (c === "#") return -1;
  }
  return -1;
}

/**
 * 0-based line of every table and key, by path ("a\0b\0c"; arrays of
 * tables include the element index).
 */
export function lineIndex(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  const counts = new Map<string, number>();
  const state = newScanState();
  let table: string[] = [];
  text.split("\n").forEach((raw, n) => {
    if (state.multi || state.depth) return void scanValue(raw, state);
    const line = raw.trim();
    const header = /^\[(\[)?\s*([^\]]*?)\s*\]\]?/.exec(line);
    if (header) {
      table = keyParts(header[2]);
      if (header[1]) {
        const key = table.join("\0");
        const i = counts.get(key) ?? 0;
        counts.set(key, i + 1);
        lines.set(key, lines.get(key) ?? n);
        table = [...table, String(i)];
      }
      lines.set(table.join("\0"), n);
      return;
    }
    const eq = assignmentAt(line);
    if (eq <= 0) return;
    lines.set([...table, ...keyParts(line.slice(0, eq))].join("\0"), n);
    scanValue(line.slice(eq + 1), state);
  });
  return lines;
}

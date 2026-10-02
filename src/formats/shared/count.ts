// ---------- word counting ----------

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const WORD = /[A-Za-z0-9À-ɏ]+(?:['’.-][A-Za-z0-9À-ɏ]+)*/g;

export function countWords(text: string): { words: number; minutes: number } {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").match(WORD)?.length ?? 0;
  const words = cjk + latin;
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(cjk / 400 + latin / 220));
  return { words, minutes };
}

/** "1,204 字", or "已选 30 / 1,204 字" with a selection. */
export function wordStats(text: string, selection: string | null): string {
  const { words } = countWords(text);
  if (selection) return `已选 ${countWords(selection).words.toLocaleString()} / ${words.toLocaleString()} 字`;
  return `${words.toLocaleString()} 字`;
}

/** Lines of text; a final line break does not start another line. */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

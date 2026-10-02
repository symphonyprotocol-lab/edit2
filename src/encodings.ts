/** Encodings offered in the status bar, as encoding_rs names them. */
export const ENCODINGS: { label: string; encoding: string; bom: boolean }[] = [
  { label: "UTF-8", encoding: "UTF-8", bom: false },
  { label: "UTF-8 BOM", encoding: "UTF-8", bom: true },
  { label: "UTF-16 LE", encoding: "UTF-16LE", bom: true },
  { label: "UTF-16 BE", encoding: "UTF-16BE", bom: true },
  { label: "GBK", encoding: "GBK", bom: false },
  { label: "GB18030", encoding: "gb18030", bom: false },
  { label: "Big5", encoding: "Big5", bom: false },
  { label: "Shift_JIS", encoding: "Shift_JIS", bom: false },
  { label: "EUC-KR", encoding: "EUC-KR", bom: false },
  { label: "Windows-1252", encoding: "windows-1252", bom: false },
];

/** Status bar name for an encoding. */
export function encodingName(encoding: string, bom: boolean): string {
  const lower = encoding.toLowerCase();
  const exact = ENCODINGS.find((e) => e.encoding.toLowerCase() === lower && e.bom === bom);
  return exact?.label ?? ENCODINGS.find((e) => e.encoding.toLowerCase() === lower)?.label ?? encoding;
}

/** From this size, preview and counting wait until asked. */
export const LARGE_FILE = 5 * 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A .pptx as an outline, for systems without Quick Look: per slide, its title,
 * text, pictures, tables and speaker notes, read straight from the package
 * with JSZip. Layout, themes and charts are not drawn.
 */
import JSZip from "jszip";

export interface OutlineSlide {
  title: string;
  paragraphs: string[];
  images: string[];
  tables: string[][][];
  notes: string[];
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const byName = (root: Element | Document, name: string) => [...root.getElementsByTagNameNS("*", name)];
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Absolute part name for a relationship target, relative to `base` ("ppt/slides/slide1.xml"). */
function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function rels(zip: JSZip, part: string): Promise<Map<string, { target: string; type: string }>> {
  const name = part.replace(/([^/]+)$/, "_rels/$1.rels");
  const text = await zip.file(name)?.async("string");
  const map = new Map<string, { target: string; type: string }>();
  if (!text) return map;
  for (const r of byName(xml(text), "Relationship")) {
    map.set(r.getAttribute("Id") ?? "", { target: resolve(part, r.getAttribute("Target") ?? ""), type: r.getAttribute("Type") ?? "" });
  }
  return map;
}

const paragraphText = (p: Element) => byName(p, "t").map((t) => t.textContent ?? "").join("");

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };

export async function readOutline(bytes: Uint8Array): Promise<OutlineSlide[]> {
  const zip = await JSZip.loadAsync(bytes);
  const pres = await zip.file("ppt/presentation.xml")?.async("string");
  if (!pres) throw new Error("文件里没有 ppt/presentation.xml");
  const presRels = await rels(zip, "ppt/presentation.xml");
  const ids = byName(xml(pres), "sldId").map((s) => s.getAttributeNS(relNs, "id") ?? s.getAttribute("r:id") ?? "");
  const slides: OutlineSlide[] = [];
  for (const id of ids) {
    const part = presRels.get(id)?.target;
    const text = part && (await zip.file(part)?.async("string"));
    if (!part || !text) continue;
    const doc = xml(text);
    const slideRels = await rels(zip, part);
    const slide: OutlineSlide = { title: "", paragraphs: [], images: [], tables: [], notes: [] };

    for (const sp of byName(doc, "sp")) {
      const ph = byName(sp, "ph")[0]?.getAttribute("type") ?? "";
      const lines = byName(sp, "p").map(paragraphText).filter((t) => t.trim());
      if ((ph === "title" || ph === "ctrTitle") && !slide.title) slide.title = lines.join(" ");
      else slide.paragraphs.push(...lines);
    }
    for (const tbl of byName(doc, "tbl")) {
      slide.tables.push(byName(tbl, "tr").map((tr) => byName(tr, "tc").map((tc) => byName(tc, "p").map(paragraphText).join("\n"))));
    }
    for (const blip of byName(doc, "blip")) {
      const target = slideRels.get(blip.getAttributeNS(relNs, "embed") ?? "")?.target;
      const media = target && zip.file(target);
      if (!media) continue;
      const ext = target.split(".").pop()!.toLowerCase();
      if (!MIME[ext]) continue; // EMF / WMF: no web view draws them
      slide.images.push(`data:${MIME[ext]};base64,${await media.async("base64")}`);
    }
    const notesPart = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart && (await zip.file(notesPart)?.async("string"));
    if (notes) {
      const body = byName(xml(notes), "sp").filter((sp) => byName(sp, "ph")[0]?.getAttribute("type") === "body");
      slide.notes = body.flatMap((sp) => byName(sp, "p").map(paragraphText)).filter((t) => t.trim());
    }
    slides.push(slide);
  }
  return slides;
}

export function outlineElement(slides: OutlineSlide[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "ppt-outline";
  slides.forEach((s, i) => {
    const card = document.createElement("section");
    card.className = "ppt-slide";
    card.append(Object.assign(document.createElement("div"), { className: "ppt-slide-n", textContent: `幻灯片 ${i + 1}` }));
    if (s.title) card.append(Object.assign(document.createElement("h3"), { textContent: s.title }));
    for (const p of s.paragraphs) card.append(Object.assign(document.createElement("p"), { textContent: p }));
    for (const rows of s.tables) {
      const table = document.createElement("table");
      for (const row of rows) {
        const tr = table.insertRow();
        for (const cell of row) tr.insertCell().textContent = cell;
      }
      card.append(table);
    }
    for (const src of s.images) card.append(Object.assign(document.createElement("img"), { src, alt: "", draggable: false }));
    if (s.notes.length) {
      const notes = document.createElement("div");
      notes.className = "ppt-notes";
      notes.textContent = `备注：${s.notes.join("\n")}`;
      card.append(notes);
    }
    list.append(card);
  });
  return list;
}

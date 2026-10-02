import { lineAt, lineStarts, SyntaxProblem } from "../types";
import type { TreeNode } from "../shared/tree";
import { memoLast } from "../shared/validity";

/** The browser's parser error, as a SyntaxProblem (null when the document is well-formed). */
function parserError(doc: Document): SyntaxProblem | null {
  const err = doc.getElementsByTagName("parsererror")[0];
  if (!err) return null;
  const text = (err.textContent ?? "").replace(/\s+/g, " ");
  // WebKit/Blink: "error on line 3 at column 10: <message>"; Gecko: "… Line Number 3, Column 10: …"
  const m = /line (\d+)(?: at column \d+)?:\s*(.+?)(?: Below is a rendering.*)?$/i.exec(text) ?? /Line Number (\d+)[^:]*:\s*(.+)$/i.exec(text);
  return new SyntaxProblem(m ? m[2].trim() : text.trim() || "XML 语法错误", m ? Number(m[1]) : undefined);
}

/** The parsed document (shared by the status bar, preview and formatter: never mutate it). */
export const parseXml = memoLast((text: string): Document => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const problem = parserError(doc);
  if (problem) throw problem;
  return doc;
});

/**
 * Offsets of every start tag, in document order. The DOM keeps no positions,
 * but its elements come in the same order, so the i-th element starts here.
 */
function startTagOffsets(text: string): number[] {
  const offsets: number[] = [];
  let i = 0;
  while ((i = text.indexOf("<", i)) !== -1) {
    if (text.startsWith("<!--", i)) i = end(text.indexOf("-->", i), 3);
    else if (text.startsWith("<![CDATA[", i)) i = end(text.indexOf("]]>", i), 3);
    else if (text.startsWith("<?", i)) i = end(text.indexOf("?>", i), 2);
    else if (text.startsWith("<!", i)) i = skipDeclaration(text, i);
    else {
      if (/[A-Za-z_:]/.test(text[i + 1] ?? "")) offsets.push(i);
      i = skipTag(text, i);
    }
  }
  return offsets;
  function end(at: number, len: number) {
    return at === -1 ? text.length : at + len;
  }
}

/** Past a `<!DOCTYPE …>`, including an internal subset in brackets. */
function skipDeclaration(text: string, i: number): number {
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") depth--;
    else if (text[i] === ">" && depth <= 0) return i + 1;
  }
  return i;
}

/** Past a tag, minding quoted attribute values that may contain ">". */
function skipTag(text: string, i: number): number {
  let quote = "";
  for (i++; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return i;
}

export function xmlTree(text: string, doc: Document): TreeNode[] {
  const starts = lineStarts(text);
  const offsets = startTagOffsets(text);
  const elements = [...doc.getElementsByTagName("*")];
  const lineOf = new Map<Element, number>();
  if (offsets.length === elements.length) elements.forEach((el, i) => lineOf.set(el, lineAt(starts, offsets[i])));

  const convert = (node: Node): TreeNode | null => {
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const el = node as Element;
        const kids = [...el.childNodes].map(convert).filter((n): n is TreeNode => !!n);
        const attrs = [...el.attributes].map((a): [string, string] => [a.name, a.value]);
        const out: TreeNode = { kind: "element", key: el.nodeName, attrs, line: lineOf.get(el) };
        if (kids.length === 1 && kids[0].kind === "text") out.value = kids[0].value;
        else out.children = kids;
        return out;
      }
      case Node.TEXT_NODE: {
        const value = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
        return value ? { kind: "text", value } : null;
      }
      case Node.CDATA_SECTION_NODE:
        return { kind: "cdata", value: node.nodeValue ?? "" };
      case Node.COMMENT_NODE:
        return { kind: "comment", value: (node.nodeValue ?? "").trim() };
      case Node.PROCESSING_INSTRUCTION_NODE: {
        const pi = node as ProcessingInstruction;
        return { kind: "pi", value: `<?${pi.target} ${pi.data}?>` };
      }
      case Node.DOCUMENT_TYPE_NODE:
        return { kind: "pi", value: `<!DOCTYPE ${(node as DocumentType).name}>` };
      default:
        return null;
    }
  };
  return [...doc.childNodes].map(convert).filter((n): n is TreeNode => !!n);
}

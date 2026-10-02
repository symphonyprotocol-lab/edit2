import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Document } from "yaml";
import { lineAt, lineStarts, SyntaxProblem } from "../types";
import type { TreeNode } from "../shared/tree";

export function parseYaml(text: string): Document.Parsed[] {
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs)) return []; // an empty stream
  for (const doc of docs) {
    const e = doc.errors[0];
    if (e) throw new SyntaxProblem(e.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, ""), e.linePos?.[0].line);
  }
  return docs;
}

export function firstProblem(text: string): SyntaxProblem | null {
  try {
    parseYaml(text);
    return null;
  } catch (err) {
    if (err instanceof SyntaxProblem) return err;
    throw err;
  }
}

export function yamlTree(text: string, docs: Document.Parsed[]): TreeNode[] {
  const starts = lineStarts(text);
  const lineOf = (node: unknown) => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range ? lineAt(starts, range[0]) : undefined;
  };

  const convert = (node: unknown, key?: string): TreeNode => {
    if (isMap(node)) {
      return {
        key,
        kind: "object",
        line: lineOf(node),
        children: node.items.map((pair) => {
          const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
          const child = convert(pair.value, k);
          child.line = lineOf(pair.key) ?? child.line;
          return child;
        }),
      };
    }
    if (isSeq(node)) {
      return { key, kind: "array", line: lineOf(node), children: node.items.map((v, i) => convert(v, String(i))) };
    }
    if (isScalar(node)) {
      const v = node.value;
      const line = lineOf(node);
      if (v === null || v === undefined) return { key, kind: "null", value: "null", line };
      if (typeof v === "string") return { key, kind: "string", value: v, line };
      if (typeof v === "number" || typeof v === "bigint") return { key, kind: "number", value: node.source ?? String(v), line };
      if (typeof v === "boolean") return { key, kind: "boolean", value: String(v), line };
      if (v instanceof Date) return { key, kind: "date", value: v.toISOString(), line };
      return { key, kind: "string", value: String(v), line };
    }
    if (isAlias(node)) return { key, kind: "string", value: `*${node.source}`, line: lineOf(node) };
    if (isPair(node)) return convert(node.value, key);
    return { key, kind: "null", value: "null" };
  };

  if (docs.length === 1) return [convert(docs[0].contents)];
  // Several documents: one top-level node each, named by position.
  return docs.map((doc, i) => ({ ...convert(doc.contents), key: `文档 ${i + 1}` }));
}

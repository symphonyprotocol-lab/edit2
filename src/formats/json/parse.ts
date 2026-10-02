import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { lineAt, lineStarts, SyntaxProblem } from "../types";
import type { TreeNode } from "../shared/tree";
import { memoLast } from "../shared/validity";

const MESSAGES: Record<number, string> = {
  1: "无效的字符",
  2: "数字格式错误",
  3: "缺少属性名",
  4: "缺少值",
  5: "缺少冒号",
  6: "缺少逗号",
  7: "缺少 }",
  8: "缺少 ]",
  9: "末尾有多余的内容",
  10: "注释格式错误",
  11: "注释没有结束",
  12: "字符串没有结束",
  13: "数字不完整",
  14: "无效的 Unicode 转义",
  15: "无效的转义字符",
  16: "字符串里有无效的字符",
};

/** Comments and trailing commas are accepted everywhere (JSONC is common under a .json name). */
const OPTIONS = { allowTrailingComma: true, disallowComments: false };

/** Parse into tree nodes, numbers keeping their source spelling. Throws SyntaxProblem. */
export const parseJson = memoLast((text: string): TreeNode | null => {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, OPTIONS);
  if (errors.length) {
    const e = errors[0];
    throw new SyntaxProblem(MESSAGES[e.error] ?? "语法错误", lineAt(lineStarts(text), e.offset) + 1);
  }
  if (!root) return null;
  const starts = lineStarts(text);

  const convert = (node: Node, key?: string): TreeNode => {
    const line = lineAt(starts, node.offset);
    switch (node.type) {
      case "object":
        return {
          key,
          kind: "object",
          line,
          children: (node.children ?? []).map((prop) => {
            const [k, v] = prop.children ?? [];
            const child = v ? convert(v, String(k?.value ?? "")) : { key: String(k?.value ?? ""), kind: "null" as const };
            child.line = lineAt(starts, prop.offset);
            return child;
          }),
        };
      case "array":
        return { key, kind: "array", line, children: (node.children ?? []).map((v, i) => convert(v, String(i))) };
      case "string":
        return { key, kind: "string", value: node.value, line };
      case "number":
        return { key, kind: "number", value: text.slice(node.offset, node.offset + node.length), line };
      case "boolean":
        return { key, kind: "boolean", value: String(node.value), line };
      default:
        return { key, kind: "null", value: "null", line };
    }
  };
  return convert(root);
});

import type { PreviewRenderer, RenderResult } from "../types";
import { SyntaxProblem } from "../types";
import { newTreeState, renderTree, type TreeNode } from "./tree";

/** A parse error as the preview reports it (anything else is a real failure). */
export function asRenderError(err: unknown): RenderResult {
  if (err instanceof SyntaxProblem) return { error: { message: err.message, line: err.line } };
  throw err;
}

/**
 * A preview that shows the document as a tree. `toTree` throws SyntaxProblem
 * on invalid input and returns null for an empty document.
 */
export function treePreview(toTree: (text: string) => TreeNode[] | null): PreviewRenderer {
  let state = newTreeState();
  return {
    render(source, ctx) {
      let roots: TreeNode[] | null;
      try {
        roots = toTree(source);
      } catch (err) {
        return asRenderError(err);
      }
      if (!roots?.length) {
        const empty = Object.assign(document.createElement("p"), { className: "tree-empty", textContent: "空文档" });
        ctx.container.replaceChildren(empty);
        return { anchors: [] };
      }
      return { anchors: renderTree(ctx.container, roots, { state, onPick: ctx.revealLine }) };
    },
    reset() {
      state = newTreeState();
    },
  };
}

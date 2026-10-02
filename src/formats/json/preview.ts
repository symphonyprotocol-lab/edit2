import type { PreviewRenderer } from "../types";
import { SyntaxProblem } from "../types";
import { newTreeState, renderTree } from "../shared/tree";
import { parseJson } from "./parse";

let state = newTreeState();

export const jsonPreview: PreviewRenderer = {
  render(source, ctx) {
    let root;
    try {
      root = parseJson(source);
    } catch (err) {
      if (err instanceof SyntaxProblem) return { error: { message: err.message, line: err.line } };
      throw err;
    }
    if (!root) {
      ctx.container.replaceChildren(Object.assign(document.createElement("p"), { className: "tree-empty", textContent: "空文档" }));
      return { anchors: [] };
    }
    const anchors = renderTree(ctx.container, [root], { state, onPick: ctx.revealLine });
    return { anchors };
  },
  reset() {
    state = newTreeState();
  },
};

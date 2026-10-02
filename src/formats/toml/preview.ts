import type { PreviewRenderer } from "../types";
import { SyntaxProblem } from "../types";
import { newTreeState, renderTree } from "../shared/tree";
import { parseToml, tomlTree } from "./parse";

let state = newTreeState();

export const tomlPreview: PreviewRenderer = {
  render(source, ctx) {
    let data;
    try {
      data = parseToml(source);
    } catch (err) {
      if (err instanceof SyntaxProblem) return { error: { message: err.message, line: err.line } };
      throw err;
    }
    return { anchors: renderTree(ctx.container, [tomlTree(source, data)], { state, onPick: ctx.revealLine }) };
  },
  reset() {
    state = newTreeState();
  },
};

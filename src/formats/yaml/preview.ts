import type { PreviewRenderer } from "../types";
import { SyntaxProblem } from "../types";
import { newTreeState, renderTree } from "../shared/tree";
import { parseYaml, yamlTree } from "./parse";

let state = newTreeState();

export const yamlPreview: PreviewRenderer = {
  render(source, ctx) {
    let docs;
    try {
      docs = parseYaml(source);
    } catch (err) {
      if (err instanceof SyntaxProblem) return { error: { message: err.message, line: err.line } };
      throw err;
    }
    if (!docs.length) {
      ctx.container.replaceChildren(Object.assign(document.createElement("p"), { className: "tree-empty", textContent: "空文档" }));
      return { anchors: [] };
    }
    return { anchors: renderTree(ctx.container, yamlTree(source, docs), { state, onPick: ctx.revealLine }) };
  },
  reset() {
    state = newTreeState();
  },
};

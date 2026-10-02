import { treePreview } from "../shared/tree-preview";
import { parseJson } from "./parse";

export const jsonPreview = treePreview((text) => {
  const root = parseJson(text);
  return root && [root];
});

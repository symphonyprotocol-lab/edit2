import { treePreview } from "../shared/tree-preview";
import { parseYaml, yamlTree } from "./parse";

export const yamlPreview = treePreview((text) => {
  const docs = parseYaml(text);
  return docs.length ? yamlTree(text, docs) : null;
});

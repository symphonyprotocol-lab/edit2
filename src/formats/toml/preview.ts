import { treePreview } from "../shared/tree-preview";
import { parseToml, tomlTree } from "./parse";

export const tomlPreview = treePreview((text) => [tomlTree(text, parseToml(text))]);

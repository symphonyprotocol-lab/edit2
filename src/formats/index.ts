/**
 * Built-in format plugins. Adding a format = a folder under src/formats/,
 * one `register` line here, and its extensions in tauri.conf.json.
 */
import { register } from "./registry";
import { markdown } from "./markdown";
import { plainText } from "./text";

register(markdown, { untitled: true });
register(plainText, { fallback: true });

export * from "./registry";
export type * from "./types";

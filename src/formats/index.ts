/**
 * Built-in format plugins. Adding a format = a folder under src/formats/,
 * one `register` line here, and its extensions in tauri.conf.json.
 */
import { register } from "./registry";
import { markdown } from "./markdown";
import { plainText } from "./text";
import { json } from "./json";
import { xml } from "./xml";
import { yaml } from "./yaml";
import { toml } from "./toml";
import { csv } from "./csv";

register(markdown, { untitled: true });
register(plainText, { fallback: true });
register(json);
register(xml);
register(yaml);
register(toml);
register(csv);

export * from "./registry";
export * from "./types";

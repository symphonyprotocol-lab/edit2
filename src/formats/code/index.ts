/**
 * Source code. One format per language, all generated from the table below
 * and grouped as "代码" in menus. Highlighting comes from
 * @codemirror/language-data, loaded the first time a file in that language
 * opens; nothing here pulls a language parser into the main bundle.
 */
import type { Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import type { FormatPlugin } from "../types";
import { lineCount } from "../shared/count";
import { codeEditor } from "./editor";

interface CodeLanguage {
  id: string;
  label: string;
  /** Name (or alias) in @codemirror/language-data. */
  mode: string;
  extensions: string[];
  /** Whole file names, matched case-insensitively. */
  filenames?: string[];
  /** Indent unit when the file itself does not show one. */
  indent?: string;
}

const FOUR = "    ";
const TAB = "\t";

// Extensions here must also be listed in the bundle's file associations
// (scripts/check-formats.mjs checks). Keep them out of other plugins' lists.
const LANGUAGES: CodeLanguage[] = [
  { id: "javascript", label: "JavaScript", mode: "JSX", extensions: ["js", "mjs", "cjs", "jsx"] },
  { id: "typescript", label: "TypeScript", mode: "TypeScript", extensions: ["ts", "mts", "cts"] },
  { id: "tsx", label: "TSX", mode: "TSX", extensions: ["tsx"] },
  { id: "vue", label: "Vue", mode: "Vue", extensions: ["vue"] },
  { id: "python", label: "Python", mode: "Python", extensions: ["py", "pyw", "pyi"], indent: FOUR },
  { id: "rust", label: "Rust", mode: "Rust", extensions: ["rs"], indent: FOUR },
  { id: "go", label: "Go", mode: "Go", extensions: ["go"], indent: TAB },
  { id: "java", label: "Java", mode: "Java", extensions: ["java"], indent: FOUR },
  { id: "kotlin", label: "Kotlin", mode: "Kotlin", extensions: ["kt", "kts"], indent: FOUR },
  { id: "scala", label: "Scala", mode: "Scala", extensions: ["scala", "sbt"] },
  { id: "groovy", label: "Groovy", mode: "Groovy", extensions: ["groovy", "gradle"], filenames: ["jenkinsfile"], indent: FOUR },
  { id: "cpp", label: "C/C++", mode: "C++", extensions: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], indent: FOUR },
  { id: "objc", label: "Objective-C", mode: "Objective-C", extensions: ["m", "mm"], indent: FOUR },
  { id: "csharp", label: "C#", mode: "C#", extensions: ["cs", "csx"], indent: FOUR },
  { id: "swift", label: "Swift", mode: "Swift", extensions: ["swift"], indent: FOUR },
  { id: "dart", label: "Dart", mode: "Dart", extensions: ["dart"] },
  { id: "ruby", label: "Ruby", mode: "Ruby", extensions: ["rb", "rake", "gemspec"], filenames: ["gemfile", "rakefile"] },
  { id: "php", label: "PHP", mode: "PHP", extensions: ["php", "phtml"], indent: FOUR },
  { id: "perl", label: "Perl", mode: "Perl", extensions: ["pl", "pm"], indent: FOUR },
  { id: "lua", label: "Lua", mode: "Lua", extensions: ["lua"] },
  { id: "r", label: "R", mode: "R", extensions: ["r"] },
  { id: "julia", label: "Julia", mode: "Julia", extensions: ["jl"], indent: FOUR },
  { id: "haskell", label: "Haskell", mode: "Haskell", extensions: ["hs"] },
  { id: "elm", label: "Elm", mode: "Elm", extensions: ["elm"], indent: FOUR },
  { id: "erlang", label: "Erlang", mode: "Erlang", extensions: ["erl", "hrl"], indent: FOUR },
  { id: "clojure", label: "Clojure", mode: "Clojure", extensions: ["clj", "cljs", "cljc", "edn"] },
  { id: "ocaml", label: "OCaml", mode: "OCaml", extensions: ["ml", "mli"] },
  { id: "fsharp", label: "F#", mode: "F#", extensions: ["fs", "fsi", "fsx"], indent: FOUR },
  {
    id: "shell",
    label: "Shell",
    mode: "Shell",
    extensions: ["sh", "bash", "zsh", "ksh"],
    filenames: [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", "pkgbuild"],
  },
  { id: "powershell", label: "PowerShell", mode: "PowerShell", extensions: ["ps1", "psm1", "psd1"], indent: FOUR },
  { id: "sql", label: "SQL", mode: "SQL", extensions: ["sql"] },
  { id: "css", label: "CSS", mode: "CSS", extensions: ["css"] },
  { id: "scss", label: "SCSS", mode: "SCSS", extensions: ["scss"] },
  { id: "sass", label: "Sass", mode: "Sass", extensions: ["sass"] },
  { id: "less", label: "Less", mode: "LESS", extensions: ["less"] },
  { id: "dockerfile", label: "Dockerfile", mode: "Dockerfile", extensions: ["dockerfile"], filenames: ["dockerfile", "containerfile"] },
  // No Make grammar ships with language-data; shell highlighting covers comments, strings and variables.
  { id: "makefile", label: "Makefile", mode: "Shell", extensions: ["mk", "mak"], filenames: ["makefile", "gnumakefile"], indent: TAB },
  { id: "cmake", label: "CMake", mode: "CMake", extensions: ["cmake"], filenames: ["cmakelists.txt"] },
  { id: "ini", label: "INI", mode: "Properties files", extensions: ["ini", "cfg", "conf", "properties"], filenames: [".editorconfig", ".gitconfig"] },
  { id: "protobuf", label: "Protocol Buffers", mode: "ProtoBuf", extensions: ["proto"] },
  { id: "diff", label: "Diff", mode: "diff", extensions: ["diff", "patch"] },
  { id: "latex", label: "LaTeX", mode: "LaTeX", extensions: ["tex", "sty", "cls"] },
];

/** Line count, plus characters (and selected lines) for the status bar. */
function codeStats(text: string, selection: string | null): string {
  const lines = lineCount(text).toLocaleString();
  if (selection) return `已选 ${lineCount(selection).toLocaleString()} 行 · ${selection.length.toLocaleString()} 字符`;
  return `${lines} 行 · ${text.length.toLocaleString()} 字符`;
}

const editors = new Map<string, Extension>();
const editorFor = (indent: string) => {
  let ext = editors.get(indent);
  if (!ext) editors.set(indent, (ext = codeEditor(indent)));
  return ext;
};

async function loadMode(name: string): Promise<Extension> {
  const { languages } = await import("@codemirror/language-data");
  const found = LanguageDescription.matchLanguageName(languages, name, false);
  return found ? found.load() : [];
}

/** Alphabetical, so the long list in the format menu is easy to scan. */
export const codeFormats: FormatPlugin[] = [...LANGUAGES]
  .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }))
  .map((lang) => ({
    id: `code-${lang.id}`,
    label: lang.label,
    extensions: lang.extensions,
    filenames: lang.filenames,
    group: "代码",
    language: () => loadMode(lang.mode),
    editorExtras: editorFor(lang.indent ?? "  "),
    stats: codeStats,
    defaultMode: "write",
  }));

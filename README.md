# edit2

A quick editor for text files. Open a file, look at it, change it, close it. There is no sidebar or file tree: each file you open becomes a tab in a single window. The + button in the tab strip (or ⌘T) starts a new draft at any time.

edit2 was called mdit and only edited Markdown. It now opens Markdown, plain text, JSON, YAML, TOML, XML, CSV and HTML, each with highlighting and (except plain text) a live preview. Each format is a built-in plugin, so adding another one does not touch the rest of the app.

Built with Tauri 2 and CodeMirror 6. The layout mockup is in [design/mockup.html](design/mockup.html).

## Download

Get the latest `.dmg` from [Releases](https://github.com/symphonyprotocol-lab/edit2/releases). It runs on Apple silicon and Intel Macs (macOS 10.13 or later). The app is not signed with an Apple Developer ID, so the first time, right-click edit2 in Applications and choose Open, or run `xattr -dr com.apple.quarantine /Applications/edit2.app`.

## Formats

| Format | Extensions | Preview | Format / minify |
| --- | --- | --- | --- |
| Markdown | md, markdown, mdown, mkd, mdx | Rendered (GFM tables, task lists, code highlighting, local images, Mermaid) | — |
| Plain text | txt, text, log, and any other text file | — | — |
| JSON | json, jsonc, json5, geojson, webmanifest | Collapsible tree | Both |
| YAML | yaml, yml | Collapsible tree, one node per document | Format |
| TOML | toml | Collapsible tree | Tidy |
| XML | xml, svg, plist, xsd, xsl, xslt, rss, atom | Element tree; SVG also as a picture | Both |
| CSV / TSV | csv, tsv, tab | Table with a sticky header | — |
| HTML | html, htm | The page, in a sandbox | Format |

- **Status bar**: shows the format, which you can change for a file (e.g. preview a `.txt` as Markdown; remembered per file), the encoding, and a summary from the format (word count, rows × columns, or whether the file parses). Parse errors show above the preview; clicking one jumps to the line.
- **Formatting** (⇧⌥F, Format menu or the status bar): pretty-prints JSON, YAML, XML and HTML and tidies TOML without dropping comments; JSON numbers keep their exact digits. One ⌘Z undoes it. Files with a syntax error are left alone. JSON and XML can also be minified.
- **Tree previews** open two levels deep, keep what you opened across edits, page long lists, and move the editor to a row's line when you click it in Split view.
- **CSV** detects the delimiter (comma, tab, semicolon, pipe), handles quoted fields with line breaks, colours columns in the editor, and adds table rows as you scroll, so 100,000 rows open instantly.
- **HTML** runs no scripts by default: the page is shown in a sandboxed frame with its local images, styles and fonts. "允许脚本" runs it in an isolated sandbox with its own origin (and allows external scripts, styles and fonts); it is per document and off again next launch.

## Features

- **Three views**: Write (editor only), Split (editor and live preview with synced scrolling) and Read (preview only), remembered per format. Below 760 px wide, Split falls back to the editor. Plain text has only Write.
- **Markdown editing**: dimmed markup characters, highlighting inside fenced code blocks, automatic list continuation, and formatting shortcuts (⌘B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⇧⌘X strikethrough). Clicking a task box in the preview updates the source.
- **Links**: external links open in the system browser; links to other files of a supported format open them in edit2, other files are shown in Finder.
- **Tabs**: files from Finder "Open With" or the Dock icon, drag and drop, the command line (`edit2 file.json`), ⌘O or links in the preview open as tabs in the same window. A file that is already open just switches to its tab, and an opened file takes over an empty untitled tab instead of adding another. Each tab keeps its own cursor, scroll position and undo history. Tabs can be reordered by dragging and closed with middle-click.
- **Auto-save**: edits are written to disk shortly after you stop typing, and when you switch tabs or leave the window. Before writing, edit2 checks that no other program has changed the file; if one has, it asks instead of overwriting.
- **Drafts**: untitled documents (Markdown) are auto-saved to a staging area (`~/Library/Application Support/dev.symphonyprotocollab.edit2/drafts` on macOS) and reopened as tabs on the next launch. Saving a draft with ⌘S turns it into a real file and removes it from staging; saving it with another extension switches its format. Closing a draft tab asks whether to save it as a file or delete it.
- **Changes on disk**: if another program changes an open file, edit2 reloads it silently when there are no pending edits, and asks otherwise. A deleted file is flagged in the status bar and is never silently recreated.
- **Closing**: quitting does not prompt, because everything is already saved or staged. edit2 only asks when something could not be saved, or when a file was deleted on disk.
- **Encodings**: the encoding is detected (UTF-8, UTF-16, GBK/GB18030, Big5, Shift_JIS, EUC-KR, Windows-1252, …) and files are written back in it, keeping a byte order mark and CRLF or LF line endings. A "?" after the encoding means it was guessed from little text; the status bar menu reopens the file in another encoding or saves it in one. If you type characters the encoding cannot hold, edit2 does not save them lossily: it offers to switch to UTF-8. Binary files are refused.
- **Large files**: from 5 MB, the preview and word count wait for a click. Files over 50 MB open read-only after you confirm.
- **Appearance**: follows the system light or dark setting. The font size is adjustable (⌘= / ⌘- / ⌘0), and soft wrap can be turned off per tab (⌥Z).
- **Settings** (views, font size, recent files, per-file formats) are kept in `settings.json` in the app data folder. The first launch copies mdit's drafts and settings over and leaves mdit's own data in place.

## Upgrading from mdit

- The first launch of edit2 copies mdit's drafts, preferences and recent files and says so once. mdit's own data is left in place; once edit2 has everything, delete mdit so "Open With" lists only one of them.
- `.txt` files are now plain text: no Markdown highlighting or preview. To keep previewing one as Markdown, pick Markdown in the status bar's format menu (remembered for that file).
- A UTF-8 byte order mark is now kept when the file is saved (mdit removed it).
- Files in other encodings (GBK, Big5, Shift_JIS, …) now open instead of being refused, and are saved back in their encoding.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New tab | ⌘T / ⌘N | Ctrl+T / Ctrl+N |
| Open | ⌘O | Ctrl+O |
| Save / Save As | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S |
| Show in Finder | ⇧⌘R | Ctrl+Shift+R |
| Write / Split / Read | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / 2 / 3 |
| Toggle preview | ⌘\ | Ctrl+\ |
| Format document | ⇧⌥F | Shift+Alt+F |
| Soft wrap | ⌥Z | Alt+Z |
| Next / previous tab | ⇧⌘] / ⇧⌘[ or ⌃Tab / ⌃⇧Tab | Ctrl+Shift+] / [ or Ctrl+Tab / Ctrl+Shift+Tab |
| Close tab | ⌘W | Ctrl+W |
| Close window | ⇧⌘W | Ctrl+Shift+W |

## Development

Requirements: Node 20+, Rust stable and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone git@github.com:symphonyprotocol-lab/edit2.git
cd edit2
npm install
npm run tauri dev                         # run the app
npm run tauri dev -- -- path/to/file.md   # open a file at launch
npm run tauri build                       # build release bundles into src-tauri/target/release/bundle
npm run tauri build -- --target universal-apple-darwin   # Apple silicon + Intel (needs `rustup target add x86_64-apple-darwin`)
cd src-tauri && cargo test                # encoding, preview protocol and migration tests
```

`npm run dev` serves the UI alone in a browser. Tauri calls are stubbed; in the browser console, `edit2.open("/absolute/path/file.json")` opens a file through the dev server.

## Adding a format

1. Create `src/formats/<id>/index.ts` exporting a `FormatPlugin` (see `src/formats/types.ts`): its extensions, a lazily loaded editor language, preview renderer and formatter, and a status bar summary. A preview renders into the element it is given and returns source-line anchors for scroll sync; it reaches the app only through its `PreviewContext`.
2. Register it in `src/formats/index.ts`.
3. Add its extensions to `bundle.fileAssociations` in `src-tauri/tauri.conf.json`. `npm run build` fails if the two lists differ.

## Layout

```
src/                     frontend (vanilla TypeScript)
  main.ts                tabs and document state, opening, auto-save and drafts, view modes, scroll sync, formatting, commands
  formats/               format plugins
    types.ts             the plugin contract
    registry.ts          extension → plugin lookup
    index.ts             the built-in plugins
    shared/              tree view, word counting
    markdown/ text/ json/ yaml/ toml/ xml/ csv/ html/
  editor.ts              CodeMirror setup and theme
  encodings.ts           encodings offered in the status bar
  popup.ts               status bar menus
  tabs.ts                tab strip (rendering, close, drag to reorder)
  host.ts                Tauri bridge with browser fallbacks
  styles.css             design tokens (light/dark) and layout
src-tauri/src/
  lib.rs                 routing opened files to the window, drafts staging area, file I/O commands
  codec.rs               encoding detection, decoding and lossless encoding
  preview.rs             preview: protocol for HTML pages with scripts enabled
  settings.rs            settings.json
  migrate.rs             one-time copy of mdit's data
  menu.rs                native macOS menu
  mac_quit.rs            applicationShouldTerminate hook so a Dock/AppleScript quit can prompt
scripts/check-formats.mjs  checks plugins and file associations list the same extensions
```

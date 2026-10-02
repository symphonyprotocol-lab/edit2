# mdit

A quick Markdown editor. Open a file, write, close it. There is no sidebar or file tree: each file you open becomes a tab in a single window. The + button in the tab strip (or ⌘T) starts a new draft at any time.

Built with Tauri 2, CodeMirror 6 and markdown-it. The macOS `.app` is about 4 MB.

The layout mockup is in [design/mockup.html](design/mockup.html).

## Features

- **Three views**: Write (editor only), Split (editor and live preview with synced scrolling) and Read (rendered preview only). Below 760 px wide, Split falls back to the editor.
- **Editor**: Markdown syntax highlighting with dimmed markup characters, highlighting inside fenced code blocks, automatic list continuation, find (⌘F), and formatting shortcuts (⌘B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⇧⌘X strikethrough).
- **Preview**: GFM tables, task lists (clicking a checkbox updates the source), code highlighting, local images and Mermaid diagrams. External links open in the system browser, and links to other `.md` files open them in mdit.
- **Tabs**: files from Finder "Open With" or the Dock icon, drag and drop, the command line (`mdit file.md`), ⌘O or links in the preview open as tabs in the same window. A file that is already open just switches to its tab, and an opened file takes over an empty untitled tab instead of adding another. Each tab keeps its own cursor, scroll position and undo history. Tabs can be reordered by dragging and closed with middle-click.
- **Auto-save**: edits are written to disk shortly after you stop typing, and when you switch tabs or leave the window. Before writing, mdit checks that no other program has changed the file; if one has, it asks instead of overwriting.
- **Drafts**: untitled documents are auto-saved to a staging area (`~/Library/Application Support/dev.symphonyprotocollab.mdit/drafts` on macOS) and reopened as tabs on the next launch. Saving a draft with ⌘S turns it into a real file and removes it from staging. Closing a draft tab asks whether to save it as a file or delete it.
- **Changes on disk**: if another program changes an open file, mdit reloads it silently when there are no pending edits, and asks otherwise. A deleted file is flagged in the status bar and is never silently recreated.
- **Closing**: quitting does not prompt, because everything is already saved or staged. mdit only asks when something could not be saved, or when a file was deleted on disk.
- **Encoding**: files are read and written as UTF-8. A BOM is removed, and the file's original CRLF or LF line endings are kept.
- **Appearance**: follows the system light or dark setting. The font size is adjustable (⌘= / ⌘- / ⌘0).

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New tab | ⌘T / ⌘N | Ctrl+T / Ctrl+N |
| Open | ⌘O | Ctrl+O |
| Save / Save As | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S |
| Show in Finder | ⇧⌘R | Ctrl+Shift+R |
| Write / Split / Read | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / 2 / 3 |
| Toggle preview | ⌘\ | Ctrl+\ |
| Next / previous tab | ⇧⌘] / ⇧⌘[ or ⌃Tab / ⌃⇧Tab | Ctrl+Shift+] / [ or Ctrl+Tab / Ctrl+Shift+Tab |
| Close tab | ⌘W | Ctrl+W |
| Close window | ⇧⌘W | Ctrl+Shift+W |

## Development

Requirements: Node 20+, Rust stable and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev                         # run the app
npm run tauri dev -- -- path/to/file.md   # open a file at launch
npm run tauri build                       # build release bundles into src-tauri/target/release/bundle
```

`npm run dev` serves the UI alone in a browser. Tauri calls are stubbed, so you can work on layout and styles without the app.

## Layout

```
src/                 frontend (vanilla TypeScript)
  main.ts            tabs and document state, opening, auto-save and drafts, view modes, scroll sync, commands
  tabs.ts            tab strip (rendering, close, drag to reorder)
  editor.ts          CodeMirror setup, theme, formatting keys
  preview.ts         markdown-it renderer (task lists, source-line anchors), word count
  mermaid.ts         lazy-loaded Mermaid rendering, themed from the app palette, with a render cache
  host.ts            Tauri bridge with browser fallbacks
  styles.css         design tokens (light/dark) and layout
src-tauri/src/
  lib.rs             routing opened files to the window, drafts staging area, file I/O commands
  menu.rs            native macOS menu
  mac_quit.rs        applicationShouldTerminate hook so a Dock/AppleScript quit can prompt
```

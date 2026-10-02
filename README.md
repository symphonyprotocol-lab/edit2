# mdit

A Markdown editor for one file at a time. Open it, write, close it. It has no sidebar, no file tree and no tabs. Each window edits exactly one file.

Built with Tauri 2, CodeMirror 6 and markdown-it. The macOS `.app` is about 4 MB.

The layout mockup is in [design/mockup.html](design/mockup.html).

## Features

- **Three views**: Write (editor only), Split (editor and live preview with synced scrolling) and Read (rendered preview only). Below 760 px wide, Split falls back to the editor.
- **Editor**: Markdown syntax highlighting with dimmed markup characters, highlighting inside fenced code blocks, automatic list continuation, find (⌘F), and formatting shortcuts (⌘B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⇧⌘X strikethrough).
- **Preview**: GFM tables, task lists (clicking a checkbox updates the source), code highlighting and local images. External links open in the system browser, and links to other `.md` files open them in mdit.
- **Opening files**: Finder "Open With" or the Dock icon, drag and drop, the command line (`mdit file.md`) or ⌘O. A file that is already open just brings its window to the front. A window with an empty, untitled document is reused; otherwise the file opens in a new window.
- **Changes on disk**: if another program changes the file, mdit reloads it silently when you have no unsaved edits. If you do, it asks first. A deleted file is flagged in the status bar.
- **Unsaved changes**: closing a window or quitting (⌘Q, the Dock or AppleScript) asks whether to save, discard or cancel.
- **Encoding**: files are read and written as UTF-8. A BOM is removed, and the file's original CRLF or LF line endings are kept.
- **Appearance**: follows the system light or dark setting. The font size is adjustable (⌘= / ⌘- / ⌘0).

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New | ⌘N | Ctrl+N |
| Open | ⌘O | Ctrl+O |
| Save / Save As | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S |
| Show in Finder | ⇧⌘R | Ctrl+Shift+R |
| Write / Split / Read | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / 2 / 3 |
| Toggle preview | ⌘\ | Ctrl+\ |
| Close window | ⌘W | Ctrl+W |

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
  main.ts            document state, file operations, view modes, scroll sync, commands
  editor.ts          CodeMirror setup, theme, formatting keys
  preview.ts         markdown-it renderer (task lists, source-line anchors), word count
  host.ts            Tauri bridge with browser fallbacks
  styles.css         design tokens (light/dark) and layout
src-tauri/src/
  lib.rs             window registry and file routing, file I/O commands
  menu.rs            native macOS menu
  mac_quit.rs        applicationShouldTerminate hook so a Dock/AppleScript quit can prompt
```

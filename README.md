# edit2

English | [简体中文](README.zh-CN.md)

A quick editor for text files. Open a file, look at it, change it, close it. Each file you open becomes a tab in a single window. Open a folder and its tree appears in a sidebar on the left; without one there is no sidebar. The + button in the tab strip (or ⌘T) starts a new draft at any time.

edit2 was called mdit and only edited Markdown. It now opens Markdown, plain text, JSON, YAML, TOML, XML, CSV and HTML, each with highlighting and (except plain text) a live preview, plus source code in about 40 languages. PDFs, images and Office documents (Word, Excel, PowerPoint) open in read-only viewers. Each format is a built-in plugin, so adding another one does not touch the rest of the app.

Built with Tauri 2 and CodeMirror 6. The layout mockup is in [design/mockup.html](design/mockup.html).

## Download

Get the latest build from [Releases](https://github.com/symphonyprotocol-lab/edit2/releases). Neither build is code-signed.

- **macOS**: the `.dmg` runs on Apple silicon and Intel Macs (macOS 10.13 or later). The first time, right-click edit2 in Applications and choose Open, or run `xattr -dr com.apple.quarantine /Applications/edit2.app`.
- **Windows**: download and run `edit2_<version>_x64-setup.exe` (64-bit Windows 10 or later). It installs for the current user without administrator rights, and installs WebView2 if it is missing. If SmartScreen stops the unsigned installer, choose More info → Run anyway. edit2 becomes the default app for Markdown only; the other formats are left with their current app and appear under Open with, so your browser keeps `.html` and `.svg` and your PDF reader, image viewer and Office keep their files.

### Updates

edit2 looks for a new release on GitHub a few seconds after launch, at most once a day, and also when you choose edit2 → Check for Updates… on macOS or the Check for updates link on the start screen. A new version is downloaded and its signature checked, then edit2 offers to restart into it (asking first about unsaved changes); if you choose Later, it is installed the next time you quit. edit2 0.2.0 cannot update itself: install the next version by hand once.

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
| Code | js, ts, jsx, tsx, py, rs, go, java, kt, c, cpp, h, cs, swift, rb, php, sh, sql, css, scss, less, lua, Dockerfile, Makefile, and more | — | — |
| PDF | pdf | Read-only viewer: pages, selectable text, links, zoom | — |
| Image | png, jpg, jpeg, gif, webp, bmp, ico, icns, avif, tif, tiff, heic, heif | Read-only viewer: fit, zoom, pan | — |
| Word | docx (doc: open in another app) | Read-only pages: styles, lists, tables, pictures | — |
| Excel | xlsx, xlsm, xlsb, xls, ods | Read-only sheets: values, dates, merged cells | — |
| PowerPoint | pptx (ppt: open in another app) | Read-only slides (macOS) or an outline | — |

- **Status bar**: shows the format, which you can change for a file (e.g. preview a `.txt` as Markdown; remembered per file), the encoding, and a summary from the format (word count, rows × columns, or whether the file parses). Parse errors show above the preview; clicking one jumps to the line.
- **Formatting** (⇧⌥F, Format menu or the status bar): pretty-prints JSON, YAML, XML and HTML and tidies TOML without dropping comments; JSON numbers keep their exact digits. One ⌘Z undoes it. Files with a syntax error are left alone. JSON and XML can also be minified.
- **Tree previews** open two levels deep, keep what you opened across edits, page long lists, and move the editor to a row's line when you click it in Split view.
- **CSV** detects the delimiter (comma, tab, semicolon, pipe), handles quoted fields with line breaks, colours columns in the editor, and adds table rows as you scroll, so 100,000 rows open instantly.
- **Code** covers JavaScript/TypeScript, Python, Rust, Go, Java, Kotlin, C/C++, C#, Swift, Ruby, PHP, shell, SQL, CSS/SCSS/Less, Lua, Dockerfile, Makefile and about 20 more, recognised by extension or by name (`Dockerfile`, `Makefile`, `CMakeLists.txt`, `Gemfile`, `.zshrc`…). Code files get line numbers, folding, bracket matching and closing, and auto-indent that follows the file's own indentation (Tab indents). The status bar shows the language; pick another under 代码… in its format menu. A language's highlighter loads the first time you open a file in it. edit2 offers itself under "Open With" for these extensions but never becomes their default app.
- **HTML** runs no scripts by default: the page is shown in a sandboxed frame with its local images, styles and fonts. "允许脚本" runs it in an isolated sandbox with its own origin (and allows external scripts, styles and fonts); it is per document and off again next launch.
- **PDF** opens in Read view only, as a viewer (pdf.js): the pages scroll continuously and fit the window's width, and only the pages in view are drawn, so long documents open at once. Files over 16 MB are read from disk in pieces as pages need them; a 270 MB file opens in a few seconds. Text can be selected and copied, links to web pages and e-mail open in the system browser and links inside the document jump to their page. ⌘= / ⌘- zoom, ⌘0 fits the width again, and pinching (or ⌘ + scroll) zooms around the pointer. The status bar shows the page you are on, the page count and the zoom. When the file changes on disk the new version replaces the old at the same place. edit2 never writes to a PDF: there is no editor, Write and Split view, formatting, encoding menu or auto-save for it, and ⌘S does nothing. Annotations and form fields are drawn but cannot be edited, password-protected PDFs and searching inside a PDF are not supported yet, and viewing PDFs needs macOS 13 or later with Safari 18. edit2 offers itself under "Open With" for PDFs but never becomes their default app.
- **Images** open in Read view only, like PDFs, and are never written. The picture loads straight from the file, so animated GIFs play. It fits the window (small images stay at 100%); ⌘= / ⌘- zoom, ⌘0 fits again, pinching or ⌘ + scroll zooms around the pointer, double-click switches between fitted and actual pixels, and a picture larger than the window can be dragged around. Transparent areas show on a checkerboard that suits light and dark mode. The status bar shows the size in pixels, the type, the file size and the zoom, and a changed file reloads in place. ICNS icons show their largest embedded PNG. TIFF and HEIC show on macOS but not on Windows, whose WebView2 cannot decode them. SVG still opens as XML with its picture in the preview. edit2 offers itself under "Open With" for images but never becomes their default app.
- **Office documents** open read-only in Read view, like PDFs, and are never written; each viewer loads the first time a file of its kind opens, and a button opens the file in its own app. **Word** (`.docx`) is laid out as pages by docx-preview, with styles, headings, lists, tables, pictures, headers, footers and footnotes; pages break where Word last paginated the file, so the count is close to Word's but not exact. **Excel** (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, and the HTML or XML tables many systems export as `.xls`) is read by [SheetJS](https://sheetjs.com) Community Edition 0.20.3 (Apache-2.0, installed from the SheetJS CDN, since the `xlsx` package on npm is no longer updated). It shows one sheet at a time, with tabs for the sheets (hidden ones marked), column letters and row numbers that stay in view, and rows added as you scroll. Cells show the values saved in the file: formulas are not recalculated, dates and times follow their number format (as `2026-03-15 14:30`; Excel's built-in short date shows as `2026-03-15` rather than in the system's locale), percentages and thousands separators are kept, and merged cells span their range. **PowerPoint** (`.pptx`) is drawn by macOS Quick Look (layout, themes, pictures, tables and charts) and scaled to the window; on Windows it shows an outline of each slide's text, pictures, tables and notes. The status bar shows the page, sheet or slide you are on, ⌘= / ⌘- / ⌘0 zoom, and a changed file reloads. Old `.xls` files open like the others, with their code page (GBK, Big5, Shift_JIS…) decoded. Old Word and PowerPoint files (`.doc`, `.ppt`) are not shown: they get a button that opens them in their own app. edit2 offers itself under "Open With" for these files but never becomes their default app.

## Features

- **Three views**: Write (editor only), Split (editor and live preview with synced scrolling) and Read (preview only), remembered per format. In Split, drag the divider to resize the two panes (double-click to reset it to half and half; arrow keys work when it has focus), and each tab keeps its own width; new tabs start at half and half. When the area beside the sidebar (the whole window if there is none) is narrower than 760 px, or 640 px next to the sidebar, Split falls back to the editor. Plain text has only Write.
- **Markdown editing**: dimmed markup characters, highlighting inside fenced code blocks, automatic list continuation, and formatting shortcuts (⌘B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⇧⌘X strikethrough). Clicking a task box in the preview updates the source.
- **Outline**: a Markdown document with headings shows an outline of them on the right, in every view. Click an entry to go to that heading: Read view scrolls the preview, Write view puts the cursor on the heading, and Split view brings the heading to the top of the preview with the editor following. The section you are in is highlighted as you scroll, and in Write and Split the outline follows your typing. Hide or show it with the button at its top right or ⇧⌘D; the choice is remembered. Documents without headings show no outline, and it hides itself when its column (the area beside the sidebar, or one of the two columns) is narrower than 860 px.
- **Links**: external links open in the system browser; links to other files of a supported format open them in edit2, other files are shown in Finder.
- **Folders**: Open Folder (⇧⌘O, the File menu, or the link on the start screen), dropping a folder on the window or the Dock icon, Finder "Open With" or `edit2 path/to/folder` shows the folder as a tree in a sidebar. On macOS, Open… (⌘O) picks folders as well as files. Folders come first, then files by name; dotfiles, `node_modules` and `__pycache__` are hidden unless you turn on "显示隐藏文件" in the sidebar's ⋯ menu. A folder's contents are read when you expand it, again each time you reopen it, and when the window comes back to the front. Clicking a file opens it as a tab like ⌘O does (files of unknown type open as plain text, other binary files are refused), and the active tab's file is highlighted. Drag the sidebar's right edge to resize it (double-click for the default width), hide it with ⇧⌘E or the button next to the window controls, and close the folder with × or File → Close Folder. Each window has at most one folder, and keeps it:
  - In a window that shows a folder, Open… (⌘O) and Open Folder… (⇧⌘O) open what you pick in a new window, and dropping another folder on it does the same. Without a folder they open in the current window, as before.
  - A folder from Finder, the Dock or the command line goes to the window that already shows it, else to the front window if it has no folder, else to a new window. Files from those places, dropped files, links in the preview and files clicked in the tree open in the window they were aimed at.
  - A file that is already open in another window is not opened twice: edit2 switches to its tab there.
  - Every window's folder comes back on the next plain launch, each in its own window. Closing a window forgets its folder; quitting, or closing the last window, keeps them.
- **Tabs**: files from Finder "Open With" or the Dock icon, drag and drop, the command line (`edit2 file.json`), ⌘O, the folder sidebar or links in the preview open as tabs in the same window (⌘O in a window with a folder opens a new window, see above). A file that is already open just switches to its tab, and an opened file takes over an empty untitled tab instead of adding another. Each tab keeps its own cursor, scroll position and undo history. Tabs can be reordered by dragging and closed with middle-click. Closing the last tab brings back the start screen; the window stays open (⇧⌘W closes it).
- **Auto-save**: edits are written to disk shortly after you stop typing, and when you switch tabs or leave the window. Before writing, edit2 checks that no other program has changed the file; if one has, it asks instead of overwriting.
- **Drafts**: untitled documents (Markdown) are auto-saved to a staging area (`~/Library/Application Support/dev.symphonyprotocollab.edit2/drafts` on macOS) and reopened as tabs on the next launch. Saving a draft with ⌘S turns it into a real file and removes it from staging; saving it with another extension switches its format. Closing a draft tab asks whether to save it as a file or delete it.
- **Changes on disk**: if another program changes an open file, edit2 reloads it silently when there are no pending edits, and asks otherwise. A deleted file is flagged in the status bar and is never silently recreated.
- **Closing**: quitting does not prompt, because everything is already saved or staged. edit2 only asks when something could not be saved, or when a file was deleted on disk.
- **Encodings**: the encoding is detected (UTF-8, UTF-16, GBK/GB18030, Big5, Shift_JIS, EUC-KR, Windows-1252, …) and files are written back in it, keeping a byte order mark and CRLF or LF line endings. A "?" after the encoding means it was guessed from little text; the status bar menu reopens the file in another encoding or saves it in one. If you type characters the encoding cannot hold, edit2 does not save them lossily: it offers to switch to UTF-8. Other binary files are refused.
- **Large files**: from 5 MB, the preview and word count wait for a click. Files over 50 MB open read-only after you confirm.
- **Appearance**: follows the system light or dark setting. The font size is adjustable (⌘= / ⌘- / ⌘0; in a PDF, image or Office document these zoom it instead), and soft wrap can be turned off per tab (⌥Z).
- **Settings** (views, font size, recent files, per-file formats, whether the outline is shown, the open folders and the sidebar's width) are kept in `settings.json` in the app data folder. The first launch copies mdit's drafts and settings over and leaves mdit's own data in place.

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
| Open Folder | ⇧⌘O | Ctrl+Shift+O |
| Show / hide sidebar | ⇧⌘E | Ctrl+Shift+E |
| Show / hide outline | ⇧⌘D | Ctrl+Shift+D |
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
npm run tauri dev -- -- path/to/folder    # open a folder in the sidebar at launch
npm run tauri build                       # build release bundles into src-tauri/target/release/bundle
npm run tauri build -- --target universal-apple-darwin   # Apple silicon + Intel (needs `rustup target add x86_64-apple-darwin`)
cd src-tauri && cargo test                # encoding, preview protocol, migration, folder listing and window routing tests
```

Releasing a version (bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` first):

1. Create the GitHub release for the tag, e.g. `v0.3.0`.
2. On a Mac, run `scripts/release-mac.sh v0.3.0`. It builds the universal app, signs the update with the key in `~/.tauri/edit2-updater.key` (password in `edit2-updater.key.password`), and uploads the `.dmg`, the update archive and its signature.
3. Publishing the release runs [.github/workflows/release-windows.yml](.github/workflows/release-windows.yml), which builds and signs the Windows installer with the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets and uploads it; run the workflow by hand with a tag to redo it.

Both steps run [scripts/publish-update.mjs](scripts/publish-update.mjs), which adds its platform to the release's `latest.json`. Installed copies read that file from the latest release, so updates reach users once the release is published (not while it is a draft or prerelease). Keep the private key: without it no future release can update existing installs. Plain `npm run tauri build` does not need the key.

`npm run dev` serves the UI alone in a browser. Tauri calls are stubbed; in the browser console, `edit2.open("/absolute/path/file.json")` opens a file through the dev server, and `edit2.openFolder("/absolute/path")` (or the Open Folder link, which asks for a path) shows a folder, listed by a small middleware in `vite.config.ts`. The dev server only serves files inside the project, so open files from the project's own tree there.

## Adding a format

1. Create `src/formats/<id>/index.ts` exporting a `FormatPlugin` (see `src/formats/types.ts`): its extensions, a lazily loaded editor language, preview renderer and formatter, and a status bar summary. A preview renders into the element it is given and returns source-line anchors for scroll sync; it reaches the app only through its `PreviewContext`.
2. Register it in `src/formats/index.ts`.
3. Add its extensions to `bundle.fileAssociations` in `src-tauri/tauri.conf.json`, and on Windows to the Open with list in `src-tauri/windows/installer-hooks.nsh` (or to `src-tauri/tauri.windows.conf.json` if edit2 should become the default app). `npm run build` fails if the lists differ.

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
  popup.ts               status bar and sidebar menus
  tabs.ts                tab strip (rendering, close, drag to reorder)
  sidebar.ts             folder tree (lazy loading, keyboard navigation, active file)
  host.ts                Tauri bridge with browser fallbacks
  styles.css             design tokens (light/dark) and layout
src-tauri/src/
  lib.rs                 routing opened files and folders to the window, drafts staging area, file I/O commands
  fstree.rs              one level of a folder for the sidebar, sorted and filtered
  routing.rs             which window a file or folder goes to; folders to reopen at launch
  codec.rs               encoding detection, decoding and lossless encoding
  preview.rs             preview: protocol for HTML pages with scripts enabled
  settings.rs            settings.json
  migrate.rs             one-time copy of mdit's data
  menu.rs                native macOS menu
  mac_quit.rs            applicationShouldTerminate hook so a Dock/AppleScript quit can prompt
  update.rs              checks for, downloads and installs updates
src-tauri/tauri.release.conf.json  release builds: adds the signed updater archives
src-tauri/tauri.windows.conf.json  Windows bundle: NSIS installer, Markdown-only default association
src-tauri/windows/installer-hooks.nsh  adds the other formats to Explorer's Open with list
scripts/check-formats.mjs  checks plugins and file associations list the same extensions
.github/workflows/release-windows.yml  builds the Windows installer and update for each release
scripts/release-mac.sh     builds the macOS app and update and uploads them to a release
scripts/publish-update.mjs uploads a signed update and adds it to the release's latest.json
```

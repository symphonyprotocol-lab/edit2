# edit2

[English](README.md) | 简体中文

一个轻量的文本文件编辑器：打开、看一眼、改一下、关掉。打开的每个文件都是同一个窗口里的一个标签页。打开文件夹时，左侧的侧边栏会显示它的目录树；不打开文件夹就没有侧边栏。随时可以点标签栏里的 + 按钮（或按 ⌘T）新建草稿。

edit2 的前身是 mdit，原来只能编辑 Markdown。现在可以打开 Markdown、纯文本、JSON、YAML、TOML、XML、CSV 和 HTML，每种格式都有语法高亮，除纯文本外都有实时预览；另外还支持约 40 种编程语言的源代码。每种格式都是一个内置插件，增加新格式不需要改动应用的其他部分。

基于 Tauri 2 和 CodeMirror 6 构建。界面布局草图见 [design/mockup.html](design/mockup.html)。

## 下载

从 [Releases](https://github.com/symphonyprotocol-lab/edit2/releases) 下载最新版本。两个平台的安装包都没有代码签名。

- **macOS**：`.dmg` 同时支持 Apple 芯片和 Intel Mac，需要 macOS 10.13 或更高版本。第一次打开时，在「应用程序」里右键 edit2 →「打开」，或者执行 `xattr -dr com.apple.quarantine /Applications/edit2.app`。
- **Windows**：下载 `edit2_<版本>_x64-setup.exe` 并运行，需要 64 位 Windows 10 或更高版本。安装到当前用户下，不需要管理员权限；系统里没有 WebView2 时，安装程序会自动安装。安装程序没有代码签名，SmartScreen 拦截时点「更多信息」→「仍要运行」。edit2 只会注册为 Markdown 的默认打开方式，其他格式不改动默认程序，需要时右键文件 →「打开方式」选择 edit2，`.html`、`.svg` 仍由原来的浏览器打开。

## 支持的格式

| 格式 | 扩展名 | 预览 | 格式化 / 压缩 |
| --- | --- | --- | --- |
| Markdown | md, markdown, mdown, mkd, mdx | 渲染（GFM 表格、任务列表、代码高亮、本地图片、Mermaid） | — |
| 纯文本 | txt, text, log，以及其他任何文本文件 | — | — |
| JSON | json, jsonc, json5, geojson, webmanifest | 可折叠的树 | 都支持 |
| YAML | yaml, yml | 可折叠的树，每个文档一个节点 | 格式化 |
| TOML | toml | 可折叠的树 | 整理 |
| XML | xml, svg, plist, xsd, xsl, xslt, rss, atom | 元素树；SVG 还可以看图片 | 都支持 |
| CSV / TSV | csv, tsv, tab | 表头固定的表格 | — |
| HTML | html, htm | 在沙箱中显示页面 | 格式化 |
| 代码 | js, ts, jsx, tsx, py, rs, go, java, kt, c, cpp, h, cs, swift, rb, php, sh, sql, css, scss, less, lua, Dockerfile, Makefile 等 | — | — |

- **状态栏**：显示文件格式，可以为单个文件改用别的格式（例如把 `.txt` 当作 Markdown 预览，按文件记住）；还显示编码，以及格式给出的摘要（字数、行数 × 列数，或文件能否解析）。解析错误显示在预览上方，点一下跳到对应的行。
- **格式化**（⇧⌥F、「格式」菜单或状态栏）：美化 JSON、YAML、XML 和 HTML，整理 TOML 而不丢掉注释；JSON 数字保持原来的每一位。按一次 ⌘Z 即可撤销。有语法错误的文件不做改动。JSON 和 XML 还可以压缩。
- **树形预览** 默认展开两层，编辑后保留已展开的节点，长列表分页显示；在分栏视图中点击某一行，编辑器会跳到对应的行。
- **CSV** 自动识别分隔符（逗号、制表符、分号、竖线），支持带换行的引号字段，在编辑器里按列着色，表格行随滚动逐步加载，10 万行也能立即打开。
- **代码** 支持 JavaScript/TypeScript、Python、Rust、Go、Java、Kotlin、C/C++、C#、Swift、Ruby、PHP、shell、SQL、CSS/SCSS/Less、Lua、Dockerfile、Makefile 等约 40 种语言，按扩展名或文件名识别（`Dockerfile`、`Makefile`、`CMakeLists.txt`、`Gemfile`、`.zshrc`…）。代码文件有行号、折叠、括号匹配和自动补全括号，自动缩进会跟随文件原有的缩进方式（Tab 键缩进）。状态栏显示语言，可以在格式菜单的「代码…」里换成别的语言。每种语言的高亮在第一次打开该语言的文件时才加载。edit2 只出现在这些扩展名的「打开方式」里，不会成为它们的默认程序。
- **HTML** 默认不运行脚本：页面显示在沙箱框架中，带上本地的图片、样式和字体。点「允许脚本」后，页面在独立来源的隔离沙箱中运行（也允许加载外部脚本、样式和字体）；这个设置只对当前文档有效，下次启动恢复关闭。

## 功能

- **三种视图**：写作（只有编辑器）、分栏（编辑器加实时预览，滚动同步）和阅读（只有预览），按格式分别记住。分栏时可以拖动中间的分隔线调整两边宽度（双击恢复对半，获得焦点时也可以用方向键），每个标签页各自记住宽度，新开的标签页从对半开始。编辑区域（侧边栏右侧的区域，没有侧边栏时就是整个窗口）窄于 760 px 时，分栏退回到编辑器；旁边有侧边栏时这个阈值是 640 px。纯文本只有写作视图。
- **Markdown 编辑**：标记符号淡化显示，围栏代码块内有语法高亮，列表自动续行，提供格式快捷键（⌘B 粗体、⌘I 斜体、⌘E 行内代码、⌘K 链接、⇧⌘X 删除线）。在预览里勾选任务框会同步修改源文本。
- **大纲**：阅读视图下，有标题的 Markdown 文档会在右侧显示标题大纲。点击条目跳到对应标题，滚动时会高亮当前正在阅读的章节。用预览右上角的按钮或 ⇧⌘D 隐藏或显示，选择会被记住。没有标题的文档不显示大纲；编辑区域（侧边栏右侧的区域，没有侧边栏时就是整个窗口）窄于 860 px 时大纲自动隐藏。
- **链接**：外部链接用系统浏览器打开；指向其他受支持格式文件的链接在 edit2 中打开，其他文件在访达中显示。
- **文件夹**：通过「打开文件夹」（⇧⌘O、「文件」菜单或开始界面上的链接）、把文件夹拖到窗口或程序坞图标、访达「打开方式」或 `edit2 path/to/folder` 打开文件夹，侧边栏会以树形显示它。文件夹排在前面，文件按名称排序；以点开头的文件、`node_modules` 和 `__pycache__` 默认隐藏，可以在侧边栏 ⋯ 菜单里打开「显示隐藏文件」。文件夹的内容在展开时读取，每次重新展开、窗口回到前台时都会刷新。点击文件会像 ⌘O 一样以标签页打开（未知类型按纯文本打开，二进制文件不打开），当前标签页对应的文件会高亮。拖动侧边栏右边缘调整宽度（双击恢复默认宽度），用 ⇧⌘E 或窗口按钮旁边的按钮隐藏侧边栏，用 × 或「文件」→「关闭文件夹」关闭文件夹。每个窗口最多显示一个文件夹，并且会一直保持：
  - 在显示文件夹的窗口里，「打开…」（⌘O）和「打开文件夹…」（⇧⌘O）会在新窗口中打开所选内容，把另一个文件夹拖进来也一样。没有文件夹时，它们和以前一样在当前窗口打开。
  - 从访达、程序坞或命令行打开的文件夹，会进入已经显示它的窗口；没有的话进入前台没有文件夹的窗口，再没有就新开一个窗口。从这些地方打开的文件、拖入的文件、预览中的链接和目录树中点击的文件，都在目标窗口中打开。
  - 已经在另一个窗口打开的文件不会再打开一次，edit2 会切换到那个窗口里的标签页。
  - 下次正常启动时，每个窗口的文件夹都会在各自的窗口中恢复。关闭某个窗口会忘记它的文件夹；退出应用或关闭最后一个窗口则会保留。
- **标签页**：通过访达「打开方式」或程序坞图标、拖放、命令行（`edit2 file.json`）、⌘O、文件夹侧边栏或预览中的链接打开的文件，都以标签页的形式出现在同一个窗口里（在显示文件夹的窗口里按 ⌘O 会打开新窗口，见上文）。已经打开的文件只会切换到它的标签页；空白的未命名标签页会被新打开的文件直接占用，而不是再加一个。每个标签页有各自的光标、滚动位置和撤销历史。拖动可以调整标签页顺序，鼠标中键点击可以关闭。
- **自动保存**：停止输入后不久、切换标签页或离开窗口时，修改会写入磁盘。写入前，edit2 会检查文件是否被其他程序改过；如果改过，会先询问，而不是直接覆盖。
- **草稿**：未命名的文档（Markdown）自动保存到暂存区（macOS 上是 `~/Library/Application Support/dev.symphonyprotocollab.edit2/drafts`），下次启动时以标签页重新打开。用 ⌘S 保存草稿会把它变成真正的文件，并从暂存区移除；保存时换一个扩展名会同时切换格式。关闭草稿标签页时会询问是保存为文件还是删除。
- **磁盘上的改动**：如果其他程序改动了已打开的文件，没有未保存的编辑时 edit2 会静默重新载入，有的话会先询问。文件被删除时会在状态栏标出，edit2 不会悄悄把它重新创建出来。
- **关闭**：退出时不会弹出提示，因为所有内容都已保存或暂存。只有某些内容没能保存，或者文件在磁盘上被删除时，edit2 才会询问。
- **编码**：自动识别编码（UTF-8、UTF-16、GBK/GB18030、Big5、Shift_JIS、EUC-KR、Windows-1252 等），按原编码写回，并保留字节顺序标记（BOM）以及 CRLF 或 LF 换行符。编码后面带「?」表示是根据很少的文本推测出来的；状态栏菜单可以用别的编码重新打开文件，或用别的编码保存。如果输入了当前编码无法表示的字符，edit2 不会有损保存，而是提示改用 UTF-8。二进制文件不会打开。
- **大文件**：5 MB 以上的文件，预览和字数统计需要点击后才进行。50 MB 以上的文件确认后以只读方式打开。
- **外观**：跟随系统的浅色或深色设置。字号可以调整（⌘= / ⌘- / ⌘0），自动换行可以按标签页关闭（⌥Z）。
- **设置**（视图、字号、最近文件、按文件记住的格式、是否显示大纲、打开的文件夹和侧边栏宽度）保存在应用数据目录下的 `settings.json` 中。首次启动时会复制 mdit 的草稿和设置，mdit 自己的数据保持不动。

## 从 mdit 升级

- edit2 首次启动时会复制 mdit 的草稿、偏好设置和最近文件，并提示一次。mdit 自己的数据保持不动；确认 edit2 里内容齐全后，删除 mdit，这样「打开方式」里只会列出其中一个。
- `.txt` 文件现在是纯文本：没有 Markdown 高亮和预览。如果还想把某个文件当作 Markdown 预览，在状态栏的格式菜单里选 Markdown（会为这个文件记住）。
- 保存时会保留 UTF-8 的字节顺序标记（mdit 会去掉它）。
- 其他编码的文件（GBK、Big5、Shift_JIS 等）现在可以打开，不再被拒绝，并按原编码保存。

## 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 新建标签页 | ⌘T / ⌘N | Ctrl+T / Ctrl+N |
| 打开 | ⌘O | Ctrl+O |
| 打开文件夹 | ⇧⌘O | Ctrl+Shift+O |
| 显示 / 隐藏侧边栏 | ⇧⌘E | Ctrl+Shift+E |
| 显示 / 隐藏大纲（阅读视图） | ⇧⌘D | Ctrl+Shift+D |
| 保存 / 另存为 | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S |
| 在访达中显示 | ⇧⌘R | Ctrl+Shift+R |
| 写作 / 分栏 / 阅读 | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / 2 / 3 |
| 切换预览 | ⌘\ | Ctrl+\ |
| 格式化文档 | ⇧⌥F | Shift+Alt+F |
| 自动换行 | ⌥Z | Alt+Z |
| 下一个 / 上一个标签页 | ⇧⌘] / ⇧⌘[ 或 ⌃Tab / ⌃⇧Tab | Ctrl+Shift+] / [ 或 Ctrl+Tab / Ctrl+Shift+Tab |
| 关闭标签页 | ⌘W | Ctrl+W |
| 关闭窗口 | ⇧⌘W | Ctrl+Shift+W |

## 开发

需要 Node 20+、Rust stable 以及 [Tauri 的前置依赖](https://tauri.app/start/prerequisites/)。

```bash
git clone git@github.com:symphonyprotocol-lab/edit2.git
cd edit2
npm install
npm run tauri dev                         # 运行应用
npm run tauri dev -- -- path/to/file.md   # 启动时打开一个文件
npm run tauri dev -- -- path/to/folder    # 启动时在侧边栏打开一个文件夹
npm run tauri build                       # 构建安装包，输出到 src-tauri/target/release/bundle
npm run tauri build -- --target universal-apple-darwin   # 同时支持 Apple 芯片和 Intel（需要先执行 `rustup target add x86_64-apple-darwin`）
cd src-tauri && cargo test                # 编码、预览协议、数据迁移、文件夹列表和窗口分派的测试
```

在 GitHub 上发布 release 会运行 [.github/workflows/release-windows.yml](.github/workflows/release-windows.yml)，构建 Windows 安装包并上传到这个 release；也可以手动运行这个工作流并指定 tag，为较早的 release 补上安装包。macOS 的 `.dmg` 仍然用上面的 universal 目标在本地构建。

`npm run dev` 只在浏览器里运行界面，Tauri 调用都用替身代替；在浏览器控制台里执行 `edit2.open("/absolute/path/file.json")` 可以通过开发服务器打开文件，执行 `edit2.openFolder("/absolute/path")`（或点「打开文件夹」链接，它会要求输入路径）可以显示文件夹，目录内容由 `vite.config.ts` 里的一个小中间件列出。开发服务器只提供项目内的文件，所以只能打开项目目录里的文件。

## 添加一种格式

1. 新建 `src/formats/<id>/index.ts`，导出一个 `FormatPlugin`（见 `src/formats/types.ts`）：包括扩展名、按需加载的编辑器语言、预览渲染器、格式化器，以及状态栏摘要。预览渲染到传入的元素中，并返回用于滚动同步的源码行锚点；它只通过自己的 `PreviewContext` 与应用交互。
2. 在 `src/formats/index.ts` 中注册。
3. 把扩展名加到 `src-tauri/tauri.conf.json` 的 `bundle.fileAssociations` 里；Windows 上还要加到 `src-tauri/windows/installer-hooks.nsh` 的「打开方式」列表中（如果希望 edit2 成为默认程序，则加到 `src-tauri/tauri.windows.conf.json`）。这些列表不一致时，`npm run build` 会失败。

## 目录结构

```
src/                     前端（原生 TypeScript）
  main.ts                标签页与文档状态、打开文件、自动保存与草稿、视图模式、滚动同步、格式化、命令
  formats/               格式插件
    types.ts             插件接口
    registry.ts          扩展名 → 插件的查找
    index.ts             内置插件
    shared/              树形视图、字数统计
    markdown/ text/ json/ yaml/ toml/ xml/ csv/ html/
  editor.ts              CodeMirror 配置和主题
  encodings.ts           状态栏中可选的编码
  popup.ts               状态栏和侧边栏菜单
  tabs.ts                标签栏（渲染、关闭、拖动排序）
  sidebar.ts             目录树（按需加载、键盘导航、高亮当前文件）
  host.ts                Tauri 桥接，带浏览器下的替代实现
  styles.css             设计变量（浅色/深色）和布局
src-tauri/src/
  lib.rs                 把打开的文件和文件夹分派到窗口、草稿暂存区、文件读写命令
  fstree.rs              为侧边栏列出文件夹的一层内容，排序并过滤
  routing.rs             文件或文件夹该进入哪个窗口；启动时要恢复的文件夹
  codec.rs               编码识别、解码和无损编码
  preview.rs             preview: 协议，用于允许脚本的 HTML 页面
  settings.rs            settings.json
  migrate.rs             一次性复制 mdit 的数据
  menu.rs                macOS 原生菜单
  mac_quit.rs            applicationShouldTerminate 钩子，让程序坞或 AppleScript 发起的退出也能询问
src-tauri/tauri.windows.conf.json  Windows 打包：NSIS 安装程序，只把 Markdown 设为默认关联
src-tauri/windows/installer-hooks.nsh  把其他格式加到资源管理器的「打开方式」列表
scripts/check-formats.mjs  检查插件和文件关联列出的扩展名是否一致
.github/workflows/release-windows.yml  为每个 release 构建 Windows 安装包
```

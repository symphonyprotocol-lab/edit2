import MarkdownIt, { type StateCore } from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

type PluginSimple = (md: InstanceType<typeof MarkdownIt>) => void;

/** Tag every block token with the source line it starts on, for scroll sync. */
const sourceLines: PluginSimple = (md) => {
  md.core.ruler.push("source_lines", (state: StateCore) => {
    for (const token of state.tokens) {
      if (token.map && token.nesting !== -1 && token.type !== "inline") {
        token.attrSet("data-line", String(token.map[0]));
      }
    }
  });
};

/** GitHub-style `- [ ]` / `- [x]` task list items. */
const taskLists: PluginSimple = (md) => {
  md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open") continue;
      const item = tokens[i - 2];
      if (item.type !== "list_item_open") continue;
      const m = /^\[([ xX])\][ \t]/.exec(inline.content);
      if (!m || !inline.children?.length) continue;
      const first = inline.children[0];
      if (first.type !== "text" || !first.content.startsWith(m[0].trimEnd())) continue;

      first.content = first.content.slice(3).replace(/^[ \t]/, "");
      const box = new state.Token("html_inline", "", 0);
      const line = item.map ? item.map[0] : -1;
      box.content = `<input type="checkbox" class="task-box" data-task-line="${line}"${m[1] === " " ? "" : " checked"}>`;
      inline.children.unshift(box);
      item.attrJoin("class", "task");
    }
  });
};

/**
 * ```mermaid blocks become placeholders holding their source; the preview
 * swaps in the rendered diagram afterwards (see mermaid.ts).
 */
const mermaidBlocks: PluginSimple = (md) => {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim().split(/\s+/)[0].toLowerCase() !== "mermaid") {
      return fence(tokens, idx, options, env, self);
    }
    const line = token.map ? ` data-line="${token.map[0]}"` : "";
    return `<div class="mermaid-block"${line}><pre class="mermaid-source"><code>${md.utils.escapeHtml(token.content)}</code></pre></div>\n`;
  };
};

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through to plain text */
      }
    }
    return "";
  },
})
  .use(sourceLines)
  .use(taskLists)
  .use(mermaidBlocks);

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), {
    ADD_ATTR: ["data-line", "data-task-line"],
    FORBID_TAGS: ["style", "form"],
  });
}

// ---------- word counting ----------

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const WORD = /[A-Za-z0-9À-ɏ]+(?:['’.-][A-Za-z0-9À-ɏ]+)*/g;

export function countWords(text: string): { words: number; minutes: number } {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").match(WORD)?.length ?? 0;
  const words = cjk + latin;
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(cjk / 400 + latin / 220));
  return { words, minutes };
}

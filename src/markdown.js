import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import anchor from "markdown-it-anchor";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";

/* ---------- slug：保留中文，去掉标点 ---------- */
export function slugify(s) {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

/* ---------- 数学公式 ---------- */
function mathPlugin(md) {
  const render = (tex, display) => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
    } catch (e) {
      return `<code class="math-error" title="${md.utils.escapeHtml(e.message)}">${md.utils.escapeHtml(tex)}</code>`;
    }
  };

  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    if (state.src[state.pos] !== "$") return false;
    if (state.src[state.pos + 1] === "$") return false;
    const start = state.pos + 1;
    let pos = start;
    let end = -1;
    while (pos < state.src.length) {
      const ch = state.src[pos];
      if (ch === "\\") { pos += 2; continue; }
      if (ch === "$") { end = pos; break; }
      if (ch === "\n") return false;
      pos++;
    }
    if (end < 0 || end === start) return false;
    if (/\s/.test(state.src[end - 1])) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = state.src.slice(start, end);
      token.markup = "$";
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.after("blockquote", "math_block", (state, startLine, endLine) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const first = state.src.slice(start, max);
    if (!first.startsWith("$$")) return false;
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;

    let content = first.slice(2);
    let next = startLine + 1;
    const sameLine = content.indexOf("$$");
    if (sameLine >= 0 && content.slice(sameLine + 2).trim() === "") {
      content = content.slice(0, sameLine);
    } else {
      let closed = false;
      while (next < endLine) {
        const s = state.bMarks[next] + state.tShift[next];
        const e = state.eMarks[next];
        const line = state.src.slice(s, e);
        const idx = line.indexOf("$$");
        if (idx >= 0 && line.slice(idx + 2).trim() === "") {
          content += "\n" + line.slice(0, idx);
          next++;
          closed = true;
          break;
        }
        content += "\n" + line;
        next++;
      }
      if (!closed) return false;
    }

    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content = content.trim();
    token.markup = "$$";
    token.map = [startLine, next];
    state.line = next;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, i) => render(tokens[i].content, false);
  md.renderer.rules.math_block = (tokens, i) =>
    `<div class="math-block">${render(tokens[i].content, true)}</div>\n`;
}

/* ---------- 代码块 / Mermaid ---------- */
function fencePlugin(md) {
  const fallback = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang === "mermaid") {
      return `<div class="mermaid-block"><pre class="mermaid-src">${md.utils.escapeHtml(
        token.content,
      )}</pre><div class="mermaid-out"></div></div>\n`;
    }
    if (lang) {
      let body;
      try {
        body = hljs.getLanguage(lang)
          ? hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value
          : md.utils.escapeHtml(token.content);
      } catch {
        body = md.utils.escapeHtml(token.content);
      }
      return `<pre class="code-block" data-lang="${md.utils.escapeHtml(lang)}"><span class="code-lang">${md.utils.escapeHtml(
        lang,
      )}</span><code class="hljs language-${md.utils.escapeHtml(lang)}">${body}</code></pre>\n`;
    }
    return fallback(tokens, idx, options, env, self);
  };
}

/* ---------- 实例 ---------- */
export const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})
  .use(footnote)
  .use(anchor, {
    slugify,
    tabIndex: false,
  })
  .use(mathPlugin)
  .use(fencePlugin);

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") || "";
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("loading", "lazy");
  return self.renderToken(tokens, idx, options);
};

/* ---------- 渲染 + 净化 ---------- */
const PURIFY = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: ["style", "form", "iframe", "object", "embed"],
  FORBID_ATTR: ["contenteditable", "onerror", "onload"],
  ADD_ATTR: ["target", "rel", "loading", "align"],
};

export function renderMarkdown(text) {
  const raw = md.render(text);
  return DOMPurify.sanitize(raw, PURIFY);
}

export function setRawHtml(enabled) {
  md.set({ html: !!enabled });
}

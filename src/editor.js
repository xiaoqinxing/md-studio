import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, bracketMatching } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { tags } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: tags.heading1, color: "var(--text)", fontWeight: "700", fontSize: "1.12em" },
  { tag: tags.heading2, color: "var(--text)", fontWeight: "700" },
  { tag: tags.heading3, color: "var(--text)", fontWeight: "650" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: "var(--text-2)", fontWeight: "600" },
  { tag: tags.strong, color: "var(--text)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--text)", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "var(--text-3)", textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent-2)", textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--code-inline)" },
  { tag: tags.quote, color: "var(--text-3)", fontStyle: "italic" },
  { tag: [tags.list, tags.meta], color: "var(--accent)" },
  { tag: tags.processingInstruction, color: "var(--text-3)" },
  { tag: tags.contentSeparator, color: "var(--text-3)" },
  { tag: tags.escape, color: "var(--syn-num)" },
]);

const theme = EditorView.theme(
  {
    "&": { color: "var(--text)", backgroundColor: "transparent", height: "100%" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-soft)",
    },
    ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--text)", borderColor: "var(--line)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--mark) 65%, transparent)", outline: "1px solid var(--line)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--mark)" },
    ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
    ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", color: "var(--text)" },
    ".cm-placeholder": { color: "var(--text-3)" },
  },
  { dark: false },
);

export function createEditor(host, { doc, onChange, onCursor, onScroll, onSave, onToggleMode }) {
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    bracketMatching(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "Markdown 源码" }),
    markdown({ base: markdownLanguage, codeLanguages: [] }),
    syntaxHighlighting(highlight),
    search({ top: true }),
    highlightSelectionMatches(),
    placeholder("在这里开始写作，或把 .md 文件拖进窗口…"),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => { onSave?.(); return true; },
      },
      {
        key: "Mod-b",
        run: (v) => wrap(v, "**", "**", "粗体"),
      },
      {
        key: "Mod-i",
        run: (v) => wrap(v, "_", "_", "斜体"),
      },
      {
        key: "Mod-k",
        run: (v) => wrap(v, "[", "](url)", "链接文字"),
      },
      {
        key: "Mod-e",
        run: (v) => wrap(v, "`", "`", "code"),
      },
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: () => { onToggleMode?.(); return true; },
      },
      indentWithTab,
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        onCursor?.({ line: line.number, col: head - line.from + 1 });
      }
    }),
    theme,
  ];
  const makeState = (text) => EditorState.create({ doc: text, extensions });
  const view = new EditorView({
    parent: host,
    state: makeState(doc),
  });

  view.scrollDOM.addEventListener("scroll", () => onScroll?.(ratio(view)), { passive: true });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    // 重建状态以清空上一个文件的撤销历史，避免跨文件 undo
    setDoc(text) {
      view.setState(makeState(text));
    },
    focus: () => view.focus(),
    openSearch: () => openSearchPanel(view),
    ratio: () => ratio(view),
    scrollToRatio(r) {
      const el = view.scrollDOM;
      el.scrollTop = r * (el.scrollHeight - el.clientHeight);
    },
  };
}

function ratio(view) {
  const el = view.scrollDOM;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function wrap(view, before, after, sample) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to) || sample;
    return {
      changes: { from: range.from, to: range.to, insert: before + selected + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + selected.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
  return true;
}

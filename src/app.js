import { createEditor } from "./editor.js";
import { renderMarkdown, setRawHtml } from "./markdown.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const LS = {
  doc: "mdstudio:doc",
  name: "mdstudio:name",
  ui: "mdstudio:ui",
  saved: "mdstudio:saved",
};

const SAMPLE = `# md·studio

一个**纯本地**的 Markdown 工作台。文字只留在这台机器上，关掉网络也能用。

## 快速开始

- 直接在这里写作，右侧实时预览
- 拖入 \`.md\` 文件，或按 \`Ctrl+O\` 打开
- \`Ctrl+S\` 保存，\`Ctrl+Shift+L\` 换主题

> 隐私不是设置项，而是默认值：没有后端、没有账号、没有出站请求。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| GFM | 表格、删除线、任务列表 |
| 公式 | 行内 $E = mc^2$ 与块级公式 |
| 图表 | Mermaid 流程图、时序图 |
| 代码 | 语法高亮 + 一键复制 |
| 目录 | 左侧大纲，随滚动高亮 |

### 任务清单

- [x] 分栏 / 源码 / 阅读三种视图
- [x] 自动保存草稿
- [ ] 把这篇文档换成你自己的内容

## 数学

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

行内公式：当 $a \\ne 0$ 时，$ax^2 + bx + c = 0$ 的解为
$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$。

## 图表

\`\`\`mermaid
flowchart LR
  A[打开文档] --> B{本地渲染}
  B --> C[预览]
  B --> D[自动保存]
  C --> E[导出 HTML / PDF]
\`\`\`

## 代码

\`\`\`js
export function debounce(fn, wait = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
\`\`\`

## 脚注

Markdown 由 John Gruber 在 2004 年创造[^1]，如今已是写作的通用格式。

[^1]: 见 <https://daringfireball.net/projects/markdown/>。

---

*把这段示例删掉，就可以开始写你自己的东西了。*
`;

const state = {
  name: "未命名.md",
  handle: null,
  lastModified: 0,
  lastSaved: "",
  dirty: false,
  mode: "split",
  theme: "auto",
  tocOpen: true,
  rawHtml: false,
  fontFamily: "sans",
  fontSize: 17,
  measure: 760,
  renderTimer: 0,
  saveTimer: 0,
  statsTimer: 0,
  renderGen: 0,
  renderVersion: 0,
  pending: false,
  mermaidSeq: 0,
  mermaidCache: new Map(),
};

let editor = null;

const ui = {
  html: document.documentElement,
  body: document.body,
  app: $("#app"),
  preview: $("#preview"),
  previewScroll: $("#previewScroll"),
  toc: $("#toc"),
  tocList: $("#tocList"),
  docName: $("#docName"),
  dirty: $("#dirty"),
  stPos: $("#stPos"),
  stWords: $("#stWords"),
  stChars: $("#stChars"),
  stTime: $("#stTime"),
  stSave: $("#stSave"),
  edMeta: $("#edMeta"),
  pvMeta: $("#pvMeta"),
  menu: $("#menu"),
  toast: $("#toast"),
  drop: $("#drop"),
  fileInput: $("#fileInput"),
};

/* ---------- 小工具 ---------- */
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function toast(msg, ms = 1800) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    ui.toast.classList.remove("show");
    setTimeout(() => (ui.toast.hidden = true), 200);
  }, ms);
}

function readUi() {
  try {
    return JSON.parse(localStorage.getItem(LS.ui) || "{}");
  } catch {
    return {};
  }
}

function saveUi() {
  localStorage.setItem(
    LS.ui,
    JSON.stringify({
      mode: state.mode,
      theme: state.theme,
      tocOpen: state.tocOpen,
      rawHtml: state.rawHtml,
      fontFamily: state.fontFamily,
      fontSize: state.fontSize,
      measure: state.measure,
      editorWidth: getComputedStyle(ui.html).getPropertyValue("--editor-w").trim(),
    }),
  );
}

function setDirty(v) {
  state.dirty = v;
  ui.dirty.hidden = !v;
  ui.stSave.textContent = v ? "未保存" : "已保存";
  ui.stSave.classList.toggle("dirty-state", v);
}

function applyTypography() {
  ui.html.style.setProperty("--reading-size", state.fontSize + "px");
  ui.html.style.setProperty("--measure", state.measure + "px");
  ui.body.dataset.font = state.fontFamily;
  $$("#fontSeg button").forEach((b) => b.classList.toggle("on", b.dataset.font === state.fontFamily));
  $("#fontSize").value = state.fontSize;
  $("#fontSizeOut").value = state.fontSize;
  $("#measure").value = state.measure;
  $("#measureOut").value = state.measure;
}

/* ---------- 渲染 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function scheduleRender(opts = {}) {
  clearTimeout(state.renderTimer);
  state.pending = true;
  const v = ++state.renderVersion;
  if (state.mode === "source" && !opts.force) {
    ui.pvMeta.textContent = "切到分栏或阅读时更新";
    return;
  }
  const len = editor ? editor.getDoc().length : 0;
  const wait = opts.immediate ? 0 : len > 400000 ? 650 : len > 120000 ? 380 : 130;
  state.renderTimer = setTimeout(() => {
    if (v !== state.renderVersion) return;
    if (len > 120000 && window.requestIdleCallback) {
      window.requestIdleCallback(() => v === state.renderVersion && renderNow(), { timeout: 1200 });
    } else {
      renderNow();
    }
  }, wait);
}

function renderNow() {
  if (!editor) return;
  const gen = ++state.renderGen;
  state.pending = false;
  setRawHtml(state.rawHtml);
  const text = editor.getDoc();
  const t0 = performance.now();
  ui.preview.classList.toggle("long", text.length > 120000);
  const html = renderMarkdown(text);
  ui.preview.innerHTML = html;
  enhance(gen);
  updateToc();
  syncTocActive();
  updateStats();
  ui.pvMeta.textContent = `渲染 ${Math.round(performance.now() - t0)} ms`;
}

function mermaidTheme() {
  return ui.html.dataset.theme === "dark" ? "dark" : "default";
}

function enhance(gen) {
  // 代码复制按钮
  $$("pre", ui.preview).forEach((pre) => {
    if (pre.classList.contains("mermaid-src")) return;
    if (pre.querySelector(".copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.title = "复制代码";
    btn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = "✓";
        setTimeout(() => {
          btn.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
        }, 1200);
      } catch {
        toast("复制失败，请手动选择");
      }
    });
    pre.appendChild(btn);
  });

  // GFM 任务列表
  let taskIndex = 0;
  $$("li", ui.preview).forEach((li) => {
    const first = li.firstChild;
    if (!first || first.nodeType !== 3) return;
    const m = first.nodeValue.match(/^\[([ xX])\]\s+/);
    if (!m) return;
    first.nodeValue = first.nodeValue.slice(m[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-check";
    box.checked = m[1].toLowerCase() === "x";
    box.dataset.task = String(taskIndex++);
    li.classList.add("task-list-item");
    li.insertBefore(box, first);
  });

  // Mermaid
  if (window.mermaid) {
    $$(".mermaid-block", ui.preview).forEach((block) => renderMermaid(block, gen));
  }
}

async function renderMermaid(block, gen) {
  const srcEl = block.querySelector(".mermaid-src");
  const out = block.querySelector(".mermaid-out");
  if (!srcEl || !out) return;
  const src = srcEl.textContent.trim();
  if (!src) return;
  const key = mermaidTheme() + "\u0000" + src;
  if (state.mermaidCache.has(key)) {
    out.innerHTML = state.mermaidCache.get(key);
    return;
  }
  const id = "mmd-" + ++state.mermaidSeq;
  try {
    const { svg } = await window.mermaid.render(id, src);
    state.mermaidCache.set(key, svg);
    if (gen === state.renderGen && out.isConnected) out.innerHTML = svg;
  } catch (e) {
    if (gen !== state.renderGen || !out.isConnected) return;
    block.classList.add("mermaid-err");
    out.innerHTML = `<p class="math-error">图表渲染失败：${escapeHtml(e?.message || e)}</p>`;
  }
}

/* ---------- 目录 ---------- */
function headingText(h) {
  return [...h.childNodes]
    .filter((n) => !(n.nodeType === 1 && n.classList.contains("header-anchor")))
    .map((n) => n.textContent)
    .join("")
    .trim();
}

function updateToc() {
  const heads = $$("h1, h2, h3", ui.preview);
  if (!heads.length) {
    ui.tocList.innerHTML = '<div class="toc-empty">标题会自动出现在这里。</div>';
    ui.tocList.dataset.sig = "";
    return;
  }
  const sig = heads.map((h) => h.id + "\u0000" + headingText(h)).join("\u0001");
  if (ui.tocList.dataset.sig === sig) return;
  ui.tocList.dataset.sig = sig;
  ui.tocList.innerHTML = heads
    .map((h, i) => {
      const lv = h.tagName === "H1" ? 1 : h.tagName === "H2" ? 2 : 3;
      return `<a href="#${h.id}" data-h="${i}" class="l${lv}">${escapeHtml(headingText(h) || "（无标题）")}</a>`;
    })
    .join("");
  ui.tocList.dataset.count = String(heads.length);
}

function scrollPreviewTo(el, smooth = true) {
  if (!el) return;
  const top = el.getBoundingClientRect().top - ui.previewScroll.getBoundingClientRect().top + ui.previewScroll.scrollTop - 12;
  ui.previewScroll.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}

let tocTick = 0;
function syncTocActive() {
  cancelAnimationFrame(tocTick);
  tocTick = requestAnimationFrame(() => {
    const links = $$("a", ui.tocList);
    if (!links.length) return;
    const heads = $$("h1, h2, h3", ui.preview);
    const base = ui.previewScroll.getBoundingClientRect().top + 60;
    let idx = 0;
    heads.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= base) idx = i;
    });
    links.forEach((a, i) => a.classList.toggle("active", i === idx && !!heads.length));
  });
}

/* ---------- 状态栏 ---------- */
function updateStats() {
  const text = editor ? editor.getDoc() : "";
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9_]+/g) || []).length;
  const chars = [...text].length;
  const units = cjk + latin;
  const minutes = Math.max(1, Math.round((cjk + latin * 1.6) / 350));
  ui.stWords.textContent = `${units} 字`;
  ui.stChars.textContent = `${chars} 字符`;
  ui.stTime.textContent = `约 ${minutes} 分钟`;
  ui.edMeta.textContent = `${text.split("\n").length} 行`;
}

/* ---------- 视图 / 主题 ---------- */
function setMode(m, persist = true) {
  state.mode = m;
  ui.body.dataset.mode = m;
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  if (persist) saveUi();
  if (m !== "source" && state.pending) scheduleRender({ force: true, immediate: true });
}

function cycleMode() {
  setMode(state.mode === "split" ? "source" : state.mode === "source" ? "read" : "split");
}

function resolveTheme() {
  if (state.theme === "auto") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return state.theme;
}

function applyTheme(rerender = true) {
  const t = resolveTheme();
  ui.html.dataset.theme = t;
  const btn = $("#btnTheme");
  btn.textContent = t === "dark" ? "☾" : "☀";
  btn.title = `主题：${state.theme === "auto" ? "跟随系统" : state.theme === "dark" ? "深色" : "浅色"}`;
  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: t === "dark" ? "dark" : "default",
      fontFamily: "var(--font-ui), sans-serif",
    });
    state.mermaidCache.clear();
  }
  if (rerender && editor) scheduleRender();
}

function cycleTheme() {
  state.theme = state.theme === "auto" ? "light" : state.theme === "light" ? "dark" : "auto";
  applyTheme();
  saveUi();
  toast(`主题：${state.theme === "auto" ? "跟随系统" : state.theme === "light" ? "浅色" : "深色"}`);
}

function toggleToc(force, persist = true) {
  state.tocOpen = typeof force === "boolean" ? force : !state.tocOpen;
  ui.app.classList.toggle("toc-hidden", !state.tocOpen);
  if (persist) saveUi();
}

/* ---------- 文件 ---------- */
function persistDoc(text) {
  try {
    localStorage.setItem(LS.doc, text);
    localStorage.setItem(LS.saved, new Date().toISOString());
  } catch (e) {
    toast("本地存储空间不足，草稿未能缓存");
  }
}

function afterSave(text, name) {
  state.lastSaved = text;
  if (name) state.name = name;
  ui.docName.textContent = state.name;
  localStorage.setItem(LS.name, state.name);
  persistDoc(text);
  setDirty(false);
  ui.stSave.textContent = "已保存";
  toast(`已保存 ${state.name}`);
}

async function writeHandle(handle, text) {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

async function openFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".txt"] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      await loadFile(file, handle);
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("文件选择器不可用，降级为 input", e);
    }
  }
  ui.fileInput.value = "";
  ui.fileInput.click();
}

async function loadFile(file, handle = null) {
  if (file.size > 20 * 1024 * 1024) {
    toast("文件超过 20 MB，已拒绝打开");
    return;
  }
  const text = await file.text();
  state.handle = handle;
  state.lastModified = file.lastModified || 0;
  state.lastSaved = text;
  state.name = file.name || "未命名.md";
  ui.docName.textContent = state.name;
  localStorage.setItem(LS.name, state.name);
  persistDoc(text);
  editor.setDoc(text);
  editor.focus();
  renderNow();
  updateStats();
  setDirty(false);
  ui.stSave.textContent = "已打开";
  toast(`已打开 ${state.name}`);
}

async function save() {
  const text = editor.getDoc();
  if (state.handle) {
    try {
      const f = await state.handle.getFile();
      if (state.lastModified && f.lastModified > state.lastModified + 1500) {
        if (!confirm(`${state.name} 已被其他程序修改，仍要覆盖吗？`)) return;
      }
    } catch {}
    try {
      await writeHandle(state.handle, text);
      const f = await state.handle.getFile();
      state.lastModified = f.lastModified || Date.now();
      afterSave(text, state.handle.name);
      return;
    } catch (e) {
      console.warn("写入失败，尝试另存为", e);
    }
  }
  await saveAs(text);
}

async function saveAs(text = editor.getDoc()) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: /\.(md|markdown|mdown|txt)$/i.test(state.name) ? state.name : state.name + ".md",
        types: [
          { description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } },
          { description: "纯文本", accept: { "text/plain": [".txt"] } },
        ],
      });
      await writeHandle(handle, text);
      state.handle = handle;
      try { state.lastModified = (await handle.getFile()).lastModified || Date.now(); } catch {}
      afterSave(text, handle.name);
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("另存为不可用，降级为下载", e);
    }
  }
  download(text, state.name, "text/markdown;charset=utf-8");
  afterSave(text, state.name);
}

function download(content, filename, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mdName(ext) {
  return state.name.replace(/\.(md|markdown|mdown|txt)$/i, "") + ext;
}

function exportMarkdown() {
  download(editor.getDoc(), mdName(".md"), "text/markdown;charset=utf-8");
  toast("已导出 Markdown");
}

function exportHtml() {
  const clone = ui.preview.cloneNode(true);
  clone.querySelectorAll(".copy-btn, .header-anchor, .code-lang").forEach((n) => n.remove());
  clone.querySelectorAll(".task-check").forEach((n) => {
    n.disabled = true;
  });
  const appCss = document.getElementById("app-style")?.textContent || "";
  const katexCss = document.getElementById("katex-style")?.textContent || "";
  const theme = ui.html.dataset.theme;
  const html = `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.name.replace(/\.(md|markdown|mdown|txt)$/i, ""))}</title>
<style>${appCss}</style>
<style>${katexCss}</style>
<style>
html,body{height:auto;overflow:visible;background:var(--bg);margin:0}
.markdown-body{max-width:820px;margin:0 auto;padding:56px 28px 96px}
</style>
</head>
<body data-font="${state.fontFamily}">
<article class="markdown-body">${clone.innerHTML}</article>
</body>
</html>`;
  download(html, mdName(".html"), "text/html;charset=utf-8");
  toast("已导出 HTML（单文件、可离线打开）");
}

function renameDoc() {
  const next = prompt("文件名", state.name);
  if (!next || !next.trim()) return;
  state.name = next.trim();
  ui.docName.textContent = state.name;
  localStorage.setItem(LS.name, state.name);
  setDirty(true);
}

function toggleTaskSource(index) {
  const doc = editor.view.state.doc.toString();
  const re = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/gm;
  let m, n = 0;
  while ((m = re.exec(doc))) {
    if (n === index) {
      const pos = m.index + m[1].length + 1;
      const ch = doc[pos].toLowerCase() === "x" ? " " : "x";
      editor.view.dispatch({ changes: { from: pos, to: pos + 1, insert: ch } });
      return;
    }
    n++;
  }
}

function printDoc() {
  renderNow();
  toast("准备打印…", 900);
  setTimeout(() => window.print(), 260);
}

/* ---------- 事件 ---------- */
function wireEvents() {
  $("#modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) setMode(b.dataset.mode);
  });
  $("#btnTheme").addEventListener("click", cycleTheme);
  $("#btnToc").addEventListener("click", () => toggleToc());
  $("#tocClose").addEventListener("click", () => toggleToc(false));
  ui.docName.addEventListener("click", renameDoc);

  ui.tocList.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-h]");
    if (!a) return;
    e.preventDefault();
    const heads = $$("h1, h2, h3", ui.preview);
    scrollPreviewTo(heads[+a.dataset.h]);
    if (matchMedia("(max-width: 980px)").matches) toggleToc(false);
  });
  $("#tocScrim").addEventListener("click", () => toggleToc(false));

  ui.preview.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const el = document.getElementById(a.getAttribute("href").slice(1));
    if (el && ui.preview.contains(el)) {
      e.preventDefault();
      scrollPreviewTo(el);
    }
  });

  ui.preview.addEventListener("change", (e) => {
    if (e.target.matches(".task-check")) toggleTaskSource(+e.target.dataset.task);
  });

  ui.previewScroll.addEventListener("scroll", syncTocActive, { passive: true });

  ui.menu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    ui.menu.open = false;
    ({ open: openFile, save, saveAs: () => saveAs(), exportMd: exportMarkdown, exportHtml, print: printDoc })[act]?.();
  });
  document.addEventListener("click", (e) => {
    if (ui.menu.open && !ui.menu.contains(e.target)) ui.menu.open = false;
  });

  ui.fileInput.addEventListener("change", () => {
    const f = ui.fileInput.files?.[0];
    if (f) loadFile(f);
  });

  $("#fontSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-font]");
    if (!b) return;
    state.fontFamily = b.dataset.font;
    applyTypography();
    saveUi();
  });

  $("#fontSize").addEventListener("input", (e) => {
    state.fontSize = +e.target.value;
    applyTypography();
    saveUi();
  });
  $("#measure").addEventListener("input", (e) => {
    state.measure = +e.target.value;
    applyTypography();
    saveUi();
  });
  $("#rawHtml").addEventListener("change", (e) => {
    state.rawHtml = e.target.checked;
    setRawHtml(state.rawHtml);
    saveUi();
    renderNow();
    toast(state.rawHtml ? "已允许原始 HTML（仍会净化）" : "已关闭原始 HTML");
  });

  // 拖拽打开
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++;
    ui.drop.hidden = false;
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.drop.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.drop.hidden = true;
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  });

  // 分栏拖拽
  const gutter = $("#gutter");
  const panes = $("#panes");
  gutter.addEventListener("pointerdown", (e) => {
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add("drag");
    const move = (ev) => {
      const rect = panes.getBoundingClientRect();
      const w = clamp(ev.clientX - rect.left, 260, rect.width - 260);
      ui.html.style.setProperty("--editor-w", w + "px");
    };
    const end = () => {
      gutter.classList.remove("drag");
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", end);
      gutter.removeEventListener("pointercancel", end);
      saveUi();
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", end);
    gutter.addEventListener("pointercancel", end);
    e.preventDefault();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.menu.open) ui.menu.open = false;
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); save(); }
    else if (k === "o") { e.preventDefault(); openFile(); }
    else if (k === "f" && state.mode !== "read") { e.preventDefault(); editor.openSearch(); }
    else if (k === "l" && e.shiftKey) { e.preventDefault(); cycleTheme(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      cycleMode();
    }
    else if (e.key === "\\") { e.preventDefault(); toggleToc(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") applyTheme();
  });

  matchMedia("(max-width: 980px)").addEventListener("change", (e) => {
    if (e.matches) toggleToc(false, false);
  });

  window.addEventListener("mermaid-ready", () => {
    if (!editor) return;
    applyTheme(false);
    scheduleRender({ force: true, immediate: true });
  });
}

/* ---------- 启动 ---------- */
function init() {
  const saved = readUi();
  Object.assign(state, {
    mode: saved.mode || "split",
    theme: saved.theme || "auto",
    tocOpen: saved.tocOpen !== false,
    rawHtml: !!saved.rawHtml,
    fontFamily: saved.fontFamily === "serif" ? "serif" : "sans",
    fontSize: clamp(+saved.fontSize || 17, 14, 24),
    measure: clamp(+saved.measure || 760, 560, 1100),
  });

  const stored = localStorage.getItem(LS.doc);
  const initial = stored === null ? SAMPLE : stored;
  state.name = localStorage.getItem(LS.name) || "未命名.md";
  state.lastSaved = initial;

  ui.docName.textContent = state.name;
  $("#rawHtml").checked = state.rawHtml;
  applyTypography();
  if (saved.editorWidth && /^\d+px$/.test(saved.editorWidth)) {
    ui.html.style.setProperty("--editor-w", saved.editorWidth);
  } else if (saved.editorWidth && /%$/.test(saved.editorWidth)) {
    ui.html.style.setProperty("--editor-w", saved.editorWidth);
  }

  applyTheme(false);
  if (matchMedia("(max-width: 980px)").matches) state.tocOpen = false;
  setMode(state.mode, false);
  toggleToc(state.tocOpen, false);

  editor = createEditor($("#cmHost"), {
    doc: initial,
    onChange: () => {
      setDirty(true);
      scheduleRender();
      clearTimeout(state.statsTimer);
      state.statsTimer = setTimeout(updateStats, 160);
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        persistDoc(editor.getDoc());
      }, 500);
    },
    onCursor: ({ line, col }) => {
      ui.stPos.textContent = `行 ${line}, 列 ${col}`;
    },
    onScroll: (r) => {
      if (state.mode !== "split") return;
      const max = ui.previewScroll.scrollHeight - ui.previewScroll.clientHeight;
      ui.previewScroll.scrollTop = r * Math.max(0, max);
    },
    onSave: save,
    onToggleMode: cycleMode,
  });

  setDirty(false);
  wireEvents();
  renderNow();
  updateStats();
  ui.stSave.textContent = stored === null ? "示例文档" : "已恢复草稿";
  $("#verLine").textContent = "md·studio v0.1";
}

init();

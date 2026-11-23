import { createEditor } from "./editor.js";
import { renderMarkdown, setRawHtml } from "./markdown.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const LS = {
  doc: "mdstudio:doc",
  name: "mdstudio:name",
  ui: "mdstudio:ui",
  saved: "mdstudio:saved",
  pickerBlocked: "mdstudio:picker-blocked",
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

const MD_RE = /\.(md|markdown|mdown)$/i;
const FOLDER_SKIP = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".cache", "vendor", "venv"]);
const MAX_SCAN_FILES = 1500;
const MAX_SCAN_DEPTH = 8;
// Electron 的 showDirectoryPicker 首次使用后常驻 “File picker already active”，
// 后续切换文件夹改用 webkitdirectory 兼容导入。
const IS_ELECTRON = /Electron/i.test(navigator.userAgent);

const state = {
  name: "未命名.md",
  handle: null,
  lastModified: 0,
  lastSaved: "",
  dirty: false,
  mode: "split",
  theme: "auto",
  tocOpen: true,
  side: "outline",
  folder: null,
  currentPath: null,
  openDirs: new Set(),
  pickerBusy: false,
  folderPickerBlocked: false,
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
  sideTabs: $("#sideTabs"),
  sideFiles: $("#sideFiles"),
  sideOutline: $("#sideOutline"),
  folderName: $("#folderName"),
  fileTree: $("#fileTree"),
  btnRefreshFolder: $("#btnRefreshFolder"),
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
  dirInput: $("#dirInput"),
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

function setSidePanel(name) {
  state.side = name === "files" ? "files" : "outline";
  $$("button[data-side]", ui.sideTabs).forEach((b) => {
    const on = b.dataset.side === state.side;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  ui.sideFiles.hidden = state.side !== "files";
  ui.sideOutline.hidden = state.side !== "outline";
  if (state.side === "outline") syncTocActive();
}

/* ---------- 文件夹与文件树 ---------- */
const ICON_FOLDER =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';

function canDiscard() {
  if (!state.dirty) return true;
  return window.confirm(`《${state.name}》有未保存的修改。\n\n继续切换会丢失这些修改。`);
}

function updateDocTitle() {
  ui.docName.title =
    state.currentPath && state.folder ? `${state.folder.name}/${state.currentPath}` : "点击重命名";
}

function countFiles(nodes) {
  let n = 0;
  for (const node of nodes) n += node.kind === "file" ? 1 : countFiles(node.children);
  return n;
}

function sortNodes(nodes) {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
  for (const n of nodes) {
    if (n.kind === "dir") {
      sortNodes(n.children);
      n.count = countFiles(n.children);
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].kind === "dir" && !nodes[i].count) nodes.splice(i, 1);
  }
  return nodes;
}

function flattenFiles(nodes, out = []) {
  for (const node of nodes) {
    if (node.kind === "file") out.push(node);
    else flattenFiles(node.children, out);
  }
  return out;
}

async function scanDirNode(handle, name, path, depth, budget) {
  const node = { kind: "dir", name, path, children: [], count: 0 };
  try {
    for await (const child of handle.values()) {
      if (budget.count >= MAX_SCAN_FILES) {
        budget.truncated = true;
        break;
      }
      const childName = child.name || "";
      if (!childName || childName.startsWith(".")) continue;
      if (child.kind === "directory") {
        if (depth >= MAX_SCAN_DEPTH || FOLDER_SKIP.has(childName.toLowerCase())) continue;
        const childPath = path ? `${path}/${childName}` : childName;
        node.children.push(await scanDirNode(child, childName, childPath, depth + 1, budget));
      } else if (child.kind === "file" && MD_RE.test(childName)) {
        budget.count++;
        node.children.push({
          kind: "file",
          name: childName,
          path: path ? `${path}/${childName}` : childName,
          handle: child,
          file: null,
        });
      }
    }
  } catch (e) {
    if (depth === 0) budget.fatal = true;
    console.warn("扫描文件夹失败", path || name, e);
  }
  sortNodes(node.children);
  node.count = countFiles(node.children);
  return node;
}

async function scanDirectory(handle) {
  const budget = { count: 0, truncated: false, fatal: false };
  const root = await scanDirNode(handle, handle.name, "", 0, budget);
  return { root, count: budget.count, truncated: budget.truncated, fatal: budget.fatal };
}

function treeFromFiles(files) {
  const first = files.find((f) => f.webkitRelativePath);
  const parts0 = first ? first.webkitRelativePath.split("/").filter(Boolean) : [];
  const rootName = parts0.length > 1 ? parts0[0] : "拖入的文件";
  const root = { kind: "dir", name: rootName, path: "", children: [] };
  const dirs = new Map();
  let count = 0;
  let truncated = false;
  for (const file of files) {
    if (!MD_RE.test(file.name)) continue;
    let rel = file.webkitRelativePath || file.name;
    if (parts0.length > 1 && rel.startsWith(rootName + "/")) rel = rel.slice(rootName.length + 1);
    const parts = rel.split("/").filter(Boolean);
    if (!parts.length) continue;
    if (parts.some((p) => p.startsWith(".") || FOLDER_SKIP.has(p.toLowerCase()))) continue;
    if (count >= MAX_SCAN_FILES) {
      truncated = true;
      break;
    }
    count++;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(p);
      if (!dir) {
        dir = { kind: "dir", name: parts[i], path: p, children: [], count: 0 };
        dirs.set(p, dir);
        cur.children.push(dir);
      }
      cur = dir;
    }
    cur.children.push({
      kind: "file",
      name: parts[parts.length - 1],
      path: parts.join("/"),
      handle: null,
      file,
    });
  }
  sortNodes(root.children);
  root.count = countFiles(root.children);
  return { root, count: root.count, truncated };
}

async function loadDirectoryHandle(handle, opts = {}) {
  if (!opts.silent) toast("正在扫描文件夹…", 3000);
  let scan;
  try {
    scan = await scanDirectory(handle);
  } catch (e) {
    console.error(e);
    toast("无法读取这个文件夹");
    return;
  }
  if (scan.fatal) {
    toast("无法读取这个文件夹，请重新授权");
    return;
  }
  applyFolder({ name: handle.name, handle, tree: scan.root, truncated: scan.truncated }, opts);
  if (!opts.silent) {
    setSidePanel("files");
    toggleToc(true);
  }
}

function loadFileList(files, opts = {}) {
  const built = treeFromFiles([...files]);
  if (!built.count) {
    toast("没有找到 Markdown 文件");
    return;
  }
  applyFolder({ name: built.root.name, handle: null, tree: built.root, truncated: built.truncated }, opts);
  setSidePanel("files");
  toggleToc(true);
}

function importFolder() {
  // 兼容模式：直接走 webkitdirectory 文件输入，不依赖可能被占用的目录选择器
  ui.dirInput.value = "";
  ui.dirInput.click();
}

function updateFolderTitles() {
  const compat =
    !window.showDirectoryPicker || state.folderPickerBlocked || (IS_ELECTRON && !!state.folder);
  const title = compat
    ? state.folder
      ? "切换文件夹（兼容导入）"
      : "打开文件夹（兼容导入）"
    : "打开文件夹 (Ctrl+Shift+O)";
  $("#btnFolder").title = title;
  $("#btnOpenFolder").title = title;
}

function setPickerBlocked() {
  state.folderPickerBlocked = true;
  try {
    sessionStorage.setItem(LS.pickerBlocked, "1");
  } catch {}
  updateFolderTitles();
}

async function openFolder() {
  if (!window.showDirectoryPicker || state.folderPickerBlocked || (IS_ELECTRON && state.folder)) {
    importFolder();
    return;
  }
  if (state.pickerBusy) return;
  state.pickerBusy = true;
  try {
    const handle = await window.showDirectoryPicker({ id: "md-studio-folder", mode: "readwrite" });
    await loadDirectoryHandle(handle);
  } catch (e) {
    if (e?.name === "AbortError") return;
    console.warn("目录选择器不可用", e);
    // 浏览器（尤其 Electron）在目录选择器被占用后不会释放，后续调用会一直失败
    setPickerBlocked();
    toast(
      e?.name === "NotAllowedError"
        ? "目录选择器被占用，再点一次文件夹按钮将改用兼容导入"
        : "目录选择器不可用，再点一次文件夹按钮将改用兼容导入",
      3200,
    );
  } finally {
    state.pickerBusy = false;
  }
}

async function refreshFolder() {
  const folder = state.folder;
  if (!folder) {
    openFolder();
    return;
  }
  if (!folder.handle) {
    renderTree();
    toast("这份文件列表来自本次选择，无法自动刷新");
    return;
  }
  await loadDirectoryHandle(folder.handle, { silent: true });
  toast("文件列表已刷新");
}

async function openTreeFile(path) {
  const folder = state.folder;
  const node = folder?.byPath?.get(path);
  if (!node) {
    toast("文件不存在，请刷新文件列表");
    return false;
  }
  if (state.currentPath === path) {
    editor?.focus();
    return true;
  }
  if (!canDiscard()) return false;
  let file = node.file;
  if (node.handle) {
    try {
      file = await node.handle.getFile();
    } catch (e) {
      console.warn("读取文件失败", e);
      toast(`无法读取 ${node.name}`);
      return false;
    }
  }
  if (!file) {
    toast(`无法读取 ${node.name}`);
    return false;
  }
  return loadFile(file, node.handle, { path });
}

function clearTreeActive() {
  if (!state.currentPath) return;
  state.currentPath = null;
  updateDocTitle();
  updateTreeActive();
}

function applyFolder(folder, opts = {}) {
  const same = state.folder?.handle && state.folder.handle === folder.handle;
  const files = flattenFiles(folder.tree.children);
  folder.files = files;
  folder.byPath = new Map(files.map((f) => [f.path, f]));
  state.folder = folder;
  if (!same) {
    state.currentPath = null;
    state.openDirs.clear();
  }
  if (state.currentPath && !folder.byPath.has(state.currentPath)) state.currentPath = null;
  ui.folderName.textContent = folder.name || "未打开文件夹";
  ui.folderName.title = folder.handle ? `文件夹：${folder.name}` : folder.name;
  ui.folderName.classList.add("has-folder");
  ui.btnRefreshFolder.hidden = !folder.handle;
  updateFolderTitles();
  renderTree();
  updateTreeActive();
  if (!opts.silent) {
    const n = files.length;
    toast(n ? `已载入 ${folder.name} · ${n} 个 Markdown 文件` : "这个文件夹里没有找到 Markdown 文件", 2600);
  }
}

function renderTree() {
  const folder = state.folder;
  if (!folder) {
    ui.fileTree.innerHTML =
      '<div class="tree-empty"><p>打开文件夹后，这里会列出所有 Markdown 文件，点击即可切换。</p><button class="tree-cta" type="button" data-act="pick-folder">打开文件夹</button></div>';
    return;
  }
  if (!folder.files.length) {
    ui.fileTree.innerHTML =
      '<div class="tree-empty"><p>没有找到 Markdown 文件。<br>支持 .md / .markdown / .mdown。</p><button class="tree-cta" type="button" data-act="pick-folder">换一个文件夹</button></div>';
    return;
  }
  const note = folder.truncated ? `<div class="tree-note">文件较多，仅显示前 ${MAX_SCAN_FILES} 个</div>` : "";
  ui.fileTree.innerHTML = treeRows(folder.tree.children) + note;
}

function treeRows(nodes) {
  return nodes.map((node) => (node.kind === "dir" ? dirRow(node) : fileRow(node))).join("");
}

function dirRow(node) {
  const open = state.openDirs.has(node.path) ? " open" : "";
  const count = node.count ? `<span class="tree-count">${node.count}</span>` : "";
  return `<details class="tree-dir" data-path="${escapeHtml(node.path)}"${open}>
    <summary class="tree-row dir" title="${escapeHtml(node.path)}">
      <span class="tree-caret">▸</span>
      <span class="tree-icon">${ICON_FOLDER}</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>${count}
    </summary>
    <div class="tree-children">${treeRows(node.children)}</div>
  </details>`;
}

function fileRow(node) {
  const active = state.currentPath === node.path ? " active" : "";
  return `<button type="button" class="tree-row file${active}" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">
    <span class="tree-caret"></span>
    <span class="tree-icon">${ICON_FILE}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>
  </button>`;
}

function updateTreeActive(scroll = false) {
  const rows = $$(".tree-row.file", ui.fileTree);
  rows.forEach((row) => row.classList.toggle("active", !!state.currentPath && row.dataset.path === state.currentPath));
  if (!state.currentPath) return;
  const active = rows.find((row) => row.dataset.path === state.currentPath);
  if (!active) return;
  let dir = active.parentElement?.closest("details.tree-dir");
  while (dir) {
    dir.open = true;
    if (dir.dataset.path) state.openDirs.add(dir.dataset.path);
    dir = dir.parentElement?.closest("details.tree-dir");
  }
  if (scroll) active.scrollIntoView({ block: "nearest" });
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
  updateDocTitle();
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
  if (!canDiscard()) return;
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

async function loadFile(file, handle = null, opts = {}) {
  if (file.size > 20 * 1024 * 1024) {
    toast("文件超过 20 MB，已拒绝打开");
    return false;
  }
  const text = await file.text();
  state.handle = handle;
  state.lastModified = file.lastModified || 0;
  state.lastSaved = text;
  state.name = file.name || "未命名.md";
  state.currentPath = opts.path || null;
  ui.docName.textContent = state.name;
  updateDocTitle();
  localStorage.setItem(LS.name, state.name);
  persistDoc(text);
  editor.setDoc(text);
  editor.focus();
  ui.previewScroll.scrollTop = 0;
  ui.stPos.textContent = "行 1, 列 1";
  renderNow();
  updateStats();
  setDirty(false);
  ui.stSave.textContent = "已打开";
  updateTreeActive(true);
  toast(`已打开 ${state.currentPath || state.name}`);
  return true;
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
      clearTreeActive();
      afterSave(text, handle.name);
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("另存为不可用，降级为下载", e);
    }
  }
  download(text, state.name, "text/markdown;charset=utf-8");
  clearTreeActive();
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
  ui.sideTabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-side]");
    if (b) setSidePanel(b.dataset.side);
  });
  ui.docName.addEventListener("click", renameDoc);

  $("#btnFolder").addEventListener("click", openFolder);
  $("#btnOpenFolder").addEventListener("click", openFolder);
  ui.btnRefreshFolder.addEventListener("click", refreshFolder);
  ui.fileTree.addEventListener("click", (e) => {
    const pick = e.target.closest('[data-act="pick-folder"]');
    if (pick) {
      openFolder();
      return;
    }
    const row = e.target.closest("button.tree-row.file");
    if (row?.dataset.path) {
      openTreeFile(row.dataset.path).then((ok) => {
        if (ok && matchMedia("(max-width: 980px)").matches) toggleToc(false);
      });
    }
  });
  ui.fileTree.addEventListener(
    "toggle",
    (e) => {
      const dir = e.target;
      if (!(dir instanceof HTMLDetailsElement) || !dir.classList.contains("tree-dir")) return;
      if (dir.open) state.openDirs.add(dir.dataset.path);
      else state.openDirs.delete(dir.dataset.path);
    },
    true,
  );

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
    ({ open: openFile, openFolder, importFolder, save, saveAs: () => saveAs(), exportMd: exportMarkdown, exportHtml, print: printDoc })[act]?.();
  });
  document.addEventListener("click", (e) => {
    if (ui.menu.open && !ui.menu.contains(e.target)) ui.menu.open = false;
  });

  ui.fileInput.addEventListener("change", () => {
    const f = ui.fileInput.files?.[0];
    if (f) loadFile(f);
  });

  ui.dirInput.addEventListener("change", () => {
    const files = [...(ui.dirInput.files || [])];
    ui.dirInput.value = "";
    if (files.length) loadFileList(files);
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
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.drop.hidden = true;
    const dt = e.dataTransfer;
    if (!dt) return;

    // Chromium：优先把拖入的文件夹当成工作区打开
    const items = [...(dt.items || [])];
    const files = [...(dt.files || [])];
    const handleTasks = items.map((it) =>
      it.kind === "file" && it.getAsFileSystemHandle
        ? it.getAsFileSystemHandle().catch(() => null)
        : Promise.resolve(null),
    );
    const handles = (await Promise.all(handleTasks)).filter(Boolean);
    const dirHandle = handles.find((h) => h.kind === "directory");
    if (dirHandle) {
      await loadDirectoryHandle(dirHandle);
      return;
    }
    if (files.length > 1) {
      loadFileList(files);
      return;
    }
    const fileHandle = handles.find((h) => h.kind === "file");
    if (fileHandle) {
      if (!canDiscard()) return;
      try {
        await loadFile(await fileHandle.getFile(), fileHandle);
      } catch (err) {
        console.warn("无法读取拖入的文件", err);
      }
      return;
    }

    if (!files.length) return;
    if (!canDiscard()) return;
    await loadFile(files[0]);
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
    else if (k === "o" && e.shiftKey) { e.preventDefault(); openFolder(); }
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
  try {
    state.folderPickerBlocked = sessionStorage.getItem(LS.pickerBlocked) === "1";
  } catch {}

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
  setSidePanel("outline");
  renderTree();
  updateFolderTitles();
  updateDocTitle();

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
  $("#verLine").textContent = "md·studio v0.2";
}

init();

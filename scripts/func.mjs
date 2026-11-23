import { launchBrowser } from "./browser.mjs";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8765/index.html";
const OUT = "/tmp/opencode";
const browser = await launchBrowser();
const results = [];
const check = (name, ok, extra = {}) => results.push({ name, ok, ...extra });

// 无 File System Access API：保存必须降级为下载
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n降级保存测试");
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);
  const p = await dl.path();
  const txt = fs.readFileSync(p, "utf8");
  check("save fallback download", txt.includes("降级保存测试") && dl.suggestedFilename().endsWith(".md"), {
    file: dl.suggestedFilename(),
    bytes: txt.length,
  });
  check("no page errors (fallback)", errors.length === 0, { errors });
  await ctx.close();
}

// 原始 HTML + XSS 净化
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.evaluate(() => {
    const cb = document.querySelector("#rawHtml");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type('\n\n<b>加粗HTML</b> <img src=x onerror="window.__xss=1"> <script>window.__xss=2<\\/script>\n');
  await page.waitForFunction(() => document.querySelector("#preview b"));
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    bold: document.querySelector("#preview b")?.textContent,
    onerror: document.querySelector("#preview img")?.getAttribute("onerror"),
    scripts: document.querySelectorAll("#preview script").length,
    xss: window.__xss ?? null,
  }));
  check("raw html on + sanitized", r.bold === "加粗HTML" && r.onerror === null && r.scripts === 0 && r.xss === null, r);
  await ctx.close();
}

// 快捷键 / TOC / 滚动
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  const doc = await page.evaluate(() => document.querySelector(".cm-content").textContent);
  const bolded = doc.startsWith("**");
  check("ctrl+b wraps selection", bolded, { head: doc.slice(0, 12) });

  await page.click('#tocList a[data-h="4"]');
  await page.waitForTimeout(700);
  const scroll = await page.evaluate(() => document.querySelector("#previewScroll").scrollTop);
  check("toc click scrolls preview", scroll > 100, { scrollTop: scroll });

  const active = await page.evaluate(() => document.querySelector("#tocList a.active")?.textContent);
  check("toc active tracking", !!active, { active });

  await page.keyboard.press("Control+f");
  const searchOpen = await page.locator(".cm-search").count();
  check("ctrl+f opens source search", searchOpen === 1);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Enter");
  const mode = await page.evaluate(() => document.body.dataset.mode);
  check("ctrl+enter cycles mode", mode === "source", { mode });
  await page.click('button[data-mode="split"]');

  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => document.querySelector('[data-act="exportHtml"]').click()),
  ]);
  const file = await dl.path();
  const local = `${OUT}/export-test.html`;
  fs.copyFileSync(file, local);
  const out = await ctx.newPage();
  await out.goto("file://" + local, { waitUntil: "load" });
  const exported = await out.evaluate(() => ({
    overflow: getComputedStyle(document.body).overflow,
    height: document.documentElement.scrollHeight,
    text: document.body.innerText.slice(0, 16),
    katex: document.querySelectorAll(".katex").length,
  }));
  check("exported html readable", exported.overflow === "visible" && exported.height > 800 && exported.katex > 0, exported);
  await ctx.close();
}

// 移动端布局
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const ed = document.querySelector("#paneEditor").getBoundingClientRect();
    const pv = document.querySelector("#panePreview").getBoundingClientRect();
    return {
      pw: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      edH: Math.round(ed.height),
      pvH: Math.round(pv.height),
      stacked: pv.top >= ed.bottom - 2,
      tocHidden: getComputedStyle(document.querySelector("#toc")).position,
    };
  });
  await page.screenshot({ path: `${OUT}/qa-mobile.png`, fullPage: false });
  check("mobile stacked layout", r.stacked && !r.overflow, r);
  await ctx.close();
}

// 文件夹文件树（webkitdirectory 降级路径）
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const root = `${OUT}/tree-case`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/guide/deep`, { recursive: true });
  fs.mkdirSync(`${root}/notes`, { recursive: true });
  fs.writeFileSync(`${root}/README.md`, "# 树根\n");
  fs.writeFileSync(`${root}/guide/a.md`, "# 指南\n");
  fs.writeFileSync(`${root}/guide/deep/b.markdown`, "# 深层\n");
  fs.writeFileSync(`${root}/notes/c.md`, "# 笔记\n");
  fs.writeFileSync(`${root}/notes/skip.txt`, "忽略\n");
  fs.writeFileSync(`${root}/.hidden.md`, "# 隐藏\n");

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.click('#sideTabs button[data-side="files"]');
  await page.setInputFiles("#dirInput", root);
  await page.waitForSelector("#fileTree button.tree-row.file", { state: "attached" });
  const tree = await page.evaluate(() => ({
    folder: document.querySelector("#folderName").textContent,
    pane: document.querySelector("#sideTabs button.on")?.dataset.side,
    paths: [...document.querySelectorAll("#fileTree button.tree-row.file")].map((b) => b.dataset.path),
  }));
  check(
    "folder tree lists nested markdown only",
    tree.folder === "tree-case" &&
      tree.pane === "files" &&
      tree.paths.length === 4 &&
      tree.paths.includes("guide/deep/b.markdown") &&
      !tree.paths.some((p) => p.endsWith(".txt") || p.includes(".hidden")),
    tree,
  );

  await page.click('#fileTree summary[title="guide"]');
  await page.click('#fileTree summary[title="guide/deep"]');
  await page.click('#fileTree button.tree-row.file[title="guide/deep/b.markdown"]');
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent.includes("深层"));
  const opened = await page.evaluate(() => ({
    name: document.querySelector("#docName").textContent,
    title: document.querySelector("#docName").title,
    active: document.querySelector("#fileTree button.tree-row.file.active")?.dataset.path,
  }));
  check(
    "folder tree switches file",
    opened.name === "b.markdown" && opened.title === "tree-case/guide/deep/b.markdown" && opened.active === "guide/deep/b.markdown",
    { file: opened.name, title: opened.title, active: opened.active },
  );
  check("no page errors (folder tree)", errors.length === 0, { errors });
  await ctx.close();
}

// 文件夹原地读写（伪 File System Access 目录句柄）
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => {
    const contents = new Map([
      ["README.md", "# FSA 根\n"],
      ["docs/a.md", "# FSA A\n"],
      ["docs/sub/b.md", "# FSA B\n"],
    ]);
    const fileHandle = (name, path) => ({
      kind: "file",
      name,
      async getFile() {
        return new File([contents.get(path) || ""], name, { lastModified: 1000 });
      },
      async createWritable() {
        return {
          async write(text) {
            contents.set(path, String(text));
            window.__folderSaved = { path, text: String(text) };
          },
          async close() {},
        };
      },
    });
    const dirHandle = (name) => ({
      kind: "directory",
      name,
      children: new Map(),
      async *values() {
        for (const child of this.children.values()) yield child;
      },
    });
    const root = dirHandle("FSA 目录");
    const docs = dirHandle("docs");
    const sub = dirHandle("sub");
    docs.children.set("sub", sub);
    docs.children.set("a.md", fileHandle("a.md", "docs/a.md"));
    sub.children.set("b.md", fileHandle("b.md", "docs/sub/b.md"));
    root.children.set("docs", docs);
    root.children.set("README.md", fileHandle("README.md", "README.md"));
    window.showDirectoryPicker = async () => root;
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.click("#btnFolder");
  await page.waitForSelector("#fileTree button.tree-row.file", { state: "attached" });
  await page.click('#fileTree summary[title="docs"]');
  await page.click('#fileTree button.tree-row.file[title="docs/a.md"]');
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent.includes("FSA A"));
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n原地保存");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__folderSaved?.path === "docs/a.md");
  const saved = await page.evaluate(() => ({
    saved: window.__folderSaved,
    state: document.querySelector("#stSave").textContent,
    active: document.querySelector("#fileTree button.tree-row.file.active")?.dataset.path,
  }));
  check(
    "folder file saved in place",
    saved.saved.text.includes("原地保存") && saved.state === "已保存" && saved.active === "docs/a.md",
    { state: saved.state, active: saved.active, bytes: saved.saved.text.length },
  );
  check("no page errors (folder fsa)", errors.length === 0, { errors });
  await ctx.close();
}

// Electron 下目录选择器只能打开一次，后续切换自动走兼容导入
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OpenCode/2.3.2 Chrome/152.0.7977.167 Electron/44.9.1 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    const fakeFile = (name, text) => ({
      kind: "file",
      name,
      async getFile() {
        return new File([text], name, { lastModified: 1000 });
      },
      async createWritable() {
        return { async write() {}, async close() {} };
      },
    });
    const root = {
      kind: "directory",
      name: "native-first",
      children: new Map([["only.md", fakeFile("only.md", "# Native\n")]]),
      async *values() {
        for (const c of this.children.values()) yield c;
      },
    };
    window.__nativeCalls = 0;
    window.showDirectoryPicker = async () => {
      window.__nativeCalls++;
      return root;
    };
  });

  const root = `${OUT}/switch-folder`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/guide`, { recursive: true });
  fs.writeFileSync(`${root}/README.md`, "# 切换后的目录\n");
  fs.writeFileSync(`${root}/guide/next.md`, "# 嵌套文件\n");

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");

  await page.click("#btnFolder");
  await page.waitForFunction(() => document.querySelector("#folderName").textContent === "native-first");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.click("#btnFolder"),
  ]);
  await chooser.setFiles(root);
  await page.waitForFunction(() => document.querySelector("#folderName").textContent === "switch-folder");
  const switched = await page.evaluate(() => ({
    folder: document.querySelector("#folderName").textContent,
    nativeCalls: window.__nativeCalls,
    paths: [...document.querySelectorAll("#fileTree button.tree-row.file")].map((b) => b.dataset.path),
    title: document.querySelector("#btnFolder").title,
  }));
  check(
    "electron folder switch falls back to import",
    switched.folder === "switch-folder" &&
      switched.nativeCalls === 1 &&
      switched.paths.includes("guide/next.md") &&
      switched.title.includes("兼容导入"),
    switched,
  );
  check("no page errors (electron switch)", errors.length === 0, { errors });
  await ctx.close();
}

// 矮窗口下大纲条目不能被 flex 压缩重叠
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 260 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#tocList a");
  const toc = await page.evaluate(() => {
    const list = document.querySelector("#tocList");
    const links = [...list.querySelectorAll("a")];
    const rects = links.map((a) => a.getBoundingClientRect());
    return {
      count: links.length,
      heights: rects.map((r) => Math.round(r.height)),
      overlaps: rects.some((r, i) => i > 0 && r.top < rects[i - 1].bottom - 0.5),
      canScroll: list.scrollHeight > list.clientHeight,
    };
  });
  check(
    "toc rows keep height and scroll",
    toc.heights.every((h) => h >= 20) && !toc.overlaps && toc.canScroll,
    { count: toc.count, minHeight: Math.min(...toc.heights), canScroll: toc.canScroll },
  );
  check("no page errors (toc rows)", errors.length === 0, { errors });
  await ctx.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();

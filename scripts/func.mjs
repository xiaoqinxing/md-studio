import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";

const exe = `${os.homedir()}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;
const BASE = "http://127.0.0.1:8765/index.html";
const OUT = "/tmp/opencode";
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
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

console.log(JSON.stringify(results, null, 2));
await browser.close();

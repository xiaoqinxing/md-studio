import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:8765/index.html";
const OUT = "/tmp/opencode";
const exe =
  process.env.CHROME ||
  `${os.homedir()}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
  acceptDownloads: true,
});
const page = await ctx.newPage();
const errors = [];
const requests = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
page.on("request", (r) => requests.push(r.url()));

const step = [];
const t = async (name, fn) => {
  try {
    const v = await fn();
    step.push({ name, ok: true, ...(v ? { value: v } : {}) });
  } catch (e) {
    step.push({ name, ok: false, error: String(e).slice(0, 300) });
  }
};

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector(".mermaid-block svg", { timeout: 15000 });
await page.waitForTimeout(300);

await t("initial render", async () => {
  return await page.evaluate(() => ({
    toc: document.querySelectorAll("#tocList a").length,
    mermaid: document.querySelectorAll(".mermaid-block svg").length,
    katex: document.querySelectorAll(".katex").length,
    tasks: document.querySelectorAll(".task-check").length,
    code: document.querySelectorAll("pre code.hljs").length,
    words: document.querySelector("#stWords").textContent,
  }));
});

await t("screenshot light", async () => {
  await page.screenshot({ path: `${OUT}/qa-light.png` });
});

await t("theme dark", async () => {
  await page.click("#btnTheme");
  await page.click("#btnTheme");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/qa-dark.png` });
  return await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mermaid: document.querySelectorAll(".mermaid-block svg").length,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
});

await t("read mode", async () => {
  await page.click('button[data-mode="read"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/qa-read.png` });
  return await page.evaluate(() => ({
    mode: document.body.dataset.mode,
    editorVisible: getComputedStyle(document.querySelector("#paneEditor")).display,
  }));
});

await t("edit updates preview", async () => {
  await page.click('button[data-mode="split"]');
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n## QA 检查\n\n行内 $a^2+b^2$\n\n- [ ] 新任务\n");
  await page.waitForFunction(() => [...document.querySelectorAll("#preview h2")].some((h) => h.textContent.includes("QA")));
  await page.waitForTimeout(500);
  return await page.evaluate(() => ({
    h2: [...document.querySelectorAll("#preview h2")].map((h) => h.textContent),
    tasks: document.querySelectorAll(".task-check").length,
    katex: document.querySelectorAll(".katex").length,
  }));
});

await t("task toggle", async () => {
  const before = await page.locator(".task-check").last().isChecked();
  await page.locator(".task-check").last().click();
  await page.waitForTimeout(300);
  const after = await page.locator(".task-check").last().isChecked();
  return { before, after };
});

await t("persist after reload", async () => {
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".mermaid-block svg");
  return await page.evaluate(() => ({
    hasQA: [...document.querySelectorAll("#preview h2")].some((h) => h.textContent.includes("QA")),
    mode: document.body.dataset.mode,
    theme: document.documentElement.dataset.theme,
  }));
});

await t("open file", async () => {
  const f = path.join(OUT, "qa-open.md");
  fs.writeFileSync(f, "# 外来文件\n\n打开测试 $x^2$ 与 <kbd>代码</kbd>\n");
  await page.setInputFiles("#fileInput", f);
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent.includes("外来文件"));
  return await page.evaluate(() => ({
    name: document.querySelector("#docName").textContent,
    h1: document.querySelector("#preview h1").textContent,
  }));
});

await t("export html", async () => {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => document.querySelector('[data-act="exportHtml"]').click()),
  ]);
  const p = await dl.path();
  const html = fs.readFileSync(p, "utf8");
  fs.copyFileSync(p, `${OUT}/qa-export.html`);
  return { bytes: html.length, hasKatexFont: html.includes("data:font/woff2"), hasArticle: html.includes("markdown-body") };
});

await t("print pdf", async () => {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".mermaid-block svg");
  await page.waitForTimeout(400);
  await page.pdf({ path: `${OUT}/qa-print.pdf`, format: "A4", printBackground: true });
  return { bytes: fs.statSync(`${OUT}/qa-print.pdf`).size };
});

await t("no external requests", async () => {
  const external = requests.filter((u) => !u.startsWith("http://127.0.0.1:8765") && !u.startsWith("data:") && !u.startsWith("blob:"));
  return { count: external.length, sample: external.slice(0, 5) };
});

console.log(JSON.stringify({ steps: step, errors }, null, 2));
await browser.close();

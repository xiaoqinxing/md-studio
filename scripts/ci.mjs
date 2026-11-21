import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const artifact = path.join(root, "index.html");
if (!fs.existsSync(artifact)) {
  console.error("index.html 不存在，请先 npm run build");
  process.exit(1);
}

const html = fs.readFileSync(artifact, "utf8");
const size = Buffer.byteLength(html);
if (size < 1_000_000) fail(`产物过小：${size} bytes`);
if (/__APP_(CSS|JS)__|__KATEX_CSS__|__MERMAID__/.test(html)) fail("产物中仍有未替换的构建占位符");

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const launch = process.env.CHROME
  ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] }
  : { channel: "chrome", args: ["--no-sandbox"] };

const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const requests = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
page.on("request", (r) => requests.push(r.url()));

try {
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".mermaid-block svg", { timeout: 20000 });

  const r = await page.evaluate(() => ({
    h1: document.querySelector("#preview h1")?.textContent,
    toc: document.querySelectorAll("#tocList a").length,
    mermaid: document.querySelectorAll(".mermaid-block svg").length,
    katex: document.querySelectorAll(".katex").length,
    code: document.querySelectorAll("pre code.hljs").length,
    tasks: document.querySelectorAll(".task-check").length,
    headings: document.querySelectorAll("#preview h1, #preview h2, #preview h3").length,
  }));

  if (r.h1 !== "md·studio") fail(`首屏标题异常：${r.h1}`);
  if (r.toc !== r.headings) fail(`TOC 数量 ${r.toc} ≠ 标题数 ${r.headings}`);
  if (!r.mermaid) fail("Mermaid 未渲染");
  if (r.katex < 5) fail(`KaTeX 数量异常：${r.katex}`);
  if (!r.code) fail("代码高亮未生效");
  if (!r.tasks) fail("任务列表未渲染");

  await page.click("#btnTheme");
  await page.click("#btnTheme");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForTimeout(500);

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n## CI 冒烟\n\n行内 $a^2$\n");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#preview h2")].some((h) => h.textContent.includes("CI 冒烟")),
  );
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    tasks: document.querySelectorAll(".task-check").length,
    katex: document.querySelectorAll(".katex").length,
    words: document.querySelector("#stWords").textContent,
  }));
  if (after.tasks !== r.tasks) fail("编辑后任务列表数量变化");
  if (after.katex <= r.katex) fail("编辑后公式未重新渲染");

  const external = requests.filter(
    (u) => !u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:"),
  );
  if (external.length) fail(`存在出站请求：${external.slice(0, 3).join(", ")}`);
  if (errors.length) fail(`控制台错误：${errors.slice(0, 3).join(" | ")}`);

  console.log(`CI 冒烟通过：${(size / 1024 / 1024).toFixed(2)} MB，` +
    `TOC ${r.toc}，公式 ${after.katex}，图表 ${r.mermaid}，${after.words}`);
} finally {
  await browser.close();
  server.close();
}

function fail(msg) {
  console.error("CI 失败：" + msg);
  process.exit(1);
}

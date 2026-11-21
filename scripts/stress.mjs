import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exe = `${os.homedir()}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;
const OUT = "/tmp/opencode";

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

// 1) file:// 可用性
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("file:///home/liqinxing/md-studio/index.html", { waitUntil: "load" }).catch((e) => errors.push("NAV " + e.message));
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => ({
    secure: window.isSecureContext,
    hasOpenPicker: typeof window.showOpenFilePicker === "function",
    hasSavePicker: typeof window.showSaveFilePicker === "function",
    rendered: !!document.querySelector("#preview h1"),
    mermaid: document.querySelectorAll(".mermaid-block svg").length,
    storageOk: (() => { try { localStorage.setItem("t", "1"); return localStorage.getItem("t") === "1"; } catch { return false; } })(),
  })).catch((e) => ({ evalError: String(e) }));
  console.log("FILE", JSON.stringify({ info, errors }));
  await ctx.close();
}

// 2) 大文档
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:8765/index.html", { waitUntil: "load" });
  await page.waitForSelector("#preview h1");

  const parts = [];
  const sections = +(process.env.SECTIONS || 420);
  for (let i = 0; i < sections; i++) {
    parts.push(`## 章节 ${i}\n\n这是第 ${i} 节的一段普通文字，用来模拟真实的长文档内容。The quick brown fox jumps over the lazy dog. 行内代码 \`code_${i}\` 与链接 [示例](https://example.com/${i})。\n\n- 列表项 A ${i}\n- 列表项 B ${i}\n\n> 引用块 ${i}：文字只在本机处理。\n\n\`\`\`js\nfunction demo${i}(x) {\n  return x * ${i};\n}\n\`\`\`\n`);
  }
  const text = parts.join("\n");
  const f = path.join(OUT, "qa-big.md");
  fs.writeFileSync(f, text);
  console.log("BIG bytes", Buffer.byteLength(text), "sections", parts.length);

  const t0 = Date.now();
  await page.setInputFiles("#fileInput", f);
  await page.waitForFunction((n) => document.querySelectorAll("#preview h2").length === n, sections, { timeout: 180000 }).catch((e) => console.log("WAIT", e.message));
  const loadMs = Date.now() - t0;

  await page.evaluate(() => {
    window.__lag = null;
    window.__keyT = 0;
    document.addEventListener("keydown", () => { window.__keyT = performance.now(); }, true);
    new MutationObserver(() => {
      if (window.__keyT) {
        window.__lag = performance.now() - window.__keyT;
        window.__keyT = 0;
      }
    }).observe(document.querySelector(".cm-content"), { subtree: true, childList: true, characterData: true });
  });

  const t1 = Date.now();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Z");
  await page.waitForFunction(() => document.querySelector("#preview").textContent.trimEnd().endsWith("Z"), null, { timeout: 60000 }).catch(() => {});
  const typeMs = Date.now() - t1;

  const metrics = await page.evaluate(() => ({
    nodes: document.querySelectorAll("#preview *").length,
    htmlBytes: document.querySelector("#preview").innerHTML.length,
    renderMeta: document.querySelector("#pvMeta").textContent,
    editorLagMs: window.__lag == null ? null : +window.__lag.toFixed(1),
    words: document.querySelector("#stWords").textContent,
  }));
  console.log("BIG", JSON.stringify({ loadMs, typeMs, ...metrics, errors: errors.slice(0, 3) }));
  await ctx.close();
}

await browser.close();

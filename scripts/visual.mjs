import { launchBrowser } from "./browser.mjs";

const BASE = "http://127.0.0.1:8765/index.html";
const OUT = "/tmp/opencode";
const browser = await launchBrowser();

// 桌面：暗色 + 图表 + 搜索面板
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".mermaid-block svg");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/v-dark.png` });

  await page.locator(".mermaid-block").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/v-dark-mermaid.png` });

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+f");
  await page.keyboard.type("功能");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/v-search.png` });
  await page.keyboard.press("Escape");

  await page.click('button[data-mode="read"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/v-read-dark.png` });

  // 暗色下打印
  await page.click('button[data-mode="split"]');
  await page.pdf({ path: `${OUT}/v-print-dark.pdf`, format: "A4", printBackground: true });
  await ctx.close();
}

// 移动端：打开目录抽屉
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#preview h1");
  await page.waitForTimeout(300);
  await page.click("#btnToc");
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/v-mobile-toc.png` });
  const open = await page.evaluate(() => {
    const t = document.querySelector("#toc").getBoundingClientRect();
    return { left: Math.round(t.left), w: Math.round(t.width), scrim: getComputedStyle(document.querySelector("#tocScrim")).display };
  });
  await page.click("#tocScrim", { position: { x: 360, y: 400 } });
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.querySelector("#toc").getBoundingClientRect().left < 0);
  console.log(JSON.stringify({ open, closed }));
  await ctx.close();
}

await browser.close();

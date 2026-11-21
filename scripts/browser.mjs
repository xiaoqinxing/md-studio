import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function cachedChromium() {
  const root = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = path.join(root, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 本地用缓存的 Chromium；CI 用系统 Chrome（channel: chrome）。 */
export async function launchBrowser(options = {}) {
  const opts = { args: ["--no-sandbox"], ...options };
  if (process.env.CHROME) {
    opts.executablePath = process.env.CHROME;
  } else {
    const found = cachedChromium();
    if (found) opts.executablePath = found;
    else opts.channel = "chrome";
  }
  return chromium.launch(opts);
}

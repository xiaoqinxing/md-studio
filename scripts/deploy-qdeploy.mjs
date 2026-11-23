import fs from "node:fs";

import { Client, ClientError } from "../tools/qdeploy/src/client.mjs";
import { deployPath, printDeployResult } from "../tools/qdeploy/src/deploy.mjs";

const ENDPOINT = (process.env.QDEPLOY_URL || "https://deploy.li.qinxing.xyz").replace(
  /\/mcp\/?$/,
  "",
);
const BASE_DOMAIN = process.env.QDEPLOY_BASE_DOMAIN || "li.qinxing.xyz";
const TOKEN = (process.env.QDEPLOY_TOKEN || "")
  .trim()
  .replace(/^Bearer\s+/i, "")
  .trim();
const SITE = process.env.QDEPLOY_SITE || "md-studio";
const DOMAIN = process.env.QDEPLOY_DOMAIN || "markdown.li.qinxing.xyz";
const SOURCE = "index.html";

if (!TOKEN) {
  console.log("::warning::QDEPLOY_TOKEN 未配置，跳过 qdeploy 部署");
  process.exit(0);
}
if (!/^[a-f0-9]{64}$/i.test(TOKEN)) {
  console.error(
    "::error::QDEPLOY_TOKEN 格式不正确：应为 64 位十六进制字符串，不要带 Bearer 前缀或换行",
  );
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) {
  console.error(`::error::找不到部署文件 ${SOURCE}`);
  process.exit(1);
}

const client = new Client(ENDPOINT, TOKEN);
const flags = {
  name: SITE,
  domain: DOMAIN,
  "no-verify": true,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployOnce() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await deployPath(client, SOURCE, flags, BASE_DOMAIN);
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof ClientError) || err.status >= 500;
      if (!retryable || attempt === 3) break;
      console.log(
        `::warning::qdeploy 第 ${attempt} 次部署失败，准备重试：${String(err.message || err).slice(0, 200)}`,
      );
      await delay(attempt * 2500);
    }
  }
  throw lastError;
}

try {
  const result = await deployOnce();
  printDeployResult(result);

  const size = `${((Number(result.bytes) || 0) / 1024 / 1024).toFixed(2)} MB`;
  const line =
    result.changed === false
      ? `已确认 ${result.name} 内容未变化 -> ${result.url}  release=${result.release || "?"}`
      : `已部署 ${result.name} -> ${result.url}  ${size}  release=${result.release || "?"}`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### qdeploy\n\n\`${line}\`\n`);
  }
} catch (err) {
  const message = String(err?.message || err).replace(/\s+/g, " ").slice(0, 400);
  console.error(`::error::qdeploy 部署失败：${message}`);
  process.exit(1);
}

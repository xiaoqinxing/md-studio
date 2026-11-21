import fs from "node:fs";

const ENDPOINT = process.env.QDEPLOY_URL || "https://deploy.li.qinxing.xyz/mcp";
const TOKEN = (process.env.QDEPLOY_TOKEN || "")
  .trim()
  .replace(/^Bearer\s+/i, "")
  .trim();
const SITE = process.env.QDEPLOY_SITE || "md-studio";
const DOMAIN = process.env.QDEPLOY_DOMAIN || "markdown.li.qinxing.xyz";

if (!TOKEN) {
  console.log("::warning::QDEPLOY_TOKEN 未配置，跳过自定义域名部署");
  process.exit(0);
}
if (!/^[a-f0-9]{64}$/i.test(TOKEN)) {
  console.error(
    "::error::QDEPLOY_TOKEN 格式不正确：应为 64 位十六进制字符串，不要带 Bearer 前缀或换行",
  );
  process.exit(1);
}

async function post(body, headers) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2500));
    }
  }
  const cause = lastErr?.cause?.code || lastErr?.cause?.message || "";
  throw new Error(`无法连接 qdeploy${cause ? `（${cause}）` : ""}`);
}

async function call(body, sessionId, { expect = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await post(body, headers);
  const sid = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  if (res.status === 401) throw new Error("QDEPLOY_TOKEN 被 qdeploy 拒绝（401）");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!expect) return { sid };

  const messages = [];
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) buf.push(line.slice(5).trimStart());
    else if (!line && buf.length) {
      messages.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length) messages.push(buf.join("\n"));

  const payloads = messages
    .map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!payloads.length) throw new Error(`无法解析 MCP 响应：${text.slice(0, 200)}`);
  const payload = payloads.find((p) => p.id === body.id) || payloads[payloads.length - 1];
  if (payload.error) throw new Error(`MCP 错误：${JSON.stringify(payload.error).slice(0, 300)}`);
  return { payload, sid };
}

async function main() {
  const html = fs.readFileSync("index.html", "utf8");
  const size = Buffer.byteLength(html);
  if (size > 4_100_000) {
    throw new Error(
      `index.html 为 ${(size / 1024 / 1024).toFixed(2)} MB，超过 qdeploy 约 4 MB 的请求体上限`,
    );
  }

  const init = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "md-studio-ci", version: "0.2.0" },
    },
  });
  const sid = init.sid;
  if (!sid) throw new Error("MCP 未返回 session id");

  await call({ jsonrpc: "2.0", method: "notifications/initialized" }, sid, { expect: false });

  const res = await call(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "deploy_files",
        arguments: {
          files: [{ path: "index.html", content: html }],
          name: SITE,
          domain: DOMAIN,
          spa: false,
        },
      },
    },
    sid,
  );

  const result = res.payload.result;
  if (!result) throw new Error("MCP 未返回部署结果");
  if (result.isError) throw new Error(result.content?.[0]?.text || "部署失败");

  const raw = result.content?.find((c) => c.type === "text")?.text || "{}";
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {}
  if (data.ok === false) throw new Error(raw);

  const line = `已部署 ${data.name || SITE} -> ${data.url || "https://" + DOMAIN}  ` +
    `${((data.bytes || size) / 1024 / 1024).toFixed(2)} MB  release=${data.release || "?"}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### qdeploy\n\n\`${line}\`\n`);
  }
}

main().catch((err) => {
  const msg = String(err?.message || err).replace(/\s+/g, " ").slice(0, 400);
  console.error(`::error::qdeploy 部署失败：${msg}`);
  process.exit(1);
});

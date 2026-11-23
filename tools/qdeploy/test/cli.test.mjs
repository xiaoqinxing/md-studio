import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "bin/qdeploy.mjs");

function tarEntries(gzip) {
  const buf = gunzipSync(gzip);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const rawName = block.subarray(0, 100).toString("utf8").split("\0")[0];
    const rawPrefix = block.subarray(345, 500).toString("utf8").split("\0")[0];
    const rawSize = block.subarray(124, 136).toString("ascii").split("\0")[0].trim();
    const size = rawSize ? parseInt(rawSize, 8) : 0;
    const type = String.fromCharCode(block[156] || 0x30);
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const data = buf.subarray(offset + 512, offset + 512 + size);
    if (type === "0") entries.push({ name, data });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function address(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runCli(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [BIN, ...args], {
      env,
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

async function makeSite() {
  const dir = await mkdtemp(join(tmpdir(), "qdeploy-test-"));
  await mkdir(join(dir, "assets"));
  await mkdir(join(dir, "node_modules"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, "index.html"), "<h1>hello</h1>\n");
  await writeFile(join(dir, "assets/app.js"), "console.log(1);\n");
  await writeFile(join(dir, "node_modules/skip.js"), "skip\n");
  await writeFile(join(dir, ".git/config"), "skip\n");
  await writeFile(join(dir, ".env.local"), "SECRET=1\n");
  await writeFile(
    join(dir, "qdeploy.json"),
    JSON.stringify({
      name: "manifest-site",
      spa: true,
      headers: { "X-Frame-Options": "DENY" },
      rules: [{ path: ["/assets/*"], headers: { "Cache-Control": "immutable" } }],
    }),
  );
  await symlink("index.html", join(dir, "link.html"));
  return dir;
}

test("archives a directory, skips noise and honors the manifest", async (t) => {
  const dir = await makeSite();
  t.after(() => rm(dir, { recursive: true, force: true }));

  let captured;
  const server = await listen(async (req, res) => {
    const body = await readBody(req);
    captured = { url: req.url, headers: req.headers, body };
    const origin = address(server);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        name: "manifest-site",
        domain: "manifest-site.li.qinxing.xyz",
        url: `${origin}/`,
        release: "20260101T000000Z-deadbeef",
        changed: true,
        bytes: 16,
        files: 2,
        caddy_reloaded: true,
      }),
    );
  });
  t.after(() => server.close());

  const cfg = join(dir, "config.json");
  const result = await runCli([dir, "--no-verify"], {
    ...process.env,
    QDEPLOY_CONFIG: cfg,
    QDEPLOY_URL: address(server),
    QDEPLOY_TOKEN: "secret-token",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /URL:\s+http:\/\/127\.0\.0\.1:/);
  assert.match(result.stdout, /caddy:\s+reloaded/);

  assert.equal(captured.url, "/api/v1/sites/manifest-site/deploy");
  assert.equal(captured.headers.authorization, "Bearer secret-token");
  assert.equal(captured.headers["content-type"], "application/gzip");
  assert.equal(
    Number(captured.headers["content-length"]),
    captured.body.length,
  );

  const meta = JSON.parse(
    Buffer.from(captured.headers["x-deploy-meta"], "base64url").toString("utf8"),
  );
  assert.deepEqual(meta, {
    domain: "manifest-site.li.qinxing.xyz",
    spa: true,
    headers: { "X-Frame-Options": "DENY" },
    rules: [{ path: ["/assets/*"], headers: { "Cache-Control": "immutable" } }],
    allow_missing_index: false,
  });
  assert.ok(!captured.headers["x-deploy-meta"].endsWith("="));

  const entries = tarEntries(captured.body);
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    ["assets/app.js", "index.html"],
  );
  assert.equal(entries.find((entry) => entry.name === "index.html").data.toString(), "<h1>hello</h1>\n");
});

test("single file deploys under its basename", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qdeploy-file-"));
  const file = join(dir, "page.html");
  await writeFile(file, "<p>page</p>");
  t.after(() => rm(dir, { recursive: true, force: true }));

  let captured;
  const server = await listen(async (req, res) => {
    const body = await readBody(req);
    captured = { url: req.url, body };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "page", url: "https://page.example" }));
  });
  t.after(() => server.close());

  const result = await runCli(["deploy", file, "--no-verify"], {
    ...process.env,
    QDEPLOY_CONFIG: join(dir, "config.json"),
    QDEPLOY_URL: address(server),
    QDEPLOY_TOKEN: "token",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(captured.url, "/api/v1/sites/page/deploy");
  assert.deepEqual(tarEntries(captured.body).map((entry) => entry.name), ["page.html"]);
});

test("HTTP errors exit with code 2 and do not hide the status", async (t) => {
  const dir = await makeSite();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const server = await listen(async (req, res) => {
    await readBody(req);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid or missing token" }));
  });
  t.after(() => server.close());

  const result = await runCli([dir, "--no-verify"], {
    ...process.env,
    QDEPLOY_CONFIG: join(dir, "config.json"),
    QDEPLOY_URL: address(server),
    QDEPLOY_TOKEN: "bad",
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid or missing token/);
  assert.match(result.stderr, /HTTP 401/);
});

test("prints unchanged status and forwards allow-missing-index", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qdeploy-unchanged-"));
  await writeFile(join(dir, "index.html"), "same");
  t.after(() => rm(dir, { recursive: true, force: true }));

  let meta;
  const server = await listen(async (req, res) => {
    await readBody(req);
    meta = JSON.parse(
      Buffer.from(req.headers["x-deploy-meta"], "base64url").toString("utf8"),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        name: "same",
        url: "https://same.example",
        release: "20260101T000000Z-aaaaaaaa",
        changed: false,
        caddy_reloaded: false,
      }),
    );
  });
  t.after(() => server.close());

  const result = await runCli(
    [dir, "--name", "same", "--no-verify", "--allow-missing-index"],
    {
      ...process.env,
      QDEPLOY_CONFIG: join(dir, "config.json"),
      QDEPLOY_URL: address(server),
      QDEPLOY_TOKEN: "token",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /status:\s+unchanged/);
  assert.doesNotMatch(result.stdout, /^size:/m);
  assert.equal(meta.allow_missing_index, true);
});

test("saves config with mode 0600", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qdeploy-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sites: [] }));
  });
  t.after(() => server.close());

  const cfg = join(dir, "nested/config.json");
  const result = await runCli(
    ["login", "--url", address(server), "--token", "tok"],
    { ...process.env, QDEPLOY_CONFIG: cfg },
  );

  assert.equal(result.code, 0, result.stderr);
  const info = await stat(cfg);
  assert.equal(info.mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(cfg, "utf8"));
  assert.equal(saved.url, address(server));
  assert.equal(saved.token, "tok");
  assert.equal(saved.base_domain, "li.qinxing.xyz");
});

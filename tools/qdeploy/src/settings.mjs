import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export const DEFAULT_URL = "https://deploy.li.qinxing.xyz";
export const DEFAULT_BASE_DOMAIN = "li.qinxing.xyz";
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class CLIError extends Error {}
export class InterruptedError extends Error {}

export function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function configPath() {
  return expandHome(process.env.QDEPLOY_CONFIG || "~/.config/qdeploy/config.json");
}

export async function readConfig() {
  const path = configPath();
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new CLIError(`cannot read config ${path}: ${err.message}`);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not a JSON object");
    }
    return value;
  } catch (err) {
    throw new CLIError(`invalid config ${path}: ${err.message}`);
  }
}

export async function saveConfig(settings) {
  const path = configPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = join(
    dir,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    throw new CLIError(`cannot write config ${path}: ${err.message}`);
  }
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
}

export async function loadSettings(flags, { requireToken = true } = {}) {
  const cfg = await readConfig();
  const url = flags.url || process.env.QDEPLOY_URL || cfg.url;
  const token = String(flags.token || process.env.QDEPLOY_TOKEN || cfg.token || "").trim();
  const baseDomain =
    flags["base-domain"] ||
    process.env.QDEPLOY_BASE_DOMAIN ||
    cfg.base_domain ||
    DEFAULT_BASE_DOMAIN;

  if (!url) {
    throw new CLIError(
      "not logged in: run `qdeploy login --url https://deploy.li.qinxing.xyz` " +
        "or set QDEPLOY_URL / QDEPLOY_TOKEN",
    );
  }
  if (requireToken && !token) {
    throw new CLIError(
      "no token: run `qdeploy login` or set QDEPLOY_TOKEN, or pass --token",
    );
  }
  return { url: String(url).replace(/\/+$/, ""), token, baseDomain };
}

export function humanSize(bytes) {
  let value = Number(bytes) || 0;
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") {
      return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

export async function promptLine(text) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(text)).trim();
  } finally {
    rl.close();
  }
}

export async function promptHidden(text) {
  if (!process.stdin.isTTY) return promptLine(text);

  process.stderr.write(text);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new InterruptedError("interrupted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else {
          value += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

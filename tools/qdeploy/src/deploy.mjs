import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";

import { createBundle } from "./archive.mjs";
import { probeUrl } from "./client.mjs";
import {
  CLIError,
  NAME_RE,
  humanSize,
  slugify,
} from "./settings.mjs";

const VERIFY_ATTEMPTS = 20;
const VERIFY_DELAY_MS = 1500;

async function readManifest(src) {
  const info = await stat(src);
  if (!info.isDirectory()) return {};
  let raw;
  try {
    raw = await readFile(join(src, "qdeploy.json"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new CLIError(`cannot read qdeploy.json: ${err.message}`);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest must be a JSON object");
    }
    return value;
  } catch (err) {
    throw new CLIError(`invalid qdeploy.json: ${err.message}`);
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function verifyUrl(url) {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    const status = await probeUrl(url);
    if (status !== null && status < 500) return true;
    if (attempt + 1 < VERIFY_ATTEMPTS) await delay(VERIFY_DELAY_MS);
  }
  return false;
}

export async function deployPath(client, path, flags, baseDomain) {
  const src = resolve(path);
  let info;
  try {
    info = await stat(src);
  } catch {
    throw new CLIError(`path does not exist: ${path}`);
  }

  const manifest = await readManifest(src);
  const rawName = flags.name || manifest.name;
  const name =
    rawName || slugify(parse(src).name) || `site-${randomBytes(3).toString("hex")}`;
  if (!NAME_RE.test(name)) {
    throw new CLIError(
      "invalid site name: use lowercase letters, digits and hyphens (max 63)",
    );
  }

  const spa = Boolean(flags.spa || manifest.spa);
  const domain = String(
    flags.domain || manifest.domain || `${name}.${baseDomain}`,
  )
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  const meta = {
    domain,
    spa,
    headers: manifest.headers ?? {},
    rules: manifest.rules ?? [],
    allow_missing_index: Boolean(flags["allow-missing-index"]),
  };

  const tmp = await mkdtemp(join(tmpdir(), "qdeploy-"));
  try {
    const bundle = join(tmp, "bundle.tar.gz");
    const { size } = await createBundle(src, bundle);
    const result = await client.deploy(name, bundle, meta, size);
    result.verify = "skipped";
    if (!flags["no-verify"] && result.url) {
      result.verify = (await verifyUrl(result.url)) ? "ok" : "pending";
    }
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function printDeployResult(result) {
  console.log(`URL:      ${result.url || "-"}`);
  console.log(`site:     ${result.name || "-"}`);
  console.log(`release:  ${result.release || "-"}`);
  if (result.changed === false) {
    console.log("status:   unchanged (content hash matched)");
  } else {
    console.log(`size:     ${humanSize(result.bytes)}`);
  }
  if (result.caddy_reloaded) console.log("caddy:    reloaded");
  if (result.verify === "pending") {
    console.log(
      "note:     TLS certificate may still be issuing; retry the URL in a few seconds",
    );
  }
}

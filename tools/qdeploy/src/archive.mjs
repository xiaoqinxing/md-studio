import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".qdeploy",
]);
const SKIP_FILES = new Set([".DS_Store", "qdeploy.json"]);

export class ArchiveError extends Error {}

function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith(".git");
}

function isSkippedFile(name) {
  return SKIP_FILES.has(name) || name.startsWith(".env");
}

export async function collectEntries(src) {
  const root = resolve(src);
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    throw new ArchiveError(`refusing to archive symlink: ${src}`);
  }
  if (info.isFile()) {
    return [{ abs: root, name: basename(root) }];
  }
  if (!info.isDirectory()) {
    throw new ArchiveError(`not a regular file or directory: ${src}`);
  }

  const entries = [];
  async function walk(dir, rel) {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const abs = join(dir, item.name);
      const name = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (isSkippedDir(item.name)) continue;
        await walk(abs, name);
      } else if (item.isFile()) {
        if (isSkippedFile(item.name)) continue;
        entries.push({ abs, name });
      }
    }
  }
  await walk(root, "");
  return entries;
}

function octal(value, width) {
  const text = Math.max(0, Math.floor(value)).toString(8);
  if (text.length > width - 1) {
    throw new ArchiveError(`value too large for tar header: ${value}`);
  }
  return text.padStart(width - 1, "0") + "\0";
}

function writeString(buf, value, offset, width) {
  const raw = Buffer.from(value, "utf8");
  if (raw.length > width) throw new ArchiveError(`tar field too long: ${value}`);
  raw.copy(buf, offset);
}

function splitUstarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  const parts = name.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const suffix = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  return null;
}

function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(tail) !== length) {
    length += 1;
  }
  return `${length}${tail}`;
}

function header({ name, prefix = "", size = 0, mtime = 0, mode = 0o644, type = "0" }) {
  const buf = Buffer.alloc(512);
  writeString(buf, name, 0, 100);
  writeString(buf, octal(mode & 0o777, 8), 100, 8);
  writeString(buf, octal(0, 8), 108, 8);
  writeString(buf, octal(0, 8), 116, 8);
  writeString(buf, octal(size, 12), 124, 12);
  writeString(buf, octal(mtime, 12), 136, 12);
  buf.fill(0x20, 148, 156);
  writeString(buf, type, 156, 1);
  writeString(buf, "ustar\0", 257, 6);
  writeString(buf, "00", 263, 2);
  writeString(buf, prefix, 345, 155);

  let sum = 0;
  for (const byte of buf) sum += byte;
  writeString(buf, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

function padding(size) {
  const rest = size % 512;
  return rest === 0 ? 0 : 512 - rest;
}

async function* tarStream(entries) {
  for (const entry of entries) {
    const info = await stat(entry.abs);
    if (!info.isFile()) continue;

    let split = splitUstarName(entry.name);
    if (!split) {
      const payload = Buffer.from(paxRecord("path", entry.name), "utf8");
      const fallback = "PaxLongName";
      yield header({ name: "PaxHeaders/path", size: payload.length, mtime: info.mtimeMs / 1000, type: "x" });
      yield payload;
      const pad = padding(payload.length);
      if (pad) yield Buffer.alloc(pad);
      split = { name: fallback, prefix: "" };
    }

    yield header({
      name: split.name,
      prefix: split.prefix,
      size: info.size,
      mtime: info.mtimeMs / 1000,
      mode: info.mode,
    });
    if (info.size > 0) {
      yield* createReadStream(entry.abs);
    }
    const pad = padding(info.size);
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

export async function createBundle(src, dest) {
  const entries = await collectEntries(src);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(
    Readable.from(tarStream(entries)),
    createGzip({ level: 6 }),
    createWriteStream(dest, { mode: 0o600 }),
  );
  const info = await stat(dest);
  return { size: info.size, files: entries.length };
}

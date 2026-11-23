import { Client } from "./client.mjs";
import {
  CLIError,
  DEFAULT_BASE_DOMAIN,
  DEFAULT_URL,
  configPath,
  loadSettings,
  promptHidden,
  promptLine,
  readConfig,
  saveConfig,
} from "./settings.mjs";

function requireName(args) {
  const name = args[0];
  if (!name) throw new CLIError("site name is required");
  return name;
}

export async function cmdLs(flags) {
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).listSites();
  const sites = Array.isArray(data.sites) ? data.sites : [];
  if (!sites.length) {
    console.log("no sites");
    return;
  }
  const rows = [["NAME", "DOMAIN", "CURRENT", "UPDATED"]];
  for (const site of sites) {
    rows.push([
      String(site.name || ""),
      String(site.domain || ""),
      String(site.current || "-").split("/").pop() || "-",
      String(site.updated_at || ""),
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) {
    console.log(row.map((value, i) => value.padEnd(widths[i])).join("  "));
  }
}

export async function cmdShow(flags, args) {
  const name = requireName(args);
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).getSite(name);
  console.log(JSON.stringify(data, null, 2));
}

export async function cmdRollback(flags, args) {
  const name = requireName(args);
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).rollback(name, flags.release);
  console.log(`rolled back: ${data.name} -> ${data.release}`);
  console.log(`URL: ${data.url}`);
}

export async function cmdRm(flags, args) {
  const name = requireName(args);
  if (!flags.yes) throw new CLIError("refusing to delete without --yes");
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).deleteSite(name);
  console.log(`deleted: ${name} (moved to trash: ${data.trash || "-"})`);
}

export async function cmdOpen(flags, args) {
  const name = requireName(args);
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).getSite(name);
  console.log(data.url);
}

export async function cmdHealth(flags) {
  const { url, token } = await loadSettings(flags);
  const data = await new Client(url, token).health();
  console.log(JSON.stringify(data, null, 2));
}

export async function cmdLogin(flags) {
  const cfg = await readConfig();
  const entered =
    flags.url ||
    (await promptLine(`Deploy URL [${DEFAULT_URL}]: `)) ||
    DEFAULT_URL;
  const token = String(
    flags.token || (await promptHidden("Deploy token: ")),
  ).trim();
  if (!token) throw new CLIError("empty token");

  const url = String(entered).replace(/\/+$/, "");
  const baseDomain =
    flags["base-domain"] ||
    process.env.QDEPLOY_BASE_DOMAIN ||
    cfg.base_domain ||
    DEFAULT_BASE_DOMAIN;

  const data = await new Client(url, token).listSites();
  await saveConfig({ url, token, base_domain: baseDomain });
  console.log(`logged in: ${url} (${(data.sites || []).length} existing sites)`);
  console.log(`config:   ${configPath()}`);
}

import { parseArgs } from "node:util";

import { Client, ClientError } from "./client.mjs";
import {
  cmdHealth,
  cmdLogin,
  cmdLs,
  cmdOpen,
  cmdRm,
  cmdRollback,
  cmdShow,
} from "./commands.mjs";
import { deployPath, printDeployResult } from "./deploy.mjs";
import { CLIError, InterruptedError, loadSettings } from "./settings.mjs";

const VERSION = "1.0.0";
const COMMANDS = new Set([
  "deploy",
  "ls",
  "show",
  "rollback",
  "rm",
  "open",
  "login",
  "health",
]);

const HELP = `Usage: qdeploy <path> [options]
       qdeploy <command> [options]

Commands:
  deploy <path>            Deploy a directory or a single file (default)
  ls                       List sites
  show <name>              Show site details as JSON
  rollback <name>          Switch to a previous release
  rm <name> --yes          Delete a site (moves it to trash)
  open <name>              Print a site URL
  login                    Save URL and token
  health                   Check the deploy API

Options:
  --name NAME              Site name (lowercase letters, digits, hyphens)
  --domain DOMAIN          Custom domain under the base domain
  --spa                    Enable single-page-app fallback
  --allow-missing-index    Allow a bundle without index.html
  --no-verify              Skip the post-deploy URL check
  --release RELEASE        Release id for rollback
  -y, --yes                Confirm destructive operations
  --url URL                Deploy API URL
  --token TOKEN            Deploy API token
  --base-domain DOMAIN     Base domain (default: li.qinxing.xyz)
  -h, --help               Show this help
  --version                Show version

Environment:
  QDEPLOY_URL, QDEPLOY_TOKEN, QDEPLOY_BASE_DOMAIN, QDEPLOY_CONFIG
`;

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      "base-domain": { type: "string" },
      name: { type: "string" },
      domain: { type: "string" },
      spa: { type: "boolean" },
      "allow-missing-index": { type: "boolean" },
      "no-verify": { type: "boolean" },
      release: { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
}

async function run(flags, args) {
  let command;
  let rest;
  if (args.length && COMMANDS.has(args[0])) {
    command = args[0];
    rest = args.slice(1);
  } else if (args.length) {
    command = "deploy";
    rest = args;
  } else {
    throw new CLIError("missing command or path (try --help)");
  }

  switch (command) {
    case "deploy": {
      const path = rest[0];
      if (!path) throw new CLIError("deploy requires a path");
      if (rest.length > 1) throw new CLIError(`unexpected argument: ${rest[1]}`);
      const { url, token, baseDomain } = await loadSettings(flags);
      const client = new Client(url, token);
      const result = await deployPath(client, path, flags, baseDomain);
      printDeployResult(result);
      return 0;
    }
    case "ls":
      await cmdLs(flags);
      return 0;
    case "show":
      await cmdShow(flags, rest);
      return 0;
    case "rollback":
      await cmdRollback(flags, rest);
      return 0;
    case "rm":
      await cmdRm(flags, rest);
      return 0;
    case "open":
      await cmdOpen(flags, rest);
      return 0;
    case "login":
      await cmdLogin(flags);
      return 0;
    case "health":
      await cmdHealth(flags);
      return 0;
    default:
      throw new CLIError(`unknown command: ${command}`);
  }
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  if (parsed.values.version) {
    console.log(`qdeploy ${VERSION}`);
    return 0;
  }
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    return await run(parsed.values, parsed.positionals);
  } catch (err) {
    if (err instanceof InterruptedError) return 130;
    if (err instanceof ClientError) {
      console.error(`error: ${err.message} (HTTP ${err.status})`);
      return 2;
    }
    console.error(`error: ${err.message || err}`);
    return 2;
  }
}

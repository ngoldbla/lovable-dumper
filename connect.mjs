#!/usr/bin/env node
//
// Thin CLI shim over the shared engine (src/engine/). It parses flags, resolves
// the GitHub owner + token (no `gh` required anymore), pipes engine events to
// the terminal, and answers the "logged in?" barrier via readline.
//
// Token resolution: GITHUB_TOKEN env var, else a stored token file beside this
// script. Renames now go through the GitHub REST API instead of `gh repo rename`.

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { AutomationEngine } from "./src/engine/automation.js";
import { EngineEvents } from "./src/engine/events.js";
import { loadProjects } from "./src/engine/state.js";
import { resolveUsername, loadToken } from "./src/engine/github-auth.js";
import { ensureBrowser } from "./src/engine/browser-install.js";

const BASE_PATH = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    "rename-only": { type: "boolean", default: false },
    "retry-failed": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    discover: { type: "boolean", default: false },
    project: { type: "string" },
    org: { type: "string" },
  },
  strict: false,
});

const DRY_RUN = flags["dry-run"];
const RENAME_ONLY = flags["rename-only"];
const DISCOVER = flags.discover;
const SINGLE_PROJECT = flags.project;

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  // Token: env wins, then a stored file. Optional for discover/dry-run.
  const token = process.env.GITHUB_TOKEN || loadToken(BASE_PATH);

  // Owner: explicit --org wins; otherwise derive from the token.
  let org = flags.org || null;
  if (!org && token) {
    try {
      org = await resolveUsername(token);
    } catch (err) {
      console.error(`Warning: could not resolve GitHub user from token: ${err.message}`);
    }
  }

  const orgRequired = !DISCOVER && !DRY_RUN;
  if (!org && orgRequired) {
    fail(
      "Could not determine GitHub org. Pass --org <name>, or set GITHUB_TOKEN " +
        "(a token with 'repo' scope) so it can be auto-detected."
    );
  }

  // Renames need a token. Rename-only with no token can't do anything.
  const willRename = (RENAME_ONLY || !DISCOVER) && !DRY_RUN;
  if (willRename && !token) {
    if (RENAME_ONLY) {
      fail("Rename requires a GitHub token. Set GITHUB_TOKEN (with 'repo' scope).");
    }
    console.error(
      "Warning: no GITHUB_TOKEN set — projects will connect, but the rename " +
        "step will be skipped."
    );
  }

  const engine = new AutomationEngine({
    basePath: BASE_PATH,
    org,
    githubToken: token,
    dryRun: DRY_RUN,
    retryFailed: flags["retry-failed"],
    renameOnly: RENAME_ONLY,
  });

  // Pipe engine events to the terminal.
  engine.on("engine", (e) => {
    if (e.type === EngineEvents.LOG) {
      console.log(`[${new Date(e.ts).toLocaleTimeString()}] ${e.msg}`);
    } else if (e.type === EngineEvents.LOGIN_NEEDED) {
      ask("Press Enter once you are logged in...").then(() => engine.confirmLogin());
    } else if (e.type === EngineEvents.ERROR && !e.fatal) {
      // Fatal errors propagate via the thrown rejection (printed by main().catch
      // with exit code 1); only surface non-fatal warnings here to avoid the
      // same failure being reported twice.
      console.error(`Warning: ${e.message}`);
    }
  });

  // Ensure Chromium is present before any browser-driving operation.
  if (!RENAME_ONLY) {
    await ensureBrowser({
      log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`),
    });
  }

  if (DISCOVER) {
    await engine.discover();
    return;
  }

  let selected = loadProjects(BASE_PATH);
  if (SINGLE_PROJECT) {
    selected = selected.filter((p) => p.id === SINGLE_PROJECT);
    if (selected.length === 0) {
      fail(`Project ${SINGLE_PROJECT} not found in projects.json`);
    }
  }
  if (!RENAME_ONLY && selected.length === 0) {
    console.log("No projects in projects.json. Run with --discover first.");
    return;
  }

  await engine.run(selected);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

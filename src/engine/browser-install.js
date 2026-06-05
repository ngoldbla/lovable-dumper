// First-run Chromium provisioning for playwright-core.
//
// playwright-core ships the automation driver but NOT a browser, so we fetch
// Chromium on first run into a writable location (userData for Electron; the
// default ms-playwright cache for the CLI). This is the single most fragile path
// in a packaged Electron app, so the mechanics matter:
//
//   • We spawn the install as a child process using `process.execPath`. In a
//     packaged app that's the Electron binary, so we set ELECTRON_RUN_AS_NODE=1
//     to make it behave like plain Node (harmlessly ignored by a real Node
//     binary, so the same code path works for the CLI).
//   • PLAYWRIGHT_BROWSERS_PATH must already be set in the parent env (the main
//     process sets it before anything imports playwright-core) and is inherited.
//   • We resolve playwright-core's own CLI via createRequire so it works whether
//     or not the package is unpacked from the asar archive.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EngineEvents } from "./events.js";

const require = createRequire(import.meta.url);

/**
 * Resolve the path to playwright-core's CLI entrypoint.
 *
 * playwright-core's package.json `exports` does NOT list "./cli.js", so a direct
 * `require.resolve("playwright-core/cli.js")` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Instead resolve the package.json (which IS exported) and locate cli.js beside
 * it — this works in dev and inside an asar-unpacked bundle alike.
 */
export function playwrightCliPath() {
  const pkgJson = require.resolve("playwright-core/package.json");
  return join(dirname(pkgJson), "cli.js");
}

/**
 * Is a usable Chromium already present for the current PLAYWRIGHT_BROWSERS_PATH?
 * Imports playwright-core lazily so callers that never touch a browser (e.g.
 * `--rename-only`) don't pay to load the driver.
 */
export async function isBrowserInstalled() {
  try {
    const { chromium } = await import("playwright-core");
    const execPath = chromium.executablePath();
    return !!execPath && existsSync(execPath);
  } catch {
    return false;
  }
}

/**
 * Ensure Chromium is installed, downloading it if needed. Idempotent: returns
 * immediately when a browser already exists.
 *
 * @param {Object}   [opts]
 * @param {Function} [opts.emit]   (type, payload) => void — progress + log
 * @param {Function} [opts.log]    (msg) => void
 * @param {string}   [opts.execPath]  override the spawned binary (defaults to process.execPath)
 * @param {boolean}  [opts.force]  reinstall even if present
 * @returns {Promise<{installed: boolean, alreadyPresent: boolean}>}
 */
export async function ensureBrowser({
  emit = () => {},
  log = () => {},
  execPath = process.execPath,
  force = false,
} = {}) {
  if (!force && (await isBrowserInstalled())) {
    emit(EngineEvents.BROWSER_DOWNLOAD_PROGRESS, { percent: 100, done: true });
    return { installed: false, alreadyPresent: true };
  }

  log("Downloading Chromium (one-time, ~280 MB)…");

  await new Promise((resolve, reject) => {
    const child = spawn(execPath, [playwrightCliPath(), "install", "chromium"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // PLAYWRIGHT_BROWSERS_PATH is inherited from process.env when set.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onChunk = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const percent = parsePercent(line);
        if (percent != null) {
          emit(EngineEvents.BROWSER_DOWNLOAD_PROGRESS, {
            percent,
            done: false,
            line,
          });
        } else {
          log(line.trim());
        }
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Chromium install exited with code ${code}`));
    });
  });

  emit(EngineEvents.BROWSER_DOWNLOAD_PROGRESS, { percent: 100, done: true });
  log("Chromium ready.");
  return { installed: true, alreadyPresent: false };
}

/** Best-effort progress parse from playwright's installer output. */
function parsePercent(line) {
  const m = line.match(/(\d{1,3})%/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

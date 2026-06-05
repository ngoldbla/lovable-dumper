// Persistence for the resumable run state and the discovered-project manifest.
//
// All files live under `basePath`. The two consumers pass different roots:
//   • CLI:      the directory containing connect.mjs (writes land beside it,
//               covered by .gitignore — matching the original behavior)
//   • Electron: app.getPath('userData') — the packaged app bundle is read-only,
//               so every write MUST go to userData instead.
//
// `state.json` tracks per-project progress so a run is resumable; `projects.json`
// is the input manifest produced by discovery.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function statePath(basePath) {
  return join(basePath, "state.json");
}

export function projectsPath(basePath) {
  return join(basePath, "projects.json");
}

/**
 * Load run state, or a fresh skeleton if none exists yet.
 * @param {string} basePath
 * @param {string} [defaultOwner]  seed value for `githubOwner`
 * @returns {{githubOwner: string, projects: Record<string, object>}}
 */
export function loadState(basePath, defaultOwner = "") {
  const p = statePath(basePath);
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  return { githubOwner: defaultOwner, projects: {} };
}

export function saveState(basePath, state) {
  ensureDir(basePath);
  writeFileSync(statePath(basePath), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Load the discovered-project manifest. Returns [] when absent so callers can
 * treat "not discovered yet" and "empty" uniformly (the original threw on a
 * missing file — returning [] is strictly more forgiving and matches the
 * Electron case where the file may not exist on first launch).
 * @param {string} basePath
 * @returns {{id: string, name: string}[]}
 */
export function loadProjects(basePath) {
  const p = projectsPath(basePath);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function saveProjects(basePath, projects) {
  ensureDir(basePath);
  writeFileSync(projectsPath(basePath), JSON.stringify(projects, null, 2) + "\n");
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

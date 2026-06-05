// Phase 2 — rename connected repos with an `lv-` prefix so they group together.
//
// This replaces the original `gh repo rename` shell-out with a native GitHub
// REST call (`PATCH /repos/{owner}/{repo}`), removing the hard dependency on the
// GitHub CLI. The HTTP surface is small and easy to mock, which is what the unit
// tests exercise.

import { EngineEvents } from "./events.js";

const GH_API = "https://api.github.com";
const USER_AGENT = "lovable-dumper";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The target slug for a repo: add `lv-` unless it's already there. */
export function targetName(currentName) {
  return currentName.startsWith("lv-") ? currentName : `lv-${currentName}`;
}

/**
 * Rename a single repo via the GitHub REST API.
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
export async function renameRepo(owner, currentName, newName, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${GH_API}/repos/${owner}/${currentName}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ name: newName }),
  });

  if (res.ok) return { ok: true, status: res.status };

  // Translate the common failures into actionable messages.
  let error = `HTTP ${res.status}`;
  if (res.status === 403) {
    error =
      `No permission to rename ${owner}/${currentName} (403). The token needs ` +
      `'repo' scope and you must be able to administer the repo (org repos ` +
      `require admin rights).`;
  } else if (res.status === 404) {
    error = `Repo ${owner}/${currentName} not found (404).`;
  } else if (res.status === 401) {
    error = `GitHub token rejected (401). Re-authenticate.`;
  } else {
    try {
      const body = await res.json();
      if (body?.message) error = body.message;
    } catch {
      /* keep the generic HTTP message */
    }
  }
  return { ok: false, status: res.status, error };
}

/**
 * Rename every connected repo recorded in `state`, mutating `state` in place and
 * emitting progress. Skips repos already renamed or already lv-prefixed.
 *
 * @param {Object}   opts
 * @param {Object}   opts.state         run state (mutated)
 * @param {string}   [opts.token]       GitHub token (required unless dryRun)
 * @param {boolean}  [opts.dryRun]
 * @param {Function} [opts.emit]        (type, payload) => void
 * @param {Function} [opts.log]         (msg) => void
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.saveState]   called after each mutation, for resumability
 * @returns {Promise<{renamed: number, skipped: number, failed: number}>}
 */
export async function renameRepos({
  state,
  token,
  dryRun = false,
  emit = () => {},
  log = () => {},
  sleep = defaultSleep,
  fetchImpl = fetch,
  saveState = () => {},
}) {
  const owner = state.githubOwner;
  let renamed = 0;
  let skipped = 0;
  let failed = 0;

  for (const [id, info] of Object.entries(state.projects)) {
    if (info.phase2 === "renamed") {
      skipped++;
      continue;
    }
    if (!info.repoName) continue;

    const currentName = info.repoName;
    const newName = targetName(currentName);

    if (currentName === newName) {
      log(`[${currentName}] Already has lv- prefix`);
      info.renamedTo = newName;
      info.phase2 = "renamed";
      skipped++;
      emit(EngineEvents.PROJECT, {
        id,
        name: info.name,
        phase2: "renamed",
        repoName: currentName,
        renamedTo: newName,
      });
      continue;
    }

    if (dryRun) {
      log(`DRY RUN: Would rename ${owner}/${currentName} → ${newName}`);
      continue;
    }

    const result = await renameRepo(owner, currentName, newName, token, fetchImpl);
    if (result.ok) {
      log(`Renamed ${currentName} → ${newName}`);
      info.renamedTo = newName;
      info.phase2 = "renamed";
      renamed++;
      emit(EngineEvents.PROJECT, {
        id,
        name: info.name,
        phase2: "renamed",
        repoName: currentName,
        renamedTo: newName,
      });
    } else {
      log(`Failed to rename ${currentName}: ${result.error}`);
      info.phase2 = "failed";
      failed++;
      emit(EngineEvents.PROJECT, {
        id,
        name: info.name,
        phase2: "failed",
        repoName: currentName,
        error: result.error,
      });
    }

    saveState();
    // Courtesy spacing — the rename endpoint is cheap but we stay well under
    // the 5000 req/hr limit and avoid hammering it.
    await sleep(200);
  }

  log(`Rename summary: ${renamed} renamed, ${skipped} skipped, ${failed} failed`);
  return { renamed, skipped, failed };
}

// The engine event contract.
//
// `AutomationEngine` (and the helpers it drives) communicate progress by
// emitting events instead of writing to the console. This keeps the engine
// UI-agnostic: the CLI shim pipes these events to stdout, while the Electron
// app forwards them over IPC to the renderer.
//
// Two emission channels carry the same payloads:
//   • a typed event (e.g. `engine.on("ENGINE_LOG", fn)`) for ergonomic listeners
//   • a single unified `"engine"` event for blanket forwarding (IPC / logging)
//
// Every payload is plain JSON — no class instances, Sets, Maps, or functions —
// so it survives `JSON.stringify`/structured-clone across the IPC boundary
// unchanged. Each event also carries a `type` (one of the constants below) and
// a `ts` (epoch ms) added by the emitter.

export const EngineEvents = Object.freeze({
  /** @see LogPayload — human-readable progress line. */
  LOG: "ENGINE_LOG",
  /** @see PhasePayload — pipeline stage changed. */
  PHASE: "ENGINE_PHASE",
  /** @see ProjectPayload — a single project's status changed. */
  PROJECT: "ENGINE_PROJECT",
  /** @see DiscoverPayload — discovery finished; full project list attached. */
  DISCOVER: "ENGINE_DISCOVER",
  /** @see DonePayload — the whole run finished; summary counts attached. */
  DONE: "ENGINE_DONE",
  /** @see ErrorPayload — recoverable or fatal error. */
  ERROR: "ENGINE_ERROR",
  /** @see BrowserDownloadProgressPayload — first-run Chromium download. */
  BROWSER_DOWNLOAD_PROGRESS: "ENGINE_BROWSER_DOWNLOAD_PROGRESS",
  /** No payload — user must log into Lovable, then call `confirmLogin()`. */
  LOGIN_NEEDED: "ENGINE_LOGIN_NEEDED",
  /** No payload — Lovable login confirmed. */
  LOGIN_OK: "ENGINE_LOGIN_OK",
  /** No payload — a `cancel()` request was acknowledged. */
  CANCEL_ACK: "ENGINE_CANCEL_ACK",
});

/**
 * @typedef {Object} LogPayload
 * @property {string} type  "ENGINE_LOG"
 * @property {number} ts    epoch ms
 * @property {string} msg   the log line (no timestamp prefix; UIs add their own)
 */

/**
 * @typedef {Object} PhasePayload
 * @property {string} type   "ENGINE_PHASE"
 * @property {number} ts
 * @property {"login"|"discover"|"connect"|"rename"} phase
 */

/**
 * @typedef {Object} ProjectPayload
 * @property {string} type   "ENGINE_PROJECT"
 * @property {number} ts
 * @property {string} id                    Lovable project UUID
 * @property {string} [name]                Lovable project name
 * @property {"connected"|"skipped"|"failed"|"dry-run"} [phase1]
 * @property {"renamed"|"failed"|"pending"} [phase2]
 * @property {string} [repoName]            GitHub repo slug, once known
 * @property {string} [renamedTo]           final slug after rename
 * @property {string} [error]               failure detail, if any
 */

/**
 * @typedef {Object} DiscoverPayload
 * @property {string} type   "ENGINE_DISCOVER"
 * @property {number} ts
 * @property {{id: string, name: string}[]} projects
 */

/**
 * @typedef {Object} DonePayload
 * @property {string} type   "ENGINE_DONE"
 * @property {number} ts
 * @property {{connected: number, skipped: number, failed: number, renamed: number}} summary
 */

/**
 * @typedef {Object} ErrorPayload
 * @property {string} type   "ENGINE_ERROR"
 * @property {number} ts
 * @property {string} message
 * @property {boolean} fatal  true if the run aborted; false for a soft warning
 */

/**
 * @typedef {Object} BrowserDownloadProgressPayload
 * @property {string} type   "ENGINE_BROWSER_DOWNLOAD_PROGRESS"
 * @property {number} ts
 * @property {number} percent  0–100 (best-effort parse of installer output)
 * @property {boolean} done    true on completion
 * @property {string} [line]   raw installer line, for verbose logging
 */

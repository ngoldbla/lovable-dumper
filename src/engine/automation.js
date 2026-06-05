// The automation engine: drives Lovable's web UI to connect projects to GitHub,
// then renames the resulting repos. This is the proven logic from the original
// connect.mjs, refactored into an event-emitting class so the same code powers
// both the CLI and the Electron app.
//
// Design notes:
//   • Extends EventEmitter; never writes to the console directly. Callers
//     subscribe to engine events (see events.js).
//   • All formerly-global config (org, dryRun, retryFailed) is injected.
//   • The blocking "Press Enter once logged in" prompt is replaced by an
//     async barrier: emit LOGIN_NEEDED, await a promise that `confirmLogin()`
//     resolves. The UI (CLI readline or a renderer button) decides how to ask.
//   • playwright-core is imported lazily, so paths that never launch a browser
//     (`--rename-only`, unit tests) don't load the driver at all.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { EngineEvents } from "./events.js";
import { loadState, saveState, loadProjects, saveProjects } from "./state.js";
import { renameRepos } from "./rename.js";

const LOVABLE_PROJECTS_URL = "https://lovable.dev/projects";
const PROJECT_LINK_SELECTOR = '[href^="/projects/"]';
const MAX_CONNECT_RETRIES = 2;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AutomationEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.basePath = opts.basePath ?? process.cwd();
    this.org = opts.org ?? null;
    this.githubToken = opts.githubToken ?? null;
    this.dryRun = !!opts.dryRun;
    this.retryFailed = !!opts.retryFailed;
    this.renameOnly = !!opts.renameOnly;
    this.headless = opts.headless ?? false;
    this.profilePath = opts.profilePath ?? join(this.basePath, "browser-data");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;

    this._cancelled = false;
    this._context = null;
    this._loginResolve = null;
    this._loginReject = null;
  }

  // --- event helpers --------------------------------------------------------

  _emit(type, payload = {}) {
    const evt = { type, ts: Date.now(), ...payload };
    this.emit(type, evt); // typed listeners
    this.emit("engine", evt); // unified stream (for IPC / blanket forwarding)
  }

  _log(msg) {
    this._emit(EngineEvents.LOG, { msg });
  }

  // --- control --------------------------------------------------------------

  /** Resolve the login barrier — call when the user has logged into Lovable. */
  confirmLogin() {
    const resolve = this._loginResolve;
    this._loginResolve = null;
    this._loginReject = null;
    if (resolve) resolve();
  }

  /** Request cancellation. Rejects a pending login barrier AND closes the
   *  context (which makes any in-flight Playwright call throw). Handling both
   *  paths means cancel() can never deadlock the run, even if it races the
   *  moment the login wait is being set up. */
  async cancel() {
    this._cancelled = true;
    this._emit(EngineEvents.CANCEL_ACK);
    const reject = this._loginReject;
    this._loginResolve = null;
    this._loginReject = null;
    if (reject) reject(this._cancelledError());
    await this._closeContext();
  }

  _cancelledError() {
    return Object.assign(new Error("Cancelled"), { cancelled: true });
  }

  _throwIfCancelled() {
    if (this._cancelled) throw this._cancelledError();
  }

  /** Cancel-aware login barrier: parks until confirmLogin() or cancel(). If
   *  cancellation already happened, it rejects immediately — so there is never a
   *  window where _cancelled is true but the resolver is unreachable. */
  _waitForLogin() {
    return new Promise((resolve, reject) => {
      if (this._cancelled) {
        reject(this._cancelledError());
        return;
      }
      this._loginResolve = resolve;
      this._loginReject = reject;
    });
  }

  // --- public operations ----------------------------------------------------

  /** Discover projects from the Lovable dashboard and persist projects.json. */
  async discover() {
    this._cancelled = false;
    const context = await this._launch();
    try {
      this._emit(EngineEvents.PHASE, { phase: "login" });
      const page = await this._login(context);
      this._throwIfCancelled();

      this._emit(EngineEvents.PHASE, { phase: "discover" });
      const projects = await this._discoverProjects(page);
      saveProjects(this.basePath, projects);
      this._emit(EngineEvents.DISCOVER, { projects });
      this._log(`Saved ${projects.length} projects.`);
      return projects;
    } catch (err) {
      return this._handleRunError(err, []);
    } finally {
      await this._closeContext();
    }
  }

  /**
   * Run the full pipeline: (connect each project) then (rename connected repos).
   * @param {{id: string, name: string}[]} [selected]  defaults to projects.json
   * @returns {Promise<object>} the final state
   */
  async run(selected) {
    this._cancelled = false;
    const state = loadState(this.basePath, this.org ?? "");
    if (this.org) state.githubOwner = this.org;
    const projects = selected ?? loadProjects(this.basePath);

    // Rename-only mode skips the browser entirely.
    if (this.renameOnly) {
      this._emit(EngineEvents.PHASE, { phase: "rename" });
      await this._renamePhase(state);
      this._finish(state);
      return state;
    }

    const context = await this._launch();
    try {
      this._emit(EngineEvents.PHASE, { phase: "login" });
      const page = await this._login(context);

      this._emit(EngineEvents.PHASE, { phase: "connect" });
      for (const project of projects) {
        this._throwIfCancelled();
        if (this._shouldSkip(project, state)) continue;

        const result = await this._connectProject(page, project);
        state.projects[project.id] = {
          ...state.projects[project.id],
          name: project.name,
          phase1: result.status,
          repoName: result.repoName || state.projects[project.id]?.repoName,
          phase2: state.projects[project.id]?.phase2 || "pending",
        };
        saveState(this.basePath, state);
        await this.sleep(3000); // brief pause between projects
      }

      this._emit(EngineEvents.PHASE, { phase: "rename" });
      await this._renamePhase(state);
      this._finish(state);
      return state;
    } catch (err) {
      return this._handleRunError(err, state);
    } finally {
      await this._closeContext();
    }
  }

  // --- internals ------------------------------------------------------------

  _shouldSkip(project, state) {
    const existing = state.projects[project.id];
    if (!existing) return false;
    if (existing.phase1 === "connected" || existing.phase1 === "skipped") {
      this._log(`[${project.name}] Already processed (${existing.phase1}), skipping.`);
      return true;
    }
    if (existing.phase1 === "failed" && !this.retryFailed) {
      this._log(`[${project.name}] Previously failed; use Retry to retry.`);
      return true;
    }
    return false;
  }

  async _renamePhase(state) {
    if (!this.dryRun && !this.githubToken) {
      this._emit(EngineEvents.ERROR, {
        message:
          "No GitHub token available — cannot rename repos. Set GITHUB_TOKEN " +
          "(CLI) or sign in to GitHub (app).",
        fatal: false,
      });
      return;
    }
    await renameRepos({
      state,
      token: this.githubToken,
      dryRun: this.dryRun,
      emit: (type, payload) => this._emit(type, payload),
      log: (msg) => this._log(msg),
      sleep: this.sleep,
      fetchImpl: this.fetchImpl,
      saveState: () => saveState(this.basePath, state),
    });
  }

  _finish(state) {
    saveState(this.basePath, state);
    const summary = { connected: 0, skipped: 0, failed: 0, renamed: 0 };
    for (const info of Object.values(state.projects)) {
      if (info.phase1 === "connected") summary.connected++;
      if (info.phase1 === "skipped") summary.skipped++;
      if (info.phase1 === "failed") summary.failed++;
      if (info.phase2 === "renamed") summary.renamed++;
    }
    this._log(
      `Done. Connected: ${summary.connected} | Skipped: ${summary.skipped} | ` +
        `Failed: ${summary.failed} | Renamed: ${summary.renamed}`
    );
    this._emit(EngineEvents.DONE, { summary });
  }

  _handleRunError(err, fallback) {
    if (err?.cancelled) {
      this._log("Cancelled.");
      return fallback;
    }
    this._emit(EngineEvents.ERROR, { message: err?.message ?? String(err), fatal: true });
    throw err;
  }

  async _launch() {
    const { chromium } = await import("playwright-core");
    this._log("Launching browser…");
    this._context = await chromium.launchPersistentContext(this.profilePath, {
      headless: this.headless,
      viewport: { width: 1280, height: 800 },
    });
    return this._context;
  }

  async _closeContext() {
    if (this._context) {
      try {
        await this._context.close();
      } catch {
        /* already closed (e.g. by cancel) */
      }
      this._context = null;
    }
  }

  // --- Phase 0: login -------------------------------------------------------

  async _login(context) {
    const page = await context.newPage();
    await page.goto(LOVABLE_PROJECTS_URL, { waitUntil: "domcontentloaded" });

    try {
      await page.waitForSelector(PROJECT_LINK_SELECTOR, { timeout: 5000 });
      this._log("Already logged in.");
    } catch {
      // If cancel() closed the context during the probe above, bail immediately
      // rather than parking on the login barrier.
      this._throwIfCancelled();
      this._log("Not logged in. Please log into Lovable in the browser window.");
      this._emit(EngineEvents.LOGIN_NEEDED);
      await this._waitForLogin(); // rejects (not hangs) if cancel() races this
      this._throwIfCancelled();
      await page.goto(LOVABLE_PROJECTS_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(PROJECT_LINK_SELECTOR, { timeout: 30000 });
      this._log("Login verified.");
      this._emit(EngineEvents.LOGIN_OK);
    }
    return page;
  }

  // --- discover: scrape project IDs from the dashboard ----------------------

  async _discoverProjects(page) {
    this._log("Discovering projects from the Lovable dashboard…");
    await page.goto(LOVABLE_PROJECTS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(PROJECT_LINK_SELECTOR, { timeout: 15000 });

    // Scroll to lazy-load the full list.
    for (let i = 0; i < 10; i++) {
      this._throwIfCancelled();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.sleep(1000);
    }

    const links = await page.$$eval(PROJECT_LINK_SELECTOR, (els) =>
      els
        .map((el) => {
          const href = el.getAttribute("href");
          const match = href.match(/\/projects\/([0-9a-f-]{36})/);
          if (!match) return null;
          const name = el.textContent?.trim() || "";
          return { id: match[1], name };
        })
        .filter(Boolean)
    );

    // Deduplicate by id, preserving first-seen order.
    const seen = new Set();
    const unique = [];
    for (const p of links) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        unique.push(p);
      }
    }

    this._log(`Discovered ${unique.length} projects.`);
    return unique;
  }

  // --- Phase 1: connect a single project ------------------------------------

  async _connectProject(page, project, attempt = 1) {
    const { id, name } = project;
    this._log(`[${name}] Navigating to settings (attempt ${attempt})…`);
    this._emit(EngineEvents.PROJECT, { id, name, phase1: "pending" });

    if (this.dryRun) {
      this._log(`[${name}] DRY RUN: would connect project ${id}`);
      this._emit(EngineEvents.PROJECT, { id, name, phase1: "dry-run", repoName: name });
      return { status: "dry-run", repoName: name };
    }

    const url = `https://lovable.dev/projects/${id}/settings?tab=github`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await this.sleep(2000);

    // Already connected?
    const viewLink = await page.$('a:has-text("View on GitHub")');
    if (viewLink) {
      const href = await viewLink.getAttribute("href");
      const repoName = href?.split("/").pop() || name;
      this._log(`[${name}] Already connected → ${repoName}`);
      this._emit(EngineEvents.PROJECT, { id, name, phase1: "skipped", repoName });
      return { status: "skipped", repoName };
    }

    try {
      const connectBtn = await page.waitForSelector(
        'role=button[name="Connect project"]',
        { timeout: 10000 }
      );
      await connectBtn.click();
      this._log(`[${name}] Clicked "Connect project"`);
      await this.sleep(2000);

      const orgItem = await page.waitForSelector(`role=menuitem[name="${this.org}"]`, {
        timeout: 10000,
      });
      await orgItem.click();
      this._log(`[${name}] Selected org "${this.org}"`);
      await this.sleep(2000);

      // "Transfer anyway" only appears sometimes.
      try {
        const transferBtn = await page.waitForSelector(
          'role=button[name="Transfer anyway"]',
          { timeout: 5000 }
        );
        await transferBtn.click();
        this._log(`[${name}] Clicked "Transfer anyway"`);
      } catch {
        /* dialog not shown */
      }

      const ghLink = await page.waitForSelector('a:has-text("View on GitHub")', {
        timeout: 90000,
      });
      const href = await ghLink.getAttribute("href");
      const repoName = href?.split("/").pop() || name;
      this._log(`[${name}] Connected → ${repoName}`);
      this._emit(EngineEvents.PROJECT, { id, name, phase1: "connected", repoName });
      return { status: "connected", repoName };
    } catch (err) {
      if (this._cancelled) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      this._log(`[${name}] Failed: ${err.message}`);
      if (attempt < MAX_CONNECT_RETRIES) {
        this._log(`[${name}] Retrying…`);
        await this.sleep(3000);
        return this._connectProject(page, project, attempt + 1);
      }
      this._emit(EngineEvents.PROJECT, { id, name, phase1: "failed", error: err.message });
      return { status: "failed", repoName: null };
    }
  }
}

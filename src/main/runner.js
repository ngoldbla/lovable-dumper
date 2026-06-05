// Owns the AutomationEngine lifecycle for the Electron app and forwards every
// engine event to the renderer. Enforces a single active operation at a time —
// discover and run both drive the shared Lovable browser profile, which is
// locked, so concurrent operations would collide.

import { AutomationEngine } from "../engine/automation.js";

export class Runner {
  /** @param {{send: (channel: string, payload: any) => void}} deps */
  constructor({ send }) {
    this.send = send;
    this.engine = null;
    this.busy = false;
  }

  _start(engine) {
    this.engine = engine;
    // One unified stream → one IPC channel. Payloads are already JSON-safe.
    engine.on("engine", (evt) => this.send("engine-event", evt));
    this.busy = true;
  }

  _finish() {
    this.busy = false;
    this.engine = null;
  }

  async discover({ basePath, org, githubToken }) {
    if (this.busy) throw new Error("Another operation is already running.");
    this._start(new AutomationEngine({ basePath, org, githubToken }));
    try {
      return await this.engine.discover();
    } finally {
      this._finish();
    }
  }

  async run({ basePath, org, githubToken, dryRun, retryFailed, renameOnly, selected }) {
    if (this.busy) throw new Error("Another operation is already running.");
    this._start(
      new AutomationEngine({
        basePath,
        org,
        githubToken,
        dryRun,
        retryFailed,
        renameOnly,
      })
    );
    try {
      return await this.engine.run(selected);
    } finally {
      this._finish();
    }
  }

  confirmLogin() {
    this.engine?.confirmLogin();
  }

  async cancel() {
    await this.engine?.cancel();
  }
}

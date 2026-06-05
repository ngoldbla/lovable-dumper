import { test } from "node:test";
import assert from "node:assert/strict";

// AutomationEngine imports playwright-core lazily (only inside _launch), so it is
// safe to import and exercise the cancellation/login-barrier logic without a
// browser. These tests pin the fix for the cancel-during-login deadlock.
import { AutomationEngine } from "../src/engine/automation.js";

test("login barrier: confirmLogin() resolves a pending wait", async () => {
  const e = new AutomationEngine({ basePath: "/tmp" });
  const p = e._waitForLogin();
  e.confirmLogin();
  await p; // resolves without throwing
});

test("login barrier: cancel() rejects a pending wait (no deadlock)", async () => {
  const e = new AutomationEngine({ basePath: "/tmp" });
  const p = e._waitForLogin();
  // Attach the rejection assertion before cancelling so there is no window for
  // an unhandled rejection.
  const settled = assert.rejects(() => p, (err) => err.cancelled === true);
  await e.cancel();
  await settled;
});

test("login barrier: waiting after cancel rejects immediately", async () => {
  const e = new AutomationEngine({ basePath: "/tmp" });
  e._cancelled = true;
  await assert.rejects(() => e._waitForLogin(), (err) => err.cancelled === true);
});

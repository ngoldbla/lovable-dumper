import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// Regression guard: playwright-core's package.json `exports` does not list
// "./cli.js", so resolving it naively throws ERR_PACKAGE_PATH_NOT_EXPORTED at
// runtime (only surfaces when ensureBrowser actually runs). playwrightCliPath()
// must resolve to a real, existing file via the exported package.json.
import { playwrightCliPath } from "../src/engine/browser-install.js";

test("playwrightCliPath resolves to an existing cli.js", () => {
  const p = playwrightCliPath();
  assert.match(p, /cli\.js$/);
  assert.ok(existsSync(p), `expected playwright-core CLI to exist at ${p}`);
});

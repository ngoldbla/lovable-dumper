import { test } from "node:test";
import assert from "node:assert/strict";

import { targetName, renameRepo, renameRepos } from "../src/engine/rename.js";

function mockResponse({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json };
}

test("targetName adds the lv- prefix exactly once", () => {
  assert.equal(targetName("myapp"), "lv-myapp");
  assert.equal(targetName("lv-myapp"), "lv-myapp");
});

test("renameRepo issues PATCH with the correct url, method, headers, and body", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return mockResponse({ ok: true, status: 200 });
  };

  const res = await renameRepo("octo", "myapp", "lv-myapp", "tok123", fetchImpl);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/octo/myapp");
  assert.equal(calls[0].opts.method, "PATCH");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer tok123");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { name: "lv-myapp" });
});

test("renameRepo surfaces a 403 with an actionable message", async () => {
  const fetchImpl = async () => mockResponse({ ok: false, status: 403 });
  const res = await renameRepo("octo", "myapp", "lv-myapp", "tok", fetchImpl);
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.match(res.error, /403/);
  assert.match(res.error, /admin/i);
});

test("renameRepos renames pending, skips done/prefixed, and emits per repo", async () => {
  const state = {
    githubOwner: "octo",
    projects: {
      a: { name: "A", repoName: "appa", phase2: "pending" }, // -> renamed
      b: { name: "B", repoName: "lv-appb", phase2: "pending" }, // already prefixed -> skip
      c: { name: "C", repoName: "appc", phase2: "renamed" }, // already done -> skip
      d: { name: "D", phase2: "pending" }, // no repoName -> ignored
    },
  };
  const events = [];
  const fetchImpl = async () => mockResponse({ ok: true, status: 200 });

  const summary = await renameRepos({
    state,
    token: "t",
    emit: (type, payload) => events.push({ type, ...payload }),
    sleep: async () => {},
    fetchImpl,
  });

  assert.equal(summary.renamed, 1);
  assert.equal(summary.skipped, 2);
  assert.equal(state.projects.a.renamedTo, "lv-appa");
  assert.equal(state.projects.a.phase2, "renamed");
  assert.equal(state.projects.b.phase2, "renamed");
  assert.ok(events.some((e) => e.id === "a" && e.phase2 === "renamed"));
});

test("renameRepos in dry-run makes no network calls", async () => {
  const state = {
    githubOwner: "octo",
    projects: { a: { name: "A", repoName: "appa", phase2: "pending" } },
  };
  let called = 0;
  const fetchImpl = async () => {
    called++;
    return mockResponse();
  };

  const summary = await renameRepos({
    state,
    token: "t",
    dryRun: true,
    sleep: async () => {},
    fetchImpl,
  });

  assert.equal(called, 0);
  assert.equal(summary.renamed, 0);
});

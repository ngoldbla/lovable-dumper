import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveUsername,
  startDeviceFlow,
  pollForToken,
} from "../src/engine/github-auth.js";

function mockResponse({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json };
}

test("resolveUsername returns the login on success", async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://api.github.com/user");
    assert.equal(opts.headers.Authorization, "Bearer tok");
    return mockResponse({ json: { login: "octocat" } });
  };
  assert.equal(await resolveUsername("tok", fetchImpl), "octocat");
});

test("resolveUsername throws on a non-ok response", async () => {
  const fetchImpl = async () => mockResponse({ ok: false, status: 401 });
  await assert.rejects(() => resolveUsername("bad", fetchImpl), /401/);
});

test("startDeviceFlow requires a client id", async () => {
  await assert.rejects(
    () => startDeviceFlow("", "repo", async () => mockResponse()),
    /client_id/
  );
});

test("startDeviceFlow posts client_id + scope and returns the parsed body", async () => {
  const body = {
    device_code: "dc",
    user_code: "WXYZ-1234",
    verification_uri: "https://github.com/login/device",
    interval: 5,
    expires_in: 900,
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://github.com/login/device/code");
    assert.deepEqual(JSON.parse(opts.body), { client_id: "cid", scope: "repo" });
    return mockResponse({ json: body });
  };
  assert.deepEqual(await startDeviceFlow("cid", "repo", fetchImpl), body);
});

test("pollForToken: authorization_pending -> slow_down -> success, with backoff", async () => {
  const responses = [
    { error: "authorization_pending" },
    { error: "slow_down", interval: 10 },
    { access_token: "gho_abc" },
  ];
  let i = 0;
  const waits = [];
  const fetchImpl = async () => mockResponse({ json: responses[i++] });
  const sleep = async (ms) => {
    waits.push(ms);
  };

  const token = await pollForToken(
    { clientId: "cid", deviceCode: "dc", interval: 5, expiresIn: 900 },
    { fetchImpl, sleep, now: () => 0 }
  );

  assert.equal(token, "gho_abc");
  // 5s, 5s, then slow_down adopts GitHub's supplied interval (10s) directly —
  // GitHub already added its +5s, so we must not add another.
  assert.deepEqual(waits, [5000, 5000, 10000]);
});

test("pollForToken throws on expired_token", async () => {
  const fetchImpl = async () => mockResponse({ json: { error: "expired_token" } });
  await assert.rejects(
    () =>
      pollForToken(
        { clientId: "c", deviceCode: "d", interval: 1, expiresIn: 900 },
        { fetchImpl, sleep: async () => {}, now: () => 0 }
      ),
    /expired/i
  );
});

test("pollForToken honors an aborted signal", async () => {
  const fetchImpl = async () =>
    mockResponse({ json: { error: "authorization_pending" } });
  await assert.rejects(
    () =>
      pollForToken(
        { clientId: "c", deviceCode: "d", interval: 1, expiresIn: 900 },
        { fetchImpl, sleep: async () => {}, signal: { aborted: true }, now: () => 0 }
      ),
    /cancel/i
  );
});

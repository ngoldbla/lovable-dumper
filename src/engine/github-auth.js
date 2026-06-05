// GitHub authentication — replaces the `gh` CLI entirely.
//
// Three concerns live here:
//   1. resolveUsername / validatePAT — turn a token into the owner login.
//   2. OAuth Device Flow — startDeviceFlow + pollForToken (no client secret;
//      device flow is secretless by design, so the client_id is safe to ship).
//   3. Token storage — encrypted (Electron safeStorage) or a 0600 plaintext file
//      (CLI), with a transparent fallback.
//
// Network and timing are injectable (fetchImpl / sleep) so the polling state
// machine is unit-testable without real HTTP or real waits.

import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

const GH = "https://github.com";
const GH_API = "https://api.github.com";
const DEVICE_CODE_URL = `${GH}/login/device/code`;
const ACCESS_TOKEN_URL = `${GH}/login/oauth/access_token`;
const USER_AGENT = "lovable-dumper";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENC_FILE = "github-token.enc";
const PLAIN_FILE = "github-token";

/**
 * Resolve the authenticated user's login from a token (GET /user).
 * Doubles as token validation — throws on a bad/unauthorized token.
 * @returns {Promise<string>} the GitHub login
 */
export async function resolveUsername(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${GH_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub authentication failed (HTTP ${res.status}). The token must be ` +
        `valid and have 'repo' scope.`
    );
  }
  const body = await res.json();
  return body.login;
}

/** Validate a Personal Access Token; resolves to the login or throws. */
export const validatePAT = resolveUsername;

/**
 * Begin the OAuth Device Flow.
 * @returns {Promise<{device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number}>}
 */
export async function startDeviceFlow(clientId, scope = "repo", fetchImpl = fetch) {
  if (!clientId) {
    throw new Error("Device flow unavailable: no OAuth client_id is configured.");
  }
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) {
    throw new Error(`Failed to start device flow (HTTP ${res.status}).`);
  }
  return res.json();
}

/**
 * Poll the token endpoint until the user authorizes (or it times out).
 * Implements the documented device-flow state machine: it waits `interval`
 * seconds between polls, backs off an extra 5s on `slow_down`, and surfaces
 * `expired_token` / `access_denied` as errors.
 *
 * @param {{clientId: string, deviceCode: string, interval?: number, expiresIn?: number}} flow
 * @param {{fetchImpl?: Function, sleep?: Function, signal?: {aborted: boolean}, now?: Function}} [deps]
 * @returns {Promise<string>} the access token
 */
export async function pollForToken(
  { clientId, deviceCode, interval = 5, expiresIn = 900 },
  { fetchImpl = fetch, sleep = defaultSleep, signal, now = () => Date.now() } = {}
) {
  const deadline = now() + expiresIn * 1000;
  let wait = interval;

  while (now() < deadline) {
    if (signal?.aborted) throw new Error("Device authorization cancelled.");
    await sleep(wait * 1000);

    const res = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      }),
    });
    const body = await res.json();

    if (body.access_token) return body.access_token;

    switch (body.error) {
      case "authorization_pending":
        break; // keep waiting at the current interval
      case "slow_down":
        // Per the device-flow spec, GitHub's returned `interval` already includes
        // its +5s bump — adopt it directly; only add 5s ourselves if it omits one.
        wait = body.interval ?? wait + 5;
        break;
      case "expired_token":
        throw new Error("The device code expired. Please start over.");
      case "access_denied":
        throw new Error("Authorization was denied.");
      default:
        throw new Error(
          body.error_description || body.error || "Device flow failed."
        );
    }
  }
  throw new Error("Device authorization timed out.");
}

// --- Token storage ----------------------------------------------------------

/**
 * Load a stored token. Prefers the encrypted file when a `decrypt` fn is given
 * (Electron safeStorage); otherwise falls back to the 0600 plaintext file.
 * @param {string} basePath
 * @param {(buf: Buffer) => string} [decrypt]
 * @returns {string|null}
 */
export function loadToken(basePath, decrypt = null) {
  const encPath = join(basePath, ENC_FILE);
  if (decrypt && existsSync(encPath)) {
    try {
      return decrypt(readFileSync(encPath));
    } catch {
      /* corrupt/undecryptable — fall through to plaintext */
    }
  }
  const plainPath = join(basePath, PLAIN_FILE);
  if (existsSync(plainPath)) {
    return readFileSync(plainPath, "utf-8").trim();
  }
  return null;
}

/**
 * Persist a token. With `encrypt` (Electron safeStorage) it writes the
 * encrypted file; otherwise a 0600 plaintext file.
 * @param {string} basePath
 * @param {string} token
 * @param {(plain: string) => Buffer} [encrypt]
 * @returns {{encrypted: boolean}}
 */
export function saveToken(basePath, token, encrypt = null) {
  if (encrypt) {
    // Owner-only, same as the plaintext path. On Linux without an OS keyring
    // safeStorage falls back to a predictable key, so the file perms are the
    // real protection there.
    const p = join(basePath, ENC_FILE);
    writeFileSync(p, encrypt(token), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* best effort (e.g. Windows) */
    }
    return { encrypted: true };
  }
  const p = join(basePath, PLAIN_FILE);
  writeFileSync(p, token, { mode: 0o600 });
  // writeFileSync's mode is masked by umask; force 0600 explicitly.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return { encrypted: false };
}

/** Remove any stored token (both encrypted and plaintext forms). */
export function clearToken(basePath) {
  for (const f of [ENC_FILE, PLAIN_FILE]) {
    const p = join(basePath, f);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

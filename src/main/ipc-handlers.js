// All ipcMain channels for the app. Each `ld:*` channel maps to an engine call.
// The renderer is sandboxed and never touches the network, the filesystem, or
// the token directly — it only invokes these handlers.

import { ipcMain, safeStorage } from "electron";
import { EngineEvents } from "../engine/events.js";
import {
  loadState,
  saveState,
  loadProjects,
  saveProjects,
} from "../engine/state.js";
import {
  resolveUsername,
  startDeviceFlow,
  pollForToken,
  loadToken,
  saveToken,
  clearToken,
} from "../engine/github-auth.js";
import { ensureBrowser } from "../engine/browser-install.js";
import { Runner } from "./runner.js";

// The OAuth App client_id is public by design for device flow (no secret). It is
// empty until the maintainer registers the OAuth App; while empty, the UI offers
// PAT-only and device-flow handlers refuse cleanly. Override via env for testing.
const GITHUB_CLIENT_ID = process.env.LD_GITHUB_CLIENT_ID || "";

export function registerIpcHandlers({ getWindow, userDataPath }) {
  const basePath = userDataPath;
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const runner = new Runner({ send });
  const cipher = makeCipher();
  let pollAbort = null;

  const getToken = () => loadToken(basePath, cipher?.decrypt);
  const emitEngine = (evt) => send("engine-event", evt);

  // --- auth -----------------------------------------------------------------

  ipcMain.handle("ld:getAuthStatus", async () => {
    const token = getToken();
    const deviceFlowAvailable = !!GITHUB_CLIENT_ID;
    if (!token) return { authenticated: false, deviceFlowAvailable };
    try {
      const login = await resolveUsername(token);
      return { authenticated: true, login, deviceFlowAvailable };
    } catch {
      return {
        authenticated: false,
        deviceFlowAvailable,
        error: "The stored GitHub token is no longer valid.",
      };
    }
  });

  ipcMain.handle("ld:submitPAT", async (_e, token) => {
    const login = await resolveUsername(token); // throws on an invalid token
    saveToken(basePath, token, cipher?.encrypt);
    send("auth-update", { authenticated: true, login });
    return { login };
  });

  ipcMain.handle("ld:startDeviceFlow", async () => {
    if (!GITHUB_CLIENT_ID) {
      throw new Error(
        "Device login is not configured for this build — use a Personal Access Token."
      );
    }
    // Abort any poll already in flight so a superseded flow can't later emit a
    // stale auth-update. `myAbort` is captured per-flow; logoutGitHub aborts
    // whatever pollAbort currently points at.
    if (pollAbort) pollAbort.aborted = true;
    const flow = await startDeviceFlow(GITHUB_CLIENT_ID);
    const myAbort = { aborted: false };
    pollAbort = myAbort;

    // Poll in the background; the renderer learns the outcome via auth-update.
    pollForToken(
      {
        clientId: GITHUB_CLIENT_ID,
        deviceCode: flow.device_code,
        interval: flow.interval,
        expiresIn: flow.expires_in,
      },
      { signal: myAbort }
    )
      .then(async (token) => {
        if (myAbort.aborted) return; // superseded or logged out
        saveToken(basePath, token, cipher?.encrypt);
        const login = await resolveUsername(token);
        send("auth-update", { authenticated: true, login });
      })
      .catch((err) => {
        if (myAbort.aborted) return;
        send("auth-update", { authenticated: false, error: err.message });
      });

    return {
      user_code: flow.user_code,
      verification_uri: flow.verification_uri,
      expires_in: flow.expires_in,
    };
  });

  ipcMain.handle("ld:logoutGitHub", async () => {
    if (pollAbort) pollAbort.aborted = true;
    clearToken(basePath);
    send("auth-update", { authenticated: false });
    return { ok: true };
  });

  // --- state / projects -----------------------------------------------------

  ipcMain.handle("ld:getState", async () => loadState(basePath));
  ipcMain.handle("ld:getProjects", async () => loadProjects(basePath));
  ipcMain.handle("ld:saveProjects", async (_e, projects) => {
    saveProjects(basePath, projects);
    return { ok: true };
  });
  ipcMain.handle("ld:setOrg", async (_e, org) => {
    const state = loadState(basePath);
    state.githubOwner = org;
    saveState(basePath, state);
    return { ok: true };
  });

  // --- browser provisioning -------------------------------------------------

  ipcMain.handle("ld:ensureBrowser", async () => {
    await ensureBrowser({
      emit: (type, payload) =>
        emitEngine({ type, ts: Date.now(), ...payload }),
      log: (msg) => emitEngine({ type: EngineEvents.LOG, ts: Date.now(), msg }),
    });
    return { ok: true };
  });

  // --- engine operations ----------------------------------------------------

  ipcMain.handle("ld:confirmLogin", async () => {
    runner.confirmLogin();
    return { ok: true };
  });

  ipcMain.handle("ld:cancel", async () => {
    await runner.cancel();
    return { ok: true };
  });

  ipcMain.handle("ld:discover", async (_e, opts = {}) => {
    const token = getToken();
    const org = await resolveOrg(opts.org, token);
    const projects = await runner.discover({ basePath, org, githubToken: token });
    return { projects };
  });

  ipcMain.handle("ld:run", async (_e, opts = {}) => {
    const token = getToken();
    const org = await resolveOrg(opts.org, token);
    await runner.run({
      basePath,
      org,
      githubToken: token,
      dryRun: !!opts.dryRun,
      retryFailed: !!opts.retryFailed,
      renameOnly: !!opts.renameOnly,
      selected: opts.selected,
    });
    return { ok: true };
  });
}

/** Explicit org wins; otherwise derive it from the token. */
async function resolveOrg(explicitOrg, token) {
  if (explicitOrg) return explicitOrg;
  if (token) {
    try {
      return await resolveUsername(token);
    } catch {
      /* leave null — the engine surfaces the missing-org/token condition */
    }
  }
  return null;
}

/** safeStorage-backed token cipher, or null to fall back to a 0600 plaintext file. */
function makeCipher() {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (buf) => safeStorage.decryptString(buf),
      };
    }
  } catch {
    /* not available — fall through */
  }
  return null;
}

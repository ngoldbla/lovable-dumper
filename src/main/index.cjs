"use strict";
//
// Electron main entry. CommonJS for deterministic require ordering: the VERY
// FIRST thing we do is point playwright-core at a writable browser location,
// before any module that reads PLAYWRIGHT_BROWSERS_PATH is loaded. The engine
// (ESM) is pulled in later via dynamic import().

const { app, BrowserWindow, session, shell } = require("electron");
const path = require("node:path");

// MUST run before anything imports playwright-core. The packaged app bundle is
// read-only, so the browser is downloaded into userData instead.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
  app.getPath("userData"),
  "pw-browsers"
);

// A second instance would fight over the shared Lovable browser-profile lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      title: "Lovable Dumper",
      backgroundColor: "#0f1117",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // External links (e.g. the device-flow verification URL) open in the user's
    // real browser, never inside the app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    return mainWindow;
  }

  app.whenReady().then(async () => {
    // Belt-and-suspenders CSP (the renderer HTML also carries a <meta> CSP, which
    // is the reliable one for file:// documents).
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": ["default-src 'self'"],
        },
      });
    });

    createWindow();

    // Wire IPC. ipc-handlers.js is ESM (it imports the ESM engine), hence the
    // dynamic import from this CommonJS module.
    const { registerIpcHandlers } = await import("./ipc-handlers.js");
    registerIpcHandlers({
      getWindow: () => mainWindow,
      userDataPath: app.getPath("userData"),
    });

    // Auto-update: best-effort, never blocks startup. No-op in dev and on
    // unsigned macOS (updates there are manual until code signing lands).
    try {
      const updaterMod = await import("electron-updater");
      const autoUpdater = updaterMod.autoUpdater || updaterMod.default?.autoUpdater;
      if (autoUpdater) {
        autoUpdater.autoDownload = true;
        autoUpdater.on("update-downloaded", () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("app-state", { updateReady: true });
          }
        });
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }
    } catch {
      /* updater unavailable in dev — ignore */
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

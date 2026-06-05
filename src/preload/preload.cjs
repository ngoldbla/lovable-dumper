// contextBridge API surface — the ONLY thing the sandboxed renderer can touch.
// Must be CommonJS: sandboxed preloads cannot use ESM import.
//
// invoke()-style methods return promises; on*()-style methods register a push
// listener and return an unsubscribe function. No Node, fs, or network is ever
// exposed to the renderer.

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("lovableDumper", {
  // auth
  getAuthStatus: () => ipcRenderer.invoke("ld:getAuthStatus"),
  submitPAT: (token) => ipcRenderer.invoke("ld:submitPAT", token),
  startDeviceFlow: () => ipcRenderer.invoke("ld:startDeviceFlow"),
  logoutGitHub: () => ipcRenderer.invoke("ld:logoutGitHub"),

  // state / projects
  getState: () => ipcRenderer.invoke("ld:getState"),
  getProjects: () => ipcRenderer.invoke("ld:getProjects"),
  saveProjects: (projects) => ipcRenderer.invoke("ld:saveProjects", projects),
  setOrg: (org) => ipcRenderer.invoke("ld:setOrg", org),

  // browser + engine
  ensureBrowser: () => ipcRenderer.invoke("ld:ensureBrowser"),
  discover: (opts) => ipcRenderer.invoke("ld:discover", opts),
  run: (opts) => ipcRenderer.invoke("ld:run", opts),
  cancel: () => ipcRenderer.invoke("ld:cancel"),
  confirmLogin: () => ipcRenderer.invoke("ld:confirmLogin"),

  // push subscriptions (return an unsubscribe fn)
  onEngineEvent: subscribe("engine-event"),
  onAuthUpdate: subscribe("auth-update"),
  onAppState: subscribe("app-state"),
});

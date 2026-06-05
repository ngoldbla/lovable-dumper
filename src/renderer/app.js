/* Renderer controller. Drives the boot → auth → select → run → summary flow,
 * talking to the main process only through the preload bridge (window.lovableDumper).
 *
 * Engine event-type strings mirror src/engine/events.js. They are duplicated
 * here (rather than imported) because the sandboxed renderer loads over file://
 * with a strict CSP; keep these in sync with events.js. */
(function () {
  "use strict";

  const API = window.lovableDumper;

  const EV = {
    LOG: "ENGINE_LOG",
    PHASE: "ENGINE_PHASE",
    PROJECT: "ENGINE_PROJECT",
    DISCOVER: "ENGINE_DISCOVER",
    DONE: "ENGINE_DONE",
    ERROR: "ENGINE_ERROR",
    BROWSER_DOWNLOAD_PROGRESS: "ENGINE_BROWSER_DOWNLOAD_PROGRESS",
    LOGIN_NEEDED: "ENGINE_LOGIN_NEEDED",
    LOGIN_OK: "ENGINE_LOGIN_OK",
    CANCEL_ACK: "ENGINE_CANCEL_ACK",
  };

  const SCREENS = ["boot", "auth", "select", "run", "summary"];
  const $ = (id) => document.getElementById(id);

  // ── shared state ─────────────────────────────────────────────────────────
  const state = {
    auth: { authenticated: false, login: null, deviceFlowAvailable: false },
    projects: [], // [{id, name}]
    selected: new Set(), // project ids
    rows: new Map(), // id -> {name, phase1, phase2, repoName, renamedTo}
    running: false,
    doneFired: false,
  };

  // ── navigation ───────────────────────────────────────────────────────────
  function show(screen) {
    SCREENS.forEach((s) => {
      const el = document.querySelector(`[data-screen="${s}"]`);
      if (el) el.classList.toggle("is-active", s === screen);
    });
    const activeIdx = SCREENS.indexOf(screen);
    document.querySelectorAll(".step").forEach((btn) => {
      const idx = SCREENS.indexOf(btn.dataset.go);
      btn.classList.toggle("is-active", idx === activeIdx);
      btn.classList.toggle("is-done", idx > -1 && idx < activeIdx);
      btn.disabled = idx > activeIdx; // can revisit prior steps, not skip ahead
    });
  }

  function openExternal(url) {
    // Intercepted by the main process's window-open handler → opens in the OS browser.
    window.open(url, "_blank");
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  $("bootStart").addEventListener("click", async () => {
    $("bootStart").disabled = true;
    $("bootProgress").hidden = false;
    try {
      await API.ensureBrowser();
    } catch (err) {
      $("bootProgressLabel").textContent = "Browser setup failed: " + err.message;
      $("bootStart").disabled = false;
      return;
    }
    show("auth");
    renderAuth();
  });

  function onBrowserProgress(p) {
    const pct = Math.max(0, Math.min(100, Math.round(p.percent ?? 0)));
    $("bootProgressFill").style.width = pct + "%";
    $("bootProgressPct").textContent = pct + "%";
    if (p.done) $("bootProgressLabel").textContent = "Browser engine ready.";
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  function renderAuth() {
    const a = state.auth;
    $("signedIn").hidden = !a.authenticated;
    $("authBox").hidden = a.authenticated;
    if (a.authenticated) {
      $("signedInLogin").textContent = "@" + a.login;
    }
    // Device-flow availability gates the device tab.
    $("deviceTabBtn").disabled = !a.deviceFlowAvailable;
    $("deviceUnavailable").hidden = a.deviceFlowAvailable;
    updateAuthChip();
  }

  function updateAuthChip() {
    const chip = $("authChip");
    chip.hidden = false;
    chip.querySelector(".dot").classList.toggle("ok", state.auth.authenticated);
    $("authChipText").textContent = state.auth.authenticated
      ? "@" + state.auth.login
      : "not connected";
  }

  // tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.disabled) return;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add("is-active");
    });
  });

  $("patLink").addEventListener("click", () =>
    openExternal("https://github.com/settings/tokens/new")
  );

  $("patSubmit").addEventListener("click", async () => {
    const token = $("patInput").value.trim();
    $("patErr").hidden = true;
    if (!token) {
      showPatErr("Paste a token first.");
      return;
    }
    $("patSubmit").disabled = true;
    $("patSubmit").textContent = "Checking…";
    try {
      const { login } = await API.submitPAT(token);
      state.auth = { ...state.auth, authenticated: true, login };
      $("patInput").value = "";
      renderAuth();
    } catch (err) {
      showPatErr(err.message || "That token was rejected.");
    } finally {
      $("patSubmit").disabled = false;
      $("patSubmit").textContent = "Save token";
    }
  });

  function showPatErr(msg) {
    const el = $("patErr");
    el.textContent = msg;
    el.hidden = false;
  }

  $("deviceStart").addEventListener("click", async () => {
    $("deviceStart").disabled = true;
    try {
      const flow = await API.startDeviceFlow();
      $("deviceIdle").hidden = true;
      $("deviceActive").hidden = false;
      $("userCode").textContent = flow.user_code;
      $("deviceOpen").onclick = () => openExternal(flow.verification_uri);
    } catch (err) {
      $("deviceStart").disabled = false;
      showPatErr(err.message);
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    await API.logoutGitHub();
    state.auth = { ...state.auth, authenticated: false, login: null };
    renderAuth();
  });

  $("authContinue").addEventListener("click", () => {
    if (!$("orgInput").value) $("orgInput").value = state.auth.login || "";
    show("select");
    refreshProjects();
  });

  function onAuthUpdate(payload) {
    if (payload.authenticated) {
      state.auth = { ...state.auth, authenticated: true, login: payload.login };
      // reset device pane to idle for next time
      $("deviceActive").hidden = true;
      $("deviceIdle").hidden = false;
      $("deviceStart").disabled = false;
    } else if (payload.error) {
      $("deviceStatus").className = "status err";
      $("deviceStatus").textContent = payload.error;
    } else {
      state.auth = { ...state.auth, authenticated: false, login: null };
    }
    renderAuth();
  }

  // ── select / discover ──────────────────────────────────────────────────────
  async function refreshProjects() {
    const projects = await API.getProjects();
    if (projects && projects.length) {
      state.projects = projects;
      renderProjectList();
    }
  }

  $("discoverBtn").addEventListener("click", async () => {
    $("discoverBtn").disabled = true;
    $("discoverBtn").textContent = "Opening Lovable…";
    try {
      const { projects } = await API.discover({ org: $("orgInput").value.trim() });
      state.projects = projects || [];
      renderProjectList();
    } catch (err) {
      // Hide any stale list so only the error shows.
      $("projects").hidden = true;
      $("filterInput").hidden = true;
      $("projectsEmpty").hidden = false;
      $("projectsEmpty").textContent = "Discovery failed: " + err.message;
    } finally {
      $("loginBanner").hidden = true;
      $("discoverBtn").disabled = false;
      $("discoverBtn").textContent = "Re-discover";
    }
  });

  $("confirmLoginBtn").addEventListener("click", () => {
    API.confirmLogin();
    $("loginBanner").hidden = true;
  });

  function renderProjectList() {
    const list = $("projectList");
    list.innerHTML = "";
    const filter = $("filterInput").value.trim().toLowerCase();
    const visible = state.projects.filter(
      (p) => !filter || p.name.toLowerCase().includes(filter) || p.id.includes(filter)
    );

    if (state.projects.length === 0) {
      $("projects").hidden = true;
      $("projectsEmpty").hidden = false;
      $("filterInput").hidden = true;
      return;
    }
    $("projects").hidden = false;
    $("projectsEmpty").hidden = true;
    $("filterInput").hidden = false;

    for (const p of visible) {
      const li = document.createElement("li");
      li.className = "project-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.selected.has(p.id);
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(p.id);
        else state.selected.delete(p.id);
        updateSelectionUI();
      });
      const name = document.createElement("span");
      name.className = "p-name";
      name.textContent = p.name || "(unnamed project)";
      const id = document.createElement("span");
      id.className = "p-id";
      id.textContent = p.id.slice(0, 8);
      li.append(cb, name, id);
      li.addEventListener("click", (e) => {
        if (e.target !== cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change"));
        }
      });
      list.appendChild(li);
    }
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const n = state.selected.size;
    $("selCount").textContent = n + " selected";
    $("runCount").textContent = n;
    $("runBtn").disabled = n === 0 && !$("optRenameOnly").checked;
    const total = state.projects.length;
    $("selectAll").checked = n > 0 && n === total;
    $("selectAll").indeterminate = n > 0 && n < total;
  }

  $("selectAll").addEventListener("change", () => {
    if ($("selectAll").checked) state.projects.forEach((p) => state.selected.add(p.id));
    else state.selected.clear();
    renderProjectList();
  });

  $("filterInput").addEventListener("input", renderProjectList);
  $("optRenameOnly").addEventListener("change", updateSelectionUI);

  // ── run ────────────────────────────────────────────────────────────────────
  $("runBtn").addEventListener("click", () => startRun());

  async function startRun() {
    const selected = state.projects.filter((p) => state.selected.has(p.id));
    state.rows.clear();
    selected.forEach((p) => state.rows.set(p.id, { name: p.name }));
    $("statusBody").innerHTML = "";
    $("log").textContent = "";
    selected.forEach((p) => renderRow(p.id));

    state.running = true;
    state.doneFired = false;
    $("cancelBtn").textContent = "Cancel";
    $("cancelBtn").className = "btn btn-danger";
    $("cancelBtn").disabled = false;
    show("run");

    const opts = {
      org: $("orgInput").value.trim(),
      dryRun: $("optDry").checked,
      retryFailed: $("optRetry").checked,
      renameOnly: $("optRenameOnly").checked,
      selected,
    };

    try {
      await API.run(opts);
    } catch (err) {
      appendLog("Run failed: " + (err.message || err), "err");
    } finally {
      state.running = false;
      if (!state.doneFired) finishToBack();
    }
  }

  function finishToBack() {
    const btn = $("cancelBtn");
    btn.textContent = "Back to projects";
    btn.className = "btn btn-ghost";
    btn.disabled = false;
  }

  $("cancelBtn").addEventListener("click", async () => {
    if (!state.running) {
      show("select");
      return;
    }
    // Stay disabled while stopping; startRun()'s finally → finishToBack() relabels
    // and re-enables once the run promise unwinds, so it can't be double-clicked.
    $("cancelBtn").disabled = true;
    $("cancelBtn").textContent = "Stopping…";
    await API.cancel();
  });

  // ── engine event routing ────────────────────────────────────────────────────
  function onEngineEvent(e) {
    switch (e.type) {
      case EV.BROWSER_DOWNLOAD_PROGRESS:
        onBrowserProgress(e);
        break;
      case EV.LOG:
        appendLog(e.msg);
        break;
      case EV.ERROR:
        appendLog((e.fatal ? "ERROR: " : "warning: ") + e.message, e.fatal ? "err" : "");
        break;
      case EV.PHASE:
        onPhase(e.phase);
        break;
      case EV.LOGIN_NEEDED:
        $("loginBanner").hidden = false;
        break;
      case EV.LOGIN_OK:
        $("loginBanner").hidden = true;
        break;
      case EV.PROJECT:
        mergeRow(e);
        break;
      case EV.DISCOVER:
        if (e.projects) {
          state.projects = e.projects;
          renderProjectList();
        }
        break;
      case EV.DONE:
        onDone(e.summary);
        break;
      default:
        break;
    }
  }

  function onPhase(phase) {
    const labels = {
      login: "Signing into Lovable…",
      discover: "Discovering projects…",
      connect: "Connecting projects…",
      rename: "Renaming repositories…",
    };
    if (labels[phase]) $("runPhase").textContent = labels[phase];
  }

  function appendLog(msg, cls) {
    const log = $("log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const time = new Date().toLocaleTimeString();
    const line = document.createElement("span");
    if (cls) line.className = "l-" + cls;
    line.textContent = `[${time}] ${msg}\n`;
    log.appendChild(line);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function mergeRow(e) {
    const row = state.rows.get(e.id) || {};
    if (e.name) row.name = e.name;
    if (e.phase1) row.phase1 = e.phase1;
    if (e.phase2) row.phase2 = e.phase2;
    if (e.repoName) row.repoName = e.repoName;
    if (e.renamedTo) row.renamedTo = e.renamedTo;
    state.rows.set(e.id, row);
    renderRow(e.id);
  }

  const PHASE1 = {
    pending: ["working", "connecting"],
    connected: ["connected", "connected"],
    skipped: ["skipped", "skipped"],
    failed: ["failed", "failed"],
    "dry-run": ["dry-run", "dry run"],
  };
  const PHASE2 = {
    renamed: ["renamed", "renamed"],
    failed: ["failed", "failed"],
    pending: ["pending", "—"],
  };

  function badge(map, key) {
    const [cls, label] = map[key] || ["pending", "—"];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function renderRow(id) {
    const row = state.rows.get(id);
    if (!row) return;
    let tr = document.querySelector(`tr[data-row="${id}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.row = id;
      $("statusBody").appendChild(tr);
    }
    // Safe: every dynamic value is run through escapeHtml(); the badge() output
    // uses only fixed class/label strings from PHASE1/PHASE2 (never user input).
    // The strict CSP (default-src 'self', no unsafe-inline) also blocks any
    // inline event handler, so injected markup could not execute regardless.
    tr.innerHTML =
      `<td title="${escapeHtml(row.name || id)}">${escapeHtml(row.name || "(unnamed)")}</td>` +
      `<td>${badge(PHASE1, row.phase1)}</td>` +
      `<td class="mono" title="${escapeHtml(row.renamedTo || row.repoName || "")}">${escapeHtml(
        row.renamedTo || row.repoName || "—"
      )}</td>` +
      `<td>${badge(PHASE2, row.phase2)}</td>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function onDone(summary) {
    state.doneFired = true;
    state.running = false;
    const s = summary || {};
    $("cConnected").textContent = s.connected ?? 0;
    $("cRenamed").textContent = s.renamed ?? 0;
    $("cSkipped").textContent = s.skipped ?? 0;
    $("cFailed").textContent = s.failed ?? 0;
    $("summaryNote").textContent =
      (s.failed ?? 0) > 0
        ? "Some projects failed — head back and re-run with “Retry failed” to try them again."
        : "Everything went through. Your repos are connected and prefixed with lv-.";
    show("summary");
  }

  $("summaryBack").addEventListener("click", () => show("select"));
  $("summaryDone").addEventListener("click", () => window.close());

  // rail step navigation (revisit prior steps only)
  document.querySelectorAll(".step").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.disabled) show(btn.dataset.go);
    });
  });

  // ── boot-time wiring ───────────────────────────────────────────────────────
  API.onEngineEvent(onEngineEvent);
  API.onAuthUpdate(onAuthUpdate);
  API.onAppState((s) => {
    if (s && s.updateReady) $("updateFlag").hidden = false;
  });

  (async function init() {
    try {
      state.auth = await API.getAuthStatus();
    } catch {
      /* keep defaults */
    }
    updateAuthChip();
    show("boot");
  })();
})();

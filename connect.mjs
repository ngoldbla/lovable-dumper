#!/usr/bin/env node

import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { parseArgs } from "util";

// --- CLI flags ---
const { values: flags } = parseArgs({
  options: {
    "rename-only": { type: "boolean", default: false },
    "retry-failed": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "discover": { type: "boolean", default: false },
    project: { type: "string" },
    org: { type: "string", default: "ngoldbla" },
  },
  strict: false,
});

const ORG = flags.org;
const DRY_RUN = flags["dry-run"];
const RENAME_ONLY = flags["rename-only"];
const RETRY_FAILED = flags["retry-failed"];
const DISCOVER = flags.discover;
const SINGLE_PROJECT = flags.project;

// --- State management ---
const STATE_PATH = new URL("state.json", import.meta.url).pathname;
const PROJECTS_PATH = new URL("projects.json", import.meta.url).pathname;

function loadState() {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  }
  return { githubOwner: ORG, projects: {} };
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function loadProjects() {
  return JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
}

function saveProjects(projects) {
  writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2) + "\n");
}

// --- Helpers ---
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// --- Phase 0: Login ---
async function login(context) {
  const page = await context.newPage();
  await page.goto("https://lovable.dev/projects", { waitUntil: "domcontentloaded" });

  // Check if already logged in by looking for project content
  try {
    await page.waitForSelector('[href^="/projects/"]', { timeout: 5000 });
    log("Already logged in.");
  } catch {
    log("Not logged in. Please log in to Lovable in the browser window.");
    await ask("Press Enter once you are logged in...");
    await page.goto("https://lovable.dev/projects", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[href^="/projects/"]', { timeout: 30000 });
    log("Login verified.");
  }

  return page;
}

// --- Discover mode: scrape project IDs from dashboard ---
async function discoverProjects(page) {
  log("Discovering projects from Lovable dashboard...");
  await page.goto("https://lovable.dev/projects", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[href^="/projects/"]', { timeout: 15000 });

  // Scroll to load all projects
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
  }

  const links = await page.$$eval('[href^="/projects/"]', (els) =>
    els.map((el) => {
      const href = el.getAttribute("href");
      const match = href.match(/\/projects\/([0-9a-f-]{36})/);
      if (!match) return null;
      // Try to get the project name from the element text
      const name = el.textContent?.trim() || "";
      return { id: match[1], name };
    }).filter(Boolean)
  );

  // Deduplicate by id
  const seen = new Set();
  const unique = [];
  for (const p of links) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      unique.push(p);
    }
  }

  log(`Discovered ${unique.length} projects.`);
  return unique;
}

// --- Phase 1: Connect a single project ---
async function connectProject(page, project, state, attempt = 1) {
  const { id, name } = project;
  const MAX_RETRIES = 2;

  log(`[${name}] Navigating to settings (attempt ${attempt})...`);

  if (DRY_RUN) {
    log(`[${name}] DRY RUN: Would connect project ${id}`);
    return { status: "dry-run", repoName: name };
  }

  const url = `https://lovable.dev/projects/${id}/settings?tab=github`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(2000);

  // Check if already connected
  const viewLink = await page.$('a:has-text("View on GitHub")');
  if (viewLink) {
    const href = await viewLink.getAttribute("href");
    const repoName = href?.split("/").pop() || name;
    log(`[${name}] Already connected → ${repoName}`);
    return { status: "skipped", repoName };
  }

  try {
    // Click "Connect project"
    const connectBtn = await page.waitForSelector('role=button[name="Connect project"]', {
      timeout: 10000,
    });
    await connectBtn.click();
    log(`[${name}] Clicked "Connect project"`);
    await sleep(2000);

    // Select org
    const orgItem = await page.waitForSelector(`role=menuitem[name="${ORG}"]`, {
      timeout: 10000,
    });
    await orgItem.click();
    log(`[${name}] Selected org "${ORG}"`);
    await sleep(2000);

    // Click "Transfer anyway" if it appears
    try {
      const transferBtn = await page.waitForSelector('role=button[name="Transfer anyway"]', {
        timeout: 5000,
      });
      await transferBtn.click();
      log(`[${name}] Clicked "Transfer anyway"`);
    } catch {
      // Transfer dialog may not always appear
    }

    // Wait for connection to complete
    const ghLink = await page.waitForSelector('a:has-text("View on GitHub")', {
      timeout: 90000,
    });
    const href = await ghLink.getAttribute("href");
    const repoName = href?.split("/").pop() || name;
    log(`[${name}] Connected → ${repoName}`);
    return { status: "connected", repoName };
  } catch (err) {
    log(`[${name}] Failed: ${err.message}`);
    if (attempt < MAX_RETRIES) {
      log(`[${name}] Retrying...`);
      await sleep(3000);
      return connectProject(page, project, state, attempt + 1);
    }
    return { status: "failed", repoName: null };
  }
}

// --- Phase 2: Rename repos ---
function renameRepos(state) {
  const owner = state.githubOwner;
  let renamed = 0;
  let skipped = 0;
  let failed = 0;

  for (const [id, info] of Object.entries(state.projects)) {
    if (info.phase2 === "renamed") {
      skipped++;
      continue;
    }
    if (!info.repoName) {
      continue;
    }

    const currentName = info.repoName;
    const newName = currentName.startsWith("lv-") ? currentName : `lv-${currentName}`;

    if (currentName === newName) {
      log(`[${currentName}] Already has lv- prefix`);
      state.projects[id].renamedTo = newName;
      state.projects[id].phase2 = "renamed";
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      log(`DRY RUN: Would rename ${owner}/${currentName} → ${newName}`);
      continue;
    }

    try {
      execSync(`gh repo rename "${newName}" --repo "${owner}/${currentName}" --yes`, {
        stdio: "pipe",
      });
      log(`Renamed ${currentName} → ${newName}`);
      state.projects[id].renamedTo = newName;
      state.projects[id].phase2 = "renamed";
      renamed++;
    } catch (err) {
      log(`Failed to rename ${currentName}: ${err.message}`);
      state.projects[id].phase2 = "failed";
      failed++;
    }

    saveState(state);
  }

  log(`\nRename summary: ${renamed} renamed, ${skipped} skipped, ${failed} failed`);
}

// --- Main ---
async function main() {
  const state = loadState();
  state.githubOwner = ORG;

  let projects = loadProjects();

  // Filter to single project if specified
  if (SINGLE_PROJECT) {
    projects = projects.filter((p) => p.id === SINGLE_PROJECT);
    if (projects.length === 0) {
      console.error(`Project ${SINGLE_PROJECT} not found in projects.json`);
      process.exit(1);
    }
  }

  // If only renaming, skip browser entirely
  if (RENAME_ONLY) {
    log("Rename-only mode: skipping browser automation.");
    renameRepos(state);
    saveState(state);
    return;
  }

  // Launch browser with persistent context
  log("Launching browser...");
  const context = await chromium.launchPersistentContext("./browser-data", {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await login(context);

    // Discover mode
    if (DISCOVER) {
      const discovered = await discoverProjects(page);
      saveProjects(discovered);
      log(`Saved ${discovered.length} projects to projects.json`);
      await context.close();
      return;
    }

    if (projects.length === 0) {
      log("No projects in projects.json. Run with --discover first.");
      await context.close();
      return;
    }

    // Phase 1: Connect projects
    log(`\n=== Phase 1: Connecting ${projects.length} projects ===\n`);

    for (const project of projects) {
      const existing = state.projects[project.id];

      // Skip already done unless retrying failures
      if (existing) {
        if (existing.phase1 === "connected" || existing.phase1 === "skipped") {
          log(`[${project.name}] Already processed (${existing.phase1}), skipping.`);
          continue;
        }
        if (existing.phase1 === "failed" && !RETRY_FAILED) {
          log(`[${project.name}] Previously failed, use --retry-failed to retry.`);
          continue;
        }
      }

      const result = await connectProject(page, project, state);

      state.projects[project.id] = {
        ...state.projects[project.id],
        name: project.name,
        phase1: result.status,
        repoName: result.repoName || state.projects[project.id]?.repoName,
        phase2: state.projects[project.id]?.phase2 || "pending",
      };
      saveState(state);

      // Brief pause between projects
      await sleep(3000);
    }

    // Phase 2: Rename repos
    log(`\n=== Phase 2: Renaming repos ===\n`);
    renameRepos(state);
    saveState(state);

    await context.close();
  } catch (err) {
    console.error("Fatal error:", err);
    await context.close();
    process.exit(1);
  }

  // Summary
  const counts = { connected: 0, skipped: 0, failed: 0, renamed: 0 };
  for (const info of Object.values(state.projects)) {
    if (info.phase1 === "connected") counts.connected++;
    if (info.phase1 === "skipped") counts.skipped++;
    if (info.phase1 === "failed") counts.failed++;
    if (info.phase2 === "renamed") counts.renamed++;
  }
  log(`\n=== Done ===`);
  log(`Connected: ${counts.connected} | Skipped: ${counts.skipped} | Failed: ${counts.failed} | Renamed: ${counts.renamed}`);
}

main().catch(console.error);

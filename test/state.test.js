import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadState,
  saveState,
  loadProjects,
  saveProjects,
} from "../src/engine/state.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ld-state-"));
}

test("loadState returns a skeleton when no file exists", () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadState(dir, "alice"), {
      githubOwner: "alice",
      projects: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state round-trips through save/load", () => {
  const dir = tmp();
  try {
    const state = {
      githubOwner: "bob",
      projects: {
        x: { name: "X", phase1: "connected", repoName: "x", phase2: "pending" },
      },
    };
    saveState(dir, state);
    assert.deepEqual(loadState(dir), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjects returns [] when missing and round-trips otherwise", () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadProjects(dir), []);
    const projects = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    saveProjects(dir, projects);
    assert.deepEqual(loadProjects(dir), projects);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save creates basePath when it does not exist", () => {
  const root = tmp();
  const dir = join(root, "nested", "deep");
  try {
    saveProjects(dir, [{ id: "a", name: "A" }]);
    assert.deepEqual(loadProjects(dir), [{ id: "a", name: "A" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

# Lovable Dumper

Automate connecting Lovable projects to GitHub and renaming repos with an `lv-` prefix. No LLM required — uses Playwright for browser automation and the `gh` CLI for repo renames.

## Prerequisites

- Node.js 18+
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- A Lovable account with projects

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

### 1. Discover projects

Scrapes your Lovable dashboard to populate `projects.json`:

```bash
node connect.mjs --discover
```

A browser will open. Log in if prompted, then the script scrapes project IDs and names.

### 2. Connect & rename all projects

```bash
node connect.mjs
```

### 3. Preview without making changes

```bash
node connect.mjs --dry-run
```

### 4. Only rename already-connected repos

```bash
node connect.mjs --rename-only
```

### 5. Process a single project

```bash
node connect.mjs --project <uuid>
```

### 6. Retry previously failed projects

```bash
node connect.mjs --retry-failed
```

### 7. Use a different GitHub org/user

```bash
node connect.mjs --org my-org
```

## How It Works

1. **Phase 0 — Login**: Opens a visible Chromium browser with persistent cookies. If not logged in, waits for you to log in manually.
2. **Phase 1 — Connect**: For each project, navigates to its GitHub settings, clicks "Connect project", selects the GitHub org, and confirms. Waits up to 90s per project.
3. **Phase 2 — Rename**: Uses `gh repo rename` to add an `lv-` prefix to each newly created repo.

Progress is saved to `state.json` after each project, so the script can resume if interrupted.

## Files

| File | Purpose |
|------|---------|
| `connect.mjs` | Main automation script |
| `projects.json` | Input manifest of Lovable projects |
| `state.json` | Auto-generated progress tracker |
| `browser-data/` | Persistent browser profile (cookies) |

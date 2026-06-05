# Lovable Dumper

> Bulk-connect your [Lovable](https://lovable.dev) projects to GitHub and tidy up the resulting repos — no LLM or API key required.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

## What it does

If you've built a pile of projects on Lovable, connecting each one to GitHub by
hand — clicking through the settings UI, picking the org, confirming the
transfer, then renaming the repo — is tedious and error-prone. **Lovable Dumper**
drives that flow for you: it discovers your projects, connects each to GitHub,
and renames the created repos with an `lv-` prefix so they group together.

It uses [Playwright](https://playwright.dev) to automate the Lovable web UI and
the [GitHub CLI](https://cli.github.com/) (`gh`) for repo renames. There's no
language model, no API key, and nothing to pay for.

> ⚠️ **Disclaimer** — This is an unofficial community tool and is **not
> affiliated with or endorsed by Lovable**. It works by driving Lovable's web
> interface, so **changes to that UI can break the selectors** this script
> relies on (see [Troubleshooting](#troubleshooting) and
> [CONTRIBUTING.md](./CONTRIBUTING.md)). Please respect
> [Lovable's Terms of Service](https://lovable.dev/terms). Use at your own risk.

## Prerequisites

- **Node.js 18+**
- **[GitHub CLI](https://cli.github.com/)** (`gh`), authenticated via `gh auth login`
- A **Lovable account** with projects

## Setup

```bash
git clone https://github.com/ngoldbla/lovable-dumper.git
cd lovable-dumper
npm install
npx playwright install chromium
```

Make sure `gh` is authenticated so the tool can detect your GitHub username and
rename repos:

```bash
gh auth login
```

## Usage

### 1. Discover projects

Scrapes your Lovable dashboard to populate `projects.json`:

```bash
node connect.mjs --discover
```

A browser window opens. Log in if prompted, then the script scrapes project IDs
and names.

### 2. Connect & rename all projects

```bash
node connect.mjs
```

### 3. Preview without making changes

```bash
node connect.mjs --dry-run
```

> Because a dry run never actually connects a project, the Phase 2 rename
> preview shows the **Lovable project name**, not the final GitHub repo slug
> (Lovable may slugify or de-duplicate the name when it creates the repo), so the
> previewed target is approximate.

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

By default the tool connects repos under **your authenticated GitHub account**
(auto-detected via `gh api user`). Pass `--org` only when you want to target a
different organization or user:

```bash
node connect.mjs --org my-org
```

## How it works

1. **Phase 0 — Login**: Opens a visible Chromium browser with a persistent
   profile (cookies are stored in `browser-data/`). If you aren't logged in, it
   waits for you to log in manually.
2. **Phase 1 — Connect**: For each project, it navigates to the project's GitHub
   settings, clicks "Connect project", selects the GitHub org, and confirms.
   It waits up to 90s per project for the connection to complete.
3. **Phase 2 — Rename**: Uses `gh repo rename` to add an `lv-` prefix to each
   newly created repo.

Progress is saved to `state.json` after each project, so the script is
**resumable** — re-run it after an interruption and it skips work already done.

## Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| `Connect project` button not found / timeout | You aren't logged in, or Lovable changed its UI. Log in manually in the opened browser; if the UI changed, the selectors in `connect.mjs` may need updating — see [CONTRIBUTING.md](./CONTRIBUTING.md). |
| `Could not determine GitHub org` | `gh` isn't installed or authenticated. Run `gh auth login`, or pass `--org <name>` explicitly. |
| Repos created under the wrong account | Pass `--org <name>` to target a specific org/user instead of the auto-detected one. |
| Some projects failed | Re-run with `--retry-failed` to retry only the failures; `state.json` tracks what's already done. |

## Files

| File | Purpose |
|------|---------|
| `connect.mjs` | Main automation script |
| `projects.json` | Input manifest of Lovable projects |
| `state.json` | Auto-generated progress tracker (gitignored) |
| `browser-data/` | Persistent browser profile / cookies (gitignored) |

## Contributing

Contributions are welcome! Because this tool automates a third-party UI, the
most common (and most valuable) contributions are selector fixes when Lovable's
interface changes. See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started.

## License

[MIT](./LICENSE) © Dylan Goldblatt

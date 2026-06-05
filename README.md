# Lovable Dumper

> Bulk-connect your [Lovable](https://lovable.dev) projects to GitHub and tidy up
> the resulting repos — now as a **downloadable desktop app**, or a CLI. No LLM,
> no API key, and (for the app) **no command line required**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/ngoldbla/lovable-dumper/actions/workflows/ci.yml/badge.svg)](https://github.com/ngoldbla/lovable-dumper/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

## What it does

If you've built a pile of projects on Lovable, connecting each one to GitHub by
hand — clicking through the settings UI, picking the org, confirming the
transfer, then renaming the repo — is tedious and error-prone. **Lovable Dumper**
drives that flow for you: it discovers your projects, connects each to GitHub,
and renames the created repos with an `lv-` prefix so they group together.

It uses [Playwright](https://playwright.dev) to automate the Lovable web UI and
the GitHub REST API for repo renames. There's no language model, no API key, and
nothing to pay for.

> ⚠️ **Disclaimer** — This is an unofficial community tool and is **not
> affiliated with or endorsed by Lovable**. It works by driving Lovable's web
> interface, so **changes to that UI can break the selectors** this tool relies
> on (see [Troubleshooting](#troubleshooting) and
> [CONTRIBUTING.md](./CONTRIBUTING.md)). Please respect
> [Lovable's Terms of Service](https://lovable.dev/terms). Use at your own risk.

---

## 📥 Download the desktop app (recommended)

Grab the latest installer for your platform from the
[**Releases page**](https://github.com/ngoldbla/lovable-dumper/releases/latest):

| Platform | File |
|----------|------|
| macOS (Apple Silicon / Intel) | `Lovable-Dumper-<version>-arm64.dmg` / `-x64.dmg` |
| Windows | `Lovable-Dumper-Setup-<version>.exe` |
| Linux | `Lovable-Dumper-<version>.AppImage` or `.deb` |

On **first launch** the app downloads its browser engine (Chromium, ~280 MB,
one time) into your user data folder. After that, you authorize GitHub, log into
Lovable in the browser window it opens, pick your projects, and click
**Connect & rename**.

### Opening an unsigned build

The app isn't code-signed yet, so your OS will warn you the first time:

- **macOS** — right-click (or Control-click) the app → **Open** → **Open**. If you
  see "app is damaged", clear the quarantine attribute:
  ```bash
  xattr -cr "/Applications/Lovable Dumper.app"
  ```
- **Windows** — on the SmartScreen prompt, click **More info** → **Run anyway**.

Auto-update is enabled on Windows and Linux. macOS auto-update will turn on once
the build is signed; until then, re-download from Releases to update.

---

## Using the app

1. **Welcome** — click *Get started*; the browser engine downloads on first run.
2. **GitHub** — paste a Personal Access Token (or use Device login when
   available). The token is stored locally, encrypted by your OS keychain.
3. **Projects** — set the GitHub owner, click *Discover my Lovable projects*, log
   into Lovable in the window that opens, then click *I've logged in*. Tick the
   projects you want.
4. **Connect** — watch the live log and per-project status. *Dry run* previews
   without making changes; *Rename only* skips the browser; *Retry failed*
   re-attempts only the failures.
5. **Done** — review the summary.

### Creating a GitHub token

Open [github.com/settings/tokens/new](https://github.com/settings/tokens/new),
create a **classic** token with the **`repo`** scope, and paste it into the app.

---

## CLI (advanced)

The original single-command CLI still ships, sharing the same engine.

### Prerequisites

- **Node.js 18+**
- A **GitHub token** with the `repo` scope, provided via the `GITHUB_TOKEN`
  environment variable (used to rename repos and auto-detect your username).
  `gh` is **no longer required**.
- A **Lovable account** with projects.

### Setup

```bash
git clone https://github.com/ngoldbla/lovable-dumper.git
cd lovable-dumper
npm install
export GITHUB_TOKEN=ghp_your_token_with_repo_scope
```

The browser is downloaded automatically the first time you run a command that
needs it (or run `npx playwright-core install chromium` manually).

### Usage

```bash
node connect.mjs --discover        # scrape your dashboard → projects.json
node connect.mjs                   # connect & rename everything
node connect.mjs --dry-run         # preview, no changes
node connect.mjs --rename-only     # only rename already-connected repos
node connect.mjs --project <uuid>  # a single project
node connect.mjs --retry-failed    # retry only previous failures
node connect.mjs --org my-org      # target a specific org/user
```

By default repos are created under the account that owns `GITHUB_TOKEN`; pass
`--org` to target a different organization or user. Installed globally
(`npm i -g`), the `lovable-dumper` command is also available.

---

## How it works

The automation lives in a reusable **engine** (`src/engine/`) shared by both the
app and the CLI — so selector fixes (the most common maintenance task) happen in
one place.

1. **Login** — opens a visible Chromium window with a persistent profile
   (cookies stored in your user data folder). If you aren't logged in, it waits.
2. **Connect** — for each project, navigates to its GitHub settings, clicks
   *Connect project*, selects the owner, and confirms (up to 90s per project).
3. **Rename** — calls `PATCH /repos/{owner}/{repo}` to add the `lv-` prefix.

Progress is saved after each project, so a run is **resumable** — re-run it after
an interruption and it skips finished work. Tokens are stored encrypted via the
OS keychain (`safeStorage`) in the app, or `GITHUB_TOKEN` / a `0600` file for the
CLI.

## Build from source

```bash
npm install
npm test          # unit tests (engine)
npm run lint      # syntax-check all sources
npm run electron  # launch the app in dev
npm run dist:mac  # build installers (dist:win / dist:linux)
```

Releases are automated: [release-please](https://github.com/googleapis/release-please)
opens a version-bump PR from conventional commits; merging it tags `vX.Y.Z`,
which triggers `release.yml` to build macOS/Windows/Linux installers and upload
them to a GitHub Release.

## Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| `Connect project` button not found / timeout | You aren't logged in, or Lovable changed its UI. Log in manually in the opened window; if the UI changed, the selectors in `src/engine/automation.js` may need updating — see [CONTRIBUTING.md](./CONTRIBUTING.md). |
| `Could not determine GitHub org` | No `--org` and no usable `GITHUB_TOKEN`. Set a token with `repo` scope or pass `--org <name>`. |
| Rename fails with `403` | Your token lacks `repo` scope, or you can't administer that repo (org repos need admin rights). |
| macOS "app is damaged" | Unsigned build quarantine — run `xattr -cr "/Applications/Lovable Dumper.app"`. |
| Some projects failed | Re-run with `--retry-failed` (CLI) or the *Retry failed* toggle (app). |

## Files

| Path | Purpose |
|------|---------|
| `src/engine/` | Shared automation engine (login, discover, connect, rename, auth, browser install) |
| `src/main/`, `src/preload/`, `src/renderer/` | Electron app (main process, IPC bridge, UI) |
| `connect.mjs` | Thin CLI shim over the engine |
| `electron-builder.yml` | Packaging + publish config |
| `projects.json` | Input manifest of Lovable projects |

## Contributing

Contributions are welcome! Because this tool automates a third-party UI, the most
common (and most valuable) contributions are selector fixes when Lovable's
interface changes. See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started.

## License

[MIT](./LICENSE) © Dylan Goldblatt

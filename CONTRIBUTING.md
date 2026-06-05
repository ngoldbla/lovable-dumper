# Contributing to Lovable Dumper

Thanks for your interest in improving Lovable Dumper! This is a small, focused
tool, and contributions of all sizes are welcome.

This project ships with a [Code of Conduct](./CODE_OF_CONDUCT.md) — by
participating, you agree to uphold it.

## The most valuable contribution: selector fixes

Lovable Dumper works by automating Lovable's **web UI**. That UI is owned by
Lovable and can change at any time. When it does, the CSS/role selectors in
[`connect.mjs`](./connect.mjs) — things like:

```js
page.waitForSelector('role=button[name="Connect project"]')
page.waitForSelector(`role=menuitem[name="${ORG}"]`)
page.waitForSelector('a:has-text("View on GitHub")')
```

— may stop matching, and the tool will time out. If you hit a broken selector
and figure out the new one, **a PR updating it is hugely appreciated** and is
the single most useful thing you can contribute.

## Local setup

```bash
git clone https://github.com/ngoldbla/lovable-dumper.git
cd lovable-dumper
npm install
npx playwright install chromium
gh auth login
```

Then run the script against your own Lovable account. Use `--dry-run` while
experimenting so you don't make real changes, and `--project <uuid>` to iterate
on a single project quickly.

## Code style

- Plain **ESM** JavaScript (`.mjs`), **no build step** and no transpiler.
- Stick to the Node.js standard library plus the existing `playwright`
  dependency — please avoid adding new runtime dependencies without discussion.
- Match the surrounding style: the existing `log()` helper for output, small
  focused functions, and 2-space indentation.
- Before opening a PR, make sure the script still parses:

  ```bash
  npm run lint   # node --check connect.mjs
  ```

## Reporting bugs

Open an [issue](https://github.com/ngoldbla/lovable-dumper/issues) using the
**Bug report** template. Because failures are usually UI- or environment-
specific, please include:

- Your **Node version** (`node --version`)
- Your **`gh` version** (`gh --version`)
- Your **OS**
- Which **phase** failed (login / connect / rename) and the **selector or error
  message** you saw

## Pull requests

- Keep PRs focused — one fix or feature per PR.
- Describe what changed and how you verified it (e.g. "ran `--dry-run` against
  3 projects").
- Update the README if you change user-facing behavior or flags.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).

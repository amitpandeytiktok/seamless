# Contributing to Seamless

Thanks for your interest! Seamless is a small, dependency-light project — contributions are welcome.

## Ground rules

- **Read-only on Copilot data.** Seamless must never write to `~/.copilot/`. It only reads
  session data and launches the `copilot` CLI on the user's behalf.
- **Keep the core dependency-free.** Everything under `src/core`, `src/server`, and `src/web`
  must run on plain Node + the browser with no third-party runtime dependencies. Electron is the
  only external dependency, and it's optional (`npm run server` runs the full dashboard without it).
- **Windows-first.** The data-model paths and terminal launchers target Windows. Cross-platform
  patches are welcome but must not regress Windows behaviour.

## Getting started

```powershell
git clone https://github.com/amitpandeytiktok/seamless.git
cd seamless
npm install          # only needed for the desktop app (Electron)
npm run server       # run the dashboard at http://127.0.0.1:4321
npm test             # smoke-test the core analyzer against your live sessions
```

Node **>= 22.5** is recommended for full features (built-in `node:sqlite`). On Node 20 the
global-DB extras degrade gracefully and core discovery still works.

## Project layout

See the **Architecture** section of the [README](README.md). The analytical heart is
`src/core/events.js` (turns `events.jsonl` into the live context/usage state).

## Pull requests

- Keep changes focused and surgical.
- Run `npm test` and confirm the dashboard still renders before opening a PR.
- Describe what you changed and why. Screenshots help for UI changes.

## Reporting bugs

Open an issue with your OS, Node version, `copilot --version`, and steps to reproduce. If it's a
parsing/sizing bug, the relevant fields from a `session-state/<id>/events.jsonl` line (with any
sensitive content redacted) are extremely helpful.

# Contributing to Skipi

Thanks for considering a contribution. Skipi is built by a working Master
Mariner for fellow seafarers, so contributions from people with maritime
domain knowledge — current or former officers, ratings, crewing managers,
maritime IT — are especially welcome.

## How to report a bug or request a feature

Open an issue at <https://github.com/CaptTymur/skipi.app/issues>. Useful
detail:

- Skipi version (shown in the welcome screen and the title bar).
- Operating system (Windows / macOS / Linux distribution).
- Steps to reproduce, expected vs actual result.
- Screenshots of the UI if relevant. Please blur certificate numbers,
  passport pages, or any other personal data before posting.

## How to contribute code

1. Fork the repository.
2. Create a branch from `main` (e.g. `fix/welcome-screen-typo`).
3. Make your changes. Keep them focused — one PR per logical change.
4. Test locally (`cd src-tauri && cargo tauri dev`).
5. Open a pull request against `main` with a clear description of what
   changes and why.

## Architecture, in one paragraph

Skipi is a Tauri 2 app. The Rust backend lives in `src-tauri/src/` and
exposes commands to the frontend via `#[tauri::command]`. The frontend is a
single `dist/index.html` with inline JavaScript — no build step, no
`node_modules`, no framework. SQLite stores structured records (documents,
work history, profile); document files themselves stay on the user's
disk in a folder the user picks. Edit `dist/index.html` directly and reload.

## Code style

- Frontend JS uses `var`, not `let`/`const` (consistent with the rest of
  the file).
- Frontend uses manual DOM via `innerHTML` — no React/Vue/Svelte.
- Toast notifications: `showToast(msg, 'success' | 'error' | 'warn' | 'info')`.
- Errors: `logError(ctx, e)` plus a user-facing toast.
- Rust calls from JS: `await invoke('cmd_name', { arg1: ..., arg2: ... })`.
- File picker: `await open({ multiple: false, filters: [...] })`.

Rust style follows the standard `cargo fmt` defaults.

## Privacy and data handling — non-negotiable rules

Skipi exists because seafarers' personal data is routinely abused by
crewing-agency portals. The following rules apply to **every** contribution:

- **No telemetry.** Don't add analytics, error reporting, crash reporting,
  or any background HTTP calls that send data anywhere without explicit
  user action.
- **No silent network calls.** If a feature needs the network (AI scan,
  optional CV upload, jobs board polling), it must be opt-in and visibly
  triggered by the user.
- **No third-party trackers.** No Google Analytics, no Sentry, no Mixpanel,
  no Datadog RUM, etc.
- **Document files stay local.** The user's chosen vault folder is
  authoritative. Skipi reads and writes inside it; it does not copy
  documents to any other location without explicit user action.
- **AI scan is opt-in and per-document.** When the user attaches a
  certificate file, optional AI extraction (Ollama local or Claude API
  key) only runs if the user has configured a key and has not disabled
  auto-scan in settings.

PRs that violate these rules will be closed without merge.

## Releases

Maintainer-only. Release tagging procedure is in `.github/SIGNING_SETUP.md`
and the `CLAUDE.md` push protocol.

## License

By contributing, you agree that your contribution will be licensed under
the [MIT License](LICENSE) — the same license as the rest of the project.

## Conduct

Be respectful. Maritime is a small world; act like you'll be working with
the other person on a vessel one day.

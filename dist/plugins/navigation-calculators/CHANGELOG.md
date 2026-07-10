# Changelog — Navigation Calculators (bundled first-party plugin)

Bundled first-party Skipi plugin. One plugin, many calculators as sub-programs.
No remote code, no network.

## 0.1.0 — 2026-06-25

Initial bundled first-party artifact — vertical slice proving the bundle
architecture (launcher + universal wrapped-calculator loader).

### Runtime contract
- Registers `window.SkipiPlugins["navigation-calculators"] = { manifest, mount, unmount }`.
- `mount(container, hostApi)` renders a categorized launcher of sub-programs.
- Tapping a card opens that calculator in place with a Back bar; `unmount()`
  removes the iframe, listeners, theme subscription and empties the container.
- `manifest.entrypoints = { ui: "index.js", style: "index.css" }`.

### Calculators in this slice
- `latlong`  — Latitude & Longitude Factors (sailing)
- `speed`    — Speed, Time & Distance (sailing)
- `gcsail`   — Great Circle Sailing, incl. way points / full track (sailing)
- `zones`    — Time Zones reference table (reference)

### How calculators are wrapped
- Each legacy NGA-style calculator (2004) is embedded verbatim and rendered in
  an **opaque sandboxed iframe** (`sandbox="allow-scripts allow-modals
  allow-forms"`, no `allow-same-origin`). The legacy code cannot reach network,
  storage, cookies or the host page.
- `window.open()` popups (Great Circle full track) are shimmed to an inline panel.
- A clean replacement stylesheet stands in for the original (missing) `formcatalog.css`,
  and themes light/dark with the host.

### Host integration
- `hostApi.theme.get()/subscribe()` skins both the shell and the open calculator.
- `hostApi.storage` (namespaced `navcalc.*`) remembers the last opened calculator.
- `hostApi.navigation.setTitle()` is updated on open/back.

### Privacy / safety
- No network, no documents, no account, no analytics, no server upload.
- Always-visible disclaimer: training/planning aid only; verify against official
  tables and approved equipment. No certified-equipment claims.

### Roadmap
- Add the remaining ~30 calculators (drop HTML into `src/calculators/`, add a
  `src/registry.json` row, run `node src/build.js`).
- Re-implement the most-used calculators natively (themed, mobile, no iframe).

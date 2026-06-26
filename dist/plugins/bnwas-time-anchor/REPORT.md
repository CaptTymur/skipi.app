# Artifact Report — BNWAS / Time Anchor 0.1.0

- **Artifact:** `dist/plugins/bnwas-time-anchor/`
- **Lab repo:** `/home/linux/Developer/skipi-plugins/bnwas-time-anchor`
- **Date:** 2026-06-24
- **Distribution:** bundled first-party, no remote code.
- **Target hosts:** Seafarer (first), On Board (later).

## Runtime contract (verified)

```js
window.SkipiPlugins["bnwas-time-anchor"] = {
  manifest,                     // includes full id app.skipi.plugins.bnwas-time-anchor
  mount(container, hostApi),    // renders into container, never into document.body
  unmount()                     // stops timers/audio/listeners, unsubscribes, empties container
};
```

`plugin.json` exposes `entrypoints.ui = "index.js"`, `entrypoints.style = "index.css"`.

## Files

| File | Purpose |
|---|---|
| `plugin.json` | host manifest (entrypoints, permissions, capabilities, safety) |
| `index.js` | plugin runtime (mount/unmount + BNWAS state machine + Web Audio alarm) |
| `index.css` | styles scoped under `.skipi-bnwas` (no leakage into host) |
| `assets/` | empty — alarm tones are synthesised at runtime; no binary assets |
| `CHANGELOG.md` | version history |
| `REPORT.md` | this report |
| `checksums.json` | SHA-256 of the artifact files |

## Tests run

### Level 0 — logic / syntax
- `plugin.json` (lab + artifact) parse as valid JSON — PASS.
- `node --check` on artifact `index.js` — PASS.
- `node --check` on extracted inline JS of `test-host/index.html`, `mock-host.html`, `contract-test.html` — PASS.

### Level 1 — standalone lab
- `test-host/index.html` opens headless and renders (status READY, Start button, clock, disclaimer) — PASS.
- Interval selection, countdown, alarm-on-expiry, alarm-until-acknowledge, acknowledge-stops + next cycle, cycle counter, day/night, safety disclaimer all present.

### Level 2 — mock host contract (`test-host/contract-test.html`, headless Chrome) — 22/22 PASS
- plugin registered under short key `bnwas-time-anchor`; exposes manifest/mount/unmount.
- manifest id is the full id; manifest declares `network: none`.
- `mount(container, hostApi)` renders `.skipi-bnwas` into the container.
- `hostApi.theme.get()` (light) is applied to the root.
- Real 1 s-tick countdown reaches the alarm at expiry; alarm audio loop active.
- Alarm persists until Acknowledge; Acknowledge stops the alarm audio and arms the next cycle (watching).
- Cycle counter increments; forced expiry re-enters alarm; escalation to aggressive level 2 works.
- No network calls; plugin does not depend on the host audio stub (uses Web Audio).
- `unmount()` removes the test handle and empties the container; re-mount works (idempotent).

### Network / privacy
- Static grep of `index.js`: no `fetch` / `XMLHttpRequest` / `sendBeacon` / `WebSocket` / `EventSource` / `importScripts` / `navigator.*` / `document.cookie` / dynamic `import()` / remote `.src=`.
- Runtime: mock host monkeypatches all network primitives and records 0 calls.
- No access to documents, vault paths, mailbox, account or admin tokens. No backend endpoint.

### Responsive
- Desktop (≈560 px card) and phone-width (390 px forced layout viewport) both render fully inside the card; no horizontal overflow (`scrollWidth == innerWidth`). A `≤480 px` breakpoint makes controls full-width and compacts presets.

## Screenshots

`~/Pictures/skipi-bnwas-plugin-lab/`
- `01-idle.png` — idle / default (dark)
- `02-running.png` — countdown running
- `03-alarm.png` — alarm with dominant Acknowledge button
- `04-ack-cycle.png` — after acknowledge / next cycle (Cycles 1)
- `05-mobile-alarm.png` — phone-width alarm layout
- `06-light-idle.png` — host light theme applied
- `07-mockhost-toolbar.png` — mock host with its toolbar (mount/unmount/theme/expire/ack), net + audio indicators
- `08-lab-standalone.png` — standalone lab (`test-host/index.html`)
- `09-mobile-idle.png` — phone-width idle layout

## Known limitations

- **Foreground only.** Background / lock-screen / OS-level alarm persistence is not guaranteed in this web artifact and was not tested. If background reliability is required, it becomes a host/native capability review — not part of this artifact.
- **Audio gesture policy.** Web Audio is unlocked on the user's "Start watch" gesture. If a host mounts and reaches alarm without any prior user gesture, the browser/webview may suppress sound until interaction. `unmount` always stops audio regardless.
- **`hostApi.audio` is a no-op in Seafarer PR #4** — alarm sound is produced by the plugin's own Web Audio. When the host gains a native audio bridge, the plugin can be switched to `hostApi.audio.playLoop()/stop()`.
- **Headless screenshot note.** Chrome headless clamps its window to a 500 px minimum; the phone-width shots use a page-forced 390 px layout viewport to render the true `≤480` breakpoint.
- **Test hook.** A local-only `__test` handle is attached **only** when a harness sets `window.__SKIPI_PLUGIN_TEST__ = true` before mount; production hosts never set it, so the artifact exposes no debug surface in Seafarer.

## NOT done (by design — out of scope for this task)

- No Seafarer / `skipi-public` changes. No merge / version bump / release.
- No feedback/rating form inside the plugin (host-owned, deferred mandatory backlog).
- No certified BNWAS / SOLAS compliance claims.

# Changelog — BNWAS / Time Anchor (bundled first-party plugin)

All notable changes to the bundled artifact are documented here.
This artifact is consumed by Skipi homes (Seafarer first) as a bundled
first-party plugin. It is not a marketplace package and loads no remote code.

## 0.1.0 — 2026-06-24

Initial bundled first-party artifact.

### Runtime contract
- Registers `window.SkipiPlugins["bnwas-time-anchor"] = { manifest, mount, unmount }`.
- `mount(container, hostApi)` renders the BNWAS UI into the host-provided container.
- `unmount()` stops the countdown ticker, stops the alarm loop, closes the Web Audio
  context, removes the keydown listener, unsubscribes from host theme and empties the container.
- `manifest.entrypoints = { ui: "index.js", style: "index.css" }`.

### Behavior
- Interval selection (presets 3 / 6 / 10 / 12 min + custom 1–300 min).
- Countdown on watch start.
- On expiry the alarm starts immediately.
- **Alarm repeats/continues until the user presses Acknowledge ("I'm here · Я здесь").**
- After 3 minutes without acknowledgement the alarm escalates to an aggressive level 2.
- Acknowledge stops the alarm, counts the cycle and arms/starts the next cycle.
- Visible cycle counter and total watch time.
- Day / Night watch mode; alarm flash overlay.
- Bilingual UI: English primary with Russian helper text (EN+RU).
- Always-visible safety disclaimer (EN + short RU).

### Host integration
- Uses `hostApi.theme.get()` / `subscribe()` for light/dark base.
- Uses `hostApi.storage` (namespaced `bnwas.*`) for local settings, with a `localStorage` fallback.
- Uses `hostApi.navigation.setTitle()` when available.
- Generates alarm audio locally via Web Audio because `hostApi.audio` is a no-op stub in Seafarer PR #4.

### Privacy / safety
- No network, no documents, no account, no analytics, no server upload.
- No certified BNWAS / SOLAS / bridge-equipment claims.
- No binary assets — alarm tones are synthesised at runtime (Web Audio).

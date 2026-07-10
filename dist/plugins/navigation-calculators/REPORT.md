# Artifact Report — Navigation Calculators 0.1.0

- **Artifact:** `dist/plugins/navigation-calculators/`
- **Lab repo:** `/home/linux/Developer/skipi-plugins/navigation-calculators`
- **Date:** 2026-06-25
- **Distribution:** bundled first-party, no remote code.
- **Model:** one plugin → many calculators as sub-programs.
- **Build:** `node src/build.js` (single-sources the manifest; embeds calculators as JSON).

## Decisions applied
- **Hybrid fidelity:** wrap the original 2004 calculators now (exact, tested
  navigation math), re-implement natively later.
- **Vertical slice first:** prove the bundle architecture on 4 representative
  calculators (simple / classic / complex+popup / static table), then mass-add the rest.

## Runtime contract (verified)
```js
window.SkipiPlugins["navigation-calculators"] = {
  manifest,
  mount(container, hostApi),   // categorized launcher → tap → calculator in place
  unmount()                    // remove iframe, listeners, theme sub; empty container
};
```
`plugin.json` exposes `entrypoints.ui = "index.js"`, `entrypoints.style = "index.css"`.

## Wrapping mechanism
Each legacy calculator runs in an **opaque sandboxed iframe**
(`sandbox="allow-scripts allow-modals allow-forms"`, **no** `allow-same-origin`).
Consequences:
- the 2004 code physically cannot touch network, storage, cookies or the host;
- `window.open()` popups are shimmed to an inline panel inside the iframe;
- a replacement stylesheet stands in for the missing `formcatalog.css` and themes light/dark.

## Files
| File | Purpose |
|---|---|
| `plugin.json` | host manifest (entrypoints, permissions, capabilities, safety) |
| `index.js` | launcher + universal wrapped-calculator loader + embedded calculators |
| `index.css` | shell styles scoped under `.skipi-navcalc` |
| `assets/` | empty (calculators embedded in `index.js`) |
| `CHANGELOG.md`, `REPORT.md`, `checksums.json` | provenance |

## Tests run

### Level 0 — math fidelity (`test-host/math-check.js`, Node) — 8/8 PASS
Runs the calculators' own functions (same source embedded in the artifact) against
known navigation values:
- latlong: dLat/dLon factors at lat 0°, az 45° → 1.0 / 1.0.
- speed: 1800 s measured mile → 2.0 kn; 10 nm in 60 min → 10.0 kn; 6 nm @ 12 kn → 30 min.
- gcsail (Great Circle): equator 0°E→10°E → 600 nm @ 090° T; meridian 0°N→10°N → 600 nm.

### Level 0/1 — syntax / JSON
- `plugin.json` (lab + artifact) and `registry.json` valid JSON.
- `node --check` on artifact `index.js` and extracted inline JS of mock-host / contract-test.

### Level 2 — mock host contract (`test-host/contract-test.html`, headless Chrome) — 26/26 PASS
Registration, manifest, network=none; launcher view with a card per calculator,
grouped into sections; host light theme applied to shell; setTitle on mount;
open → calc view in an iframe; srcdoc contains the wrapped calculator + the
window.open shim + the replacement stylesheet (and **no** `formcatalog`);
sandbox is opaque (`allow-scripts allow-modals allow-forms`, no same-origin);
light theme propagated into the srcdoc; theme.subscribe re-skins the open calc;
storage remembers last opened (namespaced); back returns to launcher; static
table calc mounts; **no network calls**; unmount empties container + removes test
handle; re-mount works.

### Network / privacy
- Static grep of `index.js`: no `fetch(` / `XMLHttpRequest` / `sendBeacon` /
  `new WebSocket` / `EventSource` / remote URLs.
- Runtime: mock host monkeypatches all network primitives → 0 calls.
- The legacy calculators are additionally confined to an opaque-origin sandbox.

## Screenshots
`~/Pictures/skipi-navcalc-plugin-lab/`
- `01-launcher-dark.png`, `02-launcher-light.png` — bundle launcher (categorized cards)
- `03-calc-latlong.png`, `04-calc-speed.png` — simple / classic calculators rendered
- `05-calc-gcsail.png` — Great Circle (complex form, popup shimmed) rendered + Back bar
- `06-calc-zones.png` — static reference table (light theme)
- `07-mobile-launcher.png` — phone-width launcher (single column)
- `08-mockhost-gcsail.png` — mock host with toolbar (mount/unmount/theme, net=0)

## Known limitations
- **Wrapped, not native.** Calculators keep their original look inside the
  sandbox (themed chrome around them). Native re-implementation is the follow-up.
- **Opaque sandbox = no parent introspection.** End-to-end math is proven by the
  Node math-check (same source) + the contract test verifies delivery into the
  sandbox; the contract test cannot read inside the cross-origin iframe by design.
- **Fixed iframe height** (70vh / 78vh on phones) with internal scroll, since the
  opaque iframe's content height isn't readable from the parent.
- **Slice only:** 4 of ~33 calculators wired. `Voyage Calc.xls` is out of scope
  for the web bundle.
- **Test hook** `__test` attaches only when `window.__SKIPI_PLUGIN_TEST__ = true`
  before mount; production hosts never set it.

## NOT done (by design)
- No host (Seafarer/On Board) changes; no integration; no merge/version/release.
- No feedback form inside the plugin (host-owned, deferred).
- No certified-equipment / SOLAS claims.

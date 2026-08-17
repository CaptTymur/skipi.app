// Regression guard: bug #2 — hardware Back exits the app from any screen.
//
// Root cause (2026-08-17, Sergey field report). The generated WryActivity maps
// Android hardware Back to `mWebView.canGoBack() ? goBack() : onBackPressed()`.
// The mobile shell navigates by mutating `mobileView` + innerHTML and never
// touched the History API, so `canGoBack()` was ALWAYS false and the very first
// Back press backgrounded/closed the whole app instead of navigating within it.
//
// Fix (front-end only — WryActivity.kt is generated "DO NOT MODIFY"): the mobile
// shell pushes a History entry per forward in-app navigation (a marked entry so
// it does not collide with the Settings/Assistant overlay markers) and a global
// `popstate` listener returns to the previous mobile view instead of exiting.
//
// This harness locks those invariants at the source level. Failing-first: fails
// on the pre-fix dist (no pushState/popstate for mobile view navigation).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

console.log('# Mobile Back / History API contract (bug #2)');

// 1) A dedicated mobile-view history marker exists (distinct from the overlay
//    markers skipiUnifiedSettings / skipiAssistant so back handling never
//    collides).
ok(/skipiMobileNav/.test(html),
  'a distinct mobile-view history marker (skipiMobileNav) is used');

// 2) The mobile shell pushes a History entry for in-app navigation.
ok(/history\.pushState\(\s*\{\s*skipiMobileNav/.test(html),
  'mobile navigation calls history.pushState with the skipiMobileNav marker');

// 3) A popstate listener handles the mobile-nav marker and navigates within the
//    app (does NOT fall through to app exit).
// Find a popstate listener whose body references the mobile-nav state/stack.
// (Body matched non-greedily up to the listener's closing `});`.)
const popstateBlocks = [
  ...html.matchAll(/addEventListener\(\s*['"]popstate['"]\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)\s*;/g),
];
const mobileNavPopstate = popstateBlocks.some(
  (m) => /skipiMobileNav|_mobileNavStack/.test(m[1]),
);
ok(mobileNavPopstate,
  'a popstate listener reacts to the mobile-nav history state (in-app back)');

// 4) The navigation tracker is wired through the single render choke point so
//    that every view change (including direct mobileView= sub-views) is tracked.
ok(/function renderMobileShell\(\)\{[\s\S]{0,500}?mobileNavTrack\s*\(/.test(html),
  'renderMobileShell wires the mobile-nav tracker (mobileNavTrack) so all view changes are captured');

// 5) No NEW inline event handlers were introduced by this fix (CSP hygiene):
//    the back integration must be event-listener based, not new onclick= markup.
//    Guard the specific idiom — the tracker/popstate must use addEventListener.
ok(/window\.addEventListener\(\s*['"]popstate['"]/.test(html),
  'back integration uses addEventListener (no inline handler)');

console.log(`ALL GREEN: ${passed} mobile-back (bug #2) checks passed`);

// Regression guard: CSP must not break inline event handlers (v0.4.170 regression).
//
// Root cause (2026-07-11): Tauri v2 injects __TAURI_SCRIPT_NONCE__ into script-src.
// Per CSP3, a nonce makes 'unsafe-inline' IGNORED, so ANY non-null CSP that restricts
// script-src blocks every inline event handler (onclick= etc.). The seafarer frontend
// uses ~582 inline handlers, so a restrictive CSP kills all buttons (v0.4.170/171 shipped
// dead; fixed by csp:null in v0.4.172). Until the frontend is refactored off inline
// handlers, the ONLY safe state is csp:null.
//
// This harness FAILS if someone re-introduces a script-src-restricting CSP.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const confPath = join(here, '..', 'src-tauri', 'tauri.conf.json');

let fail = 0;
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const csp = conf?.app?.security?.csp;

if (csp === null || csp === undefined) {
  console.log('OK: tauri.conf csp is null — inline handlers safe');
} else if (typeof csp === 'string' && /script-src/i.test(csp)) {
  // A non-null CSP with script-src. Given Tauri's nonce injection, this blocks inline
  // handlers regardless of 'unsafe-inline'. Regression.
  console.error('FAIL: tauri.conf csp restricts script-src.');
  console.error('  Tauri injects __TAURI_SCRIPT_NONCE__ -> a nonce makes unsafe-inline ignored');
  console.error('  -> all ~582 inline onclick= handlers are BLOCKED (dead buttons, v0.4.170 regression).');
  console.error('  Fix: set app.security.csp = null (v0.4.169/172 state) until inline handlers are refactored.');
  console.error('  Current csp:', csp.slice(0, 120) + '...');
  fail = 1;
} else {
  console.log('OK: csp present but no script-src restriction —', String(csp).slice(0, 80));
}

process.exit(fail);

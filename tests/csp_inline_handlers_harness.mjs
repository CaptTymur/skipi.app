// Regression guard: CSP must not break inline event handlers (v0.4.170 regression).
//
// Root cause (2026-07-11): Tauri v2 injects __TAURI_SCRIPT_NONCE__ into script-src.
// Per CSP3, a nonce makes 'unsafe-inline' IGNORED, so ANY non-null CSP that restricts
// script execution (via script-src OR a default-src fallback) blocks every inline event
// handler (onclick= etc.). The frontends use hundreds of inline handlers, so a restrictive
// CSP kills all buttons (seafarer v0.4.170/171 shipped dead; fixed by csp:null in 0.4.172).
// Until the frontends are refactored off inline handlers, the ONLY safe state is csp:null.
//
// This harness is IDENTICAL across all Tauri homes (public/crewing/broker/onboard) — a CSP
// change in ONE app must be caught in THAT app (grok B1: guard existed only in seafarer).
// It fails on: (a) a conf CSP that restricts script-src or default-src, (b) a non-null CSP
// given as an object (still triggers nonce injection), (c) a <meta http-equiv=CSP> smuggled
// into dist/index.html that restricts script-src/default-src (grok B2 bypass).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const confPath = join(here, '..', 'src-tauri', 'tauri.conf.json');
const distPath = join(here, '..', 'dist', 'index.html');

let fail = 0;
const restricts = (s) => /script-src|default-src/i.test(String(s));

// (1) tauri.conf.json app.security.csp
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const csp = conf?.app?.security?.csp;

if (csp === null || csp === undefined) {
  console.log('OK: tauri.conf csp is null — inline handlers safe');
} else if (typeof csp === 'string') {
  if (restricts(csp)) {
    console.error('FAIL: tauri.conf csp restricts script execution (script-src/default-src).');
    console.error('  Tauri injects __TAURI_SCRIPT_NONCE__ -> a nonce makes unsafe-inline ignored');
    console.error('  -> all inline onclick= handlers are BLOCKED (dead buttons, v0.4.170 regression).');
    console.error('  Fix: set app.security.csp = null (v0.4.169/172 state) until inline handlers are refactored.');
    console.error('  Current csp:', csp.slice(0, 120) + '...');
    fail = 1;
  } else {
    console.log('OK: csp string present but no script-src/default-src restriction —', csp.slice(0, 80));
  }
} else {
  // Object/array form: a non-null CSP still causes Tauri nonce injection -> unsafe. Treat as FAIL.
  console.error('FAIL: tauri.conf csp is a non-null non-string value (object/array).');
  console.error('  Any non-null CSP triggers Tauri nonce injection -> inline handlers blocked.');
  console.error('  Fix: set app.security.csp = null until inline handlers are refactored.');
  fail = 1;
}

// (2) smuggled <meta http-equiv="Content-Security-Policy"> in the shipped HTML
if (existsSync(distPath)) {
  const html = readFileSync(distPath, 'utf8');
  const metas = html.match(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi) || [];
  for (const m of metas) {
    if (restricts(m)) {
      console.error('FAIL: dist/index.html carries a <meta> CSP that restricts script execution.');
      console.error('  This bypasses the tauri.conf check and blocks inline handlers just the same.');
      console.error('  Offending meta:', m.slice(0, 160));
      fail = 1;
    }
  }
  if (metas.length && !fail) {
    console.log('OK: dist has meta CSP but no script-src/default-src restriction');
  }
} else {
  console.log('note: dist/index.html not present (not built) — meta-CSP check skipped');
}

if (fail) {
  console.error('\n>>> A restrictive CSP is present. Inline event handlers will be dead. See csp:null lesson (2026-07-11).');
}
process.exit(fail);

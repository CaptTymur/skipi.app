// Regression guard: bug #1 — RED SCREEN on document photo recognition.
//
// Root cause (2026-08-17, Sergey field report). The mobile shell auto-starts OCR
// after a scan is attached via `setTimeout(...mobileAutoStartOcrIfConfigured...)`.
// That async function `await`s with no try/catch and the setTimeout callers add no
// `.catch()`. A reject (e.g. a Rust `parse_ai_result` error that returns the WHOLE
// raw model response) escapes to the global `unhandledrejection` handler, which
// paints a full-width red error surface (#__early_err__ / #err) with the raw model
// text. Two coupled defects make this user-visible:
//   (A) the auto-OCR reject is never caught (front-end);
//   (B) parse_ai_result dumps the entire raw model output into the error string,
//       and slices a UTF-8 string by BYTE index (`s[..10]`), which can panic on a
//       multi-byte boundary (Rust).
//
// This harness locks the fixed invariants at the source level (same style as the
// other tests/*.mjs guards). It is failing-first: it fails on the pre-fix source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const ai = readFileSync(join(root, 'src-tauri', 'src', 'commands', 'ai.rs'), 'utf8');

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

console.log('# Mobile auto-OCR red-screen contract (bug #1)');

// (A) Front-end: the auto-OCR async function must not let a reject escape.
// Every `setTimeout(... mobileAutoStartOcrIfConfigured ...)` must attach a
// `.catch(` on the returned promise so the reject never reaches the global
// unhandledrejection handler (the red surface).
// Every invocation of the auto-OCR entry point that is scheduled from a
// setTimeout must chain a .catch on it. We locate each `mobileAutoStartOcr
// IfConfigured(<arg>)` call site inside a `setTimeout(function(){ ... },N)`
// and require the immediately following token to be `.catch(`.
const callSites = [
  ...html.matchAll(/setTimeout\(\s*function\s*\(\)\s*\{\s*(mobileAutoStartOcrIfConfigured\([^)]*\)(\.catch\()?)/g),
];
ok(callSites.length >= 3,
  `all auto-OCR setTimeout callers found (>=3, got ${callSites.length})`);
for (const m of callSites) {
  ok(m[2] !== undefined,
    `auto-OCR setTimeout caller attaches .catch() (site: ${m[1].slice(0, 60)}...)`);
}

// The async function itself must be self-guarded (try/catch) so a throw inside it
// is contained even if a future caller forgets the .catch.
const fnMatch = html.match(/async function mobileAutoStartOcrIfConfigured\(docId\)\s*\{([\s\S]*?)\n\}/);
ok(fnMatch, 'mobileAutoStartOcrIfConfigured is defined');
ok(/\btry\s*\{[\s\S]*\}\s*catch\b/.test(fnMatch[1]),
  'mobileAutoStartOcrIfConfigured body is wrapped in try/catch');

// (B) Rust: the raw model response must be truncated in parse_ai_result error text
// (no full raw dump flooding the red surface).
ok(/fn\s+truncate_raw\b/.test(ai) || /raw:\s*\{\}",\s*[a-z_]*e,\s*truncate/.test(ai) ||
   /truncate/.test(ai),
  'ai.rs has a raw-truncation helper/path for parse errors');
// The two parse_ai_result error sites must not embed the whole json_str verbatim.
const rawDumpSites = [...ai.matchAll(/Cannot parse AI response: \{\} — raw: \{\}",\s*e,\s*json_str\b/g)];
ok(rawDumpSites.length === 0,
  `no parse_ai_result error embeds the full json_str verbatim (found ${rawDumpSites.length})`);

// (B, UTF-8 safety) the date-normalisation slice must be codepoint-safe, not `s[..10]`.
ok(!/\bs\[\.\.10\]/.test(ai),
  'ai.rs does not byte-slice a &str with s[..10] (UTF-8 panic risk)');
ok(/s\.get\(\.\.10\)/.test(ai) || /chars\(\)\.take\(10\)/.test(ai),
  'ai.rs uses a codepoint-safe 10-char truncation (s.get(..10) or chars().take(10))');

console.log(`ALL GREEN: ${passed} red-screen (bug #1) checks passed`);

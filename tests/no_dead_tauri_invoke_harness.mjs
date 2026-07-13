// Regression guard: no USER-REACHABLE Tauri invoke may reference a command that
// is not defined in src-tauri. That is the "UI calls a nonexistent #[command]"
// class — it throws at runtime the moment the user hits that path.
//
// Context (2026-07-13, curator A2). The seafarer audit flagged sign-in / device-
// recovery UI as "broken buttons": dist invokes `sign_self_session_challenge`
// and `sign_identity_recovery_payload`, which have NO Rust command. Independent
// investigation showed BOTH are behind feature flags (my_contribution_live /
// recovery_bind[_live] / recovery_lost_device[_live]) that default OFF and that
// the app NEVER enables (no setItem) — so a normal invited seafarer never reaches
// them. They are latent, not launch-reachable. This harness locks that invariant:
//   1) The ONLY dead invokes allowed are the known dev-flagged whitelist below.
//      Any NEW invoke of an undefined command fails (the real regression).
//   2) A whitelisted dead invoke must stay UNREACHABLE: the app must never ENABLE
//      its gating flag (no `setItem(<flag>, '1')`). If someone wires a toggle that
//      turns the flag on while the command is still undefined, this fails.
// When the two commands are eventually implemented in Rust, they drop out of the
// dead set automatically and the whitelist becomes a no-op.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');

// 1. Every statically-named invoke('cmd') in dist.
const invoked = new Set();
for (const m of html.matchAll(/invoke\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) invoked.add(m[1]);

// 2. Every #[tauri::command] / #[command] fn name in src-tauri/src.
function rustFiles(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rustFiles(p, acc);
    else if (name.endsWith('.rs')) acc.push(p);
  }
  return acc;
}
const rustDefs = new Set();
for (const f of rustFiles(join(root, 'src-tauri', 'src'), [])) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/#\[(?:tauri::)?command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/g)) {
    rustDefs.add(m[1]);
  }
}

// Known dev-flagged, off-by-default, no-UI-enable → latent, not user-reachable.
// value = the gating flag keys the app must NEVER set to '1' while the command is undefined.
const WHITELIST = {
  sign_self_session_challenge: ['skipi_seafarer_my_contribution_live'],
  sign_identity_recovery_payload: [
    'skipi_seafarer_recovery_bind',
    'skipi_seafarer_recovery_bind_live',
    'skipi_seafarer_recovery_lost_device',
    'skipi_seafarer_recovery_lost_device_live',
  ],
};

let fail = 0;
const dead = [...invoked].filter((c) => !rustDefs.has(c));

for (const c of dead) {
  if (!(c in WHITELIST)) {
    console.error(`FAIL: dist invokes '${c}' but no #[tauri::command] defines it — user-reachable dead invoke (throws at runtime).`);
    fail = 1;
  } else {
    console.log(`OK: dead invoke '${c}' is dev-flagged (whitelisted, off by default).`);
  }
}

// Whitelisted dead invokes must stay UNREACHABLE: the app must never enable their flags.
for (const [cmd, flags] of Object.entries(WHITELIST)) {
  if (!dead.includes(cmd)) { console.log(`OK: '${cmd}' now has a Rust command (whitelist no-op).`); continue; }
  for (const flag of flags) {
    const enableRe = new RegExp(`setItem\\(\\s*['"]${flag}['"]\\s*,\\s*['"]1['"]`);
    if (enableRe.test(html)) {
      console.error(`FAIL: app ENABLES gating flag '${flag}' for undefined command '${cmd}' — exposes a throwing invoke to users.`);
      fail = 1;
    }
  }
  console.log(`OK: '${cmd}' gating flags never enabled by app (stays unreachable).`);
}

if (fail) {
  console.error('\n>>> A user-reachable UI path invokes a Tauri command with no Rust definition — it throws.');
  console.error('>>> Fix: implement the command, hide the entry point, or (if intentionally dev-flagged) ensure the app never enables its flag.');
  process.exit(1);
}
console.log(`OK: no user-reachable dead Tauri invokes (${invoked.size} invoked, ${rustDefs.size} defined, ${dead.length} dev-flagged).`);
process.exit(0);

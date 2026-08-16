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

// ---------------------------------------------------------------------------
// 2. assistant_chat non-blocking contract (№140, 2026-08-16).
//
// Bug: `assistant_chat` was a synchronous #[tauri::command] doing
// reqwest::blocking HTTP (timeout 70s). Tauri v2 runs non-async commands on
// the main thread, so sending a chat message froze the entire webview until
// the reply arrived. The vault conn mutex was also held across the whole
// network exchange (profile + key + chat + 401 retry), which would freeze
// every other vault command even after the command went async.
//
// Contract locked here (mechanical, source-level, on src-tauri/src/commands/assistant.rs):
//   C1.  assistant_chat is declared `#[tauri::command] pub async fn`.
//   C1b. assistant.rs delegates blocking work via tauri::async_runtime::spawn_blocking.
//   C2.  in every fn of assistant.rs that takes the conn lock, network tokens
//        (ensure_key / post_authed / post_json / .send) appear ONLY inside
//        spawn_blocking closures — never on the command's direct path.
//   C3.  no spawn_blocking closure touches state.conn / the conn lock
//        (network work never runs while holding the vault lock).
//   C4.  every conn.lock() sits in an innermost brace block that does not
//        contain spawn_blocking (guard scope closes before the blocking task).
// Limitations: literal/comment stripping is heuristic (no raw strings in the
// file); this is a source contract, not a runtime scheduler test.

const asstPath = join(root, 'src-tauri', 'src', 'commands', 'assistant.rs');
const asstRaw = readFileSync(asstPath, 'utf8');

// Blank out string/char literals and comments (length-preserving) so brace
// and paren matching is not confused by braces inside text.
function blankLiterals(sr) {
  let out = '';
  let i = 0;
  const n = sr.length;
  while (i < n) {
    const c = sr[i];
    if (c === '/' && sr[i + 1] === '/') {
      let j = i;
      while (j < n && sr[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '/' && sr[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(sr[j] === '*' && sr[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && sr[j] !== '"') {
        if (sr[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      out += '"' + ' '.repeat(Math.max(0, j - i - 2)) + '"';
      i = j;
      continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(sr.slice(i, i + 5));
      if (m) {
        out += "'" + ' '.repeat(m[0].length - 2) + "'";
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const asst = blankLiterals(asstRaw);

function matchDelim(s, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// fn spans (all fns in assistant.rs are top-level; signatures contain no braces).
const fnSpans = [];
for (const m of asst.matchAll(/(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)) {
  const open = asst.indexOf('{', m.index);
  if (open === -1) continue;
  const close = matchDelim(asst, open, '{', '}');
  if (close === -1) continue;
  fnSpans.push({ name: m[1], open, close });
}

// spawn_blocking(...) call spans.
const spawnSpans = [];
for (const m of asst.matchAll(/spawn_blocking/g)) {
  const open = asst.indexOf('(', m.index);
  if (open === -1) continue;
  const close = matchDelim(asst, open, '(', ')');
  if (close === -1) continue;
  spawnSpans.push({ open, close });
}
const inSpawn = (idx) => spawnSpans.some((s) => idx > s.open && idx < s.close);

// C1: command must be async.
if (!/#\[tauri::command\]\s*pub\s+async\s+fn\s+assistant_chat\b/.test(asst)) {
  console.error('FAIL: assistant_chat is not `#[tauri::command] pub async fn` — a sync command runs on the main thread and freezes the webview for the whole HTTP round-trip (№140).');
  fail = 1;
} else {
  console.log('OK: assistant_chat is an async #[tauri::command].');
}

// C1b: blocking work must be delegated off the async runtime.
if (spawnSpans.length === 0) {
  console.error('FAIL: assistant.rs never uses tauri::async_runtime::spawn_blocking — blocking reqwest HTTP would run on the main thread / async runtime (№140).');
  fail = 1;
} else {
  console.log(`OK: assistant.rs delegates blocking work via spawn_blocking (${spawnSpans.length} task(s)).`);
}

// C2: in lock-taking fns, network tokens only inside spawn_blocking closures.
const netRe = /(?:\bensure_key|\bpost_authed|\bpost_json|\.send)\s*\(/g;
for (const f of fnSpans) {
  const body = asst.slice(f.open, f.close + 1);
  if (!body.includes('.conn.lock(')) continue;
  for (const m of body.matchAll(netRe)) {
    const abs = f.open + m.index;
    if (!inSpawn(abs)) {
      console.error(`FAIL: fn ${f.name} takes the conn lock and calls network token '${m[0].trim()}' outside spawn_blocking — HTTP on the command's direct path (№140).`);
      fail = 1;
    }
  }
}

// C3: no spawn_blocking closure touches the conn lock.
for (const s of spawnSpans) {
  const t = asst.slice(s.open, s.close + 1);
  if (t.includes('.conn.lock(') || t.includes('state.conn')) {
    console.error('FAIL: a spawn_blocking closure touches state.conn / the conn lock — network task would hold the vault lock (№140).');
    fail = 1;
  }
}

// C4: each conn.lock() lives in an innermost brace block without spawn_blocking.
const bracePairs = [];
{
  const stack = [];
  for (let i = 0; i < asst.length; i++) {
    if (asst[i] === '{') stack.push(i);
    else if (asst[i] === '}') {
      const o = stack.pop();
      if (o !== undefined) bracePairs.push([o, i]);
    }
  }
}
for (const m of asst.matchAll(/\.conn\.lock\(/g)) {
  let best = null;
  for (const [o, c] of bracePairs) {
    if (o < m.index && m.index < c && (best === null || c - o < best[1] - best[0])) best = [o, c];
  }
  if (best && asst.slice(best[0], best[1]).includes('spawn_blocking')) {
    console.error('FAIL: a conn.lock() guard scope encloses spawn_blocking — the vault lock would be held across the blocking network task (№140).');
    fail = 1;
  }
}

if (!fail) {
  console.log('OK: assistant_chat non-blocking contract holds (async command, HTTP only in spawn_blocking, conn lock never held across network).');
}

if (fail) {
  console.error('\n>>> A user-reachable UI path invokes a Tauri command with no Rust definition — it throws.');
  console.error('>>> Fix: implement the command, hide the entry point, or (if intentionally dev-flagged) ensure the app never enables its flag.');
  process.exit(1);
}
console.log(`OK: no user-reachable dead Tauri invokes (${invoked.size} invoked, ${rustDefs.size} defined, ${dead.length} dev-flagged).`);
process.exit(0);

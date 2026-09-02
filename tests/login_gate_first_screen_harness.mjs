// Regression guard — №162b (App Review 2.1(a) reject №2, 2026-09-02, Skipi
// Seafarer iOS 0.4.185 / build 4185, iPad Air 11" iPadOS 26.6.1):
//   "we had no option to log in"
//
// Root cause (source-level, reproduced on the iPad simulator): the hard login
// gate (#login-gate-overlay, №117) was raised ONLY from loadVault(), i.e. only
// AFTER a vault existed. On a fresh install init() found no vault and went
// straight to the mobile profile wizard (9 steps of personal data) / the
// welcome screen ("Create mobile vault / Open existing vault / Open demo
// vault"). None of those screens has a Sign in action, so a reviewer holding
// the demo credentials had nowhere to enter them.
//
// Contract locked here (mechanical, source-level):
//   G1. the gate markup still offers email + password + a Sign in submit.
//   G2. init(): when no vault could be opened, the gate is raised BEFORE any
//       welcome screen / profile wizard call, guarded by the token check.
//   G3. doAppLogin(): a login accepted with no vault open resumes the startup
//       landing (continuation), not only a pending vault.
//   G4. loadVault(): the per-vault hard gate is preserved (no weakening).
//   G5. app_login.rs: app_login no longer refuses to run without an open vault
//       ("No vault open" is not on the path before the network call); the
//       accepted login is parked in PendingLogin and persisted into the first
//       vault that opens via app_login_status -> persist_pending_login.
//   G6. lib.rs: AppState carries the login_pending slot.
// Limitations: source contract (brace matching, no AST); not a runtime test.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const rustLogin = readFileSync(join(root, 'src-tauri', 'src', 'commands', 'app_login.rs'), 'utf8');
const rustLib = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');

let passed = 0;
let fail = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    fail = 1;
    return;
  }
  passed += 1;
  console.log(`OK: ${msg}`);
}

// Body of the first `function name(` / `async function name(` (brace-matched).
function fnBody(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

// Body of a Rust `fn name(` (brace-matched, first occurrence).
function rustFnBody(src, name) {
  const re = new RegExp(`fn\\s+${name}\\s*[<(]`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function firstIndex(body, token) {
  const i = body.indexOf(token);
  return i === -1 ? Infinity : i;
}

// G1 — gate markup: email, password, Sign in submit.
const gateStart = html.indexOf('id="login-gate-overlay"');
ok(gateStart !== -1, 'G1: #login-gate-overlay exists in dist');
const gate = html.slice(gateStart, gateStart + 4000);
ok(/id="lg-email"[^>]*type="email"/.test(gate), 'G1: gate has an email input');
ok(/id="lg-password"[^>]*type="password"|type="password"[^>]*id="lg-password"/.test(gate), 'G1: gate has a password input');
ok(/id="lg-submit"[^>]*onclick="doAppLogin\(\)"/.test(gate) && /id="lg-submit"[^>]*>Sign in</.test(gate), 'G1: gate has a visible "Sign in" submit wired to doAppLogin()');

// G2 — init(): gate first on the no-vault path.
const init = fnBody(html, 'init');
ok(init !== null, 'G2: init() found');
if (init !== null) {
  // The post-login continuation (`_loginGateNext=function(){...}`) names the
  // landing without calling it — strip it before ordering the calls.
  const calls = init.replace(/_loginGateNext\s*=\s*function\s*\(\)\s*\{[^}]*\};?/g, '');
  const iGate = firstIndex(calls, 'showLoginGate(');
  const iWelcome = firstIndex(calls, 'showWelcome(');
  const iWizard = firstIndex(calls, 'mobileStartVaultWizard(');
  const iLanding = Math.min(iWelcome, iWizard, firstIndex(calls, 'initNoVaultLanding('));
  ok(iGate !== Infinity, 'G2: init() raises the login gate when no vault could be opened');
  ok(iGate < iLanding, 'G2: in init() the login gate comes BEFORE the welcome screen / profile wizard (first screen = Sign in)');
  ok(/if\s*\(\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)\s*\)\s*\{[\s\S]*?showLoginGate\(\)/.test(init), 'G2: the init() gate is guarded by the negative cached-token check (a cached/pending login skips it)');
  ok(/_loginGateNext\s*=/.test(init), 'G2: init() installs the post-login continuation (welcome / wizard resumes only after Sign in)');
}

// G3 — doAppLogin(): continuation without a vault.
const doLogin = fnBody(html, 'doAppLogin');
ok(doLogin !== null, 'G3: doAppLogin() found');
if (doLogin !== null) {
  ok(doLogin.includes("await invoke('app_login'"), 'G3: doAppLogin() still signs in through the native app_login command');
  ok(/_loginGateNext/.test(doLogin), 'G3: doAppLogin() resumes the startup landing after a pre-vault login');
  ok(/if\s*\(\s*resume\s*\)\s*\{\s*await\s+loadVault\(resume\)/.test(doLogin), 'G3: doAppLogin() still resumes a pending vault after login');
}

// G4 — loadVault(): per-vault hard gate preserved.
const loadVault = fnBody(html, 'loadVault');
ok(loadVault !== null, 'G4: loadVault() found');
if (loadVault !== null) {
  ok(/if\s*\(\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)\s*\)\s*\{[\s\S]*?showLoginGate\(\)[\s\S]*?return;/.test(loadVault), 'G4: loadVault() still blocks the shell behind the login gate when the vault has no token (hard gate preserved)');
}

// G5 — Rust: pre-vault login parked and persisted; app_login runs without a vault.
ok(/struct\s+PendingLogin\b/.test(rustLogin), 'G5: app_login.rs declares PendingLogin (login accepted before the first vault exists)');
ok(/fn\s+persist_pending_login\s*\(/.test(rustLogin), 'G5: app_login.rs persists the pending login into the first opened vault (persist_pending_login)');
const appLogin = rustFnBody(rustLogin, 'app_login');
ok(appLogin !== null, 'G5: app_login command found');
if (appLogin !== null) {
  const iNoVault = firstIndex(appLogin, 'No vault open');
  const iSpawn = firstIndex(appLogin, 'spawn_blocking');
  ok(iSpawn !== Infinity, 'G5: app_login still does its HTTP in spawn_blocking (№162 non-blocking contract)');
  ok(iNoVault > iSpawn, 'G5: app_login does not refuse to sign in before a vault exists ("No vault open" is not on the path before the network call)');
  ok(/PendingLogin\s*\{/.test(appLogin), 'G5: app_login parks the accepted login when no vault is open');
}
const status = rustFnBody(rustLogin, 'app_login_status');
ok(status !== null, 'G5: app_login_status command found');
if (status !== null) {
  ok(!status.includes('ok_or("No vault open")'), 'G5: app_login_status answers (fail-closed) without an open vault instead of erroring');
}
ok(/persist_pending_login\s*\(/.test(rustFnBody(rustLogin, 'login_status_json') || '') || /persist_pending_login\s*\(/.test(status || ''), 'G5: the status path persists a pending login into the open vault');

// G6 — AppState slot.
const appState = /struct\s+AppState\s*\{[\s\S]*?\n\}/.exec(rustLib);
ok(appState !== null && /login_pending\s*:/.test(appState[0]), 'G6: AppState carries the login_pending slot');

if (fail) {
  console.error('login_gate_first_screen_harness: FAIL');
  process.exit(1);
}
console.log(`ALL GREEN: ${passed} login-gate-first-screen checks passed`);

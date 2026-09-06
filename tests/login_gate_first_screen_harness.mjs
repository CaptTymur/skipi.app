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

// G4 — loadVault(): per-vault hard gate preserved for every NON-demo vault.
// Canon «entry fork» (OWNER 06.09, DECISIONS (295)) п.3: the demo vault is the
// ONLY exception — it opens without a token, natively only — and the exception
// lives AT the gate itself: one token check, one predicate keyed on is_demo, no
// inner-function bypass, no other flag. is_demo is stamped in exactly one place
// (loadDemoVault, right after create_demo_vault_auto — Rust always writes
// is_demo=1 there), so no real vault can ever carry the exception.
const loadVault = fnBody(html, 'loadVault');
ok(loadVault !== null, 'G4: loadVault() found');
if (loadVault !== null) {
  ok(/if\s*\(\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)\s*&&\s*!\s*_efDemoNoLogin\(\s*info\s*\)\s*\)\s*\{[\s\S]*?showLoginGate\(\)[\s\S]*?return;/.test(loadVault), 'G4: loadVault() still blocks the shell behind the login gate when a NON-demo vault has no token (hard gate preserved; the only exception is the demo predicate at the gate itself)');
  ok((loadVault.match(/_hasLoginToken\(/g) || []).length === 1, 'G4: loadVault() has exactly one token check (no second, weaker path)');
  ok(!/function\s+_loadVault\w*\s*\(/.test(html), 'G4: no inner _loadVault* wrapper that could route a vault around the gate');
}
const demoPredicate = fnBody(html, '_efDemoNoLogin');
ok(demoPredicate !== null, 'G4: _efDemoNoLogin(info) exists (the demo exception predicate)');
if (demoPredicate !== null) {
  ok(/^\s*return\s+isNativeMobile\(\)\s*&&\s*String\(\(info\s*&&\s*info\.is_demo\)\|\|''\)\s*===\s*'1';\s*$/.test(demoPredicate), 'G4: the demo exception is EXACTLY native && info.is_demo === "1" — no other flag, store or platform');
}
const demoStamps = html.match(/\.is_demo\s*=\s*'1'/g) || [];
const demoLoader = fnBody(html, 'loadDemoVault') || '';
ok(demoStamps.length === 1 && /create_demo_vault_auto'\)[\s\S]*?info\.is_demo\s*=\s*'1'[\s\S]*?loadVault\(info\)/.test(demoLoader), 'G4: is_demo is stamped exactly once in dist — in loadDemoVault(), right after create_demo_vault_auto (the only demo-creating path)');

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

// G7 — entry fork «Sign in · Register · Demo» (canon (295), OWNER 06.09; card
// TASKCARD-2026-09-06-seafarer-mobile-entry-fork; Supervisor prep audit
// ff9dc253 П1–П14). Source-level forms the runtime drills (bundled_plugin_isolation
// harness, D1–D12) cannot see: the EXACT insertion form on both cold-start sites
// (the desktop gate stays — mutation «replace showLoginGate» must keep G2 red),
// exactly three doors, one Register URL, no static markup in the PRESERVE region.
const fork = fnBody(html, 'showEntryFork');
ok(fork !== null, 'G7: showEntryFork() exists');
if (fork !== null) {
  for (const door of ['sign-in', 'register', 'demo']) ok((fork.match(new RegExp(`'${door}'`, 'g')) || []).length === 1, `G7: fork renders the "${door}" door exactly once`);
  ok((fork.match(/_efDoorHtml\(/g) || []).length === 3, 'G7: fork has exactly three doors (no fourth door, no dismiss)');
  ok(/_efTxt\(\)/.test(fork), 'G7: fork copy comes from _efTxt() (UI language, like _lgTxt)');
}
const doorHtml = fnBody(html, '_efDoorHtml') || '';
ok(/data-qa="'\+qa\+'"/.test(doorHtml) && /<button\b/.test(doorHtml) && (doorHtml.match(/<button\b/g) || []).length === 1, 'G7: each door is one <button data-qa=…> (harness hooks sign-in / register / demo)');
ok(/getUiLang\(\)/.test(fnBody(html, '_efTxt') || ''), 'G7: _efTxt() switches on getUiLang()');
if (init !== null) {
  const calls = init.replace(/_loginGateNext\s*=\s*function\s*\(\)\s*\{[^}]*\};?/g, '');
  // S1 (init, no vault): the native fork sits INSIDE the negative token check, BEFORE the kept desktop gate.
  ok(/if\s*\(\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)\s*\)\s*\{[^}]*?if\s*\(\s*isNativeMobile\(\)\s*\)\s*\{\s*showEntryFork\(\);\s*return;\s*\}[^}]*?showLoginGate\(\)/.test(calls), 'G7: S1 — init() shows the fork natively INSIDE the no-token branch, BEFORE the (kept) desktop gate');
  // S2-cold (init, remembered vault): token checked natively BEFORE loadVault(); vault parked for Sign in; a remembered DEMO is closed + forgotten (demo is not a session).
  const s2 = init.slice(init.indexOf("invoke('open_vault'"), init.indexOf('shouldUseMobileShell()'));
  ok(s2.length > 0 && /isNativeMobile\(\)\s*&&\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)/.test(s2), 'G7: S2-cold — init() checks the token natively before handing the remembered vault to loadVault()');
  ok(/_loginGatePending\s*=\s*info;\s*showEntryFork\(\);\s*return;/.test(s2), 'G7: S2-cold — the vault is parked (_loginGatePending=info) and the fork shown; Sign in resumes the SAME vault');
  ok(/close_vault',\s*\{\s*forget\s*:\s*true\s*\}/.test(s2) && /_efOpenVaultIsDemo\(\)/.test(s2), 'G7: S2-cold — a remembered DEMO vault is closed + forgotten (close_vault{forget:true}), never auto-opened');
  ok(/\}\s*else\s*\{\s*await\s+loadVault\(info\);\s*return;\s*\}/.test(s2), 'G7: S2-cold — with a session (or on desktop) the remembered vault still loads as today');
}
ok((html.match(/'https:\/\/assistant\.skipi\.app\/register'/g) || []).length === 1, 'G7: exactly one Register URL literal in dist (the fork reuses openRegisterPage)');
ok(/openRegisterPage\(\)/.test(fnBody(html, 'entryForkRegister') || ''), 'G7: the Register door calls openRegisterPage()');
ok(/loadDemoVault\(\)/.test(fnBody(html, 'entryForkDemo') || ''), 'G7: the Demo door calls the existing loadDemoVault()');
ok(/_efGateClosed\(\)/.test(fnBody(html, 'hideLoginGate') || ''), 'G7: hideLoginGate() hides the JS «← Back» link + consumes the fork history marker');
ok(/history\.pushState\(\s*\{\s*skipiEntryFork\s*:\s*true\s*\}/.test(fnBody(html, 'entryForkSignIn') || ''), 'G7: the Sign in door pushes ONE distinct history marker (skipiEntryFork)');
const popstates = [...html.matchAll(/addEventListener\(\s*['"]popstate['"]\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)\s*;/g)];
ok(popstates.some((m) => /_efHistMark/.test(m[1]) && /entryForkGateBack\(\)/.test(m[1])), 'G7: a popstate listener on our marker returns from the gate to the fork (Android Back)');
const leave = fnBody(html, 'entryForkLeaveDemo') || '';
ok(/close_vault',\s*\{\s*forget\s*:\s*true\s*\}/.test(leave) && /_loginGatePending\s*=\s*null/.test(leave) && /showEntryFork\(\)/.test(leave) && !/showLoginGate\(\)/.test(leave), 'G7: leaving the demo closes + forgets it and lands on the fork with NO vault parked (the token is never written into the demo)');
const banner = fnBody(html, 'mobileRenderAssistantChat') || '';
ok(/isNativeMobile\(\)\s*\?[^:]*data-qa="assistant-demo-signin"[^:]*entryForkLeaveDemo\(\)/.test(banner), 'G7: the demo banner offers the way back (assistant-demo-signin → entryForkLeaveDemo) natively only');
const logout = fnBody(html, 'appLogoutToGate') || '';
ok(/if\s*\(\s*isNativeMobile\(\)\s*\)\s*\{[\s\S]*?showEntryFork\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?showLoginGate\(\)/.test(logout), 'G7: Sign out → fork natively (one rule: no session → fork), the gate on desktop');
ok(/_efOpenVaultIsDemo\(\)/.test(logout) && /close_vault',\s*\{\s*forget\s*:\s*true\s*\}/.test(logout), 'G7: Sign out while the demo is open closes + forgets it (no token into the demo)');
const gateMarkup = html.slice(html.indexOf('id="login-gate-overlay"'), html.indexOf('id="update-banner"'));
ok(!/lg-back|entry-fork/.test(gateMarkup), 'G7: the gate static markup is untouched — «← Back» is inserted by JS (PRESERVE sha region)');
ok(!/id="mobile-entry-fork"/.test(html), 'G7: the fork has no static markup — rendered by JS (PRESERVE sha region)');
ok(!/\b(free|бесплатн|PRO\b|\$\d)/i.test(fnBody(html, '_efTxt') || 'free'), 'G7: fork copy carries no free/PRO/price wording');

if (fail) {
  console.error('login_gate_first_screen_harness: FAIL');
  process.exit(1);
}
console.log(`ALL GREEN: ${passed} login-gate-first-screen checks passed`);

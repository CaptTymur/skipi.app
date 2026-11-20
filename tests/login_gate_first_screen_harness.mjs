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
//   E1–E4 (tasks/003, 2026-11-20): sign-in failures reach the user as human
//       texts in the UI language — classified in Rust as LoginError {code,
//       detail} (network / credentials / rate_limited / rejected / other), the
//       frontend maps the code and never parses an English string; "other"
//       keeps the technical detail as a small line UNDER the main text.
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
  // G8 / S3 (Supervisor Н1, AUDIT-2026-09-06-seafarer-entry-fork-close): the RECENT list is a third
  // cold-start site. close_vault{forget:true} empties the config, but the demo stays on disk and the
  // Android get_recent_vaults scan re-finds it — so this loop MUST carry the same native no-session
  // check as S2-cold, or a bare gate goes up over an OPEN demo vault and app_login writes the token
  // into the demo. Structural, not cosmetic: BOTH loadVault() sites in init() are guarded, and no
  // third one may appear.
  const s3 = init.slice(init.indexOf("get_recent_vaults"), init.indexOf('checkForUpdate('));
  ok(s3.length > 0 && /isNativeMobile\(\)\s*&&\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)/.test(s3), 'G8: S3 — the recent-vaults loop checks the token natively BEFORE handing a vault to loadVault()');
  ok(/_loginGatePending\s*=\s*rinfo;\s*showEntryFork\(\);\s*return;/.test(s3), 'G8: S3 — a token-less recent vault is parked and the fork shown (Sign in resumes the SAME vault)');
  ok(/_efOpenVaultIsDemo\(\)/.test(s3) && /close_vault',\s*\{\s*forget\s*:\s*true\s*\}/.test(s3), 'G8: S3 — a recent DEMO is closed + forgotten (checked against the vault on disk, get_profile_status.is_demo), never auto-opened');
  ok(!/showLoginGate\(/.test(s3), 'G8: S3 — the recent path never raises the bare login gate (Н1: it used to, over an open demo vault)');
  const initCode = init.replace(/^\s*\/\/.*$/gm, ''); // prose mentions loadVault() too
  ok((initCode.match(/loadVault\(/g) || []).length === 2, 'G8: init() hands a vault to loadVault() from EXACTLY two sites (remembered + recent) — a third, unguarded one would bypass the fork');
  ok((initCode.match(/isNativeMobile\(\)\s*&&\s*!\s*\(\s*await\s+_hasLoginToken\(\)\s*\)/g) || []).length === 2, 'G8: BOTH loadVault() sites in init() sit behind the same native no-session guard');
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
// Owner 07.10 (1015): the banner moved into one builder shared by the chat and the native home grid.
const banner = fnBody(html, 'mobileAssistantDemoBannerHtml') || '';
ok(/isNativeMobile\(\)\s*\?[^:]*data-qa="assistant-demo-signin"[^:]*entryForkLeaveDemo\(\)/.test(banner), 'G7: the demo banner offers the way back (assistant-demo-signin → entryForkLeaveDemo) natively only');
ok(/mobileAssistantDemoBannerHtml\(\)/.test(fnBody(html, 'mobileRenderAssistantChat') || '') && /mobileAssistantDemoBannerHtml\(\)/.test(fnBody(html, 'renderMobileHome') || ''), 'G7: that single banner is what both the chat and the native home grid render (one source, owner 07.10)');
const logout = fnBody(html, 'appLogoutToGate') || '';
ok(/if\s*\(\s*isNativeMobile\(\)\s*\)\s*\{[\s\S]*?showEntryFork\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?showLoginGate\(\)/.test(logout), 'G7: Sign out → fork natively (one rule: no session → fork), the gate on desktop');
ok(/_efOpenVaultIsDemo\(\)/.test(logout) && /close_vault',\s*\{\s*forget\s*:\s*true\s*\}/.test(logout), 'G7: Sign out while the demo is open closes + forgets it (no token into the demo)');
const gateMarkup = html.slice(html.indexOf('id="login-gate-overlay"'), html.indexOf('id="update-banner"'));
ok(!/lg-back|entry-fork/.test(gateMarkup), 'G7: the gate static markup is untouched — «← Back» is inserted by JS (PRESERVE sha region)');
ok(!/id="mobile-entry-fork"/.test(html), 'G7: the fork has no static markup — rendered by JS (PRESERVE sha region)');
ok(!/\b(free|бесплатн|PRO\b|\$\d)/i.test(fnBody(html, '_efTxt') || 'free'), 'G7: fork copy carries no free/PRO/price wording');

// G8 (#320, 2026-09-14): the account-first Sign in door must not race its own
// history entry against the gate's.
//
// Observed on dist 0.4.192, 3 runs of 3, deterministic (seq5-18 of the browser
// receipt): hideAccountFirst() cleared _afHistMark and issued history.back();
// history.back() is delivered ASYNCHRONOUSLY, so it landed AFTER entryForkSignIn()
// had already pushed {skipiEntryFork} and raised the gate. The fork's popstate
// listener only checks its own flag — never whose entry actually popped — so it
// claimed the stray pop, cleared _efHistMark and called entryForkGateBack(),
// closing the login gate the user had just asked for and dropping them back on
// the fork. This is the entry screen Seafarer was already rejected over
// (App Review 2.1(a)), so it is guarded mechanically.
//
// The contract is a HANDOFF, not a delay: on the native path the single open
// entry is transferred from account-first to the gate, so there is no back() and
// no second push left to order. Back still works — one entry, owned by the fork
// listener.
// ONE predicate, used by the positive check AND by both negative drills below, so
// a drill can never pass against a laxer rule than the one guarding the product.
//
// It matches the WHOLE guarded statement, condition included. An earlier version
// matched only the two assignments; the Supervisor showed (C3-2) that this let the
// native-only guard be removed in two different ways with the suite still fully
// green — the regex saw WHAT was assigned but never UNDER WHICH CONDITION. The
// condition is the load-bearing part: without isNativeMobile() the handoff would
// fire on web and desktop too, where entryForkSignIn() is never called, so nothing
// would ever consume the adopted entry.
//
// Line comments are stripped first: the explanation above the fix necessarily
// mentions hideAccountFirst(), and an index-of over raw source would match that
// prose instead of the call. The contract is about the CODE.
function afSignInBody(source) {
  return (fnBody(source, 'accountFirstSignIn') || '').replace(/^\s*\/\/.*$/gm, '');
}
function nativeGuardedHandoff(source) {
  return /if\s*\(\s*isNativeMobile\(\)\s*&&\s*_afHistMark\s*\)\s*\{\s*_afHistMark\s*=\s*false\s*;\s*_efHistMark\s*=\s*true\s*;?\s*\}/.exec(afSignInBody(source));
}
const afSignIn = afSignInBody(html);
const handoff = nativeGuardedHandoff(html);
ok(handoff !== null, 'G8 (#320): accountFirstSignIn hands its history entry to the gate under the native-only guard (if(isNativeMobile()&&_afHistMark){_afHistMark=false;_efHistMark=true;})');
ok(handoff !== null && afSignIn.indexOf('hideAccountFirst()') > handoff.index, 'G8 (#320): the handoff happens BEFORE hideAccountFirst(), so no history.back() is ever issued on this path');

// Negative drills for the assertion above, reproducing exactly the two mutations
// that used to pass (Supervisor C3-2). These are pure in-memory string edits of a
// copy: nothing is written to disk, no product byte changes and no side effect is
// possible, so no stub is required. Each drill first asserts that it ACTUALLY
// applied — a replace that silently matched nothing would otherwise make its
// negative pass for the wrong reason, which is the same class of hole being closed.
const GUARD_LITERAL = 'if(isNativeMobile()&&_afHistMark){';
const drillE = html.replace(GUARD_LITERAL, 'if(_afHistMark){');
ok(drillE !== html, 'G8 (#320) drill E applied: the native-only guard literal is present to be mutated');
ok(nativeGuardedHandoff(drillE) === null, 'G8 (#320) NEGATIVE E: dropping isNativeMobile()&& — which would fire the handoff on web and desktop too — reddens the assertion above');
const drillF = html.replace(GUARD_LITERAL, 'if(true){');
ok(drillF !== html, 'G8 (#320) drill F applied: the native-only guard literal is present to be mutated');
ok(nativeGuardedHandoff(drillF) === null, 'G8 (#320) NEGATIVE F: replacing the condition with if(true) reddens the assertion above');
ok(/if\s*\(\s*!_afHistMark\s*\)\s*return\s*;/.test(fnBody(html, 'hideAccountFirst') || ''), 'G8 (#320): hideAccountFirst still early-returns on a cleared marker — this is what makes the handoff suppress the back()');
ok(/if\s*\(\s*!_efHistMark\s*\)\s*\{/.test(fnBody(html, 'entryForkSignIn') || ''), 'G8 (#320): entryForkSignIn still guards its pushState, so the adopted entry is never doubled');

// G9 — №707 S1 «one account — one profile» (OWNER (1023), 08.10) + №976 «вход → сразу в программу»
// (OWNER 06.11, task 001 19.11). The signed-in landing WITHOUT an open profile offers the account
// restore itself through the EXISTING restoreAccountProfile() flow — one explicit consent (№193),
// 'restored' → loadVault, 'empty' → an EMPTY ACCOUNT CACHE opened straight into the app (the home
// screen invites to fill the profile inside it). Every other outcome — consent declined, download
// failed, no live restore context — lands on the account screen: the reason beside «Retry», Sign out
// underneath. showWelcome() (the create / open / demo choice of a LOCAL profile) is no longer on the
// post-login path; the web shell alone keeps it. Source-level like G1–G8; the runtime drills live in
// bundled_plugin_isolation (D5, D11, 193, S1-1…S1-10). Cancel condition of the negative drills below:
// a later slice named by the owner that moves the landing again; until then they are drill-invariants.
const landing = fnBody(html, 'initNoVaultLanding');
ok(landing !== null, 'G9: initNoVaultLanding() found');
const autoLanding = fnBody(html, 'accountRestoreLanding');
ok(autoLanding !== null, 'G9: accountRestoreLanding() exists — the auto path lives OUTSIDE init()/doAppLogin (G3/G8 pins untouched)');
if (landing !== null) {
  const auto = autoLanding || '';
  const landingCode = landing.replace(/^\s*\/\/.*$/gm, '');
  ok(/await\s+accountRestoreLanding\(\)/.test(landing), 'G9: initNoVaultLanding() awaits the account restore landing');
  ok(/'restored'/.test(landing) && /'empty'/.test(landing) && /showAccountRestoreRetry\(outcome\)/.test(landing), 'G9 (№976): restored/empty end the landing IN the app; every other outcome goes to the account screen with Retry');
  // №976: the only showWelcome() left on the post-login path is the web shell's (no Tauri invoke
  // without the shim) and the last-resort catch around the Retry screen render itself.
  ok(/^\s*if\s*\(\s*window\.__SKIPI_WEBDESKTOP__\s*\)\s*\{\s*showWelcome\(\);\s*return;\s*\}/m.test(landingCode), 'G9 (№976): the web shell is the FIRST line of the landing and the only planned way to showWelcome()');
  ok((landingCode.match(/showWelcome\(/g) || []).length === 2 && /catch\s*\([^)]*\)\s*\{[^}]*showWelcome\(\)/.test(landingCode), 'G9 (№976): exactly two showWelcome() sites in the landing — the web shell and the catch around the Retry screen render; the create/open/demo choice is NOT a post-login outcome');
  ok(/локального волта как сущности нет/.test(landing) && /consent is still asked explicitly/i.test(landing), 'G9 (N3): the landing comment carries the owner word and the explicit-consent rule — behaviour and comment changed together');
  ok(/get_account_sync_status/.test(auto), 'G9 (N4): the auto path reads get_account_sync_status — trigger is the STATE logged_in && !profile_open, not the login event');
  ok(/logged_in\s*!==\s*true/.test(auto) && /profile_open\s*!==\s*false/.test(auto) && /restore_context/.test(auto), 'G9: without logged_in===true, profile_open===false and a live restore_context the auto path returns null');
  ok(/__SKIPI_WEBDESKTOP__/.test(auto), 'G9: the web shell never auto-restores (no Tauri invoke without the shim)');
  ok(/await\s+restoreAccountProfile\(\)/.test(auto), 'G9 (W1): the auto path REUSES restoreAccountProfile() — still the only caller of restore_account_profile');
  ok((html.match(/invoke\('restore_account_profile'/g) || []).length === 1, 'G9 (W1): exactly one restore_account_profile invoke site in dist');
  ok(!/loadVault\(/.test(auto) && !/loadVault\(/.test(landingCode), 'G9 (W1): neither landing function hands a vault to loadVault() itself — the G8 count of 2 in init() is untouched by construction');
  ok(!/mobileCreateProfile\(|startSeafarerWizard\(|mobileStartVaultWizard\(/.test(auto) && !/mobileCreateProfile\(|startSeafarerWizard\(|mobileStartVaultWizard\(/.test(landing), 'G9 (W5/D6): the landing never opens the wizard itself');
  ok(!/enable_account_sync|sync_account_now/.test(auto) && !/enable_account_sync|sync_account_now/.test(landing), 'G9 (№193): sign-in is not sync consent — the landing never enables or runs sync');
  ok(!/setTimeout|setInterval/.test(auto) && !/setTimeout|setInterval/.test(landing), 'G9: no timer-driven restore');
  ok(/_accountRestoreAutoTried/.test(auto), 'G9 (D7): one automatic attempt per sign-in context per process — a declined consent or a failed download hands back the Retry button, never a loop of consent prompts or server tokens');
  const retry = fnBody(html, 'accountRestoreRetry') || '';
  ok(/_accountRestoreAutoTried\s*=\s*null/.test(retry) && /initNoVaultLanding\(/.test(retry) && !/setTimeout|setInterval/.test(retry), 'G9 (№976, D7): accountRestoreRetry() re-arms the one attempt on the user\'s tap and re-runs the landing — never a timer');
  const restore = fnBody(html, 'restoreAccountProfile');
  ok(restore !== null && /return\s*'cancel'/.test(restore) && /return\s*'error'/.test(restore) && /return\s*'restored'/.test(restore) && /return\s*'empty'/.test(restore), 'G9: restoreAccountProfile() reports cancel/error/restored/empty');
  ok(restore !== null && /outcome\s*===\s*'empty'\s*\)\s*\{[\s\S]*?await\s+openEmptyAccountCache\(\)/.test(restore) && !/mobileCreateProfile\(|startSeafarerWizard\(|mobileStartVaultWizard\(/.test(restore.replace(/^\s*\/\/.*$/gm, '')), 'G9 (№976, W5/D6): "empty" comes only from the real result and opens the empty cache — no wizard anywhere in restoreAccountProfile()');
  ok(restore !== null && /accountRestoreLastError\s*=/.test(restore) && /accountRestoreLastError/.test(fnBody(html, 'showAccountRestoreRetry') || ''), 'G9 (D3): a failed download is shown beside Retry on the account screen (accountRestoreLastError)');
  // №976: the empty account cache — created without a form, bound to the account by loadVault()'s
  // app_login_status (persist_pending_login), reopened instead of duplicated.
  const cache = fnBody(html, 'openEmptyAccountCache') || '';
  ok(/invoke\('open_vault'/.test(cache) && /invoke\('create_vault'/.test(cache) && cache.indexOf("invoke('open_vault'") < cache.indexOf("invoke('create_vault'"), 'G9 (№976): openEmptyAccountCache() opens an existing cache for this account first, creates one only when none exists');
  ok(/accountType\s*:\s*'seafarer'/.test(cache) && /vaultFolderName\('Seafarer'/.test(cache) && /defaultVaultPath\(/.test(cache), 'G9 (№976): the cache is a seafarer profile in the default profile folder (Android: app data; desktop: Documents/Skipi)');
  ok((cache.match(/loadVault\(/g) || []).length === 1 && !/create_profile_vault|mobileStartVaultWizard|startSeafarerWizard/.test(cache), 'G9 (№976): the cache is handed to loadVault() exactly once — no wizard, no stcw/position form before the app');
  ok(!/is_demo\s*=/.test(cache), 'G9 (№976): the cache never stamps is_demo (the G4 demo exception stays single-sited)');
  // №976: the account screen after sign-in — Retry beside the reason, Sign out underneath, no local-profile doors.
  const retryScreen = fnBody(html, 'showAccountRestoreRetry') || '';
  ok(/data-account-restore-retry/.test(retryScreen) && /accountRestoreRetry\(\)/.test(retryScreen) && /appAccountControlsHtml\(\)/.test(retryScreen), 'G9 (№976): showAccountRestoreRetry() renders the marked screen with the Retry button and the account controls (Sign out)');
  ok(/Данные аккаунта не загружены/.test(retryScreen) && /Account data not downloaded/.test(retryScreen) && /'cancel'/.test(retryScreen), 'G9 (№976): RU/EN account screen names the declined-consent case separately from a failed download');
  ok(!/mobileCreateProfile\(|mobileOpenExistingVault\(|loadDemoVault\(|restoreAccountProfile\(/.test(retryScreen), 'G9 (№976): no create / open / demo / connect-account door on the account screen');
  ok(!/vault/i.test(retryScreen.replace(/^\s*\/\/.*$/gm, '')), 'G9 (vocabulary): the account screen strings carry no "vault"');
  const waitScreen = fnBody(html, 'showAccountRestoreLanding');
  ok(waitScreen !== null && /Загружаю профиль из аккаунта/.test(waitScreen) && /Downloading your profile from the account/.test(waitScreen), 'G9: the RU/EN waiting screen exists');
  ok(waitScreen !== null && !/vault/i.test(waitScreen.replace(/^\s*\/\/.*$/gm, '')), 'G9 (vocabulary): the new strings carry no "vault"');
  ok(/paintAccountRestoreScreen\(/.test(waitScreen || '') && /paintAccountRestoreScreen\(/.test(retryScreen), 'G9 (№976): waiting and account screens share ONE painter (mobile main / desktop account block)');
  ok(/accountRestoreLandingReset\(\)/.test(fnBody(html, 'showWelcome') || ''), 'G9: showWelcome() still clears the waiting state (web shell / last-resort path)');
  // №976: the one invitation on the native home — fill the profile INSIDE the app.
  const home = fnBody(html, 'renderMobileHome') || '';
  const banner = fnBody(html, 'mobileEmptyProfileBannerHtml') || '';
  ok(/mobileProfileEmpty/.test(home) && /mobileEmptyProfileBannerHtml\(\)/.test(home) && home.indexOf('mobileAssistantDemoBannerHtml()') < home.indexOf('mobileEmptyProfileBannerHtml()') && /else\s+if\s*\(\s*mobileProfileEmpty\s*\)/.test(home), 'G9 (№976): the native home shows the empty-profile banner only when the profile is empty AND not the demo (demo banner wins)');
  ok(/data-qa="empty-profile-banner"/.test(banner) && /openSettings\(\\'seafarer\\'\)/.test(banner) && !/mobileStartVaultWizard|mobileCreateProfile/.test(banner), 'G9 (№976): the banner\'s one button opens the profile form inside the app (openSettings(\'seafarer\')), not the vault wizard');
  ok(/mobileProfileEmpty\s*=\s*!\(info&&\(info\.rank\|\|info\.position\)\)/.test(fnBody(html, 'loadVault') || ''), 'G9 (№976): the empty verdict is taken from VaultInfo in loadVault() (no rank, no position)');
  ok(/mobileProfileEmpty/.test(fnBody(html, 'mobileDemoFlagSelfCheck') || ''), 'G9 (№976): the verdict is refreshed with the demo flag from get_profile_status (banner disappears after the first save)');
  // №976 (OWNER 19.11): the download consent after sign-in is ONE tap; the two statements stay in the
  // text; the checkboxes stay for enabling sync from Settings (№193 unchanged there).
  const consent = fnBody(html, 'oneAccountSyncRequestConsent') || '';
  ok(/var\s+oneTap\s*=\s*mode\s*===\s*'restore'/.test(consent) && /requiredChecks\s*:\s*oneTap\s*\?\s*\[\]\s*:\s*\[\s*n\.sync_label\s*,\s*n\.health_label\s*\]/.test(consent), 'G9 (№976): restore consent passes no required checks; enable consent keeps both');
  ok(/if\s*\(\s*oneTap\s*\)\s*html\s*\+=\s*'<p>'\s*\+\s*esc\(n\.sync_label\)/.test(consent), 'G9 (№976): the two consent statements are still shown as text in the one-tap dialog');
  // Negative drills — the structural shape is what protects the user, so prove the probes bite.
  const drillA = landing.replace(/await\s+accountRestoreLanding\(\)/, 'null');
  ok(!/await\s+accountRestoreLanding\(\)/.test(drillA), 'G9 NEGATIVE A: dropping the await reddens the first G9 probe');
  const drillB = html.replace(/await\s+restoreAccountProfile\(\)/, "await invoke('restore_account_profile',{consent:true})");
  ok((drillB.match(/invoke\('restore_account_profile'/g) || []).length === 2, 'G9 NEGATIVE B (N-D): a second restore_account_profile caller in dist makes the single-invoke-site probe count 2 — the probe bites');
  const drillC = landingCode.replace(/showAccountRestoreRetry\(outcome\)/, 'showWelcome()');
  ok((drillC.match(/showWelcome\(/g) || []).length === 3, 'G9 NEGATIVE C (№976): putting the create/open/demo choice back after sign-in makes the showWelcome() count 3 — the probe bites');
  const drillD = (fnBody(html, 'restoreAccountProfile') || '').replace(/await\s+openEmptyAccountCache\(\)/, 'await mobileCreateProfile()');
  ok(/mobileCreateProfile\(/.test(drillD.replace(/^\s*\/\/.*$/gm, '')), 'G9 NEGATIVE D (№976): routing "empty" back into the wizard reddens the no-wizard probe');
  // N-A (Supervisor point 2): the waiting-screen render is the only fail-open spot — a thrown DOM error must
  // land on the account screen with the error beside Retry, never an empty screen.
  ok(/try\s*\{\s*showAccountRestoreLanding\(status\)\s*;?\s*\}\s*catch\s*\(/.test(auto), 'G9 (N-A): showAccountRestoreLanding(status) is wrapped in try/catch inside accountRestoreLanding()');
  ok(/catch\s*\([^)]*\)\s*\{[^}]*accountRestoreLastError\s*=[^}]*return\s+null/.test(auto), 'G9 (N-A): a render failure records the error for the account screen and returns null');
  ok(/try\s*\{[^}]*await\s+accountRestoreLanding\(\)[^}]*\}\s*catch\s*\(/.test(landing) && /try\s*\{\s*showAccountRestoreRetry\(outcome\)\s*;?\s*\}\s*catch\s*\(/.test(landing), 'G9 (N-A): initNoVaultLanding() itself never rejects — restore AND the Retry screen render are both caught (un-awaited callers in init()/_loginGateNext)');
}

// ---------------------------------------------------------------------------
// №1914 — vessel flags. Added to THIS file deliberately and the reason is
// mechanical, not thematic: the guard route that admits a dist/index.html edit
// (`entry-fork-187`) requires exactly {dist/index.html, this harness}, and a
// brand-new tests/*_harness.mjs would land outside every allowed pattern and be
// refused at push. Manager's word, 2026-11-16.
//
// Unlike the contracts above these drills EXECUTE the shipped code: the flag
// table and the combobox are pulled out of dist/index.html and run against a
// DOM stub, because the defect №1914 names ("a value outside the list is wiped
// without a word") is BEHAVIOUR on blur — a source match would not see it.
//
// F1. the table carries 249 countries + the 3 register variants, each row
//     [canonical, russian, ...aliases], no duplicates.
// F2. Belgium/Бельгия: findable by either spelling, labelled bilingually in RU,
//     and the STORED value stays the canonical English one.
// F3. an unlisted typed value survives blur and is labelled (the defect), while
//     a field attached WITHOUT the opt-in still clears — so airports and the
//     other closed lists keep their old behaviour.
{
  const fnSource = (src, name) => {
    const re = new RegExp(`function\\s+${name}\\s*\\(`);
    const m = re.exec(src);
    if (!m) return null;
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    return null;
  };

  const tableStart = html.indexOf('var MARITIME_FLAGS_I18N = [');
  const tableEnd = html.indexOf('];', tableStart);
  ok(tableStart !== -1 && tableEnd !== -1, 'F1: the flag table MARITIME_FLAGS_I18N is present in dist/index.html');
  const tableSrc = html.slice(tableStart, tableEnd + 2);

  const registersStart = html.indexOf('var MARITIME_FLAG_REGISTERS = [');
  const registersSrc = html.slice(registersStart, html.indexOf('];', registersStart) + 2);
  ok(registersStart !== -1, 'F1: the register-variant rows are named explicitly in the data (not guessed from brackets)');
  const pieces = [
    tableSrc,
    registersSrc,
    'var MARITIME_FLAGS = MARITIME_FLAGS_I18N.map(function(r){ return r[0]; });',
    // the lazy index declaration: extracting _maritimeFlagRow without it is
    // exactly the omission that reddened the unified-settings harness (№957)
    'var _maritimeFlagIndex = null;',
    fnSource(html, '_maritimeFlagRow'),
    fnSource(html, 'maritimeFlagLabel'),
    fnSource(html, 'maritimeFlagSearchText'),
    fnSource(html, 'maritimeFlagComboOptions'),
    fnSource(html, 'workFormListWithCurrent'),
    fnSource(html, 'attachClosedCombobox'),
  ];
  ok(pieces.every((p) => typeof p === 'string' && p.length > 0),
    'F1: table + the five flag helpers + attachClosedCombobox all extract from dist/index.html');

  // --- minimal DOM stub: only what attachClosedCombobox touches.
  const makeStub = () => {
    const mk = (tag) => {
      const el = {
        tagName: tag, className: '', innerHTML: '', textContent: '', hidden: false,
        value: '', dataset: {}, children: [], parentNode: null,
        _cls: new Set(), _handlers: {},
        classList: {
          add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); },
          contains(c) { return el._cls.has(c); },
        },
        setAttribute() {}, removeAttribute() {},
        appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
        insertBefore(c) { el.children.push(c); c.parentNode = el; return c; },
        addEventListener(ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn); },
        fire(ev, arg) { (el._handlers[ev] || []).forEach((fn) => fn(arg || { key: '', preventDefault() {} })); },
        querySelector() { return null; },
      };
      return el;
    };
    const input = mk('input');
    const parent = mk('div');
    parent.appendChild(input);
    return { input, document: { createElement: mk } };
  };

  const build = (stub, uiLang) => {
    const factory = new Function(
      'document', 'getUiLang', 'setTimeout',
      pieces.join('\n') + '\nreturn { MARITIME_FLAGS: MARITIME_FLAGS, MARITIME_FLAG_REGISTERS: MARITIME_FLAG_REGISTERS, maritimeFlagLabel: maritimeFlagLabel, maritimeFlagSearchText: maritimeFlagSearchText, maritimeFlagComboOptions: maritimeFlagComboOptions, workFormListWithCurrent: workFormListWithCurrent, attachClosedCombobox: attachClosedCombobox };'
    );
    return factory(stub.document, () => uiLang, setTimeout);
  };

  const api = build(makeStub(), 'en');
  const rows = api.MARITIME_FLAGS;

  // F1 — shape of the population, counted here rather than trusted.
  const registers = api.MARITIME_FLAG_REGISTERS;
  ok(rows.length === 252, `F1: the list carries 252 entries (got ${rows.length})`);
  ok(registers.length === 3 && registers.every((r) => rows.indexOf(r) !== -1),
    `F1: 3 named register variants, all present as rows (${registers.join(', ')})`);
  ok(rows.length - registers.length === 249,
    `F1: that leaves 249 countries — the full ISO 3166-1 set the owner asked for (got ${rows.length - registers.length})`);
  // Counting brackets instead would say 8: five ISO names carry their own.
  ok(rows.filter((r) => r.indexOf('(') !== -1).length === 8,
    'F1: and the reason the count is NAMED and not derived from brackets — 8 rows contain brackets, only 3 are registers');
  ok(new Set(rows).size === rows.length, 'F1: no duplicate canonical value');
  ok(rows.every((r) => typeof r === 'string' && r.trim() !== ''), 'F1: every canonical value is a non-empty string');
  const ruMissing = rows.filter((r) => {
    const t = api.maritimeFlagSearchText(r);
    return !/[Ѐ-ӿ]/.test(t);
  });
  ok(ruMissing.length === 0, `F1: every row carries a Cyrillic (Russian) search term (rows without: ${ruMissing.length})`);

  // F2 — the owner's own calibration, both spellings.
  const findBy = (q) => rows.filter((it) => api.maritimeFlagSearchText(it).toLowerCase().indexOf(q.toLowerCase()) !== -1);
  ok(rows.indexOf('Belgium') !== -1, 'F2: Belgium is in the list');
  ok(findBy('Belgium').indexOf('Belgium') !== -1, 'F2: typing "Belgium" finds it');
  ok(findBy('Бельгия').indexOf('Belgium') !== -1, 'F2: typing "Бельгия" finds it too — Russian is a search term');
  ok(findBy('бель').indexOf('Belgium') !== -1, 'F2: a partial Russian query ("бель") finds it');
  const ruApi = build(makeStub(), 'ru');
  ok(ruApi.maritimeFlagLabel('Belgium') === 'Belgium — Бельгия',
    `F2: the RU dropdown label is bilingual (got ${JSON.stringify(ruApi.maritimeFlagLabel('Belgium'))})`);
  ok(api.maritimeFlagLabel('Belgium') === 'Belgium',
    'F2: the EN dropdown label stays plain English');
  ok(ruApi.maritimeFlagLabel('UK') === 'UK — Соединённое Королевство' && findBy('United Kingdom').indexOf('UK') !== -1,
    'F2: the nine historical spellings are kept as stored values and carry the ISO name as an alias ("UK" is not renamed)');
  // The stored value is what the CV will print, so it must be the canonical one.
  ok(rows.indexOf('Бельгия') === -1, 'F2: the Russian name is NOT a stored value — the generated CV stays English');

  // F3 — the defect itself, on blur, executed.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const typeAndBlur = async (opts, typed) => {
    const stub = makeStub();
    const built = build(stub, 'en');
    built.attachClosedCombobox(stub.input, built.workFormListWithCurrent(built.MARITIME_FLAGS, ''), opts);
    stub.input.value = typed;
    stub.input.fire('input');
    stub.input.fire('blur');
    await wait(260);
    const note = (stub.input.parentNode.children || []).find((c) => c.className === 'combobox-note');
    return { value: stub.input.value, note };
  };

  const kept = await typeAndBlur(api.maritimeFlagComboOptions(), 'Bangladesh-Chittagong registry');
  ok(kept.value === 'Bangladesh-Chittagong registry',
    `F3: a value outside the list SURVIVES blur on a flag field (got ${JSON.stringify(kept.value)})`);
  ok(!!kept.note && kept.note.hidden === false && /Not in the list|Нет в списке/.test(kept.note.textContent),
    `F3: and it is labelled beside the control, not dropped in silence (note: ${JSON.stringify(kept.note && kept.note.textContent)})`);

  const listed = await typeAndBlur(api.maritimeFlagComboOptions(), 'Belgium');
  ok(listed.value === 'Belgium', 'F3: a listed value is untouched by blur');
  ok(!!listed.note && listed.note.hidden === true, 'F3: and carries no "not in the list" note');

  // F3 CONTROL — the opt-in is what changed behaviour; without it the old
  // closed-list clearing must still happen, or this fix silently altered every
  // other combobox in the app (airport hubs).
  const wiped = await typeAndBlur(undefined, 'Bangladesh-Chittagong registry');
  ok(wiped.value === '', `F3 CONTROL: a field attached WITHOUT the opt-in still clears an unlisted value (got ${JSON.stringify(wiped.value)}) — airports keep their behaviour`);

  // F3 NEGATIVE — prove the probes bite rather than pass vacuously.
  const comboSrc = fnSource(html, 'attachClosedCombobox');
  const drill1 = comboSrc.replace("if(!keepUnlisted && list.indexOf(inputEl.value)===-1) inputEl.value='';",
                                  "if(list.indexOf(inputEl.value)===-1) inputEl.value='';");
  ok(drill1 !== comboSrc && !/!keepUnlisted && list\.indexOf/.test(drill1),
    'F3 NEGATIVE: putting the unconditional wipe back changes the source the probe reads — the guard is on that exact line');
  ok(/keepUnlisted/.test(comboSrc) && /syncNote\(\)/.test(comboSrc),
    'F3 NEGATIVE: the shipped combobox still contains both the opt-in and the note call the drills above exercised');

  // All three flag fields reach one list — before №1914 only the desktop one had any.
  ok(/attachMaritimeFlagCombobox\('mwh-flag'/.test(html), 'F4: the mobile Sea Service flag field is attached to the shared list');
  ok(/attachMaritimeFlagCombobox\('vw-flag'/.test(html), 'F4: the vessel wizard flag field is attached to the shared list');
  ok(/attachClosedCombobox\(flagEl,flagList,maritimeFlagComboOptions\(\)\)/.test(html), 'F4: the desktop Sea Service flag field passes the flag options');
}

// ── E. Human-readable sign-in errors (tasks/003, 2026-11-20) ────────────────
// Before: offline sign-in showed the raw reqwest string
// ("assistant.skipi.app network: error sending request …"), in English,
// regardless of the UI language; 403/429 came as English sentences baked into
// app_login.rs and the frontend printed whatever it got.
{
  const rust = rustLogin;
  // E1 — Rust-side classification.
  ok(/struct\s+LoginError\b/.test(rust), 'E1: app_login.rs declares LoginError (code + detail)');
  ok(/derive\([^)]*Serialize[^)]*\)\]\s*(?:pub(?:\(crate\))?\s+)?struct\s+LoginError\b/.test(rust), 'E1: LoginError is Serialize (reaches JS as an object, not a string)');
  for (const code of ['network', 'credentials', 'rate_limited', 'other']) {
    ok(new RegExp(`"${code}"`).test(rust), `E1: app_login.rs emits code "${code}"`);
  }
  ok(/403\s*=>[^,]*credentials/.test(rust), 'E1: HTTP 403 → code credentials');
  ok(/429\s*=>[^,]*rate_limited/.test(rust), 'E1: HTTP 429 → code rate_limited');

  // E2 — the structured error leaves the command; no English network string.
  ok(/pub\s+async\s+fn\s+app_login\s*\([\s\S]*?\)\s*->\s*Result<Value,\s*LoginError>/.test(rust), 'E2: app_login returns Result<Value, LoginError>');
  ok(!/assistant\.skipi\.app network:/.test(rust), 'E2: the raw "assistant.skipi.app network: …" formatting is gone');

  // E3 — texts in both UI languages.
  const lgTxt = fnBody(html, '_lgTxt');
  ok(lgTxt !== null, 'E3: _lgTxt() found');
  if (lgTxt) {
    const ru = {
      net: 'Нет связи с сервером Skipi. Проверьте интернет и повторите.',
      creds: 'Неверный email или пароль.',
      rate: 'Слишком много попыток. Подождите минуту.',
      failed: 'Не удалось войти. Повторите позже.',
    };
    for (const [k, v] of Object.entries(ru)) {
      ok(lgTxt.includes(`${k}:'${v}'`), `E3: RU text ${k} = «${v}»`);
    }
    for (const k of Object.keys(ru)) {
      const n = (lgTxt.match(new RegExp(`\\b${k}:'`, 'g')) || []).length;
      ok(n >= 2, `E3: EN text for ${k} present (key appears in both branches)`);
    }
  }

  // E4 — the frontend maps the code, keeps the detail small and under.
  if (doLogin !== null) {
    ok(!/String\(e\s*\|\|\s*'Login failed'\)/.test(doLogin), 'E4: doAppLogin no longer prints the raw error as the main text');
    ok(/_lgErrorFor\(e\)/.test(doLogin), 'E4: doAppLogin dispatches on the error code (_lgErrorFor)');
  }
  const errFor = fnBody(html, '_lgErrorFor');
  ok(errFor !== null, 'E4: _lgErrorFor() found (code → text)');
  if (errFor) {
    ok(/'network'/.test(errFor) && /t\.net\b/.test(errFor), 'E4: network → t.net');
    ok(/'credentials'/.test(errFor) && /t\.creds\b/.test(errFor), 'E4: credentials → t.creds');
    ok(/'rate_limited'/.test(errFor) && /t\.rate\b/.test(errFor), 'E4: rate_limited → t.rate');
    ok(/t\.failed\b/.test(errFor), 'E4: other → t.failed');
    ok(/_lgError\(\s*t\.failed\s*,\s*\w+\s*\)/.test(errFor), 'E4: other → generic text WITH the detail as the second argument');
  }
  const lgError = fnBody(html, '_lgError');
  ok(lgError !== null, 'E4: _lgError() found');
  if (lgError) {
    ok(/function\s+_lgError\s*\(\s*msg\s*,\s*detail\s*\)/.test(html), 'E4: _lgError(msg, detail) takes the technical detail separately');
    // The node is created in JS: the gate markup lives in the desktop static region that
    // bundled_plugin_isolation_harness pins byte-for-byte (never re-based by the card that breaks it).
    ok(/lg-err-detail/.test(lgError) && /createElement\('div'\)/.test(lgError) && /appendChild\(/.test(lgError), 'E4: detail node #lg-err-detail is created by _lgError (frozen markup untouched)');
    ok(/font-size:\s*1[01]px/.test(lgError), 'E4: detail is small text (10–11px), under the main message');
  }
  ok(!/id="lg-err-detail"/.test(html), 'E4: no #lg-err-detail attribute in the static markup (desktop region pin stays valid)');
}

if (fail) {
  console.error('login_gate_first_screen_harness: FAIL');
  process.exit(1);
}
console.log(`ALL GREEN: ${passed} login-gate-first-screen checks passed`);

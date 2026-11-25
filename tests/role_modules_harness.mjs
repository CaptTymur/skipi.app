// tasks/018 — one app, modules by account role. Static contract of the role shell:
// the login no longer refuses crewing/broker, the role reaches the frontend, and the
// role module sets match the owner's sheet (case №208).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const rust = fs.readFileSync(new URL('../src-tauri/src/commands/app_login.rs', import.meta.url), 'utf8');

assert.ok(!/sign in with the Skipi (Broker|Crewing) app/i.test(rust), 'login must not send other roles to another app');
assert.ok(/"role": role,/.test(rust) && /"profile_mismatch": profile_mismatch/.test(rust), 'app_login reports role and profile_mismatch');

const m = html.match(/var ROLE_MODULES=\{[\s\S]*?\n\};/);
assert.ok(m, 'ROLE_MODULES is declared');
const ctx = {};
vm.runInNewContext(m[0].replace('var ROLE_MODULES', 'ROLE_MODULES'), ctx);
const keys = (role) => Array.from(ctx.ROLE_MODULES[role], (x) => x.k);
assert.deepEqual(Array.from(Object.keys(ctx.ROLE_MODULES)), ['crewing', 'broker'], 'seafarer keeps its own shell');
// Owner 25.11.2026: crewing is Crew Flow, Compliance Profile, Seafarers DB for now; Vessel DB stays;
// Documents is not a tab (a viewer opened from inside), Port DB is not built yet.
assert.deepEqual(keys('crewing'), ['crewflow', 'compliance', 'seafarers', 'vessels']);
assert.deepEqual(keys('broker'), ['vessels', 'ports', 'apps', 'bazar']);
for (const role of ['crewing', 'broker']) {
  for (const mod of ctx.ROLE_MODULES[role]) {
    assert.ok(mod.ru && mod.en, `${role}/${mod.k} has both labels`);
    if (mod.view) assert.ok(['vessels', 'apps'].includes(mod.view), `${role}/${mod.k} opens an existing role-neutral view`);
  }
}
// Crew Flow is the pilot's module (skipi-crewing), carried over — owner 25.11.2026: «это совершенно
// не то что мы сделали в крюинг пилот». It works through the one Skipi sign-in, never a stub.
{
  const crewflow = Array.from(ctx.ROLE_MODULES.crewing).find((x) => x.k === 'crewflow');
  assert.equal(crewflow.live, 'crewflow');
  assert.ok(/CREWING PILOT MODULES START/.test(html) && /CREWING PILOT MODULES END/.test(html), 'the pilot code is carried over as one marked block');
  for (const fn of ['renderCrewFlowView', 'renderCrewFlowTree', 'renderCrewFlowDetail', 'crewFlowActionsHtml', 'pilotLoadQueue', 'crewFlowMount']) {
    assert.ok(new RegExp('\\nfunction ' + fn + '\\(|\\nasync function ' + fn + '\\(').test(html), `${fn} is present`);
  }
  assert.ok(!/crewing_flow_overview/.test(html), 'the simplified list of the first attempt is gone');
  assert.ok(/invoke\('crewing_connection'\)/.test(html), 'the workspace is named through the one Skipi sign-in');
  assert.ok(!/\.bearer_token|bearer_token\s*:/.test(html.slice(html.indexOf('CREWING PILOT MODULES START'), html.indexOf('CREWING PILOT MODULES END'))), 'the screen never handles a credential');
  const cmd = fs.readFileSync(new URL('../src-tauri/src/commands/crewing.rs', import.meta.url), 'utf8');
  const intake = fs.readFileSync(new URL('../src-tauri/src/commands/crewing_intake.rs', import.meta.url), 'utf8');
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(/crewing::crewing_connection,/.test(lib), 'the connection command is registered');
  assert.ok(/commands::crewing_intake::crewing_intake_candidate_list,/.test(lib) && /commands::crewing_intake::crewing_intake_candidate_get,/.test(lib), 'the pilot commands are registered');
  assert.ok(/crewing::live_connection\(state\)/.test(intake), 'the pilot commands take the live connection of the sign-in');
  assert.ok(/\/api\/app\/login\/skipi-account/.test(cmd) && !/"password"/.test(cmd), 'one sign-in: no second password is ever sent');
  assert.ok(/"create_if_missing": false/.test(cmd), 'this app never creates a workspace');
  // The pilot's fit rule, extracted and exercised: a percentage only for a decided, applicable, fresh count.
  const fn = html.match(/\nfunction crewFlowMatchShare\(row\) \{[\s\S]*?\n\}/)[0];
  const share = vm.runInNewContext('(' + fn.replace('function crewFlowMatchShare', 'function') + ')');
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, applicability: 'applicable' }).pct, 70);
  assert.equal(share({ met: 10, missing: 0, unconfirmed: 0, total: 10 }).reason, 'complete');
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, applicability: 'unknown' }).pct, null);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, applicability: 'not_applicable' }).pct, null);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, stale: true }).pct, null);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 0, total: 10 }).pct, null);
  assert.equal(share({ met: 0, missing: 0, unconfirmed: 0, total: 0 }).pct, null);
  // Modules not carried over yet answer in words; no command without a Rust side is called.
  assert.ok(!/invoke\('save_seafarer_from_bundle'/.test(html) && !/invoke\('rank_compliance_candidate'/.test(html), 'no call into a module that is not here yet');
}
assert.ok(/if\(res&&res\.profile_mismatch\)\{[\s\S]{0,200}close_vault/.test(html), 'a login of another role closes the open cache');
assert.ok(/if\(ROLE_MODULES\[role\]\)\{\s*try\{await openRoleAccountCache\(role\);return;\}/.test(html), 'role accounts skip the seafarer restore');
console.log('role_modules_harness: ok');

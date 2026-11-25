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
// Crew Flow is live for crewing: read through the one Skipi sign-in, never a stub.
{
  const crewflow = Array.from(ctx.ROLE_MODULES.crewing).find((x) => x.k === 'crewflow');
  assert.equal(crewflow.live, 'crewflow');
  assert.ok(/invoke\('crewing_flow_overview'\)/.test(html), 'Crew Flow reads the Crewing server through its command');
  const cmd = fs.readFileSync(new URL('../src-tauri/src/commands/crewing.rs', import.meta.url), 'utf8');
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(/crewing::crewing_flow_overview,/.test(lib), 'the command is registered');
  assert.ok(/\/api\/app\/login\/skipi-account/.test(cmd) && !/"password"/.test(cmd), 'one sign-in: no second password is ever sent');
  assert.ok(/"create_if_missing": false/.test(cmd), 'this app never creates a workspace');
  // The fit rule of the queue, extracted and exercised.
  const fn = html.match(/function crewFlowShare\(row\)\{[\s\S]*?\n\}/)[0];
  const share = vm.runInNewContext('(' + fn.replace('function crewFlowShare', 'function') + ')');
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, applicability: 'applicable' }), 70);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, applicability: 'unknown' }), null);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 1, total: 10, stale: true }), null);
  assert.equal(share({ met: 7, missing: 2, unconfirmed: 0, total: 10 }), null);
  assert.equal(share({ met: 0, missing: 0, unconfirmed: 0, total: 0 }), null);
}
assert.ok(/if\(res&&res\.profile_mismatch\)\{[\s\S]{0,200}close_vault/.test(html), 'a login of another role closes the open cache');
assert.ok(/if\(ROLE_MODULES\[role\]\)\{\s*try\{await openRoleAccountCache\(role\);return;\}/.test(html), 'role accounts skip the seafarer restore');
console.log('role_modules_harness: ok');

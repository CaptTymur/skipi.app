// My Vessel («Моё судно») harness.
//
// Owner, 27.11.2026 (case 265): «моряк может зачекиниться на судне. и судно становится общим
// пространством для тех кто на нем зачекинен»; «судно будет только одно по имо номеру»;
// «базовую функцию можно сделать — доска объявлений».
//
// The screen is the vendored module @skipi/vessel (its own tests live in skipi-vessel-module).
// This checks the home's side: the pin, the scripts, the tab and the tile, and that every
// request of the module goes through a native command — run with a fake `invoke`.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log('  ✓ ' + msg); } else { fail += 1; console.error('  ✗ ' + msg); } }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the vendored module is the pinned one --------------------------------
const pinLines = read('dist', 'VESSEL_VERSION').trim().split('\n');
const pin = Object.fromEntries(pinLines.slice(1).map((l) => l.split(': ')));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
const moduleJs = read('dist', 'skipi-vessel.js');
ok(sha('skipi-vessel.js') === pin.sha256, 'dist/skipi-vessel.js matches the VESSEL_VERSION pin');
ok(sha('skipi-vessel.css') === pin['css-sha256'], 'dist/skipi-vessel.css matches the VESSEL_VERSION pin');
ok(moduleJs.includes("var VERSION = '" + pinLines[0] + "'"), 'and the pinned version is the one the module reports (' + pinLines[0] + ')');
ok(!/token|Authorization|fetch\(|XMLHttpRequest|invoke\(/.test(moduleJs), 'the module holds no account token, makes no network calls and knows nothing of Tauri');

// ---- the home loads and shows it ------------------------------------------
const html = read('dist', 'index.html');
ok(html.includes('<script src="skipi-vessel.js"></script>') && html.includes('href="skipi-vessel.css"'), 'index.html loads the module and its styles');
ok(html.includes("else if(v==='myvessel')showVesselSpace();"), 'desktop: the My Vessel tab opens the module');
ok(html.includes("if(mobileView==='myvessel')return renderMobileVesselSpace();"), 'phone: the My Vessel tile opens the module');
ok(!/showView\('myvessel'[^)]*\)[^;]*showMyVessel|v==='myvessel'\)showMyVessel|mobileView==='myvessel'\)return renderMobileMyVessel/.test(html),
  'neither of them opens the earlier «code from the ship\'s computer» screen any more');

// ---- every request of the module is a native command ----------------------
const lib = read('src-tauri', 'src', 'lib.rs');
const COMMANDS = ['vessel_space_me', 'vessel_space_lookup', 'vessel_space_checkin', 'vessel_space_leave',
  'vessel_notices_list', 'vessel_notice_post', 'vessel_notice_delete', 'vessel_notice_report'];
ok(COMMANDS.every((c) => lib.includes('vessel_space::' + c)), 'every vessel command is registered natively');

const start = html.indexOf('function vesselSpaceDeps(){');
const end = html.indexOf('function showMyVessel(){');
ok(start > 0 && end > start, 'the wiring block was located in dist/index.html');
const calls = [];
const el = { innerHTML: '', isConnected: true };
const sandbox = {
  console, Promise, Date, setTimeout,
  getUiLang: () => 'ru',
  showToast: () => {},
  show: () => {},
  mobileMainHtml: () => {},
  invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(cmd === 'vessel_space_me' ? { vessel: null } : {}); },
  document: { getElementById: (id) => (id === 'vessel-space-root' || id === 'scr-content' ? el : null) },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(moduleJs, sandbox);
vm.runInContext(html.slice(start, end), sandbox);

sandbox.showVesselSpace();
await tick();
ok(calls.length === 1 && calls[0][0] === 'vessel_space_me', 'opening the screen asks the server where the account is checked in');
ok(el.innerHTML.includes('data-qa="vessel-checkin"') && el.innerHTML.includes('Номер ИМО судна'), 'an account that is not checked in sees the check-in form, in the language of the interface');
ok(!/Scan QR|Сканировать QR|Enter code|Ввести код/.test(el.innerHTML), 'and no «Scan QR / Enter code» — the owner asked for that card to go');

const api = sandbox.vesselSpaceDeps().api;
await api.lookup('9074729'); await api.checkIn('9074729', 'TRADER'); await api.leave(); await api.notices(50);
await api.post('hello'); await api.remove(7); await api.report(8);
const sent = calls.slice(1);
ok(JSON.stringify(sent.map((c) => c[0])) === JSON.stringify(COMMANDS.slice(1)), 'each method of the module\'s contract maps to its own command');
ok(JSON.stringify(sent.map((c) => c[1])) === JSON.stringify([{ imo: '9074729' }, { imo: '9074729', name: 'TRADER' }, undefined, { offset: 50 },
  { text: 'hello' }, { noticeId: 7 }, { noticeId: 8, reason: '' }]), 'with the arguments the commands expect');
const rs = read('src-tauri', 'src', 'commands', 'vessel_space.rs');
ok(COMMANDS.every((c) => rs.includes('pub async fn ' + c + '(')) && (rs.match(/token_or_err\(&state\)\?/g) || []).length === COMMANDS.length,
  'and every command refuses without the signed-in account before it talks to the server');

// a home whose module file did not load does not throw on the tab
const bare = { console, getUiLang: () => 'en', showToast() {}, show() {}, mobileMainHtml() {}, invoke() {}, document: sandbox.document };
bare.window = bare;
vm.createContext(bare);
vm.runInContext(html.slice(start, end), bare);
let threw = false; try { bare.showVesselSpace(); bare.renderMobileVesselSpace(); } catch (e) { threw = true; }
ok(!threw, 'the tab does not throw when the module script is missing');

console.log('\nmy_vessel_harness: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

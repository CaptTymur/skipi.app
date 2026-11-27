// Chartering («Фрахтование») harness — tasks/031.
//
// Owner, 27.11.2026 (case 280): an account of the chartering type signs in to Skipi and gets the
// chartering workplace; its records live on the server with the account.
//
// The screen is the vendored module @skipi/chartering (its own tests live in skipi-chartering).
// This checks the home's side: the pin, the scripts, the role tab, that every request of the
// module goes through a native command, and how a letter is handed to the mail program —
// run with a fake `invoke`.

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the vendored module is the pinned one --------------------------------
const pinLines = read('dist', 'CHARTERING_VERSION').trim().split('\n');
const pin = Object.fromEntries(pinLines.slice(1).map((l) => l.split(': ')));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
const moduleJs = read('dist', 'skipi-chartering.js');
ok(sha('skipi-chartering.js') === pin.sha256, 'dist/skipi-chartering.js matches the CHARTERING_VERSION pin');
ok(sha('skipi-chartering.css') === pin['css-sha256'], 'dist/skipi-chartering.css matches the CHARTERING_VERSION pin');
ok(moduleJs.includes("var VERSION = '" + pinLines[0] + "'"), 'and the pinned version is the one the module reports (' + pinLines[0] + ')');
ok(!/Authorization|fetch\(|XMLHttpRequest|invoke\(/.test(moduleJs), 'the module makes no network calls, sends no account credentials and knows nothing of Tauri');

// ---- the home loads and shows it ------------------------------------------
const html = read('dist', 'index.html');
ok(html.includes('<script src="skipi-chartering.js"></script>') && html.includes('href="skipi-chartering.css"'), 'index.html loads the module and its styles');
ok(/broker:\[\s*\{k:'chartering',ru:'Фрахтование',en:'Chartering'\}/.test(html), 'the chartering role opens on the module: it is the first tab, named «Фрахтование»');

// ---- every request of the module is a native command ----------------------
const lib = read('src-tauri', 'src', 'lib.rs');
const COMMANDS = ['chartering_cargoes', 'chartering_cargo', 'chartering_cargo_save', 'chartering_cargo_remove',
  'chartering_pair_save', 'chartering_pair_remove', 'chartering_event_add', 'chartering_positions',
  'chartering_position_save', 'chartering_position_remove', 'chartering_items', 'chartering_item_save',
  'chartering_item_remove'];
ok([...COMMANDS, 'chartering_open_mail'].every((c) => lib.includes('chartering::' + c + ',')), 'every chartering command is registered natively');

const start = html.indexOf('function charteringDeps(){');
const end = html.indexOf('// The account cache of a crewing / broker account');
ok(start > 0 && end > start, 'the wiring block was located in dist/index.html');
const calls = [];
const el = { innerHTML: '', isConnected: true, className: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], clientWidth: 1200, offsetWidth: 1200 };
const sandbox = {
  console, Promise, Date, setTimeout, clearTimeout,
  getUiLang: () => 'ru',
  showToast: () => {},
  invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve({ cargoes: [], positions: [], items: [] }); },
  document: { getElementById: (id) => (id === 'chartering-root' ? el : null), addEventListener() {}, createElement: () => el, body: el, documentElement: el },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(moduleJs, sandbox);
vm.runInContext(html.slice(start, end), sandbox);
ok(typeof sandbox.SkipiChartering.mount === 'function', 'the module registers window.SkipiChartering.mount');

sandbox.charteringMount();
await tick(); await tick();
ok(calls.length > 0 && calls.every((c) => c[0].startsWith('chartering_')), 'opening the screen reads the account\'s records through native commands (' + calls.map((c) => c[0]).filter((c, i, a) => a.indexOf(c) === i).join(', ') + ')');
ok(el.innerHTML.includes('Базар') && el.innerHTML.includes('Грузы') && el.innerHTML.includes('Настройки'), 'and draws the workplace in the language of the interface');

const deps = sandbox.charteringDeps();
const api = deps.api;
ok(same(Object.keys(api).sort(), ['addEvent', 'get', 'items', 'list', 'positions', 'removeCargo', 'removeItem', 'removePair', 'removePosition',
  'saveCargo', 'saveItem', 'savePair', 'savePosition']), 'deps.api has exactly the methods of CONTRACT.md v0.5');
calls.length = 0;
await api.list(); await api.get(3); await api.saveCargo({ cargo_name: 'Wheat' }); await api.removeCargo(3);
await api.savePair(3, { id: 9, step: 'quoted' }); await api.removePair(3, 9); await api.addEvent(3, 9, { kind: 'firm' });
await api.positions(); await api.savePosition({ ship_name: 'Trader' }); await api.removePosition(4);
await api.items('ships'); await api.saveItem('ships', { name: 'Trader' }); await api.removeItem('ships', 5);
ok(same(calls.map((c) => c[0]), COMMANDS), 'each method of the module\'s contract maps to its own command');
ok(same(calls.map((c) => c[1]), [undefined, { cargoId: 3 }, { body: { cargo_name: 'Wheat' } }, { cargoId: 3 },
  { cargoId: 3, body: { id: 9, step: 'quoted' } }, { cargoId: 3, pairId: 9 }, { cargoId: 3, pairId: 9, event: { kind: 'firm' } },
  undefined, { body: { ship_name: 'Trader' } }, { positionId: 4 },
  { kind: 'ships' }, { kind: 'ships', body: { name: 'Trader' } }, { kind: 'ships', itemId: 5 }]), 'with the arguments the commands expect');

// ---- a letter opens as a draft in the user's mail program ------------------
const letter = { to: 'ops@owner.test; desk@owner.test', cc: 'boss@montline.test', bcc: 'archive@montline.test', subject: 'MV TRADER & wheat', body: 'Dear Sirs,\nPls quote.' };
calls.length = 0;
await deps.openMail(letter);
ok(same(calls, [['chartering_open_mail', { mail: letter }]]), 'a letter is handed to the native command whole: to, copy, blind copy, subject and text untouched');
const rust = read('src-tauri', 'src', 'commands', 'chartering.rs');
ok(/fn mailto_link\(/.test(rust) && /link\.len\(\) > MAILTO_MAX[\s\S]{0,80}write_and_open_draft/.test(rust) && rust.includes('X-Unsent: 1'),
  'which opens a mailto: link, and on a computer an .eml draft when the letter is too long for a link');
ok(!/smtp|lettre|send_mail/i.test(rust), 'Skipi itself sends nothing');

console.log('chartering_harness: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

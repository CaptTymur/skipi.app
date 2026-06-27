#!/usr/bin/env node
// Focused harness for Seafarer mobile Settings information architecture.
//
// Verifies the accepted root menu:
// 1. Vault
//    1.1 Switch vault
//    1.2 Export / share backup
//    1.3 Create new
//    1.4 Open demo
// 2. Seafarer profile
// 3. Appearance
// 4. About / updates

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('dist/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let script = scripts[scripts.length - 1];
script = script
  .split('\n')
  .filter((line) => !line.includes('try{loadTheme();') && !line.includes('try{init().catch'))
  .join('\n');

const elements = new Map();
function makeEl(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
function element(id) {
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  window: {},
  document: {
    title: 'Skipi Test',
    body: makeEl('body'),
    documentElement: { getAttribute: () => 'light', setAttribute() {}, style: { setProperty() {} } },
    getElementById: element,
    createElement: () => makeEl(`anon-${elements.size}`),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  navigator: { onLine: true },
  location: { hash: '', pathname: '/' },
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.window = context;
context.addEventListener = () => {};

vm.createContext(context);
vm.runInContext(script, context, { filename: 'dist/index.html' });

context.renderMobileSettingsHome();
const body = element('settings-body').innerHTML;
const order = [
  'Vault',
  'Switch vault',
  'Export / share backup',
  'Create new',
  'Open demo',
  'Профиль моряка',
  'Внешний вид',
  'О программе',
];

console.log('# mobile settings IA');
let last = -1;
for (const label of order) {
  const idx = body.indexOf(label);
  assert.ok(idx > last, `${label} should appear after the previous settings item`);
  last = idx;
}
console.log('  ✓ canonical settings order is restored');

[
  'settings-vault-switch',
  'settings-vault-export',
  'settings-vault-create',
  'settings-vault-demo',
  'seafarer-nav-profile',
  'seafarer-nav-appearance',
  'seafarer-nav-about',
].forEach((qa) => assert.ok(body.includes(`data-qa="${qa}"`), `${qa} hook missing`));
console.log('  ✓ required QA hooks are present');

[
  'Документы / данные',
  'Сопряжённые устройства',
  'Приватность / безопасность',
  'Pairing-flow отдельно',
].forEach((wrong) => assert.equal(body.includes(wrong), false, `${wrong} must not be on root settings menu`));
console.log('  ✓ non-canonical root sections are absent');

assert.ok(body.includes("openSettings('vaults')"), 'Vault row should open vault settings');
assert.ok(body.includes('mobileOpenExistingVault(true)'), 'Switch vault action missing');
assert.ok(body.includes('mobileExportVaultBackup(true)'), 'Export/share backup action missing');
assert.ok(body.includes('mobileStartVaultWizard()'), 'Create new action missing');
assert.ok(body.includes('loadDemoVault()'), 'Open demo action missing');
console.log('  ✓ root actions call the expected flows');

console.log('mobile_settings_ia_harness: GREEN');

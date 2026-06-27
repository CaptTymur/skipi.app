#!/usr/bin/env node
// Focused harness for Seafarer mobile shared bottom rail structure.
//
// Verifies the accepted rail shape:
// - exactly four shared QA hooks: Home / workspace / Apps / More;
// - workspace is Vault before vessel context;
// - workspace becomes My Vessel in vessel context;
// - My Vessel activates the workspace item, not More;
// - Home is not duplicated as an interactive header route.

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

const storage = new Map();
function makeClassList() {
  const set = new Set();
  return {
    add: (...xs) => xs.forEach((x) => set.add(x)),
    remove: (...xs) => xs.forEach((x) => set.delete(x)),
    toggle: (x, on) => (on ? set.add(x) : set.delete(x)),
    contains: (x) => set.has(x),
    toString: () => [...set].join(' '),
  };
}
function makeEl(id = '') {
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    style: {},
    attrs: {},
    children: new Map(),
    classList: makeClassList(),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild() {},
    remove() {},
    addEventListener() {},
    querySelector(sel) { return this.children.get(sel) || null; },
    querySelectorAll() { return []; },
  };
}

const elements = new Map();
const navButtons = [];
function element(id) {
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
}
function navButton(mview, qa, label = '') {
  const el = makeEl(qa);
  el.attrs['data-mview'] = mview;
  el.attrs['data-qa'] = qa;
  const icon = makeEl(`${qa}-icon`);
  const lab = makeEl(`${qa}-label`);
  lab.textContent = label;
  el.children.set('.mobile-nav-icon', icon);
  el.children.set('.mobile-nav-label', lab);
  navButtons.push(el);
  return el;
}
const homeBtn = navButton('home', 'bottom-nav-home', 'Дом');
const workspaceBtn = navButton('workspace', 'bottom-nav-workspace', 'Vault');
const appsBtn = navButton('apps', 'bottom-nav-apps', 'Apps');
const moreBtn = navButton('more', 'bottom-nav-more', 'Ещё');

const context = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  window: {},
  document: {
    title: 'Skipi Test',
    body: { appendChild() {}, classList: makeClassList() },
    documentElement: { getAttribute: () => 'light', setAttribute() {}, style: { setProperty() {} }, classList: makeClassList() },
    getElementById: element,
    createElement: () => makeEl(`anon-${elements.size}`),
    querySelector(sel) {
      if (sel === '[data-qa="bottom-nav-workspace"]') return workspaceBtn;
      if (sel === '#mobile-top-home' || sel === '[data-qa="mobile-top-home"]') return null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.mobile-nav-btn') return navButtons;
      return [];
    },
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
context.getUiLang = () => 'ru';
context.shouldUseMobileShell = () => true;
context.mobileSyncModuleRail = () => {};
context.mobileRefreshProfileMeter = () => {};
context.myVesselLoadMembership = async () => {};

function active(btn) { return btn.classList.contains('active'); }
function label(btn) { return btn.querySelector('.mobile-nav-label')?.textContent || ''; }

console.log('# mobile shared bottom rail');
assert.deepEqual(navButtons.map((b) => b.getAttribute('data-qa')), [
  'bottom-nav-home',
  'bottom-nav-workspace',
  'bottom-nav-apps',
  'bottom-nav-more',
]);
console.log('  ✓ shared QA hook order is stable');

context.myVessel.stage = 'home';
context.myVessel.membership = null;
context.mobileView = 'docs';
context.mobileSetBottomNav(true);
assert.equal(context.mobileWorkspaceView(), 'docs');
assert.equal(label(workspaceBtn), 'Vault');
assert.equal(active(workspaceBtn), true);
assert.equal(active(moreBtn), false);
console.log('  ✓ workspace is Vault and active for document vault before vessel context');

context.myVessel.stage = 'joined';
context.myVessel.membership = { status: 'linked', vessel_imo: 7533197 };
context.mobileView = 'myvessel';
context.mobileSetBottomNav(true);
assert.equal(context.mobileWorkspaceView(), 'myvessel');
assert.equal(label(workspaceBtn), 'Моё судно');
assert.equal(active(workspaceBtn), true);
assert.equal(active(moreBtn), false);
console.log('  ✓ vessel context makes My Vessel the workspace item');

context.mobileShow('workspace');
assert.equal(context.mobileView, 'myvessel');
console.log('  ✓ workspace route opens My Vessel in vessel context');

vm.runInContext("mobileView='docs'", context);
context.mobileSetBottomNav(true);
assert.equal(active(workspaceBtn), false);
assert.equal(active(moreBtn), true);
console.log('  ✓ Vault moves under More when My Vessel owns the workspace slot');

assert.equal(html.includes('id="mobile-top-home"'), false);
console.log('  ✓ Home is not duplicated as a header navigation button');

console.log('mobile_bottom_rail_harness: GREEN');

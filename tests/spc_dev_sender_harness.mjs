#!/usr/bin/env node
// Headless harness for the Seafarer local-dev ship-photo-collection sender.
//
// Loads the REAL inline script from dist/index.html and verifies the hidden
// dev sender path:
// - hidden unless local dev gate is enabled;
// - accepts localhost/127.0.0.1 only;
// - requires one explicit image file;
// - creates /api/reports, then uploads /api/reports/{id}/photos;
// - verifies the report appears in the vessel inbox list;
// - never returns the bearer token in results or rendered state.

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
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, value: '', innerHTML: '', textContent: '', style: {}, className: '',
      setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, toggle() {} },
      click() { this.clicked = true; },
    });
  }
  return elements.get(id);
}

const calls = [];
let fetchQueue = [];
class FakeFormData {
  constructor() { this.parts = []; }
  append(name, value, filename) { this.parts.push({ name, value, filename }); }
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  localStorage: {
    getItem: (k) => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  window: {},
  document: {
    title: 'Skipi Test',
    body: { appendChild() {} },
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    getElementById: element,
    createElement: () => element(`anon-${elements.size}`),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  },
  navigator: { onLine: true },
  location: { hash: '', pathname: '/' },
  URL: {
    createObjectURL: () => 'blob:test-photo',
    revokeObjectURL: () => {},
  },
  FormData: FakeFormData,
  fetch: async (url, opt = {}) => {
    calls.push({ url, opt });
    if (!fetchQueue.length) throw new Error(`unexpected fetch ${url}`);
    const next = fetchQueue.shift();
    if (next.throw) throw next.throw;
    return {
      ok: next.ok !== false,
      status: next.status || (next.ok === false ? 500 : 200),
      json: async () => next.json,
    };
  },
};
context.window = context;
context.addEventListener = () => {};
vm.createContext(context);
vm.runInContext(script, context, { filename: 'dist/index.html' });

function section(name) { console.log(`# ${name}`); }
function ok(cond, msg) { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); }
function setInput(id, value) { element(id).value = value; }
function goodCfg() {
  return {
    apiBase: 'http://127.0.0.1:8817',
    token: 'local-dev-token',
    imo: '7654321',
    vesselName: 'QA Vessel',
    title: 'Paint damage',
    location: 'Deck 4',
    caption: 'Rust near railing',
  };
}
const file = { name: 'deck.jpg', size: 2345, type: 'image/jpeg' };

section('gate + rendering');
storage.delete('skipi.spcDevSender');
ok(context.spcDevSenderEnabled() === false, 'sender hidden by default');
ok(context.spcDevSenderCardHtml(false) === '', 'default render returns no card');
storage.set('skipi.spcDevSender', '1');
ok(context.spcDevSenderEnabled() === true, 'localStorage gate enables sender');
ok(context.spcDevSenderCardHtml(false).includes('data-qa="spc-dev-sender"'), 'enabled card renders');

section('validation');
let bad = await context.spcDevSend({ ...goodCfg(), apiBase: 'https://api.skipi.app' }, file);
ok(bad.ok === false && bad.state === 'local_only', 'prod API base is blocked');
bad = await context.spcDevSend(goodCfg(), null);
ok(bad.ok === false && bad.state === 'no_file', 'missing file is blocked');
bad = await context.spcDevSend(goodCfg(), { name: 'notes.txt', size: 9, type: 'text/plain' });
ok(bad.ok === false && bad.state === 'not_image', 'non-image file is blocked');

section('successful send path');
calls.length = 0;
fetchQueue = [
  { status: 201, json: { id: 'report-1234567890', status: 'submitted' } },
  { status: 201, json: { id: 'photo-abc123', storage_url: '/media/reports/report-1234567890/photo.jpg' } },
  { status: 200, json: { items: [{ id: 'report-1234567890' }], total: 1 } },
];
const res = await context.spcDevSend(goodCfg(), file);
ok(res.ok === true && res.report.id === 'report-1234567890', 'returns real report id');
ok(res.photo.id === 'photo-abc123', 'returns real photo id');
ok(res.inboxVerified === true, 'verifies report in inbox list');
ok(calls.length === 3, 'creates report, uploads photo, verifies inbox');
ok(calls[0].url.endsWith('/api/reports') && calls[0].opt.method === 'POST', 'first call POST /api/reports');
ok(calls[1].url.endsWith('/api/reports/report-1234567890/photos') && calls[1].opt.method === 'POST', 'second call POST /photos');
ok(calls[2].url.includes('/api/reports?imo=7654321'), 'third call lists vessel inbox by IMO');
ok(calls[0].opt.headers.Authorization === 'Bearer local-dev-token', 'bearer injected into request');
ok(calls[1].opt.body instanceof FakeFormData, 'photo body is multipart FormData');
ok(calls[1].opt.body.parts.some((p) => p.name === 'file' && p.filename === 'deck.jpg'), 'multipart carries selected file');
ok(!JSON.stringify(res).includes('local-dev-token'), 'result does not leak bearer token');

section('no fake success on photo failure');
calls.length = 0;
fetchQueue = [
  { status: 201, json: { id: 'report-created', status: 'submitted' } },
  { ok: false, status: 500, json: { detail: 'photo store failed' } },
];
let failed = false;
try {
  await context.spcDevSend(goodCfg(), file);
} catch (e) {
  failed = /photo store failed/.test(String(e.message || e));
}
ok(failed, 'photo upload failure rejects instead of returning success');

section('DOM helpers preserve token only in memory');
setInput('spc-dev-api', goodCfg().apiBase);
setInput('spc-dev-token', goodCfg().token);
setInput('spc-dev-imo', goodCfg().imo);
setInput('spc-dev-vessel', goodCfg().vesselName);
setInput('spc-dev-title', goodCfg().title);
setInput('spc-dev-location', goodCfg().location);
setInput('spc-dev-caption', goodCfg().caption);
context.spcDevRememberDraft();
ok(storage.get('spc.dev.apiBase') === goodCfg().apiBase, 'non-secret api base is persisted');
ok(![...storage.values()].join('\n').includes(goodCfg().token), 'bearer token is not persisted to localStorage');

console.log('spc_dev_sender_harness: GREEN');

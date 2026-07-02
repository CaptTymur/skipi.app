// Headless harness for Seafarer's ISOLATED bundled-plugin path.
//
// Bundled first-party plugins are routed through the SAME isolated runtime as
// remote plugins (SkipiPluginRuntime, dist/plugin-host-bridge.js). This harness
// loads the REAL runtime + the REAL bundled host glue from dist/index.html,
// feeds the REAL on-disk BNWAS artifact bytes through SkipiBundledLoader (so the
// sha256 integrity check is genuine), and asserts the §1 isolation contract:
//   - bundled mount goes through the iframe runtime, NOT inline plugin.mount;
//   - the loader no longer injects plugin code into the host document;
//   - frame is sandbox="allow-scripts" with NO allow-same-origin (opaque origin);
//   - frame srcdoc carries a strict CSP (default-src 'none'; connect-src 'none');
//   - a per-mount capability token gates every bridge message (wrong token ignored);
//   - host API works through the bridge (storage round-trip, host-side namespaced);
//   - a secret host localStorage token NEVER appears in any frame message;
//   - integrity is fail-closed (a tampered byte refuses to mount);
//   - the remote-delivery feature flag is OFF by default;
//   - desktop + mobile Apps entry points still exist.
//
//   node tests/bundled_plugin_isolation_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const HTML = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(DIST, 'plugin-host-bridge.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(DIST, 'plugin-host-config.js'), 'utf8');

const PDIR = path.join(DIST, 'plugins', 'bnwas-time-anchor');
const FILES = {
  'plugin.json': fs.readFileSync(path.join(PDIR, 'plugin.json')),
  'index.js': fs.readFileSync(path.join(PDIR, 'index.js')),
  'index.css': fs.readFileSync(path.join(PDIR, 'index.css')),
  'checksums.json': fs.readFileSync(path.join(PDIR, 'checksums.json')),
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const section = (t) => console.log('\n# ' + t);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ fake DOM
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const noop = () => {};
const framePosts = [];
function makeIframe() {
  return {
    _tag: 'iframe', attrs: {}, style: {}, srcdoc: '', parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    contentWindow: { postMessage: (m) => framePosts.push(m) }, appendChild: noop, remove: noop,
  };
}
const genEl = () => ({ innerHTML: '', textContent: '', style: {}, attrs: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, getAttribute: () => null, appendChild: noop, remove: noop });
globalThis.document = {
  getElementById: () => genEl(), querySelector: () => null, querySelectorAll: () => [],
  createElement: (t) => (t === 'iframe' ? makeIframe() : genEl()),
  head: genEl(), body: genEl(), documentElement: { getAttribute: () => 'dark', setAttribute: noop },
};
globalThis.window = globalThis;
const msgHandlers = [];
globalThis.addEventListener = (type, fn) => { if (type === 'message') msgHandlers.push(fn); };
const emit = (data) => msgHandlers.forEach((fn) => { try { fn({ data }); } catch (e) {} });

// fetch stub: serves the REAL on-disk bundled artifact as ArrayBuffers, so the
// loader's sha256 integrity check runs against genuine bytes + checksums.json.
let CORRUPT = false;
function abuf(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  let buf = FILES[name];
  if (!buf) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
  if (CORRUPT && name === 'index.js') buf = Buffer.concat([buf, Buffer.from('//x')]); // tamper -> hash mismatch
  return { ok: true, status: 200, async arrayBuffer() { return abuf(buf); } };
};

// ------------------------------------------------------------------ load code
// 1) the shared isolated runtime (defines window.SkipiPluginRuntime + its bridge).
try { new Function(BRIDGE)(); } catch (e) { console.error('bridge load failed:', e); process.exit(1); }
if (typeof globalThis.SkipiPluginRuntime?.create !== 'function') { console.error('SkipiPluginRuntime missing'); process.exit(1); }

// 2) the bundled host glue extracted verbatim from dist/index.html.
const START = '// ---- bundled first-party plugin host';
const END = '// ---- shared permissions/safety panel ----';
const block = HTML.slice(HTML.indexOf(START), HTML.indexOf(END));
if (!block || block.length < 500) { console.error('could not extract bundled host block'); process.exit(1); }
let M;
try {
  M = new Function('pluginById', 'pluginSetState', 'pluginNowIso', 'pluginClose', 'logError',
    block + '\nreturn { SkipiPluginHost, SkipiBundledLoader, SkipiBundledStore, bundledRuntime };')(
    (id) => ({ id, bundle: 'plugins/bnwas-time-anchor/' }), noop, () => '', noop, noop);
} catch (e) { console.error('bundled block load failed:', e); process.exit(1); }
for (const n of ['SkipiPluginHost', 'SkipiBundledLoader', 'SkipiBundledStore', 'bundledRuntime']) {
  if (M[n] === undefined) { console.error('missing symbol:', n); process.exit(1); }
}

// a secret host token sits in host localStorage — it must never reach the frame
const TOKEN = 'SECRET-SEAFARER-VAULT-TOKEN-DO-NOT-LEAK';
store.set('skipi_session_token', TOKEN);

// ------------------------------------------------------------------ static
section('static source — no host-side plugin execution');
ok(!HTML.includes('data-plugin-js'), 'loader no longer injects plugin <script> into the host document');
ok(!/function makeHostApi/.test(HTML), 'inline makeHostApi (direct host localStorage/DOM) removed');
ok(/rt\.open\(id, container\)/.test(HTML), 'SkipiPluginHost.mount routes through the isolated runtime (rt.open)');
ok(/SkipiPluginRuntime\.create/.test(HTML), 'bundled path constructs a SkipiPluginRuntime');
ok(/enabled:true/.test(block.replace(/\s/g, '')) || /enabled: ?true/.test(block), 'bundled runtime is enabled:true (isolation always on)');
ok(/connect-src 'none'/.test(BRIDGE) && /default-src 'none'/.test(BRIDGE), "runtime frame CSP forbids network (connect-src 'none') + default-src 'none'");
ok(/setAttribute\('sandbox', 'allow-scripts'\)/.test(BRIDGE) && !/allow-scripts allow-same-origin/.test(BRIDGE), 'runtime iframe sandbox is allow-scripts only (no allow-same-origin)');
ok(/return p;/.test(BRIDGE) && /storage:\s*{[\s\S]*?get: function \(k, cb\) {[\s\S]*?new Promise/.test(BRIDGE), 'frame proxy storage.get returns a Promise (async bridge contract)');
ok(/FEATURE_REMOTE_PLUGIN_DELIVERY = false/.test(CONFIG), 'remote-delivery feature flag is OFF by default');
ok(/function showApps\(/.test(HTML) && /function renderMobileApps\(/.test(HTML) && /function pluginMountInto\(/.test(HTML), 'desktop + mobile Apps entry points still exist');

// ------------------------------------------------------------------ mount
section('open() builds an isolated frame from verified bundled bytes');
const mountEl = { innerHTML: '', _child: null, appendChild(c) { this._child = c; c.parentNode = this; }, removeChild(c) { if (this._child === c) this._child = null; } };
const opened = M.SkipiPluginHost.mount('bnwas-time-anchor', mountEl);
const ifr = mountEl._child;
ok(ifr && ifr._tag === 'iframe', 'an iframe was mounted into the container');
ok(ifr.attrs.sandbox === 'allow-scripts', 'sandbox="allow-scripts"');
ok(!/allow-same-origin/.test(ifr.attrs.sandbox || ''), 'NO allow-same-origin (opaque cross-origin)');
ok(/default-src 'none'/.test(ifr.srcdoc) && /connect-src 'none'/.test(ifr.srcdoc), 'frame srcdoc carries the strict CSP');
ok(/__SKIPI_TOKEN__=/.test(ifr.srcdoc), 'frame boots with a per-mount capability token');
ok(!ifr.srcdoc.includes(TOKEN), 'secret host token is NOT in the frame srcdoc');
const tokMatch = ifr.srcdoc.match(/__SKIPI_TOKEN__=("[0-9a-f]+")/);
const token = tokMatch ? JSON.parse(tokMatch[1]) : null;
ok(!!token && token.length >= 16, 'capability token is random + non-trivial');

section('init handshake — verified BNWAS bytes to frame, no secrets');
await tick(); await tick();                 // let loader.install() (fetch + sha256) resolve
framePosts.length = 0;
emit({ ch: 'skipi-plugin', v: 1, token, type: 'ready' });
await tick();
const init = framePosts.find((m) => m.type === 'init');
ok(!!init, 'host sends init after frame ready + integrity pass');
ok(init && init.js && init.js.indexOf('BNWAS') >= 0, 'init carries the verified BNWAS index.js (runs in frame, not host)');
ok(init && Array.isArray(init.permissions) && init.permissions.indexOf('local_storage') >= 0, 'init grants the manifest permissions (local_storage)');
ok(init && !JSON.stringify(init).includes(TOKEN), 'init message contains NO host token');

section('token gating — forged token is ignored');
framePosts.length = 0;
emit({ ch: 'skipi-plugin', v: 1, token: 'WRONG', type: 'storage.get', id: 91, key: 'bnwas.x' });
await tick();
ok(framePosts.length === 0, 'storage.get with wrong token is dropped (no response)');

section('host API via bridge — storage round-trip, host-side namespaced');
framePosts.length = 0;
emit({ ch: 'skipi-plugin', v: 1, token, type: 'storage.set', key: 'bnwas.anchor', value: '42' });
emit({ ch: 'skipi-plugin', v: 1, token, type: 'storage.get', id: 5, key: 'bnwas.anchor' });
await tick();
const got = framePosts.find((m) => m.type === 'storage.result' && m.id === 5);
ok(got && got.value === '42', 'storage.set then storage.get returns 42 via the bridge');
ok(store.get('skipi_plugin_bnwas-time-anchor_bnwas.anchor') === '42', 'value persisted in HOST-side namespaced storage (frame has none)');
ok(store.get('skipi_session_token') === TOKEN, 'plugin write did NOT touch the host session token key');

section('frame self-check recorded on mount');
emit({ ch: 'skipi-plugin', v: 1, token, type: 'mounted', height: 260, selfcheck: { parentDomAccess: false, storageBlocked: true, fetchBlocked: true } });
const res = await opened;
ok(res && res.ok, 'mount() resolves ok after frame reports mounted');
const act = M.bundledRuntime()._active && M.bundledRuntime()._active();
ok(act && act.selfcheck && act.selfcheck.parentDomAccess === false && act.selfcheck.storageBlocked === true, 'host records frame self-check (no parent DOM, storage blocked)');

section('no host token leaked across the whole session');
ok(!framePosts.some((m) => JSON.stringify(m).includes(TOKEN)), 'no frame message ever contained the host token');

section('teardown');
M.SkipiPluginHost.unmount();
ok(M.bundledRuntime()._active() === null, 'unmount() tears down the active frame');
ok(M.SkipiPluginHost.current === null, 'host clears current after unmount');

section('integrity is fail-closed (tampered byte refuses to mount)');
CORRUPT = true;
const r2 = await M.SkipiBundledLoader.install('bnwas-time-anchor');
ok(r2 && r2.ok === false && r2.stage === 'integrity', 'tampered index.js -> install fails with stage:integrity');
CORRUPT = false;

// ===========================================================================
// Apps launcher surfaces (cross-home Apps standard v1 desktop + mobile v2).
// Boots the REAL inline scripts of dist/index.html in a VM with a small DOM
// that keeps every element carrying id / data-qa / data-i18n / data-mview,
// then drives the app's own render path (showApps and friends) and asserts
// hooks + semantics in the render output. Self-contained on purpose: guard
// scope for the plugin-host task pins the file list, so no helper module.
// ===========================================================================

function vmParseAttrs(raw) {
  const attrs = {};
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw || ''))) attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

class VmClassList {
  constructor(raw = '') { this._s = new Set(String(raw || '').split(/\s+/).filter(Boolean)); }
  add(...n) { n.forEach((x) => this._s.add(x)); }
  remove(...n) { n.forEach((x) => this._s.delete(x)); }
  contains(n) { return this._s.has(n); }
  toggle(n, f) { if (f === true) { this._s.add(n); return true; } if (f === false) { this._s.delete(n); return false; } if (this._s.has(n)) { this._s.delete(n); return false; } this._s.add(n); return true; }
  toString() { return Array.from(this._s).join(' '); }
}

class VmElement {
  constructor(doc, tag, attrs = {}, initialHtml = '') {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.attrs = { ...attrs };
    this.id = attrs.id || ''; this.value = attrs.value || ''; this.title = attrs.title || '';
    this.disabled = false; this.scrollTop = 0; this.clientWidth = 1024; this.clientHeight = 768;
    this.classList = new VmClassList(attrs.class || '');
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => { t[k] = String(v); return true; } });
    this.innerHTML = initialHtml; this.textContent = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v ?? ''); if (k === 'id') { this.id = this.attrs[k]; this.ownerDocument._ids.set(this.id, this); } if (k === 'class') this.classList = new VmClassList(v); }
  getAttribute(k) { if (k === 'class') return this.classList.toString(); return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() {}
  addEventListener() {} removeEventListener() {} focus() {} blur() {} click() {} scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  querySelector(s) { return this.ownerDocument.querySelector(s); }
  querySelectorAll(s) { return this.ownerDocument.querySelectorAll(s); }
}

class VmDocument {
  constructor(sourceHtml) {
    this._ids = new Map(); this._all = []; this.title = '';
    this.documentElement = this._make('html', { id: '__html', 'data-theme': 'light' });
    this.head = this._make('head', { id: '__head' });
    this.body = this._make('body', { id: '__body' });
    const re = /<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?>/g;
    let m;
    while ((m = re.exec(sourceHtml))) {
      const tag = m[1].toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'html') continue;
      const attrs = vmParseAttrs(m[2] || '');
      if (!attrs.id && !attrs['data-qa'] && !attrs['data-i18n'] && !attrs['data-mview']) continue;
      this._make(tag, attrs);
    }
  }
  _make(tag, attrs = {}) { const el = new VmElement(this, tag, attrs); this._all.push(el); if (el.id) this._ids.set(el.id, el); return el; }
  getElementById(id) { return this._ids.get(String(id)) || null; }
  createElement(tag) { return this._make(tag, {}); }
  createTextNode(t) { const el = this._make('#text', {}); el.textContent = t; return el; }
  addEventListener() {} removeEventListener() {}
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) {
    s = String(s || '').trim();
    if (s.startsWith('#')) { const el = this.getElementById(s.slice(1)); return el ? [el] : []; }
    const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
    if (attr) return this._all.filter((el) => { const a = el.getAttribute(attr[1]); return a !== null && (attr[2] === undefined || a === attr[2]); });
    if (s.startsWith('.')) return this._all.filter((el) => el.classList.contains(s.slice(1)));
    return this._all.filter((el) => el.tagName.toLowerCase() === s.toLowerCase());
  }
}

function bootApp({ seed = {}, onLine = true } = {}) {
  const doc = new VmDocument(HTML);
  const lstore = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const invoke = async (cmd) => {
    if (cmd === 'get_build_info') return { version: '0.0.0-apps-harness', sha: 'apps-harness' };
    if (cmd === 'get_platform') return 'linux';
    if (cmd === 'get_vault_types' || cmd === 'get_recent_vaults' || cmd === 'get_optional_categories') return [];
    if (cmd === 'get_last_vault') return null;
    return {};
  };
  const sandbox = {
    console, document: doc,
    navigator: { userAgent: 'Node Apps Harness', platform: 'Linux x86_64', onLine, clipboard: { writeText: async () => {} }, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    location: { hash: '', pathname: '/apps-harness', reload() {} },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    localStorage: { getItem: (k) => (lstore.has(k) ? lstore.get(k) : null), setItem: (k, v) => lstore.set(k, String(v)), removeItem: (k) => lstore.delete(k) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: webcrypto,
    __TAURI__: { core: { invoke, convertFileSrc: (p) => p }, invoke, event: { listen: async () => () => {} }, window: { getCurrentWindow: () => ({ setTitle: async () => {} }) } },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    SkipiPluginRuntime: { create: () => ({ open() {}, close() {}, destroy() {} }) },
    addEventListener() {}, removeEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    alert() {}, confirm: () => true, prompt: () => null,
    Blob: class {}, FileReader: class {}, Image: class {},
    URL: { createObjectURL: () => 'blob:apps-harness', revokeObjectURL() {} },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const scripts = Array.from(HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, a]) => !/\ssrc\s*=/.test(a || ''))
    .map(([, , c]) => c);
  scripts.forEach((code, i) => vm.runInContext(code, sandbox, { filename: `dist/index.html#inline-${i + 1}` }));
  return { sandbox, doc, lstore };
}

const settleVm = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const BNWAS_INSTALLED = { skipi_plugins_state: JSON.stringify({ 'bnwas-time-anchor': { installed: true, enabled: true } }) };
const appsHtml = (doc) => String((doc.getElementById('scr-content') || {}).innerHTML || '');

{
  section('desktop launcher v1 — hooks render through the real path');
  const { sandbox, doc } = bootApp({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.showApps();
  const h = appsHtml(doc);
  ok(h.includes('data-qa="seafarer-module-apps"'), 'launcher root carries seafarer-module-apps');
  ok(h.includes('data-qa="apps-search-input"'), 'search input hook present');
  ok(h.includes('data-qa="plugins-settings-open"'), 'gear (plugins-settings-open) hook present');
  ok(h.includes('data-qa="plugin-tile-bnwas-time-anchor"'), 'installed plugin tile hook present');
  ok(h.includes('data-qa="plugin-open-bnwas-time-anchor"'), 'plugin open hook present');
  ok(!h.includes('plugin-tile-distance-tables'), 'coming-soon plugin is NOT in the launcher grid');
  ok(!h.includes('data-qa="plugin-empty-state"'), 'no empty state while a plugin is installed');
  ok(!h.includes('data-qa="plugin-offline-state"'), 'no offline state while navigator.onLine is true');
}

{
  section('desktop launcher v1 — State B (no installed plugins)');
  const { sandbox, doc } = bootApp({ seed: {} });
  await settleVm();
  sandbox.showApps();
  const h = appsHtml(doc);
  ok(h.includes('data-qa="plugin-empty-state"'), 'empty state hook renders when nothing is installed');
  ok(h.includes('pluginOpenManage()'), 'empty state CTA routes to manage');
  ok(!h.includes('data-qa="plugin-tile-'), 'no tiles in State B');
}

{
  section('desktop launcher v1 — search is installed-only (State C semantics)');
  const { sandbox } = bootApp({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.pluginHostState.search = 'zzz-no-such-plugin';
  const none = sandbox.pluginLauncherResultsHtml();
  ok(none.includes('data-qa="plugin-empty-state"') && none.includes('data-context="search"'), 'no-match search renders the search-context empty state');
  sandbox.pluginHostState.search = 'bnwas';
  const hit = sandbox.pluginLauncherResultsHtml();
  ok(hit.includes('data-qa="plugin-tile-bnwas-time-anchor"'), 'matching installed plugin stays in results');
  sandbox.pluginHostState.search = 'distance';
  const cat = sandbox.pluginLauncherResultsHtml();
  ok(!cat.includes('distance-tables'), 'catalog-only name never matches launcher search');
}

{
  section('desktop launcher v1 — honest offline + error states');
  const off = bootApp({ seed: BNWAS_INSTALLED, onLine: false });
  await settleVm();
  off.sandbox.showApps();
  ok(appsHtml(off.doc).includes('data-qa="plugin-offline-state"'), 'offline hook renders only from real navigator.onLine === false');
  const errHtml = off.sandbox.pluginPlaceholderHtml({ id: 'x', name: 'X', icon: '▢' }, 'integrity');
  ok(errHtml.includes('data-qa="plugin-error-state"'), 'load/integrity failure renders the error hook');
  const pendingHtml = off.sandbox.pluginPlaceholderHtml({ id: 'x', name: 'X', icon: '▢' }, 'not_bundled');
  ok(!pendingHtml.includes('data-qa="plugin-error-state"'), 'not-bundled placeholder is NOT an error state');
}

{
  section('desktop launcher v1 — manage behind the gear, lifecycle not on primary');
  const { sandbox, doc } = bootApp({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.showApps();
  const launcher = appsHtml(doc);
  ok(!/pluginInstall\(/.test(launcher) && !/pluginDisable\(/.test(launcher) && !/pluginUninstall\(/.test(launcher), 'no Install/Disable/Remove on the primary surface');
  sandbox.pluginOpenManage();
  const manage = appsHtml(doc);
  ok(manage.includes('data-qa="plugin-settings-bnwas-time-anchor"'), 'manage carries plugin-settings-<id> hooks');
  ok(manage.includes('plugin-settings-distance-tables'), 'full catalog (incl. coming-soon) lives in manage');
  ok(manage.includes('pluginBackToLauncher()'), 'manage has the explicit «← Apps» return');
  ok(!manage.includes('Staging · remote'), 'remote staging section absent while the dev gate is OFF');
}

{
  section('desktop launcher v1 — UHOST-11 close semantics');
  const { sandbox } = bootApp({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.pluginLaunch('bnwas-time-anchor');
  ok(sandbox.pluginHostState.openId === 'bnwas-time-anchor', 'launcher tile opens the plugin');
  sandbox.pluginClose();
  ok(sandbox.pluginHostState.surface === 'launcher' && !sandbox.pluginHostState.selectedId, 'opened from launcher -> closes back to launcher');
  sandbox.pluginSelect('bnwas-time-anchor');
  sandbox.pluginOpen('bnwas-time-anchor');
  sandbox.pluginClose();
  ok(sandbox.pluginHostState.surface === 'manage' && sandbox.pluginHostState.selectedId === 'bnwas-time-anchor', 'opened from detail -> closes back to detail');
  sandbox.pluginBack();
  ok(sandbox.pluginHostState.selectedId === null && sandbox.pluginHostState.surface === 'manage', 'detail back returns to the manage list');
}

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

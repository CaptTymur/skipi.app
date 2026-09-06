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
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const HTML = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(DIST, 'plugin-host-bridge.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(DIST, 'plugin-host-config.js'), 'utf8');
const REMOTE_BOOT = fs.readFileSync(path.join(DIST, 'plugin-remote-boot.js'), 'utf8');
const REMOTE_LOADER = fs.readFileSync(path.join(DIST, 'plugin-loader.js'), 'utf8');
// @skipi/plugin-host-ui — the Apps/plugin UI module the app loads via <script src> before
// its inline script (adopted 2026-07-14, retiring the inline Apps-UI fork).
const HOST_UI_MODULE = fs.readFileSync(path.join(DIST, 'plugin-host-ui.js'), 'utf8');
const HOST_RUNTIME_BRIDGE_SHA256 = 'edd0ba5f8b21f05fcf55485b13b1dafc963173b2d2aa79e261611297283c307a';

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
const sha256Text = (s) => createHash('sha256').update(s).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 0));
const waitUntil = async (fn, n = 24) => {
  for (let i = 0; i < n; i++) {
    if (fn()) return true;
    await tick();
  }
  return false;
};

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
ok(/FEATURE_REMOTE_PLUGIN_DELIVERY = true/.test(CONFIG), 'remote-delivery feature flag is ON for production by default');
ok(/skipi\.remotePluginDelivery/.test(CONFIG) && /=== 'off'/.test(CONFIG), 'remote-delivery local override only supports explicit off kill shape');
ok(/pinnedPublicKeys/.test(CONFIG) && !/skipi-firstparty-staging-v1/.test(CONFIG) && /skipi-firstparty-prod-v1/.test(CONFIG), 'production remote config pins only the prod public key');
ok(!/"d"\s*:/.test(CONFIG) && !/\bd\s*:/.test(CONFIG), 'remote config does NOT ship a private JWK d component');
ok(/delivery_enabled/.test(REMOTE_BOOT) && /central_kill_switch/.test(REMOTE_BOOT), 'remote boot checks central catalog kill-switch before remote install/open');
ok(/pinnedPublicKeys: CFG\.pinnedPublicKeys/.test(REMOTE_BOOT), 'remote boot passes the trusted key set to the loader');
ok(/catalog && catalog\.keyId/.test(REMOTE_LOADER) && /pinnedJwks\[keyId\]/.test(REMOTE_LOADER), 'remote loader selects the verification key by catalog.keyId');
ok(/revoked/.test(REMOTE_LOADER) && /revocation/.test(REMOTE_LOADER), 'remote loader enforces catalog revocation before install/offline launch');
ok(/downgrade blocked/.test(REMOTE_LOADER) && /semverGt/.test(REMOTE_LOADER), 'remote loader blocks catalog rollback below installed/bundled baseline');
ok(sha256Text(BRIDGE) === HOST_RUNTIME_BRIDGE_SHA256, 'plugin-host-bridge.js matches @skipi/host-runtime artifact sha256');
// After the @skipi/plugin-host-ui adoption these entry points live in the module, not inline HTML.
ok(/function showApps\(/.test(HOST_UI_MODULE) && /function renderMobileApps\(/.test(HOST_UI_MODULE) && /function pluginMountInto\(/.test(HOST_UI_MODULE), 'desktop + mobile Apps entry points still exist (in @skipi/plugin-host-ui)');

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
ok(await waitUntil(() => M.bundledRuntime()._active()?.installed === true), 'verified install completes before frame init');
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
      const close = sourceHtml.indexOf(`</${tag}>`, re.lastIndex);
      const initialHtml = close >= 0 ? sourceHtml.slice(re.lastIndex, close) : '';
      this._make(tag, attrs, initialHtml);
    }
  }
  _make(tag, attrs = {}, initialHtml = '') { const el = new VmElement(this, tag, attrs, initialHtml); this._all.push(el); if (el.id) this._ids.set(el.id, el); return el; }
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

function bootApp({ seed = {}, onLine = true, platform = 'linux' } = {}) {
  const doc = new VmDocument(HTML);
  const lstore = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  // mobile-home-assistant (owner 05.09): capture window listeners (popstate/online/offline) and
  // record History calls so the Android Back contract can be driven and asserted from the harness.
  const listeners = {};
  const invoke = async (cmd) => {
    if (cmd === 'get_build_info') return { version: '0.0.0-apps-harness', sha: 'apps-harness' };
    if (cmd === 'get_platform') return platform;
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
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {},
    history: { calls: [], pushState(state) { this.calls.push(['pushState', state]); }, go(n) { this.calls.push(['go', n]); }, back() { this.calls.push(['back']); } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    alert() {}, confirm: () => true, prompt: () => null,
    Blob: class {}, FileReader: class {}, Image: class {},
    URL: { createObjectURL: () => 'blob:apps-harness', revokeObjectURL() {} },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The app loads @skipi/plugin-host-ui via <script src> BEFORE the inline script; mirror
  // that here so the module's create()/attachGlobals (called from the inline) can expose the
  // plugin* UI globals (showApps, pluginSelect, …) that moved out of the inline during adoption.
  vm.runInContext(HOST_UI_MODULE, sandbox, { filename: 'dist/plugin-host-ui.js' });
  const scripts = Array.from(HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, a]) => !/\ssrc\s*=/.test(a || ''))
    .map(([, , c]) => c);
  scripts.forEach((code, i) => vm.runInContext(code, sandbox, { filename: `dist/index.html#inline-${i + 1}` }));
  return { sandbox, doc, lstore, listeners };
}

const settleVm = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const BNWAS_INSTALLED = { skipi_plugins_state: JSON.stringify({ 'bnwas-time-anchor': { installed: true, enabled: true } }) };
const ALL_BUNDLED_UNINSTALLED = {
  skipi_plugins_state: JSON.stringify({
    'bnwas-time-anchor': { installed: false, enabled: false },
    'ecdis-position-reminder': { installed: false, enabled: false },
    'navigation-calculators': { installed: false, enabled: false }
  })
};
const NAVCALC_INSTALLED = {
  skipi_remote_plugins_state: JSON.stringify({
    'navigation-calculators': {
      installed: true,
      enabled: true,
      slug: 'navigation-calculators',
      id: 'app.skipi.plugins.navigation-calculators',
      name: 'Navigation Calculators',
      version: '1.0.0',
      entry: { slug: 'navigation-calculators', permissions: ['local_storage'], version: '1.0.0' }
    }
  })
};
const appsHtml = (doc) => String((doc.getElementById('scr-content') || {}).innerHTML || '');

function remoteCanonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(remoteCanonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + remoteCanonical(v[k])).join(',') + '}';
}
const remoteB64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const remoteSha256 = async (txt) => {
  const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return Buffer.from(new Uint8Array(d)).toString('hex');
};
function remoteStore(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
  };
}
async function remoteFixture() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  publicJwk.kid = 'skipi-firstparty-prod-v1';
  function makePack(version) {
    return {
      id: 'app.skipi.plugins.navigation-calculators',
      slug: 'navigation-calculators',
      version,
      entrypoints: { ui: 'index.js', style: 'index.css' },
      permissions: ['local_storage'],
      files: {
        'index.js': `window.SkipiPlugins=window.SkipiPlugins||{};window.SkipiPlugins["navigation-calculators"]={manifest:{name:"Navigation Calculators",version:"${version}"},mount:function(el){el.textContent="NAVCALC ${version}";},unmount:function(){}};`,
        'index.css': '.navcalc{display:block}'
      }
    };
  }
  const pack = makePack('0.1.0');
  const packStr = JSON.stringify(pack);
  async function signedPack(version) {
    const p = makePack(version);
    return { pack: p, packStr: JSON.stringify(p) };
  }
  async function catalog(entryPatch = {}, catalogPatch = {}) {
    const version = entryPatch.version || pack.version;
    const current = version === pack.version ? { pack, packStr } : await signedPack(version);
    const entryNoSig = Object.assign({
      id: current.pack.id,
      slug: current.pack.slug,
      name: 'Navigation Calculators',
      version,
      packUrl: 'packs/navigation-calculators.skpack.json',
      sha256: await remoteSha256(current.packStr),
      permissions: ['local_storage'],
      capabilities: { network: 'none', documents: 'none', account: 'none', analytics: 'none', server_upload: false },
      compat: { host: ['seafarer'], minHostVersion: '0.4.165' }
    }, entryPatch);
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(remoteCanonical(entryNoSig)));
    return Object.assign({ schema: 'skipi-catalog/1', env: 'production', keyId: 'skipi-firstparty-prod-v1', plugins: [Object.assign({}, entryNoSig, { signature: remoteB64(sig) })] }, catalogPatch);
  }
  return { publicJwk, packStr, catalog: await catalog(), signedCatalog: catalog, signedPack };
}
async function runRemoteInstallOfflineHarness() {
  const fx = await remoteFixture();
  const storage = remoteStore();
  let online = true;
  let activeCatalog = fx.catalog;
  const packByVersion = { '0.1.0': fx.packStr };
  async function setCatalogVersion(version, catalogPatch = {}) {
    const signed = await fx.signedPack(version);
    packByVersion[version] = signed.packStr;
    activeCatalog = await fx.signedCatalog({ version, sha256: await remoteSha256(signed.packStr) }, catalogPatch);
  }
  const ctx = {
    console, TextEncoder, TextDecoder, Uint8Array, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    crypto: webcrypto, localStorage: storage, setTimeout, clearTimeout,
    document: {
      getElementById: () => ({ innerHTML: '', appendChild() {} }),
      head: { appendChild() {} },
      body: { getAttribute: () => 'light' },
      documentElement: { getAttribute: () => 'light' },
      createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} })
    },
    Blob: class Blob {},
    URL: { createObjectURL: () => 'blob:remote-harness', revokeObjectURL() {} }
  };
  ctx.window = {
    console,
    FEATURE_REMOTE_PLUGIN_DELIVERY: true,
    SKIPI_REMOTE_CONFIG: {
      catalogUrl: 'https://unit.test/catalog.json',
      remoteSlugs: ['bnwas-time-anchor', 'navigation-calculators'],
      host: { id: 'seafarer', version: '0.4.167' },
      policy: { maxPermissions: ['local_storage', 'audio_alert'], requireCapabilities: { network: 'none', documents: 'none', account: 'none', analytics: 'none', server_upload: false } },
      pinnedPublicKeys: { 'skipi-firstparty-prod-v1': fx.publicJwk },
      pinnedPublicKey: fx.publicJwk,
      bundledVersions: { 'navigation-calculators': '0.1.0' }
    },
    APP_VERSION: '0.4.167',
    pluginMountInto: (id) => { ctx.origMount = id; },
    SkipiPluginHost: { unmount() { ctx.hostUnmounted = true; } }
  };
  ctx.window.window = ctx.window;
  ctx.window.localStorage = storage;
  ctx.window.document = ctx.document;
  ctx.fetch = async (url) => {
    if (!online) throw new Error('offline');
    if (String(url).endsWith('catalog.json')) return { ok: true, status: 200, text: async () => JSON.stringify(activeCatalog) };
    if (String(url).endsWith('navigation-calculators.skpack.json')) {
      const entry = activeCatalog.plugins.find((p) => p.slug === 'navigation-calculators');
      return { ok: true, status: 200, text: async () => packByVersion[entry.version] };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  ctx.window.fetch = ctx.fetch;
  vm.createContext(ctx);
  vm.runInContext(REMOTE_LOADER, ctx, { filename: 'dist/plugin-loader.js' });
  const loader = ctx.window.SkipiPluginLoader.create({
    catalogUrl: ctx.window.SKIPI_REMOTE_CONFIG.catalogUrl,
    host: ctx.window.SKIPI_REMOTE_CONFIG.host,
    policy: ctx.window.SKIPI_REMOTE_CONFIG.policy,
    pinnedPublicKeys: ctx.window.SKIPI_REMOTE_CONFIG.pinnedPublicKeys,
    pinnedPublicKey: ctx.window.SKIPI_REMOTE_CONFIG.pinnedPublicKey,
    bundledVersions: ctx.window.SKIPI_REMOTE_CONFIG.bundledVersions
  });
  await setCatalogVersion('0.0.9');
  const bundledRollback = await loader.install('navigation-calculators');
  ok(!bundledRollback.ok && bundledRollback.stage === 'downgrade', 'remote loader blocks install below bundled baseline version');
  await setCatalogVersion('0.1.0');
  const net = await loader.install('navigation-calculators');
  ok(net.ok && net.source === 'network/network', 'remote network install verifies and caches');
  ok(!!storage.getItem('skpd.entry:navigation-calculators'), 'remote entry cache exists');
  ok(!!storage.getItem('skpd.pack:navigation-calculators@0.1.0'), 'remote pack cache exists');
  online = false;
  const off = await loader.install('navigation-calculators', { allowNetwork: false });
  ok(off.ok && off.source === 'cache/cache', 'remote offline install path succeeds from verified cache');
  const goodCatalog = storage.getItem('skpd.catalog');
  storage.setItem('skpd.pack:navigation-calculators@0.1.0', JSON.stringify({ tampered: true }));
  const tampered = await loader.install('navigation-calculators', { allowNetwork: false });
  ok(!tampered.ok && tampered.stage === 'integrity', 'remote tampered cache is rejected by sha256');
  storage.setItem('skpd.pack:navigation-calculators@0.1.0', fx.packStr);
  storage.setItem('skpd.catalog', JSON.stringify(Object.assign({}, fx.catalog, { keyId: 'unknown-key' })));
  const badKey = await loader.install('navigation-calculators', { allowNetwork: false });
  ok(!badKey.ok && badKey.stage === 'signature', 'remote offline path still enforces keyId/signature');
  storage.setItem('skpd.catalog', JSON.stringify(await fx.signedCatalog({ permissions: ['server_access'] })));
  const badPolicy = await loader.install('navigation-calculators', { allowNetwork: false });
  ok(!badPolicy.ok && badPolicy.stage === 'policy', 'remote offline path still enforces policy');
  storage.setItem('skpd.catalog', JSON.stringify(await fx.signedCatalog({ compat: { host: ['broker'], minHostVersion: '0.4.165' } })));
  const badCompat = await loader.install('navigation-calculators', { allowNetwork: false });
  ok(!badCompat.ok && badCompat.stage === 'compat', 'remote offline path still enforces host compatibility');
  storage.setItem('skpd.catalog', goodCatalog);
  online = true;
  vm.runInContext('window.SkipiPluginRuntime={create:function(){return{open:function(slug,container,opts){window.__lastOpen={slug:slug,opts:opts||null};return Promise.resolve({ok:true});},close:function(){window.__closed=true;}};}};', ctx);
  vm.runInContext(REMOTE_BOOT, ctx, { filename: 'dist/plugin-remote-boot.js' });
  ok(typeof ctx.window.SkipiRemoteInstall === 'function', 'remote boot exposes SkipiRemoteInstall');
  ok(typeof ctx.window.SkipiRemoteUninstall === 'function', 'remote boot exposes SkipiRemoteUninstall');
  const uiInstall = await ctx.window.SkipiRemoteInstall('navigation-calculators');
  ok(uiInstall.ok, 'SkipiRemoteInstall delegates to verified loader install');
  ok(JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators']?.installed, 'SkipiRemoteInstall persists registry');
  await setCatalogVersion('0.2.0');
  const refreshed = await ctx.window.SkipiRemoteEnsureLatest('navigation-calculators');
  const refreshedRec = JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators'];
  ok(refreshed.ok && refreshed.updated && refreshed.version === '0.2.0', 'SkipiRemoteEnsureLatest updates installed remote plugin from 0.1.0 to catalog 0.2.0');
  ok(refreshedRec && refreshedRec.version === '0.2.0', 'remote registry version advances after verified refresh');
  ok(!!storage.getItem('skpd.pack:navigation-calculators@0.2.0'), 'verified refreshed pack is cached by new version');
  await setCatalogVersion('0.1.5');
  const downgrade = await ctx.window.SkipiRemoteEnsureLatest('navigation-calculators');
  const afterDowngrade = JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators'];
  const cachedAfterDowngrade = JSON.parse(storage.getItem('skpd.catalog') || '{}').plugins?.[0];
  ok(!downgrade.ok && downgrade.stage === 'downgrade' && afterDowngrade.version === '0.2.0', 'older catalog version is rejected and does not downgrade installed remote plugin');
  ok(cachedAfterDowngrade && cachedAfterDowngrade.version === '0.2.0', 'downgrade catalog does not replace latest verified catalog cache');
  await setCatalogVersion('0.2.0', { revoked: ['navigation-calculators@0.2.0'] });
  const revoked = await ctx.window.SkipiRemoteEnsureLatest('navigation-calculators');
  ok(!revoked.ok && revoked.stage === 'revocation', 'catalog revocation by slug@version rejects installed remote plugin');
  ok(!JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators'], 'revoked remote plugin is removed from host registry');
  ok(!storage.getItem('skpd.entry:navigation-calculators') && !storage.getItem('skpd.pack:navigation-calculators@0.2.0'), 'revoked remote plugin removes entry and cached pack before offline launch');
  await setCatalogVersion('0.2.0');
  const reinstallAfterRevocationReset = await ctx.window.SkipiRemoteInstall('navigation-calculators');
  ok(reinstallAfterRevocationReset.ok, 'remote plugin can reinstall after catalog revocation is lifted in test fixture');
  await setCatalogVersion('0.2.1');
  delete packByVersion['0.2.1'];
  const failedRefresh = await ctx.window.SkipiRemoteEnsureLatest('navigation-calculators');
  const cachedAfterFailedRefresh = JSON.parse(storage.getItem('skpd.catalog') || '{}').plugins?.[0];
  ok(!failedRefresh.ok && cachedAfterFailedRefresh && cachedAfterFailedRefresh.version === '0.2.0', 'failed newer refresh preserves previous verified catalog for offline fallback');
  await setCatalogVersion('0.3.0');
  ctx.window.SkipiRemoteSetEnabled('navigation-calculators', false);
  const enableRefresh = ctx.window.SkipiRemoteSetEnabled('navigation-calculators', true);
  ok(enableRefresh && typeof enableRefresh.then === 'function', 'remote enable returns refresh promise');
  const enableResult = await enableRefresh;
  const afterEnable = JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators'];
  ok(enableResult.ok && enableResult.updated === true && afterEnable.version === '0.3.0' && afterEnable.enabled === true, 'Disable→Enable refreshes to latest verified version and preserves enabled state');
  online = false;
  ctx.window.pluginMountInto('navigation-calculators');
  await settleVm();
  ok(ctx.window.__lastOpen?.opts?.allowNetwork === false, 'installed remote open is forced to allowNetwork:false');
  online = true;
  ctx.window.SkipiRemoteSetEnabled('navigation-calculators', false);
  ok(JSON.parse(storage.getItem('skipi_remote_plugins_state'))['navigation-calculators'].enabled === false, 'remote disable persists');
  ctx.window.SkipiRemoteUninstall('navigation-calculators');
  ok(!JSON.parse(storage.getItem('skipi_remote_plugins_state') || '{}')['navigation-calculators'], 'remote uninstall removes registry');
  const leftoverNavcalcPacks = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith('skpd.pack:navigation-calculators@')) leftoverNavcalcPacks.push(key);
  }
  ok(!storage.getItem('skpd.entry:navigation-calculators') && leftoverNavcalcPacks.length === 0, 'remote uninstall removes entry and all versioned pack caches');
}

{
  section('desktop launcher v1 — hooks render through the real path');
  const { sandbox, doc } = bootApp();
  await settleVm();
  sandbox.showApps();
  const h = appsHtml(doc);
  ok(h.includes('data-qa="seafarer-module-apps"'), 'launcher root carries seafarer-module-apps');
  ok(h.includes('data-qa="apps-search-input"'), 'search input hook present');
  ok(h.includes('data-qa="plugins-settings-open"'), 'gear (plugins-settings-open) hook present');
  ok(h.includes('data-qa="plugin-tile-bnwas-time-anchor"'), 'BNWAS bundled plugin tile is installed by default');
  ok(h.includes('data-qa="plugin-tile-ecdis-position-reminder"'), 'ECDIS bundled plugin tile is installed by default');
  ok(h.includes('data-qa="plugin-tile-navigation-calculators"'), 'Navigation Calculators bundled plugin tile is installed by default');
  ok(h.includes('data-qa="plugin-open-bnwas-time-anchor"'), 'plugin open hook present');
  ok(!h.includes('plugin-tile-distance-tables'), 'coming-soon plugin is NOT in the launcher grid');
  ok(!h.includes('data-qa="plugin-empty-state"'), 'no empty state while a plugin is installed');
  ok(!h.includes('data-qa="plugin-offline-state"'), 'no offline state while navigator.onLine is true');
}

{
  section('desktop launcher v1 — stale remote state dedupes against bundled plugins');
  const { sandbox, doc } = bootApp({ seed: { ...BNWAS_INSTALLED, ...NAVCALC_INSTALLED } });
  await settleVm();
  sandbox.showApps();
  const h = appsHtml(doc);
  ok(h.includes('data-qa="plugin-tile-bnwas-time-anchor"'), 'bundled installed plugin remains in Installed');
  ok(h.includes('data-qa="plugin-tile-ecdis-position-reminder"'), 'ECDIS stays visible without old localStorage state');
  ok((h.match(/data-qa="plugin-tile-navigation-calculators"/g) || []).length === 1, 'stale remote Navigation Calculators does not duplicate the bundled tile');
  ok(h.includes('data-qa="plugin-open-navigation-calculators"'), 'Navigation Calculators has an Installed open hook');
  sandbox.pluginUninstall('navigation-calculators');
  sandbox.showApps();
  const after = appsHtml(doc);
  ok(!after.includes('plugin-tile-navigation-calculators'), 'uninstall hides the bundled plugin and clears stale remote shadow state');
}

{
  section('desktop launcher v1 — State B (no installed plugins)');
  const { sandbox, doc } = bootApp({ seed: ALL_BUNDLED_UNINSTALLED });
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
  ok(!cat.includes('distance-tables'), 'removed placeholder name never matches launcher search');
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
  ok(manage.includes('plugin-settings-navigation-calculators'), 'manage carries real Navigation Calculators plugin');
  ok(!/plugin-settings-(distance-tables|draft-survey|education|reports)/.test(manage), 'manage has no coming-soon placeholder tiles');
  ok(manage.includes('pluginBackToLauncher()'), 'manage has the explicit «← Apps» return');
  ok(!manage.includes('Staging · remote') && !manage.includes('dev gate') && !manage.includes('transport not connected'), 'desktop manage no longer exposes staging/dev-gate remote copy');
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

// ---------------------------------------------------------------------------
// Mobile compact launcher v2 + rail R2 (test matrix M1–M13; M10 is the visual
// pass, M11/M12 are the whole-suite + guard runs — covered outside this file).
// ---------------------------------------------------------------------------

const mobileHtml = (doc) => String((doc.getElementById('mobile-main') || {}).innerHTML || '');

function bootMobile(opts) {
  // Force mobile the way production does: boot on the 'android' platform so the async init sets
  // hostPlatform='android'. @skipi/plugin-host-ui captures the host's shouldUseMobileShell at
  // create(); that captured function reads hostPlatform live, so booting on android makes both the
  // host's and the module's mobile branch active (overriding the sandbox global alone no longer
  // reaches the module after adoption).
  const app = bootApp({ ...(opts || {}), platform: 'android' });
  app.sandbox.shouldUseMobileShell = () => true;
  return app;
}

{
  section('mobile v2 (M1) — canonical hooks through the real render path');
  const { sandbox, doc } = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.mobileShow('apps');
  const h = mobileHtml(doc);
  ok(h.includes('data-qa="seafarer-module-apps"'), 'launcher root hook renders in #mobile-main');
  ok(h.includes('data-qa="apps-search-input"'), 'apps-search-input renders');
  ok(h.includes('data-qa="plugins-settings-open"'), 'plugins-settings-open (gear) renders');
  ok(h.includes('data-qa="plugin-tile-bnwas-time-anchor"') && h.includes('data-qa="plugin-open-bnwas-time-anchor"'), 'plugin-tile-/plugin-open-<id> render for the installed plugin');
  // Canonical rail (волна №73): 5 pinned module slots; Home lives in the
  // header (app-header-home), Settings only behind the header gear.
  for (const qa of ['bottom-nav-docs', 'bottom-nav-experience', 'bottom-nav-cv', 'bottom-nav-dispatch', 'bottom-nav-apps']) {
    ok(doc.querySelectorAll(`[data-qa="${qa}"]`).length === 1, `${qa} exists exactly once in the rail`);
  }
  ok(doc.querySelectorAll('[data-qa="bottom-nav-settings"]').length === 0 && doc.querySelectorAll('[data-qa="bottom-nav-home"]').length === 0, 'no Settings/Home slot on the canonical rail');
  sandbox.pluginOpenManage();
  ok(mobileHtml(doc).includes('data-qa="plugin-settings-bnwas-time-anchor"'), 'plugin-settings-<id> renders in manage');
}

{
  section('mobile v2 (M2) — installed-only grid');
  const { sandbox, doc } = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.mobileShow('apps');
  const h = mobileHtml(doc);
  ok(!h.includes('distance-tables') && !h.includes('draft-survey'), 'removed catalog placeholders never appear on the launcher');
  ok(h.includes('apps-launcher-grid'), 'installed grid renders');
  sandbox.pluginOpenManage();
  const m = mobileHtml(doc);
  ok(m.includes('plugin-settings-navigation-calculators'), 'real Navigation Calculators lives behind the gear');
  ok(!/plugin-settings-(distance-tables|draft-survey|education|reports)/.test(m), 'coming-soon placeholders do not live behind the gear');
}

{
  section('mobile v2 (M3/M4) — search + states B/C semantics (language-agnostic)');
  const empty = bootMobile({ seed: ALL_BUNDLED_UNINSTALLED });
  await settleVm();
  empty.sandbox.mobileShow('apps');
  const hB = mobileHtml(empty.doc);
  ok(hB.includes('data-qa="plugin-empty-state"') && !hB.includes('data-context="search"'), 'State B renders the empty hook (not search context)');
  ok(hB.includes('pluginOpenManage()'), 'State B CTA routes to manage');
  const inst = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  inst.sandbox.mobileShow('apps');
  inst.sandbox.pluginHostState.search = 'no-such-plugin';
  const hC = inst.sandbox.pluginLauncherResultsHtml();
  ok(hC.includes('data-qa="plugin-empty-state"') && hC.includes('data-context="search"'), 'State C is a distinct search-context empty state');
  inst.sandbox.pluginHostState.search = 'BNWAS';
  ok(inst.sandbox.pluginLauncherResultsHtml().includes('plugin-tile-bnwas-time-anchor'), 'search match is case-insensitive on installed plugins');
  inst.sandbox.pluginHostState.search = 'draft';
  ok(!inst.sandbox.pluginLauncherResultsHtml().includes('draft-survey'), 'removed placeholder names never match');
}

{
  section('mobile v2 (M5) — honest offline state');
  const off = bootMobile({ seed: BNWAS_INSTALLED, onLine: false });
  await settleVm();
  off.sandbox.mobileShow('apps');
  ok(mobileHtml(off.doc).includes('data-qa="plugin-offline-state"'), 'offline hook renders from real navigator.onLine === false');
  const on = bootMobile({ seed: BNWAS_INSTALLED, onLine: true });
  await settleVm();
  on.sandbox.mobileShow('apps');
  ok(!mobileHtml(on.doc).includes('data-qa="plugin-offline-state"'), 'no offline hook while online');
}

{
  section('mobile v2 (M6/M7) — gear/manage/detail routing + UHOST-11');
  const { sandbox, doc } = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.mobileShow('apps');
  ok(!/pluginInstall\(/.test(mobileHtml(doc)), 'no Install on the primary surface');
  sandbox.pluginOpenManage();
  sandbox.pluginSelect('bnwas-time-anchor');
  const detail = mobileHtml(doc);
  ok(/pluginOpen\(/.test(detail) && /pluginDisable\(/.test(detail) && /pluginUninstall\(/.test(detail), 'lifecycle buttons live on the manage detail');
  sandbox.pluginOpen('bnwas-time-anchor');
  ok(sandbox.pluginHostState.openId === 'bnwas-time-anchor', 'detail Open mounts the plugin screen');
  ok(mobileHtml(doc).includes('plugin-host-container'), 'plugin screen renders the single host mount container');
  sandbox.pluginClose();
  ok(sandbox.pluginHostState.selectedId === 'bnwas-time-anchor' && sandbox.pluginHostState.surface === 'manage', 'UHOST-11: opened from detail -> closes to detail');
  sandbox.pluginBack();
  ok(sandbox.pluginHostState.selectedId === null && sandbox.pluginHostState.surface === 'manage', 'detail back -> manage list');
  sandbox.pluginBackToLauncher();
  ok(mobileHtml(doc).includes('data-qa="apps-search-input"'), '«← Apps» returns to the launcher');
  sandbox.pluginLaunch('bnwas-time-anchor');
  sandbox.pluginClose();
  ok(sandbox.pluginHostState.surface === 'launcher', 'UHOST-11: opened from launcher -> closes to launcher');
}

{
  section('mobile v2 (M8) — rail active state + unmount on leaving Apps');
  const { sandbox, doc } = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.mobileShow('apps');
  const btn = (qa) => doc.querySelector(`[data-qa="${qa}"]`);
  ok(btn('bottom-nav-apps').classList.contains('active'), 'bottom-nav-apps is active on the launcher');
  ok(!btn('bottom-nav-docs').classList.contains('active'), 'docs slot not active on Apps');
  sandbox.pluginLaunch('bnwas-time-anchor');
  ok(sandbox.pluginHostState.openId === 'bnwas-time-anchor', 'plugin open before leaving');
  sandbox.mobileShow('home');
  ok(sandbox.pluginHostState.openId === null, 'leaving Apps unmounts the open plugin');
  // Canonical rail: Home is the header ⌂ button, not a rail slot.
  ok(!btn('bottom-nav-apps').classList.contains('active'), 'active leaves Apps on going Home');
  ok(!!doc.getElementById('mobile-top-home') && doc.getElementById('mobile-top-home').classList.contains('active'), 'header ⌂ (mobile-top-home) is active on Home');
  sandbox.mobileShow('docs');
  ok(btn('bottom-nav-docs').classList.contains('active'), 'docs slot active on docs');
  sandbox.mobileShow('experience');
  ok(btn('bottom-nav-experience').classList.contains('active'), 'experience slot active on experience');
  sandbox.mobileShow('cv');
  ok(btn('bottom-nav-cv').classList.contains('active'), 'cv slot active on cv');
  sandbox.mobileShow('myvessel');
  ok(['bottom-nav-docs', 'bottom-nav-experience', 'bottom-nav-cv', 'bottom-nav-dispatch', 'bottom-nav-apps'].every((qa) => !btn(qa).classList.contains('active')), 'no rail slot claims a non-rail grid-module view');
  ok(!btn('bottom-nav-settings'), 'no settings slot on the rail (Settings only behind the header gear)');
  ok(/openSettings\(\)/.test(doc.querySelector('[data-qa="app-header-settings"]').getAttribute('onclick') || ''), 'header gear remains the Settings entry');
}

{
  section('mobile v2 (M9) — rail ids kept; NATIVE home = assistant chat + ☰ (owner 05.09, DIRECTIVE 01.09)');
  const { sandbox, doc } = bootMobile({ seed: {} });
  await settleVm();
  for (const v of ['docs', 'assistant', 'experience', 'cv', 'dispatch', 'jobs', 'information', 'vessels', 'myvessel', 'apps']) {
    ok(doc.querySelectorAll(`[data-mview="${v}"]`).length === 1, `existing data-mview="${v}" button still present`);
  }
  ok(!!doc.getElementById('mobile-module-rail') && !!doc.getElementById('mobile-bottom-nav') && !!doc.getElementById('mobile-profile-meter'), 'mobile-module-rail / mobile-bottom-nav / profile-meter ids kept');
  ok(!!doc.getElementById('mobile-home-modules-tpl') && !!doc.getElementById('mobile-primary-rail'), 'home module template + primary rail present');
  // On a NATIVE mobile build (android/ios) the home screen is the assistant chat with ONE ☰
  // button under the composer (sketch 1); the module grid moved to the menu screen (sketch 2);
  // the 5-slot rail is never shown. Two seeds (Supervisor Н1): without consent the consent card
  // shows and ☰ is STILL there (no dead end); with consent — composer + ☰.
  sandbox.mobileShow('home');
  const mm = mobileHtml(doc);
  ok(mm.includes('data-qa="mobile-menu-btn"') && mm.includes("mobileShow('menu')"), "home (no consent) renders the ☰ menu button routed to mobileShow('menu')");
  ok(!mm.includes('id="mobile-assistant-input"'), 'home (no consent) shows the consent card, not the composer');
  ok(!mm.includes('fam-app-tile') && !mm.includes('data-qa="home-hero"'), 'home no longer injects the module grid / hero');
  ok(doc.getElementById('mobile-bottom-nav').style.display === 'none', 'bottom rail hidden on the native home');
  const consented = bootMobile({ seed: { 'skipi-assistant-consent': '1' } });
  await settleVm();
  consented.sandbox.mobileShow('home');
  const mc = mobileHtml(consented.doc);
  ok(mc.includes('id="mobile-assistant-input"') && mc.includes('data-qa="mobile-menu-btn"'), 'home (consented) renders the chat composer AND the ☰ menu button');
  ok(!mc.includes('left today') && !mc.includes('осталось сегодня'), 'home chat shows no remaining-requests counter (DECISIONS 251)');
  ok(consented.doc.getElementById('mobile-bottom-nav').style.display === 'none', 'bottom rail hidden on the consented native home');
  // Drill Н8: the explicit assistant view (renderMobileAssistant) holds the same contract.
  consented.sandbox.mobileShow('assistant');
  const ma = mobileHtml(consented.doc);
  ok(ma.includes('data-qa="mobile-menu-btn"') && ma.includes('id="mobile-assistant-input"'), 'assistant view renders chat + ☰ too');
  ok(consented.doc.getElementById('mobile-bottom-nav').style.display === 'none', 'bottom rail hidden on the native assistant view (renderMobileAssistant)');
}

{
  section('mobile v2 (M13) — plugin opens only via the existing §1 mount path');
  const { sandbox, doc } = bootMobile({ seed: BNWAS_INSTALLED });
  await settleVm();
  sandbox.mobileShow('apps');
  sandbox.pluginLaunch('bnwas-time-anchor');
  const h = mobileHtml(doc);
  ok(h.includes('id="plugin-host-container"'), 'mobile plugin screen mounts into the single #plugin-host-container');
  // The single mount choke point moved into @skipi/plugin-host-ui's pluginMountInto (host.mount);
  // the host document must carry no direct SkipiPluginHost.mount() bypass of it.
  ok((HOST_UI_MODULE.match(/host\.mount\(/g) || []).length === 1 && (HTML.match(/SkipiPluginHost\.mount\(/g) || []).length === 0, 'exactly one plugin mount call site (module pluginMountInto), no host-side bypass');
  ok(!/srcdoc\s*=/.test(HTML), 'host document builds no iframes of its own (runtime bridge owns the frame)');
}

// ---------------------------------------------------------------------------
// Family UI Base v1 — Wave 1 (cards 1,2,4,11,12): AppHeader anatomy, state
// dictionary, language selector persistence, home module grid integrity.
// ---------------------------------------------------------------------------

{
  section('family UI base — AppHeader anatomy (card 1); native build shows only ⌂ and ⚙ (owner 05.09)');
  const { sandbox, doc } = bootMobile({ seed: {} });
  await settleVm();
  for (const qa of ['app-header-icon', 'app-header-title', 'app-header-context', 'app-header-settings', 'app-header-feedback']) {
    ok(doc.querySelectorAll(`[data-qa="${qa}"]`).length === 1, `${qa} present exactly once`);
  }
  const gear = doc.querySelector('[data-qa="app-header-settings"]');
  ok(/openSettings\(\)/.test(gear.getAttribute('onclick') || ''), 'header gear opens Settings');
  // Native build (android/ios): brand / «!» / chat are hidden by CSS under body.mobile-native
  // (markup stays for the non-native mobile shell, hence the five hooks above remain exactly once).
  sandbox.applyMobileMode();
  ok(doc.body.classList.contains('mobile-mode') && doc.body.classList.contains('mobile-native'), 'native android boot marks body.mobile-mode + body.mobile-native');
  ok(typeof sandbox.isNativeMobile === 'function' && sandbox.isNativeMobile() === true, 'isNativeMobile() is true on android');
  const hideRule = /body\.mobile-native \.mobile-brand-wrap,\s*body\.mobile-native #mobile-feedback-btn,\s*body\.mobile-native \[data-qa="app-header-assistant"\]\s*\{[^}]*display:\s*none/;
  ok(hideRule.test(HTML), 'CSS hides brand-wrap / «!» / chat button under body.mobile-native');
  ok(doc.querySelectorAll('[data-qa="app-header-home"]').length === 1 && /mobileShow\('home'\)/.test(doc.querySelector('[data-qa="app-header-home"]').getAttribute('onclick') || ''), 'header ⌂ present once and routes home');
}

{
  section('family UI base — state dictionary chips (card 4)');
  const { sandbox } = bootMobile({ seed: {} });
  await settleVm();
  const states = ['empty', 'loading', 'ready', 'stale', 'pending', 'queued', 'offline', 'valid', 'expiring', 'expired', 'error'];
  for (const st of states) {
    const chip = sandbox.famStateChip(st);
    ok(chip.includes(`data-qa="state-chip-${st}"`) && /tone-(ready|pending|danger|neutral)/.test(chip), `chip renders for '${st}' with a dictionary tone`);
  }
  ok(sandbox.famStateChip('ready').includes('tone-ready') && sandbox.famStateChip('error').includes('tone-danger') && sandbox.famStateChip('queued').includes('tone-pending') && sandbox.famStateChip('offline').includes('tone-neutral'), 'tones map per the accepted dictionary');
  const panel = sandbox.famStatePanelHtml('empty', '', 'T', 'C', '');
  ok(panel.includes('data-qa="state-empty-panel"'), 'family state panel exposes its state hook');
}

{
  section('family UI base — language in Settings (card 11)');
  const fresh = bootMobile({ seed: {} });
  await settleVm();
  ok(fresh.sandbox.getUiLang() === 'en', 'fresh install defaults to EN');
  const saved = bootMobile({ seed: { 'skipi-ui-language': 'ru' } });
  await settleVm();
  ok(saved.sandbox.getUiLang() === 'ru', 'saved locale choice wins over the default');
  saved.sandbox.setUiLang('tl');
  ok(saved.lstore.get('skipi-ui-language') === 'tl' && saved.sandbox.getUiLang() === 'tl', 'selector persists a new choice');
  saved.sandbox.setUiLang('xx');
  ok(saved.sandbox.getUiLang() === 'en', 'unknown locale falls back to EN');
  const opts = saved.sandbox.uiLanguageSelectHtml();
  for (const loc of ['ru', 'en', 'tl', 'hi', 'id']) ok(opts.includes(`value="${loc}"`), `locale list keeps '${loc}'`);
  saved.sandbox.settingsTab = 'vaults';
  saved.sandbox.isMobileMode = () => true;
  let err = null;
  try { saved.sandbox.renderSettingsBody(); } catch (e) { err = e; }
  const body = String((saved.doc.getElementById('settings-body') || {}).innerHTML || '');
  ok(!err && body.includes('data-qa="settings-language"') && body.includes('id="i-lang"'), 'mobile Settings exposes the language row');
}

{
  section('family UI base — module grid covers all 11 modules — on the MENU screen behind ☰ (owner 05.09, sketch 2)');
  const { sandbox, doc } = bootMobile({ seed: {} });
  await settleVm();
  sandbox.mobileShow('menu');
  ok(sandbox.mobileView === 'menu', "mobileShow('menu') switches mobileView to 'menu'");
  const mm = mobileHtml(doc);
  ok(mm.includes('data-qa="mobile-menu-screen"'), 'menu screen wrapper renders');
  for (const v of ['docs', 'experience', 'cv', 'dispatch', 'jobs', 'information', 'vessels', 'myvessel', 'apps', 'assistant']) {
    ok(mm.includes(`data-mview="${v}"`) && mm.includes(`mobileShow('${v}')`), `menu grid routes '${v}' through mobileShow`);
  }
  ok(mm.includes('id="mobile-home-packages"') && mm.includes('mobilePackagesHint()'), 'Packages card is present with the honest desktop-only hint');
  ok((mm.match(/fam-app-tile/g) || []).length === 13, 'exactly 13 icons: 11 module icons + Profile + Feedback (Supervisor Н6 count kept through the icon-grid rework)');
  ok(mm.includes('data-qa="menu-tile-profile"') && mm.includes("mobileShow('profile')"), 'Profile tile routes to the profile screen (its only other entry, the rail meter, is hidden natively)');
  ok(mm.includes('data-qa="menu-tile-feedback"') && mm.includes('openMobileFeedbackMenu()'), 'Feedback tile routes to the feedback menu (its only other entry, the header «!», is hidden natively)');
  const idx = (v) => mm.indexOf(`data-mview="${v}"`);
  ok(idx('docs') >= 0 && idx('docs') < idx('experience') && idx('experience') < idx('cv') && ['dispatch', 'jobs', 'information', 'vessels', 'myvessel', 'apps', 'assistant'].every((v) => idx(v) > idx('cv')), 'first three tiles are Documents · Experience · CV (sketch 2)');
  ok(!mm.includes('data-qa="mobile-menu-btn"'), 'no ☰ on the menu screen (sketch 2: no bottom panel at all)');
  ok(!mm.includes('data-qa="home-hero"'), 'no home hero on the menu');
  ok(doc.getElementById('mobile-bottom-nav').style.display === 'none', 'bottom rail hidden on the menu');
  ok(/openSettings\(\)/.test(doc.querySelector('[data-qa="app-header-settings"]').getAttribute('onclick') || '') && /mobileShow\('home'\)/.test(doc.querySelector('[data-qa="app-header-home"]').getAttribute('onclick') || ''), 'from the menu: header ⌂ → home, ⚙ → Settings');
}

{
  section('mobile-home-assistant — Android Back: home → menu → Back; menu → module → Back; ⌂ collapses (Supervisor Н4)');
  const { sandbox, doc, listeners } = bootMobile({ seed: { 'skipi-assistant-consent': '1' } });
  await settleVm();
  const hist = sandbox.history;
  const pops = () => (listeners.popstate || []);
  ok(pops().length >= 1, 'app registered popstate listener(s)');
  const firePop = (state) => pops().forEach((fn) => fn({ state }));
  sandbox.mobileShow('home');
  hist.calls.length = 0;
  sandbox.mobileShow('menu');
  ok(JSON.stringify(sandbox._mobileNavStack) === JSON.stringify(['home', 'menu']), "menu is tracked on the in-app stack ['home','menu']");
  ok(hist.calls.length === 1 && hist.calls[0][0] === 'pushState' && !!hist.calls[0][1] && hist.calls[0][1].skipiMobileNav === 'menu', "exactly one history.pushState({skipiMobileNav:'menu'}) on entering the menu");
  // Scenario 1: home → menu → system Back. The browser lands on the entry BELOW the marker
  // (state=null) — the handler must still unwind to home (not-ours + depth>1).
  firePop(null);
  ok(sandbox.mobileView === 'home' && JSON.stringify(sandbox._mobileNavStack) === JSON.stringify(['home']), 'Back from the menu returns home (popstate with state=null)');
  ok(mobileHtml(doc).includes('id="mobile-assistant-input"') && mobileHtml(doc).includes('data-qa="mobile-menu-btn"'), 'home chat re-rendered after Back');
  // Scenario 2: home → menu → module → system Back lands on the menu marker.
  sandbox.mobileShow('menu');
  sandbox.mobileShow('docs');
  ok(JSON.stringify(sandbox._mobileNavStack) === JSON.stringify(['home', 'menu', 'docs']), "stack ['home','menu','docs'] after menu → docs");
  firePop({ skipiMobileNav: 'menu' });
  ok(sandbox.mobileView === 'menu' && mobileHtml(doc).includes('data-qa="mobile-menu-screen"'), 'Back from a module returns to the menu (popstate with our menu marker)');
  // Scenario 3: ⌂ from the menu collapses the in-app stack via history.go(-1).
  hist.calls.length = 0;
  sandbox.mobileShow('home');
  ok(JSON.stringify(sandbox._mobileNavStack) === JSON.stringify(['home']) && hist.calls.some((c) => c[0] === 'go' && c[1] === -1), '⌂ from the menu collapses the stack with history.go(-1)');
  sandbox._mobileNavPopping = false; // the sandbox setTimeout is a stub, so the popping flag never self-clears here
  // Scenario 4: Back on home with an empty in-app stack leaves navigation alone (the system backgrounds the app).
  firePop(null);
  ok(sandbox.mobileView === 'home', 'Back at the home root does not navigate (system handles it)');
}

{
  section('mobile-home-assistant — demo vault: chat stays open with a demo banner + create-profile CTA (DECISIONS 249, no src-tauri change)');
  const consent = { 'skipi-assistant-consent': '1' };
  const { sandbox, doc } = bootMobile({ seed: consent });
  await settleVm();
  sandbox.mobileIsDemo = true;
  sandbox.mobileShow('home');
  const mm = mobileHtml(doc);
  ok(mm.includes('data-qa="assistant-demo-banner"') && mm.includes('mobileStartVaultWizard()'), 'demo banner with «create my profile» renders on home');
  ok(mm.includes('id="mobile-assistant-input"') && mm.includes('data-qa="mobile-menu-btn"'), 'demo keeps the composer and ☰ (no dead end)');
  sandbox.mobileIsDemo = false;
  sandbox.mobileShow('home');
  ok(!mobileHtml(doc).includes('data-qa="assistant-demo-banner"'), 'no demo banner on a real vault');
  // The demo flag may arrive AFTER the first render (loadVault async get_profile_status, dist ~:8856):
  // the in-render self-check must flip the banner in place without changing mobileView.
  const late = bootMobile({ seed: consent });
  await settleVm();
  const baseInvoke = late.sandbox.invoke;
  late.sandbox.invoke = async (cmd, args) => (cmd === 'get_profile_status' ? { is_demo: '1' } : baseInvoke(cmd, args));
  late.sandbox.mobileShow('home');
  await settleVm();
  ok(late.sandbox.mobileIsDemo === true && late.sandbox.mobileView === 'home' && mobileHtml(late.doc).includes('data-qa="assistant-demo-banner"'), 'async is_demo from get_profile_status re-renders home with the banner (mobileView stays home)');
}

{
  section('mobile-home-assistant — offline: honest no-network state in the chat; menu keeps working');
  const consent = { 'skipi-assistant-consent': '1' };
  const off = bootMobile({ seed: consent, onLine: false });
  await settleVm();
  off.sandbox.mobileShow('home');
  const mm = mobileHtml(off.doc);
  ok(mm.includes('data-qa="assistant-offline"'), 'offline banner renders on home when navigator.onLine === false');
  ok(mm.includes('data-qa="mobile-menu-btn"') && mm.includes('id="mobile-assistant-input"'), '☰ and composer still there offline');
  off.sandbox.mobileShow('menu');
  ok((mobileHtml(off.doc).match(/fam-app-tile/g) || []).length === 13, 'menu renders all icons offline');
  const on = bootMobile({ seed: consent, onLine: true });
  await settleVm();
  on.sandbox.mobileShow('home');
  ok(!mobileHtml(on.doc).includes('data-qa="assistant-offline"'), 'no offline banner while online');
  ok((on.listeners.online || []).length >= 1 && (on.listeners.offline || []).length >= 1, 'app listens to window online/offline to refresh the banner in place');
}

{
  section('mobile-home-assistant — copy: no free/paid wording, no counter (DECISIONS 251/253); home branches on isNativeMobile()');
  const fnBody = (name) => { const i = HTML.indexOf(name); if (i < 0) return null; const j = HTML.indexOf('\n}\n', i); return j < 0 ? null : HTML.slice(i, j); };
  const send = fnBody('async function mobileAssistantSend(');
  const chat = fnBody('function mobileRenderAssistantChat(');
  ok(!!send && !!chat, 'mobileAssistantSend + mobileRenderAssistantChat exist');
  for (const [where, body] of [['mobileAssistantSend', send || ''], ['mobileRenderAssistantChat', chat || '']]) {
    ok(body.length > 0 && !/\bfree\b|бесплат|left today|осталось сегодня|remaining_today|тариф|покуп|подписк|оплат/i.test(body), `${where}: no free/paid/counter wording`);
  }
  ok(/isNativeMobile\(\)/.test(fnBody('function renderMobileHome(') || ''), 'renderMobileHome branches on isNativeMobile() (native-only assistant home)');
  ok(/function mobileAssistantRerender\(/.test(HTML) && !/renderMobileAssistant\(\);\s*}\s*function mobileAssistantClear/.test(HTML), 'consent/clear/send re-render through mobileAssistantRerender, not renderMobileAssistant (Supervisor Н2)');
}

{
  section('mobile-home-assistant — PRESERVE: desktop static region byte-identical to BASELINE 34705f8b; desktop boot untouched (Supervisor Н5)');
  const lines = HTML.split('\n');
  const startComment = lines.findIndex((l) => l.startsWith('<!-- Top horizontal modules bar'));
  const start = startComment - 2; // BASELINE :1444 = the </div> closing .mobile-shell, then a blank line
  const end = lines.findIndex((l) => l === '<script src="skipi-assistant.js"></script>');
  ok(startComment > 0 && lines[start] === '</div>' && lines[start + 1] === '' && end > start, 'desktop region boundaries found by markers (</div> of .mobile-shell … skipi-assistant.js script tag)');
  const region = lines.slice(start, end + 1).join('\n') + '\n';
  ok(sha256Text(region) === 'b28a9c36ee5891dce24510e51189c033b8f45f50b1f5e826c0156802f19fc0ce', 'desktop static markup region sha256 == BASELINE (sed -n 1444,1660p | sha256sum on 34705f8b)');
  const cssStart = HTML.indexOf('/* mobile-home-assistant (owner 05.09)');
  const cssEnd = HTML.indexOf('/* /mobile-home-assistant */');
  const css = cssStart >= 0 && cssEnd > cssStart ? HTML.slice(cssStart, cssEnd) : '';
  ok(css.length > 50, 'CSS for this card lives in ONE marked block');
  const selectors = css.split('\n').filter((l) => /\{/.test(l)).map((l) => l.slice(0, l.indexOf('{')).trim());
  ok(selectors.length > 0 && selectors.every((s) => s.split(',').every((x) => /^(\.mobile-|body\.mobile-)/.test(x.trim()))), 'every selector in the block starts with .mobile- or body.mobile-');
  const { sandbox, doc } = bootApp({ platform: 'linux' });
  await settleVm();
  sandbox.applyMobileMode();
  ok(!doc.body.classList.contains('mobile-mode') && !doc.body.classList.contains('mobile-native'), 'desktop boot: body carries neither mobile-mode nor mobile-native');
  sandbox.mobileShow('home');
  ok(String(doc.getElementById('mobile-main').innerHTML || '') === '', "desktop boot: mobileShow('home') writes nothing into #mobile-main (guard)");
  ok(typeof sandbox.isNativeMobile === 'function' && sandbox.isNativeMobile() === false, 'isNativeMobile() false on linux');
}

{
  section('mobile-home-assistant — NON-native mobile shell (web-Моряк ≤720px, harness linux) keeps the OLD home: grid + rail, no ☰ (Supervisor Н3/B9)');
  const { sandbox, doc } = bootApp({ platform: 'linux' });
  await settleVm();
  sandbox.shouldUseMobileShell = () => true;
  sandbox.applyMobileMode();
  ok(doc.body.classList.contains('mobile-mode') && !doc.body.classList.contains('mobile-native'), 'mobile-mode without mobile-native on linux');
  sandbox.mobileShow('home');
  const mm = mobileHtml(doc);
  ok(mm.includes('data-qa="home-hero"') && (mm.match(/fam-app-tile/g) || []).length === 11, 'old home: hero + the same 11-icon grid');
  ok(!mm.includes('data-qa="mobile-menu-btn"'), 'no ☰ on the old shell');
  ok(doc.getElementById('mobile-bottom-nav').style.display === 'flex', 'old shell keeps the 5-slot rail visible');
  sandbox.mobileShow('assistant');
  ok(doc.getElementById('mobile-bottom-nav').style.display === 'flex' && !mobileHtml(doc).includes('data-qa="mobile-menu-btn"'), 'old shell assistant view: rail visible, no ☰');
}

{
  section('mobile-home-assistant — sending from home keeps mobileView=home and ⌂ active (Supervisor Н2/B10)');
  const { sandbox, doc } = bootMobile({ seed: { 'skipi-assistant-consent': '1' } });
  await settleVm();
  sandbox.mobileShow('home');
  ok(doc.getElementById('mobile-top-home').classList.contains('active'), '⌂ active on home before sending');
  // The fake DOM does not materialise innerHTML; provide the composer element the send path reads.
  const ta = doc.createElement('textarea'); ta.setAttribute('id', 'mobile-assistant-input'); ta.value = 'hello';
  await sandbox.mobileAssistantSend();
  ok(sandbox.mobileView === 'home', "mobileView stays 'home' after a message is sent from home");
  ok(doc.getElementById('mobile-top-home').classList.contains('active'), '⌂ still active after sending');
  ok(mobileHtml(doc).includes('data-qa="mobile-menu-btn"'), '☰ still rendered after sending');
  ok(Array.isArray(sandbox.mobileAssistantMessages) && sandbox.mobileAssistantMessages.length >= 2 && sandbox.mobileAssistantMessages[0].role === 'user', 'user message + reply recorded');
  sandbox.mobileAssistantClear();
  ok(sandbox.mobileView === 'home' && sandbox.mobileAssistantMessages.length === 0, 'Clear keeps mobileView=home');
  sandbox.mobileShow('assistant');
  sandbox.mobileAssistantClear();
  ok(sandbox.mobileView === 'assistant', "Clear on the assistant view keeps mobileView='assistant'");
}

// ---------------------------------------------------------------------------
// Entry fork «Sign in · Register · Demo» (canon (295), OWNER 06.09; card
// TASKCARD-2026-09-06-seafarer-mobile-entry-fork) — runtime drills D1–D12 of the
// Supervisor prep audit ff9dc253, driven through the REAL init() on 'android'.
// init() is kicked off synchronously by the last inline script and parks on its
// first await (loadBuildInfo), so the invoke map + spies installed right after
// bootMobile() are exactly what the cold-start path sees. Native-only: D12 boots
// the same drill on linux and expects the plain gate + no fork.
// ---------------------------------------------------------------------------

const EF_REAL = { name: 'Real Vault', account_type: 'seafarer', position: 'master', vessel_category: 'tanker' };
const EF_DEMO = { name: 'Skipi Demo', account_type: 'seafarer', position: 'master', vessel_category: 'tanker' };
const EF_LIST_CMDS = new Set(['get_vault_types', 'get_recent_vaults', 'get_optional_categories', 'get_documents', 'get_active_template_ids', 'get_conditional_template_ids']);
function efInvoke(map, platform = 'android') {
  return async (cmd, args) => {
    if (Object.prototype.hasOwnProperty.call(map, cmd)) { const v = map[cmd]; return typeof v === 'function' ? v(args) : v; }
    if (cmd === 'get_build_info') return { version: '0.0.0-apps-harness', sha: 'apps-harness' };
    if (cmd === 'get_platform') return platform;
    if (EF_LIST_CMDS.has(cmd)) return [];
    if (cmd === 'get_last_vault' || cmd === 'get_current_vault_path') return null;
    if (cmd === 'app_login_status') return { logged_in: false };
    return {};
  };
}
const efSettle = async () => { for (let i = 0; i < 600; i++) await Promise.resolve(); };
// Boot (android by default), install the invoke map + spies BEFORE init() resumes, let init() run to rest.
async function efBoot(map, opts) {
  const o = opts || {};
  const platform = o.platform === 'linux' ? 'linux' : 'android';
  const app = platform === 'linux' ? bootApp({ ...o, platform }) : bootMobile(o);
  const calls = [];
  const base = efInvoke(map || {}, platform);
  app.sandbox.invoke = async (cmd, args) => { calls.push([cmd, args]); return base(cmd, args); };
  // loadVault() fires the DESKTOP dashboard (showDashboard → career compass) without awaiting it; that
  // renderer needs a module the harness does not load (informationEffectiveRank) and its rejection would
  // crash Node later as an unhandled rejection. It is not under test here — the native shell is.
  app.sandbox.showDashboard = async () => {};
  const spies = {};
  for (const name of ['showEntryFork', 'showLoginGate', 'renderMobileShell', 'showWelcome', 'initNoVaultLanding', 'mobileStartVaultWizard', 'showToast', 'err']) {
    spies[name] = [];
    const orig = app.sandbox[name];
    if (typeof orig !== 'function') continue;
    app.sandbox[name] = function (...a) { spies[name].push(a); return orig.apply(this, a); };
  }
  await efSettle();
  return Object.assign(app, { calls, spies, base });
}
const efFork = (doc) => doc.getElementById('mobile-entry-fork');
const efForkShown = (doc) => { const f = efFork(doc); return !!f && f.style.display === 'flex'; };
const efGateShown = (doc) => doc.getElementById('login-gate-overlay').style.display === 'flex';
const efCalled = (calls, cmd, pred) => calls.filter(([c, a]) => c === cmd && (!pred || pred(a)));
const efGateMarkup = () => HTML.slice(HTML.indexOf('id="login-gate-overlay"'), HTML.indexOf('id="update-banner"'));

{
  section('entry fork (D1/D1b) — S1 fresh install, no session: opaque fork with exactly three doors; header unreachable');
  const { doc, spies } = await efBoot({});
  ok(efForkShown(doc), 'D1: the fork overlay is shown on a fresh native start with no session');
  ok(spies.showEntryFork.length === 1, 'D1: showEntryFork() called exactly once');
  const f = String((efFork(doc) || {}).innerHTML || '');
  for (const door of ['sign-in', 'register', 'demo']) ok((f.match(new RegExp(`data-qa="${door}"`, 'g')) || []).length === 1, `D1: door "${door}" rendered exactly once`);
  ok((f.match(/<button\b/g) || []).length === 3, 'D1: exactly three buttons — no fourth door, no dismiss');
  ok(!efGateShown(doc) && spies.showLoginGate.length === 0, 'D1: the login gate is NOT raised first (the fork comes first, natively)');
  // applyMobileMode() paints the idle welcome into #mobile-main before the token check (as it did under
  // the gate); what must NOT happen before a session is the landing / profile wizard being STARTED.
  ok(spies.showWelcome.length === 0 && spies.initNoVaultLanding.length === 0 && spies.mobileStartVaultWizard.length === 0, 'D1: no startup landing / profile wizard started behind the fork');
  ok(spies.renderMobileShell.length === 0, 'D1: the shell is not rendered before a session');
  // D1b — gate-class overlay: fixed, full-inset, opaque, z-index >= the login gate (100000); no header action inside.
  const cssStart = HTML.indexOf('/* mobile-entry-fork (owner 06.09');
  const cssEnd = HTML.indexOf('/* /mobile-entry-fork */');
  const css = cssStart >= 0 && cssEnd > cssStart ? HTML.slice(cssStart, cssEnd) : '';
  ok(css.length > 50, 'D1b: fork CSS lives in ONE marked block');
  const selectors = css.split('\n').filter((l) => /\{/.test(l)).map((l) => l.slice(0, l.indexOf('{')).trim());
  ok(selectors.length > 0 && selectors.every((s) => s.split(',').every((x) => /^(\.mobile-|body\.mobile-)/.test(x.trim()))), 'D1b: every selector in the block starts with .mobile- or body.mobile-');
  const rule = /\.mobile-entry-fork\s*\{([^}]*)\}/.exec(css);
  const z = rule && /z-index:\s*(\d+)/.exec(rule[1]);
  ok(!!rule && /position:\s*fixed/.test(rule[1]) && /inset:\s*0/.test(rule[1]) && /background:\s*var\(--bg\)/.test(rule[1]) && !!z && Number(z[1]) >= 100000, 'D1b: .mobile-entry-fork is position:fixed; inset:0; opaque var(--bg); z-index >= 100000 (the login gate) — the header below is unreachable');
  ok(!!efFork(doc) && efFork(doc).classList.contains('mobile-entry-fork') && efFork(doc).getAttribute('data-qa') === 'entry-fork', 'D1b: the overlay element carries the marked class + data-qa="entry-fork"');
  ok(!/openAssistant\(|openSettings\(|mobileShow\(|mobileStartVaultWizard\(/.test(f), 'D1b: no header / menu / wizard action inside the fork markup');
  ok(!/id="mobile-entry-fork"/.test(HTML), 'D1b: the fork is rendered by JS — no static markup (PRESERVE sha region)');
}

{
  section('entry fork (D2) — S2-cold: remembered vault WITHOUT a token → fork (not the gate), vault parked for Sign in');
  const { doc, spies, sandbox } = await efBoot({ get_last_vault: '/v', open_vault: EF_REAL, app_login_status: { logged_in: false } });
  ok(efForkShown(doc) && spies.showEntryFork.length === 1, 'D2: fork shown on cold start with a remembered token-less vault');
  ok(spies.showLoginGate.length === 0 && !efGateShown(doc), 'D2: the old «Sign in to Skipi» gate is NOT the first screen any more');
  ok(sandbox._loginGatePending === EF_REAL, 'D2: _loginGatePending === the opened vault info (Sign in resumes the SAME vault)');
  ok(spies.renderMobileShell.length === 0, 'D2: the shell is not rendered behind the fork');
}

{
  section('entry fork (D3) — S2-cold with last vault = DEMO: demo is not a session → close_vault{forget:true} → fork');
  const { doc, spies, sandbox, calls } = await efBoot({ get_last_vault: '/demo', open_vault: EF_DEMO, get_profile_status: { is_demo: '1' } });
  ok(efForkShown(doc), 'D3: fork shown (no auto-demo on cold start)');
  ok(efCalled(calls, 'close_vault', (a) => a && a.forget === true).length === 1, 'D3: the remembered demo vault is closed AND forgotten (close_vault{forget:true})');
  ok(spies.renderMobileShell.length === 0 && !mobileHtml(doc).includes('assistant-demo-banner'), 'D3: the demo home is NOT rendered');
  ok(sandbox._loginGatePending === null, 'D3: nothing is parked for Sign in (a token must never land in the demo vault)');
  ok(spies.showLoginGate.length === 0, 'D3: no gate');
}

{
  section('entry fork (D4) — live session + vault: fork never called (not even a flash), native home rendered');
  const { doc, spies } = await efBoot({ get_last_vault: '/v', open_vault: EF_REAL, app_login_status: { logged_in: true } }, { seed: { 'skipi-assistant-consent': '1' } });
  ok(spies.showEntryFork.length === 0 && !efFork(doc), 'D4: showEntryFork() NOT called with a live session (no overlay element at all)');
  ok(spies.showLoginGate.length === 0, 'D4: no gate either');
  ok(spies.renderMobileShell.length >= 1 && mobileHtml(doc).includes('id="mobile-assistant-input"'), 'D4: loadVault() reached renderMobileShell → native home (assistant chat)');
}

{
  section('entry fork (D5) — session (parked login) but no vault: no fork, welcome/wizard landing as today');
  const { doc, spies } = await efBoot({ app_login_status: { logged_in: true, pending: true } });
  ok(spies.showEntryFork.length === 0 && !efFork(doc), 'D5: no fork with a parked login');
  ok(spies.showLoginGate.length === 0, 'D5: no gate');
  ok(spies.showWelcome.length === 1 && mobileHtml(doc).includes('mobileStartVaultWizard()'), 'D5: welcome landing rendered (the wizard is scheduled from it, as today)');
}

{
  section('entry fork (D6) — mid-session loadVault() for a token-less NON-demo vault keeps the hard gate (G4), not the fork');
  const app = await efBoot({ get_last_vault: '/v', open_vault: EF_REAL, app_login_status: { logged_in: true } }, { seed: { 'skipi-assistant-consent': '1' } });
  const { doc, spies, sandbox, calls, base } = app;
  const OTHER = { ...EF_REAL, name: 'Other' };
  sandbox.invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'app_login_status') return { logged_in: false }; if (cmd === 'get_recent_vaults') return ['/other']; if (cmd === 'open_vault') return OTHER; return base(cmd, args); };
  await sandbox.mobileOpenExistingVault();
  await efSettle();
  ok(spies.showLoginGate.length === 1 && efGateShown(doc), 'D6: mid-session token-less vault → login gate (hard gate preserved)');
  ok(spies.showEntryFork.length === 0 && !efForkShown(doc), 'D6: fork NOT shown mid-session');
  ok(sandbox._loginGatePending === OTHER, 'D6: the gate parks the vault for resume');
}

{
  section('entry fork (D7) — Demo door OFFLINE: demo vault opens WITHOUT a token, home with demo banner, no gate, no error-state');
  const app = await efBoot({ create_demo_vault_auto: EF_DEMO, get_profile_status: { is_demo: '1' } }, { seed: { 'skipi-assistant-consent': '1' }, onLine: false });
  const { doc, spies, sandbox, calls } = app;
  sandbox.fetch = async () => { throw new Error('offline'); };
  ok(efForkShown(doc), 'D7: fork shown first');
  ok(typeof sandbox.entryForkDemo === 'function', 'D7: the Demo door handler exists');
  if (typeof sandbox.entryForkDemo === 'function') { await sandbox.entryForkDemo(); await efSettle(); }
  ok(efCalled(calls, 'create_demo_vault_auto').length === 1, 'D7: Demo creates the demo vault (create_demo_vault_auto) — no network involved');
  ok(!efForkShown(doc), 'D7: fork hidden after Demo');
  ok(spies.showLoginGate.length === 0 && !efGateShown(doc), 'D7: NO login gate for the demo vault (canon (295) п.3 exception, keyed on is_demo only)');
  const h = mobileHtml(doc);
  ok(spies.renderMobileShell.length >= 1 && h.includes('data-qa="assistant-demo-banner"'), 'D7: demo home rendered with the demo banner');
  ok(h.includes('data-qa="assistant-offline"'), 'D7: honest offline banner (navigator.onLine=false, fetch rejecting) — no error-state');
  ok(!spies.showToast.some((a) => a[1] === 'error') && spies.err.length === 0, 'D7: no error toast / red error strip while offline');
  ok(h.includes('data-qa="assistant-demo-signin"') && h.includes('entryForkLeaveDemo()'), 'D7: the demo banner offers the way back to the fork (Sign in)');
  ok(sandbox.mobileIsDemo === true, 'D7: mobileIsDemo is true synchronously (info.is_demo stamped by loadDemoVault)');
}

{
  section('entry fork (D8) — S3 Sign out → fork (one rule: no session → fork); shell hidden; vault parked for Sign in');
  const app = await efBoot({ get_last_vault: '/v', open_vault: EF_REAL, app_login_status: { logged_in: true }, get_current_vault_path: '/v' }, { seed: { 'skipi-assistant-consent': '1' } });
  const { doc, spies, sandbox, calls, base } = app;
  let loggedIn = true;
  sandbox.invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'app_logout') { loggedIn = false; return {}; } if (cmd === 'app_login_status') return { logged_in: loggedIn }; return base(cmd, args); };
  calls.length = 0;
  await sandbox.appLogoutToGate();
  await efSettle();
  ok(efCalled(calls, 'app_logout').length === 1, 'D8: app_logout invoked');
  ok(efForkShown(doc) && spies.showEntryFork.length === 1, 'D8: Sign out lands on the fork');
  ok(spies.showLoginGate.length === 0 && !efGateShown(doc), 'D8: not the bare gate');
  ok(doc.getElementById('scr-content').style.display === 'none', 'D8: #scr-content hidden');
  ok(sandbox._loginGatePending === EF_REAL, 'D8: the signed-out vault is parked — Sign in resumes it');
  ok(efCalled(calls, 'close_vault').length === 0, 'D8: a real vault is NOT closed/forgotten on Sign out (data untouched)');
}

{
  section('entry fork (D8b) — Sign out while the DEMO is open: demo closed + forgotten, nothing parked');
  const app = await efBoot({ create_demo_vault_auto: EF_DEMO, get_profile_status: { is_demo: '1' }, get_current_vault_path: '/demo', open_vault: EF_DEMO }, { seed: { 'skipi-assistant-consent': '1' } });
  const { doc, sandbox, calls } = app;
  if (typeof sandbox.entryForkDemo === 'function') { await sandbox.entryForkDemo(); await efSettle(); }
  calls.length = 0;
  await sandbox.appLogoutToGate();
  await efSettle();
  ok(efCalled(calls, 'close_vault', (a) => a && a.forget === true).length === 1 && sandbox._loginGatePending === null, 'D8b: Sign out from the demo closes + forgets it and parks nothing (no token into the demo)');
  ok(efForkShown(doc), 'D8b: fork shown');
}

{
  section('entry fork (D9) — Register door: exactly the existing external URL; fork stays');
  const { doc, sandbox, calls } = await efBoot({});
  calls.length = 0;
  if (typeof sandbox.entryForkRegister === 'function') sandbox.entryForkRegister();
  await efSettle();
  const reg = efCalled(calls, 'open_external_url');
  ok(reg.length === 1 && !!reg[0][1] && reg[0][1].url === 'https://assistant.skipi.app/register', "D9: exactly one invoke('open_external_url',{url:'https://assistant.skipi.app/register'})");
  ok(calls.length === 1, 'D9: no other command on Register');
  ok(efForkShown(doc), 'D9: the fork is still on screen (registration finishes in the browser; Sign in is the door back)');
}

{
  section('entry fork (D10) — Sign in door: gate with a history marker + JS «← Back»; system Back and the link both return to the fork; login resumes the continuation');
  const app = await efBoot({});
  const { doc, sandbox, listeners } = app;
  const hist = sandbox.history; hist.calls.length = 0;
  const firePop = (state) => (listeners.popstate || []).forEach((fn) => fn({ state }));
  ok(typeof sandbox.entryForkSignIn === 'function', 'D10: the Sign in door handler exists');
  if (typeof sandbox.entryForkSignIn === 'function') sandbox.entryForkSignIn();
  ok(efGateShown(doc) && !efForkShown(doc), 'D10: Sign in → gate shown, fork hidden');
  ok(hist.calls.length === 1 && hist.calls[0][0] === 'pushState' && !!hist.calls[0][1] && hist.calls[0][1].skipiEntryFork === true, 'D10: exactly one history.pushState({skipiEntryFork:true})');
  const back = doc.getElementById('lg-back');
  ok(!!back && back.getAttribute('data-qa') === 'login-gate-back' && back.style.display !== 'none' && String(back.textContent || '').length > 0, 'D10: JS-inserted «← Back» link is present + visible in the gate');
  ok(!/lg-back|entry-fork/.test(efGateMarkup()), 'D10: the link is NOT static markup (PRESERVE region untouched)');
  // system Back: the browser pops OUR marker entry → gate closes, fork returns, no extra back()
  firePop(null);
  ok(!efGateShown(doc) && efForkShown(doc), 'D10: system Back (popstate) → gate hidden, fork back');
  ok(!hist.calls.some((c) => c[0] === 'back'), 'D10: no history.back() when the browser already popped our entry (no phantom entries)');
  ok(!!back && back.style.display === 'none', 'D10: «← Back» hidden once the gate closes');
  // the link path: consumes the marker with ONE history.back()
  hist.calls.length = 0;
  if (typeof sandbox.entryForkSignIn === 'function') sandbox.entryForkSignIn();
  if (typeof sandbox.entryForkGateBack === 'function') sandbox.entryForkGateBack();
  ok(!efGateShown(doc) && efForkShown(doc), 'D10: «← Back» link → fork');
  ok(hist.calls.filter((c) => c[0] === 'back').length === 1, 'D10: the link consumes the marker with exactly one history.back()');
  // login from the fork-opened gate → continuation (S1: welcome/wizard landing); marker consumed
  hist.calls.length = 0;
  if (typeof sandbox.entryForkSignIn === 'function') sandbox.entryForkSignIn();
  let nextCalled = 0; sandbox._loginGateNext = () => { nextCalled++; };
  doc.getElementById('lg-email').value = 'qa@example.com'; doc.getElementById('lg-password').value = 'x';
  await sandbox.doAppLogin();
  await efSettle();
  ok(nextCalled === 1 && !efGateShown(doc) && !efForkShown(doc), 'D10: successful app_login → _loginGateNext continuation; gate + fork both hidden');
  ok(hist.calls.filter((c) => c[0] === 'back').length === 1, 'D10: the marker is consumed on login (a later Back never resurrects the fork over the home)');
  firePop(null);
  ok(!efForkShown(doc) && !efGateShown(doc), 'D10: a later popstate does not bring the fork back');
}

{
  section('entry fork (D11) — demo → Sign in: close_vault{forget:true} FIRST, fork with NO vault open, login parks (never written into the demo)');
  const app = await efBoot({ create_demo_vault_auto: EF_DEMO, get_profile_status: { is_demo: '1' } }, { seed: { 'skipi-assistant-consent': '1' } });
  const { doc, sandbox, calls, spies, base } = app;
  if (typeof sandbox.entryForkDemo === 'function') { await sandbox.entryForkDemo(); await efSettle(); }
  ok(mobileHtml(doc).includes('data-qa="assistant-demo-signin"'), 'D11: demo home shows the Sign in way back');
  calls.length = 0;
  ok(typeof sandbox.entryForkLeaveDemo === 'function', 'D11: the leave-demo handler exists');
  if (typeof sandbox.entryForkLeaveDemo === 'function') { await sandbox.entryForkLeaveDemo(); await efSettle(); }
  ok(efCalled(calls, 'close_vault', (a) => a && a.forget === true).length === 1, 'D11: leaving the demo closes + forgets it');
  ok(efForkShown(doc) && !efGateShown(doc), 'D11: fork shown (not the gate) after leaving the demo');
  ok(sandbox._loginGatePending === null, 'D11: nothing parked — Sign in must NOT resume the demo vault');
  ok(doc.getElementById('scr-content').style.display === 'none', 'D11: shell hidden behind the fork');
  // Sign in with no vault open → app_login parks the login (pending:true) → continuation, not the demo.
  sandbox.invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'app_login') return { pending: true }; if (cmd === 'app_login_status') return { logged_in: true, pending: true }; return base(cmd, args); };
  if (typeof sandbox.entryForkSignIn === 'function') sandbox.entryForkSignIn();
  doc.getElementById('lg-email').value = 'qa@example.com'; doc.getElementById('lg-password').value = 'x';
  await sandbox.doAppLogin();
  await efSettle();
  ok(efCalled(calls, 'app_login').length === 1 && efCalled(calls, 'create_demo_vault_auto').length === 0 && efCalled(calls, 'open_vault').length === 0, 'D11: login goes through app_login with no vault re-opened (token parked, lands in the first REAL vault)');
  ok(spies.showWelcome.length >= 1 && !mobileHtml(doc).includes('data-qa="assistant-demo-banner"'), 'D11: continuation = welcome landing — not the demo home');
}

{
  section('entry fork (D12) — desktop (linux): no fork, the plain gate as today; PRESERVE sha unchanged (checked above)');
  const { doc, spies } = await efBoot({}, { platform: 'linux' });
  ok(spies.showEntryFork.length === 0 && !efFork(doc), 'D12: no fork on desktop');
  ok(spies.showLoginGate.length === 1 && efGateShown(doc), 'D12: desktop still raises the login gate first');
  ok(!doc.body.classList.contains('mobile-mode') && !doc.body.classList.contains('mobile-native'), 'D12: no mobile-mode on desktop');
  ok(!doc.getElementById('lg-back'), 'D12: no «← Back» link on the desktop gate (nothing to go back to)');
}

{
  section('entry fork (D13) — S3 cold start via the RECENT list: same native no-session check as the remembered vault (Supervisor Н1)');
  // Н1 (AUDIT-2026-09-06-seafarer-entry-fork-close): close_vault{forget:true} writes `{}` into the
  // config, but the demo directory stays on disk and get_recent_vaults RE-FINDS it on Android by
  // scanning app_data_dir/vaults. init() then fed that vault straight to loadVault() with no native
  // check: VaultInfo carries no is_demo, so the demo exception was false and a BARE login gate went
  // up OVER an OPEN demo vault — app_login would have written the token into the demo (the very thing
  // the card forbids), and the next Demo tap wipes it with remove_dir_all.
  // A FRESH object on purpose: loadDemoVault() stamps is_demo='1' onto whatever
  // create_demo_vault_auto returned, so the shared EF_DEMO constant is already stamped by the
  // drills above — while Rust's VaultInfo (db.rs) carries NO is_demo field at all. What
  // open_vault() hands back for a demo found on disk is exactly this: an unstamped info.
  const diskDemo = { name: 'Skipi Demo', account_type: 'seafarer', position: 'master', vessel_category: 'tanker' };
  const { doc, spies, sandbox, calls } = await efBoot({ get_recent_vaults: ['/demo'], open_vault: diskDemo, get_profile_status: { is_demo: '1' } });
  ok(efForkShown(doc) && spies.showEntryFork.length === 1, 'D13: a recent DEMO on a cold start with no session lands on the fork');
  ok(spies.showLoginGate.length === 0 && !efGateShown(doc), 'D13: NO bare login gate on the recent path (Н1: the gate used to come up over an open demo vault)');
  ok(efCalled(calls, 'close_vault', (a) => a && a.forget === true).length === 1, 'D13: the recent demo is closed AND forgotten (the demo is not a session)');
  ok(sandbox._loginGatePending === null, 'D13: nothing parked — a login must never be written into the demo vault');
  ok(spies.renderMobileShell.length === 0 && !mobileHtml(doc).includes('assistant-demo-banner'), 'D13: no auto-demo home behind the fork');
}

{
  section('entry fork (D13b) — S3 recent REAL vault without a token: fork with the vault parked, never the bare gate');
  const { doc, spies, sandbox } = await efBoot({ get_recent_vaults: ['/v'], open_vault: EF_REAL, app_login_status: { logged_in: false } });
  ok(efForkShown(doc) && spies.showEntryFork.length === 1, 'D13b: a recent token-less REAL vault lands on the fork');
  ok(spies.showLoginGate.length === 0 && !efGateShown(doc), 'D13b: not the bare gate (no session → the fork is the first screen, canon (295))');
  ok(sandbox._loginGatePending === EF_REAL, 'D13b: the vault is parked — Sign in resumes the SAME vault');
  ok(spies.renderMobileShell.length === 0, 'D13b: the shell is not rendered behind the fork');
}

{
  section('entry fork (D13c) — S3 recent vault WITH a live session: unchanged, opens straight into the native home');
  const { doc, spies } = await efBoot({ get_recent_vaults: ['/v'], open_vault: EF_REAL, app_login_status: { logged_in: true } }, { seed: { 'skipi-assistant-consent': '1' } });
  ok(spies.showEntryFork.length === 0 && !efFork(doc), 'D13c: no fork with a live session (the recent path still opens the vault)');
  ok(spies.showLoginGate.length === 0, 'D13c: no gate either');
  ok(spies.renderMobileShell.length >= 1 && mobileHtml(doc).includes('id="mobile-assistant-input"'), 'D13c: loadVault() reached renderMobileShell → native home');
}

// ---------------------------------------------------------------------------
// Module menu = phone-style ICON GRID (OWNER 06.09, DECISIONS (302); card
// TASKCARD-2026-09-06-seafarer-module-icon-grid): one outline icon + a short
// label, four per row; the description moved into a long-press hint; no
// «ready/desktop» chips; Packages stays on the phone («пекеджес должен быть в
// мобильной версии»). Plus the header ‹ Back the owner asked for the same day:
// «возвращает пользователя в то меню где он был до этого» — i.e. exactly one
// step of the SAME history the system Back walks (no second handler).
// The template is the single source of truth for both mobile surfaces, so the
// drills read it out of dist/index.html AND drive the real render path.
// ---------------------------------------------------------------------------
const MODULE_TPL = (() => {
  const i = HTML.indexOf('<template id="mobile-home-modules-tpl">');
  const j = HTML.indexOf('</template>', i);
  return i >= 0 && j > i ? HTML.slice(i, j) : '';
})();
const MODULE_KEYS = ['docs', 'experience', 'cv', 'packages', 'dispatch', 'jobs', 'information', 'vessels', 'myvessel', 'apps', 'assistant'];
const tplButtons = () => (MODULE_TPL.match(/<button[\s\S]*?<\/button>/g) || []);
const tplButtonOf = (k) => tplButtons().find((b) => b.includes(k === 'packages' ? 'id="mobile-home-packages"' : `data-mview="${k}"`)) || '';
const cssRule = (sel) => {
  const re = new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(HTML);
  return m ? m[1] : '';
};
const cssNum = (sel, prop) => {
  const m = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:\\s*([0-9.]+)px').exec(cssRule(sel));
  return m ? parseFloat(m[1]) : NaN;
};
// A faithful little History: pushState/back/go move an index over real entries
// and back()/go() fire popstate with the state of the entry we land on — which
// is what the WebView does and what the in-app back contract is built on.
function installNavHistory(app) {
  const entries = [null];
  let idx = 0;
  const fire = () => (app.listeners.popstate || []).slice().forEach((fn) => { try { fn({ state: entries[idx] }); } catch (e) {} });
  app.sandbox.history = {
    calls: [],
    pushState(st) { this.calls.push(['pushState', st]); entries.length = idx + 1; entries.push(st); idx = entries.length - 1; },
    replaceState() {},
    back() { this.calls.push(['back']); if (idx > 0) { idx -= 1; fire(); } },
    go(n) { this.calls.push(['go', n]); if (n < 0 && idx > 0) { idx = Math.max(0, idx + n); fire(); } },
  };
  const timers = [];
  app.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };
  app.sandbox.clearTimeout = (id) => { if (id && timers[id - 1]) timers[id - 1].fn = null; };
  app.runTimers = (maxMs) => {
    const cap = maxMs === undefined ? 0 : maxMs;
    const due = timers.filter((t) => typeof t.fn === 'function' && t.ms <= cap);
    const rest = timers.filter((t) => t.ms > cap);
    timers.length = 0; rest.forEach((t) => timers.push(t));
    due.forEach((t) => { try { t.fn(); } catch (e) {} });
  };
  app.timers = timers;
  return app;
}

{
  section('module icon grid (IG1) — 11 icons, order and navigation unchanged (owner 06.09, DECISIONS 302)');
  ok(MODULE_TPL.length > 200, '#mobile-home-modules-tpl extracted from dist/index.html');
  const btns = tplButtons();
  ok(btns.length === 11, 'template holds exactly 11 module buttons (got ' + btns.length + ')');
  ok(/class="fam-app-grid"/.test(MODULE_TPL), 'grid container uses fam-app-grid');
  ok((MODULE_TPL.match(/fam-app-tile/g) || []).length === 11, 'each of the 11 buttons is a fam-app-tile');
  ok(MODULE_TPL.includes('id="mobile-module-rail"'), 'container keeps the mobile-module-rail id the presence contract mounts on');
  for (const v of MODULE_KEYS.filter((k) => k !== 'packages')) {
    ok(MODULE_TPL.includes(`data-mview="${v}"`) && MODULE_TPL.includes(`mobileShow('${v}')`), `'${v}' keeps data-mview + the same mobileShow route`);
  }
  ok(MODULE_TPL.includes('id="mobile-home-packages"') && MODULE_TPL.includes('mobilePackagesHint()'), 'Packages stays in the grid with the handler it has today (owner: «пекеджес должен быть в мобильной версии»)');
  const at = (k) => MODULE_TPL.indexOf(k === 'packages' ? 'id="mobile-home-packages"' : `data-mview="${k}"`);
  const order = MODULE_KEYS.map(at);
  ok(order.every((p) => p >= 0) && order.every((p, i) => i === 0 || p > order[i - 1]), 'order unchanged: Documents · Experience · CV · Packages · Mailings · Jobs · Information · Vessel DB · My Vessel · Apps · Assistant');
}

{
  section('module icon grid (IG2) — short label stays, description moves to data-hint, status chips gone');
  const btns = tplButtons();
  ok(btns.length === 11 && btns.every((b) => /data-hint="[^"]{3,}"/.test(b)), 'every icon carries a non-empty data-hint (the old description)');
  ok(btns.length === 11 && btns.every((b) => /class="fam-app-label"[^>]*>[^<]{1,18}</.test(b)), 'every icon carries a visible short fam-app-label');
  ok(!/fam-module-desc/.test(MODULE_TPL), 'no fam-module-desc left in the template');
  ok(!/fam-chip/.test(MODULE_TPL), 'no fam-chip left in the template');
  ok(!/ready/.test(MODULE_TPL), "no 'ready' readiness marker left in the template (owner: «указатель готовности спрятать»)");
  ok(!/desktop/i.test(MODULE_TPL), "no 'desktop' dead-end marker left in the template (owner: «недоступно на телефоне — плохая идея»)");
  const hintOf = (k) => { const m = /data-hint="([^"]+)"/.exec(tplButtonOf(k)); return m ? m[1] : ''; };
  ok(hintOf('docs') === 'Certificates and personal files' && hintOf('packages') === 'Prepared document sets' && hintOf('assistant') === 'Drafts and help', 'the baseline descriptions survive verbatim as hints');
}

{
  section('module icon grid (IG3) — one outline icon style, no letter/emoji placeholders');
  const btns = tplButtons();
  ok(btns.length === 11 && btns.every((b) => /<svg viewBox="0 0 24 24"/.test(b)), 'every icon is an inline 24×24 SVG');
  ok((MODULE_TPL.match(/<svg /g) || []).length === 11, 'exactly 11 icon SVGs, one per module');
  ok(!/&#9633;|&#9873;|&#9993;|&#9872;|&#9875;|&#9638;|&#128172;/.test(MODULE_TPL), 'the old symbol placeholders (▢ ⚑ ✉ ⚓ ▨ 💬) are gone');
  ok(!/fam-module-icon/.test(MODULE_TPL), 'the old letter placeholders (CV / P / J / i) in fam-module-icon boxes are gone');
  const icon = cssRule('.fam-app-tile .fam-app-icon-box svg');
  ok(/fill\s*:\s*none/.test(icon) && /stroke\s*:\s*currentColor/.test(icon) && /stroke-width\s*:\s*1\.7/.test(icon), 'one shared outline style: fill:none, stroke:currentColor, stroke-width 1.7');
  ok(/stroke-linecap\s*:\s*round/.test(icon) && /stroke-linejoin\s*:\s*round/.test(icon), 'rounded caps/joins on every icon');
}

{
  section('module icon grid (IG4) — long-press ≥400 ms shows the hint; release / scroll / tap outside hide it');
  try {
    const app = installNavHistory(bootMobile({ seed: {} }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('menu');
    app.runTimers(0);
    const btn = doc.getElementById('mhb-docs');
    const hint = doc.getElementById('mobile-module-hint');
    ok(!!btn && !!hint, 'icon button + the single hint node exist in the shell');
    ok((HTML.match(/id="mobile-module-hint"/g) || []).length === 1, 'exactly ONE hint node on the screen (not one per icon)');
    ok((MODULE_TPL.match(/onpointerdown="mobileHintPress\(this\)"/g) || []).length === 11, 'every icon arms the long-press on pointerdown');
    ok((MODULE_TPL.match(/onpointerup="mobileHintRelease\(\)"/g) || []).length === 11 && (MODULE_TPL.match(/onpointercancel="mobileHintRelease\(\)"/g) || []).length === 11, 'every icon releases the hint on pointerup/pointercancel');
    app.timers.length = 0;
    sandbox.mobileHintPress(btn);
    ok(hint.style.display !== 'block', 'hint stays hidden while the press is still short');
    const armed = app.timers.filter((t) => t.ms >= 400);
    ok(armed.length === 1, 'a single ≥400 ms long-press timer is armed (got ' + armed.length + ')');
    armed[0].fn();
    ok(hint.style.display === 'block' && hint.textContent === btn.getAttribute('data-hint'), 'after the delay the hint shows exactly the data-hint text');
    sandbox.mobileHintRelease();
    ok(hint.style.display === 'none', 'releasing the finger hides the hint');
    // scroll hides it
    sandbox.mobileHintPress(btn); app.timers.filter((t) => t.ms >= 400).forEach((t) => t.fn());
    ok(hint.style.display === 'block', 'hint shown again for the scroll drill');
    ok((app.listeners.scroll || []).length >= 1, 'the shell listens for scroll to drop the hint');
    (app.listeners.scroll || []).forEach((fn) => fn({}));
    ok(hint.style.display === 'none', 'scrolling hides the hint');
    // tap outside hides it
    sandbox.mobileHintPress(btn); app.timers.filter((t) => t.ms >= 400).forEach((t) => t.fn());
    ok(hint.style.display === 'block', 'hint shown again for the outside-tap drill');
    ok((app.listeners.pointerdown || []).length >= 1, 'the shell listens for pointerdown to drop the hint');
    (app.listeners.pointerdown || []).forEach((fn) => fn({ target: doc.body }));
    ok(hint.style.display === 'none', 'a tap outside hides the hint');
    // a long-press must NOT also open the module (the click that follows is swallowed)
    sandbox.mobileHintPress(btn); app.timers.filter((t) => t.ms >= 400).forEach((t) => t.fn());
    sandbox.mobileHintRelease();
    let prevented = false, stopped = false;
    const ev = { target: btn, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    ok((app.listeners.click || []).length >= 1, 'the shell has a capture-phase click guard');
    (app.listeners.click || []).forEach((fn) => fn(ev));
    ok(prevented && stopped, 'the click that follows a shown hint is swallowed — reading the hint does not open the module');
    const ev2 = { target: btn, preventDefault() { prevented = 'again'; }, stopPropagation() {} };
    prevented = false;
    (app.listeners.click || []).forEach((fn) => fn(ev2));
    ok(prevented === false, 'a plain tap (no hint shown) is NOT swallowed — navigation still works');
  } catch (e) { ok(false, 'module icon grid (IG4) crashed before it could assert: ' + e.message); }
}

{
  section('module icon grid (IG5) — accessibility: label = aria-label, ≥48 px targets, hint reachable');
  const btns = tplButtons();
  const labelOf = (b) => { const m = /class="fam-app-label"[^>]*>([^<]+)</.exec(b); return m ? m[1] : ''; };
  const ariaOf = (b) => { const m = /aria-label="([^"]+)"/.exec(b); return m ? m[1] : ''; };
  ok(btns.length === 11 && btns.every((b) => ariaOf(b) && ariaOf(b) === labelOf(b)), 'aria-label equals the visible label on every icon');
  ok(btns.every((b) => !/aria-describedby/.test(b)), 'no icon carries a permanent aria-describedby to an empty node (Supervisor Н5)');
  ok(cssNum('.fam-app-tile', 'min-height') >= 48, 'icon tap target is at least 48 px tall (got ' + cssNum('.fam-app-tile', 'min-height') + ')');
  ok(cssNum('.fam-app-tile .fam-app-icon-box', 'width') >= 48 && cssNum('.fam-app-tile .fam-app-icon-box', 'height') >= 48, 'icon box itself is at least 48×48 px');
  ok(/grid-template-columns\s*:\s*repeat\(4,/.test(cssRule('.fam-app-grid')), 'four icons per row (phone standard)');
  ok(/role="status"/.test((/<div[^>]*id="mobile-module-hint"[^>]*>/.exec(HTML) || [''])[0]), 'the hint node is a live region for screen readers');
}

{
  section('module icon grid (IG6) — real menu render: 11 module icons + Profile/Feedback; RU keeps the i18n keys');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-ui-language': 'ru' } }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('menu');
    app.runTimers(0);
    const mm = mobileHtml(doc);
    ok(mm.includes('data-qa="mobile-menu-screen"'), 'menu screen renders');
    ok((mm.match(/fam-app-tile/g) || []).length === 13, 'exactly 13 icons on the menu: 11 modules + Profile + Feedback (Supervisor Н6 count kept)');
    ok(!mm.includes('fam-module-desc') && !mm.includes('fam-chip'), 'the rendered menu carries no descriptions and no status chips at all');
    const docsBtn = doc.getElementById('mhb-docs');
    const label = doc.getElementById('mhn-docs');
    ok(!!docsBtn && !!label && label.textContent === 'Документы', 'RU label applied to the icon (MOBILE_HOME_MODULE_L10N key kept)');
    ok(docsBtn.getAttribute('data-hint') === 'Сертификаты и личные файлы', 'RU description applied to the hint — same i18n pair as the old desc');
    ok(docsBtn.getAttribute('aria-label') === 'Документы', 'aria-label follows the localized label');
  } catch (e) { ok(false, 'module icon grid (IG6) crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK1) — ‹ sits between ⌂ and ⚙ and calls the shared in-app back');
  const iHome = HTML.indexOf('data-qa="app-header-home"');
  const iBack = HTML.indexOf('data-qa="app-header-back"');
  const iGear = HTML.indexOf('data-qa="app-header-settings"');
  ok(iHome > 0 && iBack > iHome && iGear > iBack, 'header order in the markup: ⌂ … ‹ … ⚙');
  const tag = (/<button[^>]*data-qa="app-header-back"[^>]*>/.exec(HTML) || [''])[0];
  ok(/aria-label="[^"]+"/.test(tag), 'back button carries an aria-label');
  ok(/id="mobile-top-back"/.test(tag), 'back button has a stable id the render pass toggles');
  ok(/onclick="mobileNavBack\(\)"/.test(tag), 'back button calls mobileNavBack() — the one shared with the system Back');
  ok(/<svg viewBox="0 0 24 24"/.test(tag) || /<svg viewBox="0 0 24 24"/.test(HTML.slice(iBack, iBack + 400)), 'back button draws the same outline arrow style');
  ok(cssNum('.mobile-top-back::after', 'width') >= 48 && cssNum('.mobile-top-back::after', 'height') >= 48, 'back tap target is at least 48×48 px');
}

{
  section('header back (BK2) — hidden at the root, shown as soon as there is somewhere to go back to');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox, doc } = app;
    const back = doc.getElementById('mobile-top-back');
    sandbox.mobileShow('home'); app.runTimers(0);
    ok(!!back && back.style.display === 'none', 'no back button on the root assistant home (no dead-end control)');
    sandbox.mobileShow('menu'); app.runTimers(0);
    ok(back.style.display === 'flex', 'back button appears on the module menu');
    sandbox.mobileShow('docs'); app.runTimers(0);
    ok(back.style.display === 'flex', 'back button stays on a module screen');
    sandbox.mobileShow('home'); app.runTimers(0);
    ok(back.style.display === 'none', 'back button disappears again at the root');
  } catch (e) { ok(false, 'header back (BK2) crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK3) — assistant → module → ‹ returns to the assistant (owner: «в то меню где он был до этого»)');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox } = app;
    sandbox.mobileShow('home'); app.runTimers(0);
    sandbox.mobileShow('docs'); app.runTimers(0);
    ok(sandbox.mobileView === 'docs', 'Documents opened straight from the assistant home');
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'home', '‹ returns to the assistant home, not to the icon menu');
  } catch (e) { ok(false, 'header back (BK3) crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK4) — menu → module → ‹ returns to the icon menu, ‹ again to the assistant');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('home'); app.runTimers(0);
    sandbox.mobileShow('menu'); app.runTimers(0);
    sandbox.mobileShow('docs'); app.runTimers(0);
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'menu' && mobileHtml(doc).includes('data-qa="mobile-menu-screen"'), '‹ from a module opened via the menu returns to the menu');
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'home', '‹ from the menu returns to the assistant home');
  } catch (e) { ok(false, 'header back (BK4) crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK5) — module → sub-page → ‹ returns to the module list, not out of the module');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox } = app;
    sandbox.mobileShow('home'); app.runTimers(0);
    sandbox.mobileShow('menu'); app.runTimers(0);
    sandbox.mobileShow('docs'); app.runTimers(0);
    sandbox.mobileShow('doc'); app.runTimers(0);
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'docs', '‹ from an open document returns to the documents list');
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'menu', 'the next ‹ returns to the icon menu');
  } catch (e) { ok(false, 'header back (BK5) crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK6) — ‹ and the system Back are ONE handler: same history step, same result');
  try {
    const seq = async (drive) => {
      const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
      await settleVm();
      app.sandbox.mobileShow('home'); app.runTimers(0);
      app.sandbox.mobileShow('menu'); app.runTimers(0);
      app.sandbox.mobileShow('docs'); app.runTimers(0);
      drive(app);
      app.runTimers(0);
      return app;
    };
    const byButton = await seq((app) => app.sandbox.mobileNavBack());
    const bySystem = await seq((app) => app.sandbox.history.back());
    ok(byButton.sandbox.mobileView === bySystem.sandbox.mobileView && byButton.sandbox.mobileView === 'menu', '‹ and system Back land on the same screen');
    ok(JSON.stringify(byButton.sandbox._mobileNavStack) === JSON.stringify(bySystem.sandbox._mobileNavStack), 'both leave the in-app stack in the same state');
    ok(byButton.sandbox.history.calls.some((c) => c[0] === 'back'), '‹ walks the real History (history.back) instead of forking its own navigation');
    ok(/function mobileNavBack\(/.test(HTML) && (HTML.match(/_mobileNavStack\.pop\(\)/g) || []).length === 1, 'exactly ONE place pops the in-app stack (no second back implementation)');
  } catch (e) { ok(false, 'header back (BK6) crashed before it could assert: ' + e.message); }
}


// ---------------------------------------------------------------------------
// Supervisor close audit 06.09 (AUDIT-2026-09-06-seafarer-module-icons-close):
// Н1 — a declaration in the stylesheet proves NOTHING. `.mobile-nav-btn span
// { font-size:17px }` (0,1,1) outranked `.fam-app-label { font-size:13px }`
// (0,1,0), so the ten labels whose button carries the rail class rendered at
// 17px while Packages/Profile/Feedback rendered at 13px, and the ≤340px media
// rule was dead for those ten. These drills therefore RESOLVE THE CASCADE
// (specificity + source order) for the label as it exists on the menu screen.
// ---------------------------------------------------------------------------
const CSS_RULES = (() => {
  const rules = [];
  const blocks = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  let order = 0;
  for (const raw of blocks) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0, media = null;
    while (i < css.length) {
      const brace = css.indexOf('{', i);
      if (brace < 0) break;
      let prelude = css.slice(i, brace);
      if (/\}/.test(prelude)) media = null;            // a media block just closed
      prelude = prelude.replace(/\}/g, '').trim();
      if (/^@(media|supports)/i.test(prelude)) { media = prelude; i = brace + 1; continue; }
      if (prelude.startsWith('@')) {                   // keyframes/font-face: skip the whole block
        let depth = 1, j = brace + 1;
        while (j < css.length && depth > 0) { const c = css[j]; if (c === '{') depth++; else if (c === '}') depth--; j++; }
        i = j; continue;
      }
      const close = css.indexOf('}', brace);
      if (close < 0) break;
      const body = css.slice(brace + 1, close);
      for (const sel of prelude.split(',').map((s) => s.trim()).filter(Boolean)) rules.push({ sel, body, media, order: order++ });
      i = close + 1;
    }
  }
  return rules;
})();
const specificity = (sel) => {
  let s = ' ' + sel;
  const ids = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
  s = s.replace(/\[[^\]]*\]/g, ' ');
  const pEls = (s.match(/::[a-z-]+/g) || []).length;
  s = s.replace(/::[a-z-]+/g, ' ');
  const pCls = (s.match(/:[a-z-]+(\([^)]*\))?/g) || []).length;
  s = s.replace(/:[a-z-]+(\([^)]*\))?/g, ' ');
  const classes = (s.match(/\.[A-Za-z0-9_-]+/g) || []).length;
  s = s.replace(/\.[A-Za-z0-9_-]+/g, ' ').replace(/#[A-Za-z0-9_-]+/g, ' ');
  const tags = (s.match(/(^|[\s>+~])[a-zA-Z][A-Za-z0-9_-]*/g) || []).length;
  return [ids, classes + attrs + pCls, tags + pEls];
};
const specGE = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);
const stripPseudo = (c) => c.replace(/::[a-z-]+/g, '').replace(/:[a-z-]+(\([^)]*\))?/g, '');
function compoundMatch(comp, node) {
  const bare = stripPseudo(comp);
  const tag = /^[a-zA-Z][A-Za-z0-9_-]*/.exec(bare);
  if (tag && tag[0].toLowerCase() !== node.tag) return false;
  for (const c of bare.match(/\.[A-Za-z0-9_-]+/g) || []) if (!(node.cls || []).includes(c.slice(1))) return false;
  for (const id of bare.match(/#[A-Za-z0-9_-]+/g) || []) if (node.id !== id.slice(1)) return false;
  for (const a of bare.match(/\[[^\]]*\]/g) || []) {
    const m = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(a);
    if (!m) return false;
    const v = (node.attrs || {})[m[1]];
    if (v === undefined || (m[2] !== undefined && v !== m[2])) return false;
  }
  return true;
}
// 'yes' — applies at rest, 'state' — only in a pseudo state (:active/:hover), 'no' — never.
function selApplies(sel, chain) {
  if (/[+~]/.test(sel)) return 'no';
  const flat = sel.replace(/\s*>\s*/g, ' ').trim();
  const parts = flat.split(/\s+/);
  const stateful = /::[a-z-]+|(^|[^:]):[a-z-]+/.test(flat);
  let ci = chain.length - 1;
  if (!compoundMatch(parts[parts.length - 1], chain[ci])) return 'no';
  ci -= 1;
  for (let pi = parts.length - 2; pi >= 0; pi--) {
    let found = false;
    while (ci >= 0) { if (compoundMatch(parts[pi], chain[ci])) { found = true; ci--; break; } ci--; }
    if (!found) return 'no';
  }
  return stateful ? 'state' : 'yes';
}
const declOf = (body, prop) => {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'g');
  let m, last = null;
  while ((m = re.exec(body))) last = m[1].trim();
  return last;
};
// The winning declaration for `prop` on `chain`'s last node, in the given media context.
function cascadeWinner(prop, chain, media = null) {
  let best = null;
  for (const r of CSS_RULES) {
    if (r.media !== media && r.media !== null) continue;
    if (media !== null && r.media !== null && r.media !== media) continue;
    if (selApplies(r.sel, chain) !== 'yes') continue;
    const v = declOf(r.body, prop);
    if (v === null) continue;
    const spec = specificity(r.sel);
    if (!best || specGE(spec, best.spec) || (!specGE(best.spec, spec) && r.order > best.order)) best = { sel: r.sel, value: v, spec, order: r.order };
  }
  return best;
}
const HTML_NODE = { tag: 'html', cls: [], attrs: { 'data-theme': 'light' } };
const CHAIN_BASE = [
  HTML_NODE,
  { tag: 'body', cls: ['mobile-mode', 'mobile-native'] },
  { tag: 'div', cls: ['mobile-shell'] },
  { tag: 'main', cls: ['mobile-main'] },
  { tag: 'div', cls: ['mobile-menu'] },
  { tag: 'div', cls: ['fam-app-grid'] },
];
const railLabelChain = () => CHAIN_BASE.concat([
  { tag: 'button', cls: ['fam-app-tile', 'mobile-nav-btn'], id: 'mhb-docs' },
  { tag: 'span', cls: ['fam-app-label'], id: 'mhn-docs' },
]);
const plainLabelChain = () => CHAIN_BASE.concat([
  { tag: 'button', cls: ['fam-app-tile'], id: 'mobile-home-packages' },
  { tag: 'span', cls: ['fam-app-label'], id: 'mhn-packages' },
]);
const railIconChain = () => CHAIN_BASE.concat([
  { tag: 'button', cls: ['fam-app-tile', 'mobile-nav-btn'], id: 'mhb-docs' },
  { tag: 'span', cls: ['fam-app-icon-box'] },
]);

{
  section('module icon grid (IG7) — CASCADE: no .mobile-nav-btn rule outranks the icon label (Supervisor Н1)');
  ok(CSS_RULES.length > 100, 'stylesheet parsed into rules (' + CSS_RULES.length + ')');
  const railFs = cascadeWinner('font-size', railLabelChain());
  const plainFs = cascadeWinner('font-size', plainLabelChain());
  ok(!!railFs && /fam-app-label/.test(railFs.sel), 'the winning font-size for a RAIL-class tile label comes from the fam-app-label rule, not from «' + (railFs ? railFs.sel : '-') + '»');
  ok(!!plainFs && /fam-app-label/.test(plainFs.sel), 'the winning font-size for a plain tile label comes from the fam-app-label rule');
  ok(!!railFs && !!plainFs && railFs.value === plainFs.value, 'both label kinds resolve to the SAME size (' + (railFs ? railFs.value : '?') + ' vs ' + (plainFs ? plainFs.value : '?') + ') — no two-kegel menu');
  const railLh = cascadeWinner('line-height', railLabelChain());
  ok(!!railLh && /fam-app-label/.test(railLh.sel), 'line-height too is decided by the label rule, not by «' + (railLh ? railLh.sel : '-') + '»');
  const losers = CSS_RULES.filter((r) => /mobile-nav-btn/.test(r.sel) && selApplies(r.sel, railLabelChain()) === 'yes' && (declOf(r.body, 'font-size') || declOf(r.body, 'line-height')));
  ok(losers.every((r) => railFs && specGE(specificity(railFs.sel), specificity(r.sel))), 'every .mobile-nav-btn rule that reaches the label is strictly weaker than the label rule (' + losers.length + ' checked)');
  const iconFs = cascadeWinner('width', railIconChain());
  ok(!!iconFs && /fam-app-icon-box/.test(iconFs.sel) && parseFloat(iconFs.value) >= 48, 'the icon box keeps its own ≥48 px size on rail-class tiles too');
  // the small-screen rule must actually reach the same labels
  const media340 = (CSS_RULES.find((r) => r.media && /340px/.test(r.media)) || {}).media || null;
  const railFsSmall = media340 ? cascadeWinner('font-size', railLabelChain(), media340) : null;
  ok(!!railFsSmall && /fam-app-label/.test(railFsSmall.sel) && railFsSmall.value !== railFs.value, 'the ≤340 px rule is alive for rail-class labels too (' + (railFsSmall ? railFsSmall.value : '-') + ')');
}

{
  section('header back (BK7) — ‹ stands right next to ⌂ (owner: «справа от домика»), not adrift in the middle');
  const grp = /<div class="mobile-top-nav">([\s\S]*?)<\/div>/.exec(HTML);
  ok(!!grp, 'the header groups ⌂ and ‹ in one container (.mobile-top-nav)');
  const inner = grp ? grp[1] : '';
  ok(inner.includes('data-qa="app-header-home"') && inner.includes('data-qa="app-header-back"'), 'both ⌂ and ‹ live in that container');
  ok(inner.indexOf('app-header-home') >= 0 && inner.indexOf('app-header-home') < inner.indexOf('app-header-back'), '⌂ first, ‹ immediately to its right');
  const between = inner.slice(inner.indexOf('</button>') + 9, inner.lastIndexOf('<button'));
  ok(!/<[a-zA-Z]/.test(between), 'nothing else renders between ⌂ and ‹');
  ok(!inner.includes('app-header-settings'), '⚙ is NOT in the pair — it stays on the far side of the header');
  const gap = cssNum('.mobile-top-nav', 'gap');
  ok(/display\s*:\s*flex/.test(cssRule('.mobile-top-nav')), 'the pair is a flex row, so the two buttons keep touching');
  ok(gap > 0 && gap <= 8, 'the pair is spaced by a small gap (' + gap + 'px) — the header space-between can no longer push ‹ to the centre');
}

{
  section('header back (BK8) — the pushed-entry counter is honest in BOTH directions (Supervisor Н2)');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox } = app;
    sandbox.mobileShow('home'); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 0, 'at the root nothing is pushed yet');
    sandbox.mobileShow('menu'); app.runTimers(0);
    sandbox.mobileShow('docs'); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 2, 'two forward steps → two marked History entries (got ' + sandbox._mobileNavPushed + ')');
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 1, 'a back step CONSUMES one entry (a never-decrementing counter dies here)');
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 0 && sandbox.mobileView === 'home', 'back to the root leaves the counter at zero');
    sandbox.mobileShow('menu'); app.runTimers(0);
    sandbox.mobileShow('docs'); app.runTimers(0);
    sandbox.mobileShow('home'); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 0, '⌂ gives back every entry its history.go(-N) rewound');
  } catch (e) { ok(false, 'BK8 crashed before it could assert: ' + e.message); }
}

{
  section('header back (BK9) — with no marked entry ‹ never calls history.back() (that would leave the app)');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox } = app;
    sandbox.history.pushState = () => { throw new Error('pushState blocked'); };
    sandbox.mobileShow('home'); app.runTimers(0);
    sandbox.mobileShow('menu'); app.runTimers(0);
    ok(sandbox._mobileNavPushed === 0 && JSON.stringify(sandbox._mobileNavStack) === JSON.stringify(['home', 'menu']), 'the in-app stack is tracked even when the History entry could not be pushed');
    sandbox.history.calls.length = 0;
    sandbox.mobileNavBack(); app.runTimers(0);
    ok(sandbox.mobileView === 'home', '‹ still returns to the previous screen');
    ok(!sandbox.history.calls.some((c) => c[0] === 'back'), 'and it did NOT touch history.back() — nothing of ours to consume');
  } catch (e) { ok(false, 'BK9 crashed before it could assert: ' + e.message); }
}

{
  section('module icon grid (IG8) — the hint is announced only while it is on screen (Supervisor Н5)');
  try {
    ok(!/aria-describedby/.test(MODULE_TPL), 'no icon points at an empty hint node in the resting markup');
    const app = installNavHistory(bootMobile({ seed: {} }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('menu'); app.runTimers(0);
    const btn = doc.getElementById('mhb-docs');
    ok(!!btn && btn.getAttribute('aria-describedby') === null, 'at rest the icon has no aria-describedby');
    app.timers.length = 0;
    sandbox.mobileHintPress(btn);
    app.timers.filter((t) => t.ms >= 400).forEach((t) => t.fn());
    ok(btn.getAttribute('aria-describedby') === 'mobile-module-hint', 'while the hint shows, the pressed icon is described by it');
    sandbox.mobileHintRelease();
    ok(btn.getAttribute('aria-describedby') === null, 'hiding the hint removes the description again');
    ok(/aria-label="[^"]+"/.test(MODULE_TPL) && /title="[^"]+"/.test(MODULE_TPL), 'the always-available name (aria-label) and desktop hover (title) stay');
  } catch (e) { ok(false, 'IG8 crashed before it could assert: ' + e.message); }
}


// ---------------------------------------------------------------------------
// Mobile IME inset (defect 308, owner 06.09: «клавиатура закрывала область
// ввода»). MEASURED ROOT CAUSE, not a guess: with the Android default
// softInputMode the WebView window runs adjust=pan, so with the keyboard up the
// live WebView reported innerHeight=842, visualViewport.height=842.29,
// offsetTop=0 and fired ZERO resize/scroll events — i.e. the whole
// visualViewport family is blind here and a dist-only fix is impossible. The
// fix therefore lives in the two checked-in Android sources, and the drills
// below assert exactly that, plus the dist half (feed scroll on focus).
//
// The same block also carries the MANIFEST CONTRACT drills (RISKS №212b): the
// guard route opens AndroidManifest.xml and MainActivity.kt by path, and
// nothing else inspects what those files then say — so a permission, an
// exported component, a deep link or a JS bridge could ride in under a green
// gate. These snapshots are the content check the route itself cannot do.
// ---------------------------------------------------------------------------
const ANDROID_MAIN = path.join(__dirname, '..', 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
const MANIFEST = fs.readFileSync(path.join(ANDROID_MAIN, 'AndroidManifest.xml'), 'utf8');
const MAIN_ACTIVITY = fs.readFileSync(path.join(ANDROID_MAIN, 'java', 'app', 'skipi', 'seafarer', 'MainActivity.kt'), 'utf8');
const manifestActivity = (() => {
  const m = /<activity\b[\s\S]*?(?:\/>|<\/activity>)/.exec(MANIFEST);
  return m ? m[0] : '';
})();
const countOf = (re) => (MANIFEST.match(re) || []).length;

{
  section('mobile IME (IME1) — the manifest carries adjustResize for the SDK<=34 path');
  ok(!!manifestActivity, 'the <activity> block is found in AndroidManifest.xml');
  ok(/android:name="\.MainActivity"/.test(manifestActivity), 'the block found is MainActivity, not some other activity');
  ok(/android:windowSoftInputMode="adjustResize"/.test(manifestActivity),
    'MainActivity declares windowSoftInputMode="adjustResize" — without it the window stays adjust=pan and the composer sits under the keyboard');
  ok(!/android:windowSoftInputMode="[^"]*adjustPan/.test(MANIFEST), 'nothing re-declares adjustPan anywhere in the manifest');
}

{
  section('mobile IME (IME2) — MainActivity carries the ime() insets path for Android 15+, where adjustResize is ignored');
  ok(/setOnApplyWindowInsetsListener/.test(MAIN_ACTIVITY),
    'MainActivity installs an OnApplyWindowInsetsListener (the only route left once edge-to-edge makes adjustResize a no-op)');
  ok(/WindowInsets\.Type\.ime\(\)/.test(MAIN_ACTIVITY), 'the listener reads the ime() inset type specifically');
  ok(/setPadding\(/.test(MAIN_ACTIVITY), 'the ime inset is turned into bottom padding on the content view (that is what shrinks the WebView)');
  ok(/android\.R\.id\.content/.test(MAIN_ACTIVITY), 'the padding lands on the activity content view, so the WebView is laid out inside it');
  ok(/Build\.VERSION\.SDK_INT/.test(MAIN_ACTIVITY), 'the path is version-gated — minSdk is 24 and WindowInsets.Type.ime() only exists from API 30');
  ok(/onCreate/.test(MAIN_ACTIVITY) && MAIN_ACTIVITY.indexOf('setOnApplyWindowInsetsListener') > MAIN_ACTIVITY.indexOf('onCreate'),
    'the listener is installed from onCreate, not left as dead code');
  const imeNeighbourhood = MAIN_ACTIVITY.slice(
    Math.max(0, MAIN_ACTIVITY.indexOf('setOnApplyWindowInsetsListener') - 700),
    MAIN_ACTIVITY.indexOf('setOnApplyWindowInsetsListener'));
  ok(/try\s*\{/.test(imeNeighbourhood),
    'the inset wiring itself sits inside a try {} — a platform surprise must not turn into a crash on launch');
}

{
  section('mobile IME (IME3) — the feed follows the composer when the keyboard opens (dist half)');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('assistant');
    app.runTimers(0);
    const composer = mobileHtml(doc);
    ok(/id="mobile-assistant-input"/.test(composer), 'the assistant composer rendered');
    ok(/onfocus="mobileAssistantOnInputFocus\(\)"/.test(composer), 'the composer textarea announces focus to the app');
    ok(/onblur="mobileAssistantOnInputBlur\(\)"/.test(composer), 'and announces blur, so the resize hook cannot stay armed forever');

    const main = doc.getElementById('mobile-main');
    ok(!!main, '#mobile-main (the real scroll container) exists');
    main.scrollHeight = 4321;

    main.scrollTop = 0;
    sandbox.mobileAssistantOnInputFocus();
    ok(main.scrollTop === 4321, 'focusing the composer pins the feed to the newest message (got ' + main.scrollTop + ')');

    // The IME resize lands a frame or two AFTER focus: the deferred passes are
    // what actually survive the keyboard animation.
    main.scrollTop = 0;
    app.runTimers(400);
    ok(main.scrollTop === 4321, 'a deferred pass re-pins the feed after the keyboard has finished opening (got ' + main.scrollTop + ')');

    main.scrollTop = 0;
    ok((app.listeners.resize || []).length > 0, 'the app listens for window resize at all');
    (app.listeners.resize || []).forEach((fn) => fn());
    ok(main.scrollTop === 4321, 'a resize while the composer has focus re-pins the feed (got ' + main.scrollTop + ')');

    // Negative control: with the composer unfocused a resize (rotation, split
    // screen) must NOT yank the feed to the bottom under the reader.
    sandbox.mobileAssistantOnInputBlur();
    main.scrollTop = 7;
    (app.listeners.resize || []).forEach((fn) => fn());
    ok(main.scrollTop === 7, 'with the composer unfocused a resize leaves the feed where the reader left it (got ' + main.scrollTop + ')');
  } catch (e) { ok(false, 'IME3 crashed before it could assert: ' + e.message); }
}

{
  section('mobile IME (IME4) — desktop is untouched: the composer hook is inert off the mobile shell');
  try {
    const app = installNavHistory(bootApp({ seed: { 'skipi-assistant-consent': '1' } }));
    await settleVm();
    const { sandbox, doc } = app;
    ok(sandbox.isNativeMobile() === false, 'the desktop boot really is not native mobile');
    ok(sandbox.shouldUseMobileShell() === false, 'and the desktop boot is not on the mobile shell either');
    ok((app.listeners.resize || []).length > 0, 'the desktop boot DOES register the same resize listener (so this negative is not vacuous)');
    const main = doc.getElementById('mobile-main');
    main.scrollHeight = 4321;
    // Arm the focus flag by hand: the platform gate — not merely "nobody
    // focused anything" — is what has to keep desktop out. Without this the
    // drill passes even if the shouldUseMobileShell() check is deleted.
    sandbox.mobileAssistantInputFocused = true;
    main.scrollTop = 11;
    (app.listeners.resize || []).forEach((fn) => fn());
    ok(main.scrollTop === 11, 'even with the focus flag armed, a desktop resize never re-pins the assistant feed (got ' + main.scrollTop + ')');
  } catch (e) { ok(false, 'IME4 crashed before it could assert: ' + e.message); }
}

{
  section('manifest contract (MAN1) — the permission set is a snapshot, not a door (RISKS №212b)');
  const perms = (MANIFEST.match(/<uses-permission[^>]*android:name="([^"]+)"/g) || [])
    .map((s) => /android:name="([^"]+)"/.exec(s)[1]).sort();
  ok(JSON.stringify(perms) === JSON.stringify(['android.permission.CAMERA', 'android.permission.INTERNET']),
    'exactly INTERNET + CAMERA are requested — any added permission fails here (got ' + JSON.stringify(perms) + ')');
  const feats = (MANIFEST.match(/<uses-feature[^>]*android:name="([^"]+)"/g) || [])
    .map((s) => /android:name="([^"]+)"/.exec(s)[1]).sort();
  ok(JSON.stringify(feats) === JSON.stringify(['android.hardware.camera', 'android.software.leanback']),
    'the uses-feature set is unchanged too (got ' + JSON.stringify(feats) + ')');
  ok(!/android\.permission\.(RECORD_AUDIO|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_CONTACTS|BLUETOOTH|NEARBY_WIFI_DEVICES|READ_EXTERNAL_STORAGE|POST_NOTIFICATIONS)/.test(MANIFEST),
    'no mic / location / contacts / bluetooth / storage / notification permission slipped in under the IME route');
}

{
  section('manifest contract (MAN2) — no cleartext, no debuggable, no new exported surface, no deep links');
  ok(!/android:usesCleartextTraffic="true"/.test(MANIFEST), 'usesCleartextTraffic is not hard-wired to true (it stays the build placeholder)');
  ok(/android:usesCleartextTraffic="\$\{usesCleartextTraffic\}"/.test(MANIFEST), 'and it is still the ${usesCleartextTraffic} placeholder the build controls');
  ok(!/android:debuggable="true"/.test(MANIFEST), 'the manifest does not force android:debuggable="true"');
  ok(countOf(/android:exported="true"/g) === 1, 'exactly ONE exported component — the launcher activity (got ' + countOf(/android:exported="true"/g) + ')');
  ok(/android:name="\.MainActivity"/.test(manifestActivity) && /android:exported="true"/.test(manifestActivity), 'and that one exported component is MainActivity itself');
  ok(countOf(/<intent-filter>/g) === 1, 'exactly ONE <intent-filter> — the launcher (got ' + countOf(/<intent-filter>/g) + ')');
  ok(!/android:scheme=/.test(MANIFEST), 'no android:scheme= anywhere — no deep link / custom URL entry point');
  ok(!/android:host=/.test(MANIFEST) && !/BROWSABLE/.test(MANIFEST), 'no app-links host and no BROWSABLE category');
  ok(/<provider[\s\S]*?android:exported="false"/.test(MANIFEST), 'the FileProvider stays non-exported');
  ok(countOf(/<service\b/g) === 0 && countOf(/<receiver\b/g) === 0, 'no service and no broadcast receiver were added');
}

{
  section('manifest contract (MAN3) — the component inventory is fixed');
  ok(countOf(/<activity\b/g) === 1, 'exactly one <activity> (got ' + countOf(/<activity\b/g) + ')');
  ok(countOf(/<provider\b/g) === 1, 'exactly one <provider> — the FileProvider (got ' + countOf(/<provider\b/g) + ')');
  ok(countOf(/<application\b/g) === 1, 'one <application> block');
  ok(/android:theme="@style\/Theme\.skipi"/.test(MANIFEST), 'the app theme is unchanged');
  ok(/android:launchMode="singleTask"/.test(manifestActivity), 'launchMode stays singleTask — the Back contract (bug #2) depends on it');
}

{
  section('manifest contract (MAN4) — MainActivity opens no JS bridge and loads no external URL');
  ok(!/addJavascriptInterface/.test(MAIN_ACTIVITY), 'no addJavascriptInterface — that would hand the page a native bridge outside the plugin isolation contract');
  ok(!/setWebContentsDebuggingEnabled\s*\(\s*true\s*\)/.test(MAIN_ACTIVITY), 'no unconditional setWebContentsDebuggingEnabled(true)');
  ok(!/loadUrl\s*\(\s*"https?:\/\//.test(MAIN_ACTIVITY), 'no loadUrl() to an external http(s) URL');
  ok(!/loadData(WithBaseURL)?\s*\(/.test(MAIN_ACTIVITY), 'no loadData/loadDataWithBaseURL injection point');
  ok(!/setAllowFileAccess\s*\(\s*true\s*\)|setAllowUniversalAccessFromFileURLs\s*\(\s*true\s*\)/.test(MAIN_ACTIVITY), 'no WebView file-access relaxation');
  ok(!/Runtime\.getRuntime|ProcessBuilder/.test(MAIN_ACTIVITY), 'no process execution from the activity');
}

{
  section('remote install + offline persistence harness');
  await runRemoteInstallOfflineHarness();
}

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

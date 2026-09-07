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
// @skipi/settings — the unified settings shell the gear really opens (desktop AND mobile).
// Loaded on demand by bootApp({ withSettings: true }) so the account/deletion drills can
// exercise the shell the user actually sees instead of the legacy fallback screen.
const SETTINGS_MODULE = fs.readFileSync(path.join(DIST, 'skipi-settings.js'), 'utf8');
const ACCOUNT_DELETE_RS = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'commands', 'account_delete.rs'), 'utf8');
const LIB_RS = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
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

function bootApp({ seed = {}, onLine = true, platform = 'linux', withSettings = false, invokeOverride = null } = {}) {
  const doc = new VmDocument(HTML);
  const lstore = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  // mobile-home-assistant (owner 05.09): capture window listeners (popstate/online/offline) and
  // record History calls so the Android Back contract can be driven and asserted from the harness.
  const listeners = {};
  const invokeCalls = [];
  const invoke = async (cmd, args) => {
    invokeCalls.push([cmd, args]);
    if (invokeOverride) {
      const hit = await invokeOverride(cmd, args);
      if (hit !== undefined) return hit;
    }
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
  // Same for @skipi/settings when a drill needs the REAL unified shell: without it the
  // adapter takes its fail-closed branch and the legacy screen answers instead.
  if (withSettings) vm.runInContext(SETTINGS_MODULE, sandbox, { filename: 'dist/skipi-settings.js' });
  const scripts = Array.from(HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, a]) => !/\ssrc\s*=/.test(a || ''))
    .map(([, , c]) => c);
  scripts.forEach((code, i) => vm.runInContext(code, sandbox, { filename: `dist/index.html#inline-${i + 1}` }));
  return { sandbox, doc, lstore, listeners, invokeCalls };
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
  for (const v of ['docs', 'experience', 'cv', 'packages', 'dispatch', 'jobs', 'information', 'vessels', 'myvessel', 'apps', 'assistant']) {
    ok(mm.includes(`data-mview="${v}"`) && mm.includes(`mobileShow('${v}')`), `menu grid routes '${v}' through mobileShow`);
  }
  ok(mm.includes('id="mobile-home-packages"'), 'Packages keeps its tile id (the presence drills mount on it) and now opens the real module — see PKG1');
  ok((mm.match(/fam-app-tile/g) || []).length === 14, 'exactly 14 icons: 11 module icons + Profile + Feedback + Language (the wide language row owner asked to remove on 06.09 became the third menu-only icon — see LANG1)');
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
  ok((mobileHtml(off.doc).match(/fam-app-tile/g) || []).length === 14, 'menu renders all icons offline');
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
  // 2026-09-06 (iOS blockers slice): this frozen region carries #login-gate-overlay and
  // #forced-profile-overlay, and BOTH had to take safe-area padding + flex-start scroll
  // (audit 5cfff5b3 Н7). The pin is re-based — and the old pin is kept honest: revert
  // exactly those two style attributes and the ORIGINAL 34705f8b sha must come back, which
  // proves nothing else in the desktop markup was touched by this slice.
  ok(sha256Text(region) === '584d444887da3e713d2363caa8a845c6d34c60f3e4ee3ed3ed5dcaddd0a8afbc', 'desktop static markup region sha256 == the re-based pin');
  const preIosRegion = region
    .replace('align-items:flex-start;justify-content:center;overflow:auto;padding:calc(32px + env(safe-area-inset-top,0px)) 20px calc(32px + env(safe-area-inset-bottom,0px));', 'align-items:center;justify-content:center;overflow:auto;padding:32px 20px;')
    .replace('padding:calc(40px + env(safe-area-inset-top,0px)) 20px calc(40px + env(safe-area-inset-bottom,0px));', 'padding:40px 20px;');
  ok(sha256Text(preIosRegion) === 'b28a9c36ee5891dce24510e51189c033b8f45f50b1f5e826c0156802f19fc0ce',
    'undoing ONLY the two overlay safe-area attributes restores BASELINE 34705f8b byte for byte (sed -n 1444,1660p | sha256sum) — the rest of the desktop markup is untouched');
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
  ok(MODULE_TPL.includes('id="mobile-home-packages"') && MODULE_TPL.includes("mobileShow('packages')"), 'Packages stays in the grid and now OPENS the module (owner 06.09: «пекеджес должен быть в мобильной версии») — see PKG1');
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
  section('module icon grid (IG6) — real menu render: 11 module icons + Profile/Feedback/Language; RU keeps the i18n keys');
  try {
    const app = installNavHistory(bootMobile({ seed: { 'skipi-ui-language': 'ru' } }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('menu');
    app.runTimers(0);
    const mm = mobileHtml(doc);
    ok(mm.includes('data-qa="mobile-menu-screen"'), 'menu screen renders');
    ok((mm.match(/fam-app-tile/g) || []).length === 14, 'exactly 14 icons on the menu: 11 modules + Profile + Feedback + Language');
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
// Apps screen icon grid (AG1–AG7) — owner 06.09 with the Apps screenshot:
// «в разделе apps это уберем вовсе. а значки плагинов (в том числе и
// установленных) делаем в таком же стиле как и значки главного меню».
// Two things are drilled: the duplicated module list above the launcher is gone
// for good (AG1/AG6), and the launcher's own plugin tiles now speak the module
// grid's icon language — rounded icon box, short label, description behind a
// long press (AG2/AG3), with the open path and the module grid untouched
// (AG4/AG5). AG7 drills the pure transform on icon shapes no bundled plugin
// ships today (inline SVG, bitmap) so the styling is not emoji-only by accident.
// ---------------------------------------------------------------------------

const appsTileTag = (h, id) => {
  const m = new RegExp('<button[^>]*data-qa="plugin-open-' + id + '"[^>]*>').exec(h);
  return m ? m[0] : '';
};

{
  section('apps icon grid (AG1) — the duplicated module list is gone from the Apps screen');
  try {
    const app = installNavHistory(bootMobile({ seed: BNWAS_INSTALLED }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('apps'); app.runTimers(0);
    const h = mobileHtml(doc);
    ok(h.includes('data-qa="seafarer-module-apps"'), 'the Apps launcher itself still renders');
    ok(!h.includes('data-qa="apps-module-tiles"'), 'zero apps-module-tiles wrappers on the Apps screen');
    ok((h.match(/fam-module-card/g) || []).length === 0, 'zero fam-module-card tiles on the Apps screen (got ' + (h.match(/fam-module-card/g) || []).length + ')');
    ok(!h.includes('mobile-apps-module-grid'), 'the module-duplicate grid container is gone');
    ok(!/mobileShow\('(docs|experience|cv|dispatch|jobs|information|vessels|myvessel|assistant)'\)/.test(h), 'the Apps screen routes to no home module any more — only plugins live here');
  } catch (e) { ok(false, 'AG1 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG2) — plugin tiles speak the main-menu icon language');
  try {
    const app = installNavHistory(bootMobile({ seed: BNWAS_INSTALLED }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('apps'); app.runTimers(0);
    const h = mobileHtml(doc);
    ok(h.includes('data-qa="plugin-tile-bnwas-time-anchor"') && h.includes('data-qa="plugin-open-bnwas-time-anchor"'), 'both plugin hooks survive the restyle');
    const tag = appsTileTag(h, 'bnwas-time-anchor');
    ok(/class="fam-app-tile"/.test(tag), 'the plugin tile IS a fam-app-tile, like every module icon');
    ok(/data-hint="[^"]{3,}"/.test(tag), 'the description moved into data-hint');
    ok(/aria-label="[^"]+"/.test(tag), 'aria-label carries the plugin name');
    ok(h.includes('<span class="fam-app-icon-box" aria-hidden="true">'), 'the icon sits in the same rounded fam-app-icon-box');
    ok(/<span class="fam-app-label">BNWAS \/ Time Anchor<\/span>/.test(h), 'a single short label sits under the icon');
    ok(!h.includes('apps-icon-tile-meta'), 'no «meta» second text line in the tile');
    ok(!h.includes('apps-icon-tile-name') && !h.includes('apps-icon-tile-icon'), 'the old tile spans are gone from the Apps screen');
    ok(!/class="apps-icon-tile"/.test(h), 'no old .apps-icon-tile wrapper left on the Apps screen');
    ok(!h.includes('data-qa="state-chip-ready"') && !h.includes('fam-chip'), 'no readiness chip in the tile (same rule the module grid follows)');
    ok(!h.includes('apps-badge'), 'no badge text inside a tile');
    ok(/grid-template-columns\s*:\s*repeat\(4,/.test(cssRule('body.mobile-mode .apps-launcher-grid')), 'four plugin icons per row, exactly like .fam-app-grid');
    ok(/font-size\s*:\s*26px/.test(cssRule('.fam-app-tile .fam-app-icon-box .fam-app-glyph')), 'an emoji/letter plugin icon is drawn at the shared icon size inside the box');
    // A module icon is an <svg>; a plugin icon is usually an emoji, i.e. TEXT. A long
    // press over text hands the gesture to the WebView's selection/callout machinery,
    // which cancels the pointer stream the hint is built on — so the glyph is made
    // non-interactive and the whole tile non-selectable (smoke 06.09, emulator).
    ok(/pointer-events\s*:\s*none/.test(cssRule('.fam-app-tile .fam-app-icon-box .fam-app-glyph')), 'the emoji glyph is pointer-transparent, so the press target is the button (like the module <svg>)');
    ok(/user-select\s*:\s*none/.test(cssRule('.fam-app-tile')) && /-webkit-touch-callout\s*:\s*none/.test(cssRule('.fam-app-tile')), 'the tile is non-selectable and has no long-press callout, so a long press stays a hint');
  } catch (e) { ok(false, 'AG2 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG3) — long press on a plugin icon shows the same hint bubble');
  try {
    const app = installNavHistory(bootMobile({ seed: BNWAS_INSTALLED }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('apps'); app.runTimers(0);
    const tag = appsTileTag(mobileHtml(doc), 'bnwas-time-anchor');
    ok(/onpointerdown="mobileHintPress\(this\)"/.test(tag), 'the plugin icon arms the long-press on pointerdown');
    ok(/onpointerup="mobileHintRelease\(\)"/.test(tag) && /onpointercancel="mobileHintRelease\(\)"/.test(tag), 'and releases it on pointerup/pointercancel — the module-grid contract');
    const hintText = (/data-hint="([^"]+)"/.exec(tag) || [])[1] || '';
    ok(hintText.length > 3, 'the plugin tile carries a non-empty hint (got "' + hintText + '")');
    ok(hintText === (sandbox.pluginById('bnwas-time-anchor') || {}).short, 'the hint says what the plugin IS (registry .short), not just its version — the module-grid rule');
    // The VM DOM keeps generated markup as a string, so the bubble is driven
    // through the REAL mobileHint* path on a node carrying the REAL data-hint.
    const hint = doc.getElementById('mobile-module-hint');
    const node = doc.createElement('button');
    node.setAttribute('data-hint', hintText);
    app.timers.length = 0;
    sandbox.mobileHintPress(node);
    ok(hint.style.display !== 'block', 'a short press shows nothing');
    const armed = app.timers.filter((t) => t.ms >= 400);
    ok(armed.length === 1, 'a single ≥400 ms long-press timer is armed (got ' + armed.length + ')');
    armed[0].fn();
    ok(hint.style.display === 'block' && hint.textContent === hintText, 'after the delay the bubble shows the plugin hint verbatim');
    sandbox.mobileHintRelease();
    ok(hint.style.display === 'none', 'releasing the finger hides it again');
  } catch (e) { ok(false, 'AG3 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG4) — tapping an icon opens the plugin through the existing path');
  try {
    const app = installNavHistory(bootMobile({ seed: BNWAS_INSTALLED }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('apps'); app.runTimers(0);
    const tag = appsTileTag(mobileHtml(doc), 'bnwas-time-anchor');
    ok(/onclick="pluginLaunch\('bnwas-time-anchor'\)"/.test(tag), 'the icon keeps the SAME onclick the launcher shipped (pluginLaunch)');
    sandbox.pluginLaunch('bnwas-time-anchor');
    ok(sandbox.pluginHostState.openId === 'bnwas-time-anchor', 'pluginLaunch from the icon opens the plugin');
    ok(mobileHtml(doc).includes('id="plugin-host-container"'), 'and it mounts into the single isolated host container');
    sandbox.pluginClose();
    ok(sandbox.pluginHostState.surface === 'launcher' && sandbox.pluginHostState.openId === null, 'close returns to the launcher (UHOST-11 unchanged)');
    const back = mobileHtml(doc);
    ok(/class="fam-app-tile"/.test(back) && !/class="apps-icon-tile"/.test(back), 'the launcher comes back in the NEW icon style after closing a plugin (module pluginRerender path)');
    sandbox.pluginOpenManage();
    ok(mobileHtml(doc).includes('data-qa="plugin-settings-bnwas-time-anchor"'), 'the gear still opens plugin management');
    sandbox.pluginBackToLauncher();
    const back2 = mobileHtml(doc);
    ok(/class="fam-app-tile"/.test(back2) && !/class="apps-icon-tile"/.test(back2), '«← Apps» returns to the launcher in the new icon style too');
  } catch (e) { ok(false, 'AG4 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG5) — the main menu grid is untouched by the Apps restyle');
  try {
    const app = installNavHistory(bootMobile({ seed: {} }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('menu'); app.runTimers(0);
    const mm = mobileHtml(doc);
    ok((mm.match(/fam-app-tile/g) || []).length === 14, 'menu still shows 14 icons: 11 modules + Profile + Feedback + Language (got ' + (mm.match(/fam-app-tile/g) || []).length + ')');
    ok(tplButtons().length === 11 && !/apps-icon-tile/.test(MODULE_TPL), 'the module template itself is not touched by the Apps restyle');
    ok(mm.includes('data-qa="menu-tile-profile"') && mm.includes('data-qa="menu-tile-feedback"'), 'Profile and Feedback tiles still there');
  } catch (e) { ok(false, 'AG5 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG6) — the module-duplicate code is deleted, not just hidden');
  ok(!/MOBILE_APPS_MODULE_TILES/.test(HTML), 'MOBILE_APPS_MODULE_TILES is gone from dist/index.html');
  ok(!/mobileAppsModuleTilesHtml/.test(HTML), 'mobileAppsModuleTilesHtml is gone');
  ok(!/mobileAppsEnsureModuleTiles/.test(HTML), 'mobileAppsEnsureModuleTiles is gone');
  ok(!/apps-module-tiles/.test(HTML), 'the apps-module-tiles marker is gone from the shipped bytes');
  ok(!/mobile-apps-module-grid/.test(HTML), 'the .mobile-apps-module-grid CSS is gone');
  ok(/function mobileAppsIconizeHtml\(/.test(HTML), 'the restyle is one pure string transform (mobileAppsIconizeHtml)');
  ok(/MutationObserver/.test(HTML), 'partial launcher re-renders (search / async catalog refresh) are covered by an observer');
  ok((HOST_UI_MODULE.match(/apps-icon-tile/g) || []).length > 0, 'the vendored @skipi/plugin-host-ui bytes are NOT edited — the home restyles what the module rendered');
}

{
  section('apps icon grid (AG7) — the transform itself: emoji, inline SVG and bitmap icons all land in the icon box');
  try {
    const app = bootMobile({ seed: BNWAS_INSTALLED });
    await settleVm();
    const t = app.sandbox.mobileAppsIconizeHtml;
    ok(typeof t === 'function', 'mobileAppsIconizeHtml is reachable');
    if (typeof t === 'function') {
      const tile = (icon, extra) => '<div class="apps-icon-tile" data-qa="plugin-tile-x"><button type="button" data-qa="plugin-open-x" onclick="pluginLaunch(\'x\')" title="X &#183; v1"><span class="apps-icon-tile-icon">' + icon + '</span><span class="apps-icon-tile-name">X</span><span class="apps-icon-tile-meta">v1</span>' + (extra || '') + '</button></div>';
      const emoji = t(tile('⏱️'));
      ok(/<span class="fam-app-icon-box" aria-hidden="true"><span class="fam-app-glyph">⏱️<\/span><\/span>/.test(emoji), 'an emoji icon is wrapped in a sized glyph span (the box itself is font-size:0)');
      const svg = t(tile('<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>'));
      ok(/<span class="fam-app-icon-box" aria-hidden="true"><svg viewBox="0 0 24 24">/.test(svg), 'an inline SVG icon goes straight into the box (the shared outline CSS styles it)');
      const img = t(tile('<img src="plugins/x/icon.png" alt="">'));
      ok(/<span class="fam-app-icon-box" aria-hidden="true"><img src="plugins\/x\/icon\.png"/.test(img), 'a bitmap icon goes into the box too');
      ok(!/apps-icon-tile/.test(emoji) && !/apps-icon-tile/.test(svg) && !/apps-icon-tile/.test(img), 'nothing of the old tile markup survives the transform');
      ok(/data-qa="plugin-tile-x"/.test(emoji) && /data-qa="plugin-open-x"/.test(emoji) && /onclick="pluginLaunch\('x'\)"/.test(emoji), 'id hooks and the open handler are carried over verbatim');
      const upd = t(tile('⏱️', '<span class="apps-badge live" data-qa="plugin-update-available-x">Update available</span>'));
      ok(/data-hint="v1"/.test(emoji), 'an unknown plugin id falls back to the meta line the launcher printed, never to an empty hint');
      ok(/data-hint="v1 · Update available"/.test(upd) && !/apps-badge/.test(upd), '«Update available» moves into the hint instead of a second text line in the tile');
      ok(t('<div>nothing to do</div>') === '<div>nothing to do</div>', 'markup without launcher tiles comes back byte-identical');
    }
  } catch (e) { ok(false, 'AG7 crashed before it could assert: ' + e.message); }
}

{
  section('apps icon grid (AG8) — the restyle never reaches the DESKTOP launcher (defect F5)');
  try {
    const app = installNavHistory(bootMobile({ seed: BNWAS_INSTALLED }));
    await settleVm();
    const { sandbox, doc } = app;
    sandbox.mobileShow('apps'); app.runTimers(0);
    // The vendored module emits the SAME #apps-launcher-results id on BOTH surfaces:
    // the desktop launcher writes it into #scr-content and the mobile one into
    // #mobile-main. #mobile-main is always in the DOM, so a GLOBAL getElementById
    // would let the mobile observer rewrite a DESKTOP screen (matters for WEB=DESKTOP).
    const fnBody = (name) => { const i = HTML.indexOf(name); if (i < 0) return null; const j = HTML.indexOf('\n}\n', i); return j < 0 ? null : HTML.slice(i, j); };
    const fn = fnBody('function mobileAppsIconizeTiles(') || '';
    ok(fn.length > 50, 'mobileAppsIconizeTiles located in the shipped bytes');
    ok(!/document\.getElementById\(\s*'apps-launcher-results'\s*\)/.test(fn), 'no GLOBAL getElementById for the launcher-results id');
    ok(/main\.querySelector\(\s*'#apps-launcher-results'\s*\)/.test(fn), 'the launcher-results node is looked up INSIDE #mobile-main');
    ok((HOST_UI_MODULE.match(/id="apps-launcher-results"/g) || []).length >= 2, 'the module really emits that id on both the desktop and the mobile launcher (got ' + (HOST_UI_MODULE.match(/id="apps-launcher-results"/g) || []).length + ')');
    // Behavioural: a node carrying that id OUTSIDE #mobile-main is left untouched.
    const OLD = '<div class="apps-icon-tile" data-qa="plugin-tile-desk"><button type="button" data-qa="plugin-open-desk" onclick="pluginLaunch(\'desk\')" title="Desk"><span class="apps-icon-tile-icon">D</span><span class="apps-icon-tile-name">Desk</span></button></div>';
    const outside = doc.createElement('div');
    outside.setAttribute('id', 'apps-launcher-results');
    outside.innerHTML = OLD;
    const main = doc.getElementById('mobile-main');
    // The VM DOM keeps no real tree, so element.querySelector delegates to the document.
    // Model the browser for this drill: nothing with that id sits inside #mobile-main.
    // If the code ever goes back to document.getElementById, the node above IS found
    // (it is registered by id) and rewritten — which is exactly what must stay RED.
    main.querySelector = () => null;
    sandbox.mobileAppsIconizeTiles();
    ok(outside.innerHTML === OLD, 'a launcher-results node OUTSIDE #mobile-main is never rewritten (the desktop launcher is safe)');
    ok(/class="apps-icon-tile"/.test(outside.innerHTML), 'and its old .apps-icon-tile markup survives byte-for-byte');
  } catch (e) { ok(false, 'AG8 crashed before it could assert: ' + e.message); }
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

// ---------------------------------------------------------------------------
// Mobile «Packages» — slice 1: list, create, delete (owner 06.09 dословно
// «это не правильно. пекеджес должен быть в мобильной версии», DECISIONS (302);
// card TASKCARD-2026-09-06-seafarer-mobile-packages). Drills PKG1..PKG11.
//
// The Rust side is already platform-neutral (get_packages / create_package /
// delete_package in src-tauri/src/commands/packages.rs) — this slice is UI only.
// Sending a package OUT of the phone is NOT in this slice (Rust blocks it:
// open_email_with_attachment is Err() on android/ios), so a Share/Save/Email
// button on the mobile screen is a FAILURE here, not a missing feature.
// ---------------------------------------------------------------------------

// The mobile Packages implementation lives between these two anchors in
// dist/index.html; every "no invoke outside the contract" drill scopes to it so
// the desktop packages code (which does have Email/Save) never satisfies them.
const PKG_SRC = (() => {
  const i = HTML.indexOf('// ---- BEGIN mobile Packages');
  const j = HTML.indexOf('// ---- END mobile Packages');
  return i >= 0 && j > i ? HTML.slice(i, j) : '';
})();
// …and the same block with its // comments stripped: a comment that NAMES a
// command (the block explains why sharing is absent) is not a wired call, so
// the "what does this code do" drills read PKG_CODE, not the prose.
const PKG_CODE = PKG_SRC.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// Desktop packages region — PRESERVE: this slice must not touch it.
const DESKTOP_PKG_SHA = '179099b3b5dd56b36714d89e88daa3bf6191a462deac9673a385d02822d0417b';

const PKG_A = { id: 'pkg-a', title: 'Crewing set', created_on: '2026-09-01 10:11:12', expires_on: '2027-09-01T10:11:12', download_count: 0, download_limit: 999, password: null, file_count: 3 };
const PKG_B = { id: 'pkg-b', title: 'Medical set', created_on: '2026-08-02 09:00:00', expires_on: '2026-08-03T09:00:00', download_count: 0, download_limit: 999, password: null, file_count: 1 };
const PKG_DOCS = [
  { id: 'd1', title: 'Passport', category: 'personal', file_name: 'passport.pdf' },
  { id: 'd2', title: 'Seaman Book', category: 'personal', file_name: 'sb.pdf' },
  { id: 'd3', title: 'GMDSS', category: 'certificates', file_name: '' },
];

// Boot the NATIVE mobile shell, then take over invoke() so the packages screen
// runs against a controlled backend. init() has already settled by then, so the
// recorded calls belong to the packages screen and nothing else.
async function pkgBoot(opts) {
  const o = opts || {};
  const app = installNavHistory(bootMobile({ seed: o.lang ? { 'skipi-ui-language': o.lang } : {} }));
  await settleVm();
  const calls = [];
  let pkgs = (o.packages || []).slice();
  app.sandbox.invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'get_packages') { if (o.getFails) throw new Error('No vault open'); return pkgs.slice(); }
    if (cmd === 'create_package') {
      if (o.createFails) throw new Error('Cannot create package — 1 document(s) have no file');
      const id = 'pkg-new-' + (pkgs.length + 1);
      pkgs.push({ id, title: args.title, created_on: '2026-09-06 12:00:00', expires_on: '2027-09-06T12:00:00', download_count: 0, download_limit: args.downloadLimit, password: null, file_count: (args.docIds || []).length });
      return id;
    }
    if (cmd === 'delete_package') { pkgs = pkgs.filter((p) => p.id !== args.packageId); return null; }
    if (cmd === 'get_build_info') return { version: '0.0.0-apps-harness', sha: 'apps-harness' };
    if (cmd === 'get_platform') return 'android';
    return {};
  };
  app.sandbox.allDocs = (o.docs || []).slice();
  app.sandbox.uiConfirm = async () => (o.confirm === undefined ? true : !!o.confirm);
  const toasts = [];
  const origToast = app.sandbox.showToast;
  app.sandbox.showToast = (msg, kind) => { toasts.push([String(msg), kind]); if (typeof origToast === 'function') try { origToast(msg, kind); } catch (e) {} };
  app.calls = calls;
  app.toasts = toasts;
  app.pkgs = () => pkgs;
  // The VmDocument indexes every id it sees in the RAW source, including the
  // ones that live only inside a JS string literal — so #mobile-pkg-title
  // exists in the fake DOM from boot, holding the template text. Typing goes
  // through that field (as a user does) AND the mirror variable, exactly like
  // the real oninput does, so mobileCapturePackageTitle() stays under test.
  app.typeTitle = (v) => {
    app.sandbox.mobilePackagesTitle = v;
    const el = app.doc.getElementById('mobile-pkg-title');
    if (el) el.value = v;
  };
  return app;
}
const pkgCalls = (app, cmd) => app.calls.filter(([c]) => c === cmd);

{
  section('mobile Packages (PKG1) — the grid icon opens the module, the dead-end toast is gone');
  ok(MODULE_TPL.includes('id="mobile-home-packages"'), 'Packages keeps its tile id in the module grid');
  ok(MODULE_TPL.includes("mobileShow('packages')"), "the Packages tile routes through mobileShow('packages')");
  ok(!/mobilePackagesHint/.test(MODULE_TPL), 'the tile no longer calls mobilePackagesHint()');
  ok(!/mobilePackagesHint/.test(HTML), 'mobilePackagesHint is gone from dist/index.html entirely — no dead-end toast left to call');
  ok(!/desktop-версии|desktop app/.test(PKG_CODE), 'the mobile packages code contains no "lives on desktop" copy');
}

{
  section('mobile Packages (PKG2) — router branch + module info key + Back history');
  try {
    const app = await pkgBoot({ packages: [PKG_A] });
    const { sandbox, doc } = app;
    ok(typeof sandbox.renderMobilePackages === 'function', 'renderMobilePackages() exists');
    const info = sandbox.mobileModuleInfo('packages');
    const fallback = sandbox.mobileModuleInfo('information');
    ok(!!info && info !== fallback && info.title !== fallback.title, "mobileModuleInfo('packages') is its own entry, not the information fallback");
    ok(/packages?/i.test(String(info.title)) || /пакет/i.test(String(info.title)), 'and its title names the module (got ' + (info && info.title) + ')');
    sandbox.mobileShow('packages');
    await settleVm();
    ok(sandbox.mobileView === 'packages', "mobileShow('packages') switches mobileView");
    ok(mobileHtml(doc).includes('data-qa="seafarer-module-packages"'), 'renderMobileShell dispatches to the packages screen (root hook rendered)');
    // Back must come home through the SAME shared nav (mobileNavTrack in renderMobileShell).
    const pushed = sandbox.history.calls.filter(([k, st]) => k === 'pushState' && st && st.skipiMobileNav === 'packages');
    ok(pushed.length === 1, 'exactly one marked History entry pushed for the packages view (got ' + pushed.length + ')');
    sandbox.history.back();
    await settleVm();
    ok(sandbox.mobileView === 'home', 'system Back from packages returns to the previous screen, it does not leave the app');
  } catch (e) { ok(false, 'PKG2 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG3) — list renders from get_packages as CARDS (title, created, files), no <table>');
  try {
    const app = await pkgBoot({ packages: [PKG_A, PKG_B], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    const h = mobileHtml(doc);
    ok(pkgCalls(app, 'get_packages').length >= 1, 'the screen actually calls get_packages');
    ok(h.includes('Crewing set') && h.includes('Medical set'), 'both package titles are on screen');
    ok(h.includes('2026-09-01'), 'the creation date is shown (got a screen without it)');
    ok(/\b3\b/.test(h) && /\b1\b/.test(h), 'the per-package file counts are shown');
    ok(!h.includes('2027-09-01') && !h.includes('2026-08-03'), 'and NO expiry date is printed — see PKG12 for why');
    ok(!/<table/i.test(h) && !/pkg-table/.test(h), 'the mobile list is NOT the desktop <table class="pkg-table"> (phone-shaped cards only)');
    ok((h.match(/data-qa="mobile-pkg-card"/g) || []).length === 2, 'exactly one card per package (got ' + (h.match(/data-qa="mobile-pkg-card"/g) || []).length + ')');
    ok(h.includes('data-qa="mobile-pkg-delete-pkg-a"') && h.includes('data-qa="mobile-pkg-delete-pkg-b"'), 'each card carries its own delete control');
    ok(h.includes('data-qa="mobile-pkg-create"'), 'the create entry point is on the list screen too');
  } catch (e) { ok(false, 'PKG3 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG4) — empty state: honest text + a create button, and NO silent auto-create');
  try {
    const app = await pkgBoot({ packages: [], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    const h = mobileHtml(doc);
    ok(h.includes('data-qa="mobile-pkg-empty"'), 'an explicit empty state is rendered');
    const emptyText = h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    ok(emptyText.length >= 40, 'the empty state carries readable prose, not a bare dash (got ' + emptyText.length + ' chars of text)');
    ok(h.includes('data-qa="mobile-pkg-create"'), 'the empty state offers the create button');
    ok(pkgCalls(app, 'create_package').length === 0, 'opening an empty Packages screen creates NOTHING behind the user (desktop auto-creates "All Documents"; the phone must not)');
  } catch (e) { ok(false, 'PKG4 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG4b) — nothing to package yet: create is refused honestly, with the way out');
  try {
    const app = await pkgBoot({ packages: [], docs: [{ id: 'd3', title: 'GMDSS', category: 'certificates', file_name: '' }] });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    const h = mobileHtml(doc);
    ok(h.includes('data-qa="mobile-pkg-empty"'), 'the empty state still renders when no document has a file');
    ok(h.includes("mobileShow('docs')"), 'and it points at Documents — the actual way out (upload a file first)');
    sandbox.mobileStartPackage();
    await settleVm();
    ok(app.toasts.length >= 1, 'starting a package with no uploaded file says so instead of opening an empty picker');
    ok(mobileHtml(doc).indexOf('data-qa="mobile-pkg-picker"') === -1, 'and the picker screen is not opened');
  } catch (e) { ok(false, 'PKG4b crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG5) — create: pick documents, create_package, list re-rendered');
  try {
    const app = await pkgBoot({ packages: [], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    sandbox.mobileStartPackage();
    await settleVm();
    let h = mobileHtml(doc);
    ok(h.includes('data-qa="mobile-pkg-picker"'), 'the create screen (document picker) renders');
    ok(h.includes('data-qa="mobile-pkg-doc-d1"') && h.includes('data-qa="mobile-pkg-doc-d2"'), 'documents WITH an attached file are offered (uploadedDocsForSharing)');
    ok(!h.includes('data-qa="mobile-pkg-doc-d3"'), 'a document with no attached file is NOT offered — create_package would reject it');
    ok(h.includes('data-qa="mobile-pkg-title"'), 'a title field is offered');
    sandbox.mobileTogglePackageDoc('d1', true);
    sandbox.mobileTogglePackageDoc('d2', true);
    await settleVm();
    app.typeTitle('Crewing set');
    await sandbox.mobileCreatePackage();
    await settleVm();
    const created = pkgCalls(app, 'create_package');
    ok(created.length === 1, 'create_package called exactly once (got ' + created.length + ')');
    const args = created.length ? created[0][1] : {};
    ok(args.title === 'Crewing set', 'the typed title is sent (got ' + JSON.stringify(args.title) + ')');
    ok(JSON.stringify((args.docIds || []).slice().sort()) === '["d1","d2"]', 'exactly the two ticked documents are sent (got ' + JSON.stringify(args.docIds) + ')');
    ok(typeof args.expiryDays === 'number' && typeof args.downloadLimit === 'number', 'expiryDays/downloadLimit are sent as the Rust signature requires');
    h = mobileHtml(doc);
    ok(h.includes('data-qa="mobile-pkg-card"') && h.includes('Crewing set'), 'after success the LIST is re-rendered and shows the new package');
    ok(!h.includes('data-qa="mobile-pkg-picker"'), 'and the picker is closed');
    ok(pkgCalls(app, 'get_packages').length >= 2, 'the list was refreshed from the backend, not patched from memory');
  } catch (e) { ok(false, 'PKG5 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG6) — create negatives: no title / nothing ticked / backend error never lie');
  try {
    const app = await pkgBoot({ packages: [], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    sandbox.mobileStartPackage();
    await settleVm();
    app.typeTitle('   ');
    sandbox.mobileTogglePackageDoc('d1', true);
    await sandbox.mobileCreatePackage();
    await settleVm();
    ok(pkgCalls(app, 'create_package').length === 0, 'a blank title never reaches create_package');
    ok(app.toasts.length >= 1, 'and the user is told why');
    app.toasts.length = 0;
    app.typeTitle('Set');
    sandbox.mobileTogglePackageDoc('d1', false);
    await sandbox.mobileCreatePackage();
    await settleVm();
    ok(pkgCalls(app, 'create_package').length === 0, 'an empty selection never reaches create_package');
    ok(app.toasts.length >= 1, 'and the user is told why');
    ok(mobileHtml(doc).includes('data-qa="mobile-pkg-picker"'), 'the picker stays open so the user can fix it');
  } catch (e) { ok(false, 'PKG6 crashed before it could assert: ' + e.message); }
  try {
    const app = await pkgBoot({ packages: [], docs: PKG_DOCS, createFails: true });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    sandbox.mobileStartPackage();
    await settleVm();
    sandbox.mobileTogglePackageDoc('d1', true);
    app.typeTitle('Set');
    await sandbox.mobileCreatePackage();
    await settleVm();
    ok(app.toasts.some(([m]) => /no file|has no file|Cannot create/i.test(m)), 'a Rust-side refusal is surfaced verbatim, not swallowed (toasts: ' + JSON.stringify(app.toasts) + ')');
    ok(mobileHtml(doc).includes('data-qa="mobile-pkg-picker"'), 'and the picker stays open with the selection intact');
  } catch (e) { ok(false, 'PKG6 (backend error) crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG7) — delete goes through uiConfirm (never alert/confirm)');
  try {
    const app = await pkgBoot({ packages: [PKG_A], docs: PKG_DOCS, confirm: false });
    const { sandbox } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    let asked = 0;
    sandbox.uiConfirm = async () => { asked++; return false; };
    await sandbox.mobileDeletePackage('pkg-a');
    await settleVm();
    ok(asked === 1, 'delete asks for confirmation exactly once');
    ok(pkgCalls(app, 'delete_package').length === 0, 'declining the confirmation deletes NOTHING');
  } catch (e) { ok(false, 'PKG7 (decline) crashed before it could assert: ' + e.message); }
  try {
    const app = await pkgBoot({ packages: [PKG_A, PKG_B], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    sandbox.uiConfirm = async () => true;
    await sandbox.mobileDeletePackage('pkg-a');
    await settleVm();
    const del = pkgCalls(app, 'delete_package');
    ok(del.length === 1 && del[0][1] && del[0][1].packageId === 'pkg-a', 'accepting deletes exactly that package id (got ' + JSON.stringify(del.map((d) => d[1])) + ')');
    const h = mobileHtml(doc);
    ok(!h.includes('Crewing set') && h.includes('Medical set'), 'the list re-renders without the deleted package');
  } catch (e) { ok(false, 'PKG7 (accept) crashed before it could assert: ' + e.message); }
  ok(PKG_SRC.length > 400, 'the mobile Packages source block is delimited by its BEGIN/END anchors (got ' + PKG_SRC.length + ' chars)');
  ok(!/\balert\s*\(/.test(PKG_CODE), 'no alert() anywhere in the mobile packages code (the desktop path still has three — that is what this slice does not copy)');
  ok(!/\bconfirm\s*\(/.test(PKG_CODE.replace(/uiConfirm\s*\(/g, '')), 'no bare window.confirm() either');
  ok(/uiConfirm\s*\(/.test(PKG_CODE), 'the confirmation really is uiConfirm');
}

{
  section('mobile Packages (PKG8) — a hostile package title is escaped (the desktop list is not; do not copy that)');
  try {
    const nasty = { id: "pkg-'x", title: '<img src=x onerror="alert(1)"> O\'Brien & Co', created_on: '2026-09-01 10:00:00', expires_on: '2027-09-01T10:00:00', download_count: 0, download_limit: 999, password: null, file_count: 2 };
    const app = await pkgBoot({ packages: [nasty], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    const h = mobileHtml(doc);
    ok(!/<img\s+src=x/i.test(h), 'the injected <img> tag never reaches the DOM as markup');
    ok(h.includes('&lt;img'), 'it is rendered as escaped text instead');
    ok(!/<img/i.test(h), 'no <img> element exists in the rendered list at all — the payload stayed text');
    ok(h.includes('&amp;'), 'the ampersand in the title is escaped too');
    // The id lands inside an onclick="mobileDeletePackage('…')" — an apostrophe
    // must not close that string and start new JS.
    const del = /onclick="mobileDeletePackage\(([^)]*)\)"/.exec(h);
    ok(!!del, 'the delete control carries an onclick with the package id');
    ok(!!del && !/[^\\]'[^)]*'/.test(del[1].slice(1, -1)), 'the apostrophe inside the id is escaped, it does not break out of the JS string (got ' + (del ? del[1] : '') + ')');
    sandbox.uiConfirm = async () => true;
    await sandbox.mobileDeletePackage("pkg-'x");
    await settleVm();
    const calls = pkgCalls(app, 'delete_package');
    ok(calls.length === 1 && calls[0][1].packageId === "pkg-'x", 'and the id still round-trips to Rust unchanged');
  } catch (e) { ok(false, 'PKG8 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG9) — no invoke without a Rust command; no Share/Save/Email in THIS slice');
  const used = Array.from(new Set((PKG_CODE.match(/invoke\(\s*'([a-zA-Z0-9_]+)'/g) || []).map((s) => /'([a-zA-Z0-9_]+)'/.exec(s)[1]))).sort();
  ok(JSON.stringify(used) === JSON.stringify(['create_package', 'delete_package', 'get_packages']),
    'the mobile screen invokes exactly the three existing Rust commands (got ' + JSON.stringify(used) + ')');
  const RUST = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'commands', 'packages.rs'), 'utf8');
  ok(used.every((c) => new RegExp('fn\\s+' + c + '\\s*\\(').test(RUST)), 'and each of them is a real #[tauri::command] in packages.rs');
  ok(!/export_package|open_email_with_attachment|dispatch_package|navigator\.share|saveDlg|dialog\.save/.test(PKG_CODE),
    'slice 1 wires NO outbound path — sharing a package off the phone is slice 2 (Rust returns Err on android/ios today)');
  ok(!/>\s*(Share|Поделиться|Save|Сохранить|Email|Отправить)\s*</.test(PKG_CODE), 'and no Share/Save/Email button is drawn on the mobile packages screen');
}

{
  section('mobile Packages (PKG10) — PRESERVE: the desktop packages path is byte-identical to the baseline');
  const i = HTML.indexOf('async function showPackages(){');
  const j = HTML.indexOf('var settingsTab = ');
  ok(i > 0 && j > i, 'the desktop packages region is locatable');
  ok(sha256Text(HTML.slice(i, j)) === DESKTOP_PKG_SHA,
    'showPackages/startPkg/doPkg/emailPkg/exportPkg/delPkg unchanged (sha ' + sha256Text(HTML.slice(i, j)).slice(0, 12) + ' vs baseline ' + DESKTOP_PKG_SHA.slice(0, 12) + ')');
  ok(/<table class="pkg-table">/.test(HTML), 'the desktop list still uses its table — the phone got its own UI, the desktop was not refactored');
}

{
  section('mobile Packages (PKG11) — RU: the module speaks the UI language');
  try {
    const app = await pkgBoot({ packages: [PKG_A], docs: PKG_DOCS, lang: 'ru' });
    const { sandbox, doc } = app;
    ok(sandbox.getUiLang() === 'ru', 'the harness boot really is in RU (so this drill is not vacuous)');
    sandbox.mobileShow('packages');
    await settleVm();
    const h = mobileHtml(doc);
    ok(/[А-Яа-я]{4,}/.test(h.replace(/<[^>]*>/g, ' ')), 'the RU packages screen renders Russian copy');
    ok(/packages\s*:\s*\['Пакеты'/.test(HTML), 'the grid label pair for packages is still in MOBILE_HOME_MODULE_L10N');
  } catch (e) { ok(false, 'PKG11 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG12) — the screen promises NOTHING the product does not keep (Supervisor Т1, 06.09)');
  // By bytes: expires_on / download_limit / download_count are written into
  // SQLite and read by no Rust command; export_package copies the ZIP with no
  // check and no counter bump; create_package always passes password=None
  // (packages.rs:321); the 365 days are hard-wired with no field in the UI.
  // So a validity date, an "expired" pill, a download limit or a password
  // badge on this screen would be a promise the product cannot honour.
  const FORBIDDEN = /expir|valid until|срок|истёк|истек|действует до|password|пароль|protected|защищ|download limit|лимит скач|скачиван/i;
  const asked = PKG_CODE.replace(/expiryDays\s*:/g, 'RUSTARG:').replace(/downloadLimit\s*:/g, 'RUSTARG:');
  ok(!FORBIDDEN.test(asked), 'no expiry / password / download-limit wording in the mobile packages code (the two create_package arguments the Rust signature requires are not copy on screen)');
  try {
    const app = await pkgBoot({ packages: [PKG_A, PKG_B], docs: PKG_DOCS });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    const list = mobileHtml(doc);
    ok(!FORBIDDEN.test(list), 'and none of it is rendered on the list screen either');
    // PKG_B expired on 2026-08-03; the desktop mailing wizard hides such a
    // package (validDispatchPackages) while the list used to show it. With no
    // expiry claimed, both surfaces agree again.
    ok(list.includes('Medical set'), 'a package past its stored expires_on is listed like any other — the screen makes no claim about it');
    ok(!/mobile-pill (warn|bad)/.test(list), 'no warning/expired pill is drawn');
    sandbox.mobileStartPackage();
    await settleVm();
    ok(!FORBIDDEN.test(mobileHtml(doc)), 'and none of it appears on the create screen');
  } catch (e) { ok(false, 'PKG12 crashed before it could assert: ' + e.message); }
}

{
  section('mobile Packages (PKG13) — the counter on the picker is the number that actually leaves for Rust (Supervisor Т4)');
  try {
    const app = await pkgBoot({ packages: [], docs: PKG_DOCS.concat([{ id: 'd4', title: 'Yellow Fever', category: 'medical', file_name: 'yf.pdf' }]) });
    const { sandbox, doc } = app;
    sandbox.mobileShow('packages');
    await settleVm();
    sandbox.mobileStartPackage();
    await settleVm();
    const countOnScreen = () => {
      const m = /data-qa="mobile-pkg-count"[^>]*>([^<]*)</.exec(mobileHtml(doc));
      const n = m ? /(\d+)/.exec(m[1]) : null;
      return n ? Number(n[1]) : NaN;
    };
    ok(countOnScreen() === 0, 'the picker opens saying 0 selected (got ' + countOnScreen() + ')');
    sandbox.mobileTogglePackageDoc('d1', true);
    sandbox.mobileTogglePackageDoc('d2', true);
    sandbox.mobileTogglePackageDoc('d4', true);
    await settleVm();
    ok(countOnScreen() === 3, 'after ticking three documents it says 3 (got ' + countOnScreen() + ')');
    sandbox.mobileTogglePackageDoc('d2', false);
    await settleVm();
    const shown = countOnScreen();
    ok(shown === 2, 'unticking one brings it back to 2 (got ' + shown + ')');
    app.typeTitle('Counted set');
    await sandbox.mobileCreatePackage();
    await settleVm();
    const created = pkgCalls(app, 'create_package');
    ok(created.length === 1, 'create_package called once');
    const sent = created.length ? (created[0][1].docIds || []) : [];
    ok(sent.length === shown, 'the number on screen equals the number of docIds actually sent (screen ' + shown + ', sent ' + sent.length + ')');
    ok(JSON.stringify(sent.slice().sort()) === '["d1","d4"]', 'and they are exactly the documents still ticked (got ' + JSON.stringify(sent) + ')');
  } catch (e) { ok(false, 'PKG13 crashed before it could assert: ' + e.message); }
}


// ════════════════════════════════════════════════════════════════════════════════════
// App Store readiness drills (iOS) — 2026-09-06.
// Sources: skipi-supervisor/audits/AUDIT-2026-09-06-seafarer-ios-readiness.md (5cfff5b3),
// the owner screenshot of 06.09 (content under the status bar) and the user reports in
// skipi-ops/handoffs/USER-FEEDBACK-2026-09-06-youtube-comments.md.
// EVERY finding below is invisible on an Android phone: the safe area is a notch the
// emulator does not have, the zoom-on-focus is a WKWebView behaviour, and the two dead
// commands are #[cfg(target_os = "ios")] stubs. That is exactly why they are byte drills
// and not «we looked at it on the phone».
// Each rule below is followed by its negative: a synthetic mutation that MUST turn it red.
// ════════════════════════════════════════════════════════════════════════════════════

const SETTINGS_JS = fs.readFileSync(path.join(DIST, 'skipi-settings.js'), 'utf8');

// A full-screen container = `position:fixed` + `inset:0`, wherever it is declared:
// a CSS rule, a style="" attribute or a JS cssText string. One entry per source line.
const fullScreenDecls = (html) => html.split('\n')
  .map((l, i) => ({ n: i + 1, l }))
  .filter(({ l }) => /position:\s*fixed/.test(l) && /inset:\s*0/.test(l));

// Allowlist = a written promise that this container needs no safe area, with the reason
// (same technique the copy rules below use for legitimate words). Anything not listed
// here is red — a new overlay has to be looked at, not waved through.
const FS_ALLOW = [
  { key: '#drop-overlay', why: 'pointer-events:none decorative drag tint — it draws no text, takes no taps and hides nothing the user must read, so an inset under the notch changes nothing' },
];
const fsAllowed = (line) => FS_ALLOW.some((a) => line.includes(a.key));
const safeAreaMisses = (html) => fullScreenDecls(html).filter(({ l }) => !fsAllowed(l) && !/env\(safe-area-inset-/.test(l));
const centredFullScreen = (html) => fullScreenDecls(html).filter(({ l }) => !fsAllowed(l) && /align-items:\s*center/.test(l));

{
  section('SAFEAREA1 — the viewport meta opts into the safe area (without it every env(safe-area-inset-*) in this file is 0)');
  const metaOf = (html) => (/<meta name="viewport"[^>]*>/.exec(html) || [''])[0];
  const meta = metaOf(HTML);
  ok(/viewport-fit=cover/.test(meta), 'the viewport meta carries viewport-fit=cover (' + meta + ')');
  ok(!/user-scalable\s*=\s*no|maximum-scale/.test(meta),
    'and it does NOT disable pinch-zoom — user-scalable=no is an accessibility finding of its own, 16px fields are the fix for zoom-on-focus (see FONT1)');
  // negative
  const noCover = HTML.replace('width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1');
  ok(!/viewport-fit=cover/.test(metaOf(noCover)), 'NEGATIVE: dropping viewport-fit from the meta turns this rule red (mutated meta: ' + metaOf(noCover) + ')');
}

{
  section('SAFEAREA2 — every full-screen container reserves the notch and the home indicator itself');
  const all = fullScreenDecls(HTML);
  ok(all.length >= 14, 'the scan really finds the full-screen containers of this file (found ' + all.length + ')');
  const misses = safeAreaMisses(HTML);
  ok(misses.length === 0, 'no full-screen container is left without env(safe-area-inset-*) or an allowlist entry (offenders: '
    + JSON.stringify(misses.map((m) => m.n)) + ')');
  ok(FS_ALLOW.every((a) => a.why && a.why.length > 40), 'every allowlist entry states WHY, so the list cannot grow silently');
  ok(all.filter((d) => fsAllowed(d.l)).length === FS_ALLOW.length, 'each allowlist entry still matches exactly one live container (dead entries are not tolerated)');
  // negative
  const injected = HTML.replace('.modal-overlay.open { display:flex; }',
    '.new-overlay-added-by-a-future-slice { position:fixed; inset:0; z-index:1; }\n.modal-overlay.open { display:flex; }');
  const after = safeAreaMisses(injected);
  ok(after.length === 1 && /new-overlay-added-by-a-future-slice/.test(after[0].l),
    'NEGATIVE: a newly added position:fixed;inset:0 container with no inset turns this rule red (0 offenders before, ' + after.length + ' after)');
}

{
  section('SAFEAREA3 — no full-screen container centres its card with align-items:center (that is what put the owner screenshot under the status bar)');
  // A flex item CENTRED in a container it is taller than overflows in BOTH directions, and
  // the part above top:0 can never be scrolled to — adding overflow:auto does not help.
  // The canon here is: align to flex-start, scroll, and let the card centre itself with
  // margin:auto, which collapses to 0 exactly when the card stops fitting.
  const centred = centredFullScreen(HTML);
  ok(centred.length === 0, 'no full-screen container uses align-items:center (offenders: ' + JSON.stringify(centred.map((c) => c.n)) + ')');
  ok(/\.modal-overlay > \*, \.skipi-settings-overlay > \*, \.skipi-assistant-overlay > \*/.test(HTML)
    && /margin-top:auto !important; margin-bottom:auto !important;/.test(HTML),
    'the margin:auto canon rule that gives the centring back is present');
  ok(/\.skipi-fs-overlay > \*/.test(HTML) && (HTML.match(/skipi-fs-overlay/g) || []).length >= 5,
    'the JS-built overlays carry the .skipi-fs-overlay marker so the same canon reaches them (' + (HTML.match(/skipi-fs-overlay/g) || []).length + ' mentions)');
  ok(/overflow:auto;-webkit-overflow-scrolling:touch/.test(HTML),
    'the assistant consent card — the screen on the owner screenshot — sits in its own scroller');
  // negative
  const recentred = HTML.replace('.skipi-assistant-overlay { display:none; position:fixed; inset:0; z-index:121; background:rgba(0,0,0,0.5); align-items:flex-start;',
    '.skipi-assistant-overlay { display:none; position:fixed; inset:0; z-index:121; background:rgba(0,0,0,0.5); align-items:center;');
  const backCentred = centredFullScreen(recentred);
  ok(backCentred.length === 1 && /skipi-assistant-overlay/.test(backCentred[0].l),
    'NEGATIVE: putting align-items:center back on the assistant overlay turns this rule red (0 offenders before, ' + backCentred.length + ' after)');
}

// ════════════════════════════════════════════════════════════════════════════════════
// NOPAY1–NOPAY4 — the shipped bundle says NOTHING about buying.
//
// ANCHOR — owner 06.09: «в дистах домов ни слова о покупке — оплата только в вебе»
// (skipi-ops DECISIONS (253), (319)). Payment lives on the web only. The bundle the
// stores ship (desktop / Android / iOS all boot this one dist/) must not name Paddle,
// a price, a plan, a checkout or a billing page — that is the standing product
// decision, and it is also what keeps store review calm: selling digital access
// inside the app, or linking out to an external payment page, is exactly what
// Apple's and Google's billing rules forbid.
//
// Until now that invariant was held by memory alone — nothing under tests/ checked a
// single one of these words. These drills are that check, and they read the SAME set
// of assets NOPAY5 below reads: EVERY file under dist/, bundled plugins, .md files
// and version stamps included. Reading dist/index.html alone is exactly the mistake
// Supervisor Н-A caught on 06.09 — the strings that actually shipped a price claim
// sat in dist/skipi-assistant.js, and the rule was green for the wrong reason;
// reading only .html/.js/.css/.json is the SAME mistake one layer down — Н-E, 06.09.
//
// Exceptions are DECLARED, never silently regexed away: each NOPAY_WORDS_ALLOW entry
// is a narrow pattern plus the reason it is not about buying. A stale entry fails
// NOPAY3, so the list gets pruned instead of growing into a loophole.
// ════════════════════════════════════════════════════════════════════════════════════

// ONE walk over the shipped dist, shared by NOPAY1–NOPAY4 and NOPAY5 below.
//
// «What ships» = EVERY file under dist/, with no extension filter. src-tauri/
// tauri.conf.json sets "frontendDist": "../dist", so Tauri embeds that directory
// WHOLE: the .md files and the *_VERSION stamps travel into the desktop, Android
// and iOS bundles byte for byte, exactly like the .js does.
// The previous version of this walk filtered on /\.(html|js|css|json)$/ and so read
// 26 of the 34 files that ship. Supervisor proved the hole on 06.09 (Н-E): a full
// Paddle checkout block pasted into dist/plugins/navigation-calculators/REPORT.md
// left the harness ALL GREEN — all 17 word/host rules and the NOPAY5 «free» rule
// walked straight past it, because that file was never opened.
// So there is no extension filter any more. A file leaves the scan ONLY by being
// named in DIST_NOT_SCANNED below, with the reason it cannot carry copy — and that
// reason is verified in NOPAY3, not taken on trust.
const DIST_NOT_SCANNED = [
  { file: 'plugins/bnwas-time-anchor/assets/.gitkeep',
    why: 'an empty-directory marker: git cannot store an empty assets/ folder, so this placeholder stands in for it. The BNWAS bundle has no binary assets at all — its alarm tones are synthesised at runtime — and the file is 0 bytes, which NOPAY3 asserts instead of believing' },
  { file: 'plugins/navigation-calculators/assets/.gitkeep',
    why: 'the same empty-directory marker for the calculators bundle, whose assets/ is empty because every calculator is embedded inside index.js; NOPAY3 asserts the 0 bytes, so the moment anyone writes copy into it the drill goes red' },
];
// The exact set the scan MUST read, BY NAME. A lower bound («at least 20 assets»)
// would let six of them disappear in silence and stay green (Supervisor Н-C, 06.09);
// this list reddens on a file that vanishes just as loudly as on one that appears.
const SHIPPED_EXPECTED = [
  'ASSISTANT_VERSION', 'SETTINGS_VERSION',
  'index.html',
  'intelligence.css', 'intelligence.js',
  'plugin-host-bridge.js', 'plugin-host-config.js', 'plugin-host-ui.js',
  'plugin-loader.js', 'plugin-remote-boot.js',
  'skipi-assistant.css', 'skipi-assistant.js',
  'skipi-settings.css', 'skipi-settings.js',
  'vessel-db.css', 'vessel-db.js',
  'plugins/bnwas-time-anchor/CHANGELOG.md', 'plugins/bnwas-time-anchor/REPORT.md',
  'plugins/bnwas-time-anchor/checksums.json', 'plugins/bnwas-time-anchor/index.css',
  'plugins/bnwas-time-anchor/index.js', 'plugins/bnwas-time-anchor/plugin.json',
  'plugins/ecdis-position-reminder/checksums.json', 'plugins/ecdis-position-reminder/index.css',
  'plugins/ecdis-position-reminder/index.js', 'plugins/ecdis-position-reminder/plugin.json',
  'plugins/navigation-calculators/CHANGELOG.md', 'plugins/navigation-calculators/REPORT.md',
  'plugins/navigation-calculators/checksums.json', 'plugins/navigation-calculators/index.css',
  'plugins/navigation-calculators/index.js', 'plugins/navigation-calculators/plugin.json',
];
const DIST_ALL = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else DIST_ALL.push(path.relative(DIST, p));
  }
})(DIST);
DIST_ALL.sort();
const NOT_SCANNED = new Set(DIST_NOT_SCANNED.map((x) => x.file));
const SHIPPED_FILES = DIST_ALL.filter((f) => !NOT_SCANNED.has(f));
const SHIPPED_ASSETS = SHIPPED_FILES.map((f) => path.join(DIST, f));
const SHIPPED_TEXT = SHIPPED_FILES.map((f) => ({ file: f, text: fs.readFileSync(path.join(DIST, f), 'utf8') }));

const NOPAY_WORDS_ALLOW = [
  { re: /Minimum salary per month/g,
    why: 'the label of the seafarer’s own salary EXPECTATION field (desktop form, mobile form, summary) — the figure the user asks an employer for, not a price this app charges' },
  { re: /\(sp\.min_salary_currency\|\|'USD'\)\+'\/month'/g,
    why: 'that same salary expectation rendered into the application e-mail body as «<amount> USD/month» — still the seafarer’s own figure, addressed to a crewing manager' },
  { re: /'в месяц':'\/ month'/g,
    why: 'the «/ month» suffix printed under the market p50 figure on the salary-band card — a wage statistic about the market, not a price of anything sold here' },
  { re: / per month\. Sample /g,
    why: 'intelligence.js prints the market band as «Range: USD p25-p75 per month. Sample N» — the same wage statistic, with its sample size, shown to the seafarer' },
  { re: /purchasing[-\s]power/gi,
    why: 'Numbeo «purchasing power» is the cost-of-living index behind the salary lens — the economics term, and nothing in it is bought inside the app' },
  { re: /hostApi\.theme\.subscribe/g,
    why: 'the bundled plugins subscribe to the HOST THEME through the plugin API — pub/sub code in a callback registration, a word that never reaches a screen' },
  { re: /subscribe: function \(cb\)/g,
    why: 'the publisher side of that same theme pub/sub, defined in plugin-host-bridge.js — the API the two plugins above call, not an offer to the user' },
  { re: /\(get \/ subscribe\)/g,
    why: 'a header comment in the BNWAS plugin listing which host APIs it uses (theme get / subscribe) — a comment about code, stripped from nothing and rendered nowhere' },
  { re: /theme subscription and empties the container/g,
    why: 'a header comment in the calculators plugin describing what unmount() tears down — the theme pub/sub again, in prose about the code' },
  { re: /subscription: '<svg/g,
    why: 'an unused icon key in the vendored @skipi/settings icon set (zero references anywhere else in the dist) — the name of an SVG path, not screen copy' },
  { re: /billing: '<svg/g,
    why: 'the neighbouring unused icon key in that same vendored @skipi/settings icon set (also zero references anywhere in the dist) — an SVG path name, and this home ships no billing screen for it to open' },
  { re: /`hostApi\.theme\.get\(\)` \/ `subscribe\(\)`/g,
    why: 'the BNWAS CHANGELOG line «Uses `hostApi.theme.get()` / `subscribe()` for light/dark base» — developer provenance about the theme pub/sub API, in a file no screen ever renders' },
  { re: /`hostApi\.theme\.get\(\)\/subscribe\(\)`/g,
    why: 'the same theme pub/sub sentence in the calculators CHANGELOG («skins both the shell and the open calculator») — again the host API, again a provenance document and not copy' },
  { re: /theme\.subscribe re-skins the open calc/g,
    why: 'the calculators REPORT describing what its contract test proved about the theme pub/sub — prose about a test result, and the word is the API name' },
  // Н-F, 06.09: the two entries below are the ENTIRE price the dist pays for the
  // «plan» and «monthly» rules added with that finding. One each — a rule that needs
  // a third exception is the wrong rule and gets re-worded instead.
  { re: /relief plan/gi,
    why: 'intelligence.js career guidance «Check internet access, joining window, relief plan, and repatriation terms before accepting» — the RELIEF plan is when a crew replacement comes aboard so the seafarer can go home, a contract term to check with an employer and not a tariff sold here' },
  { re: /offered monthly salary/gi,
    why: 'the Offer Check card in intelligence.js says «Type an offered monthly salary» — the wage an employer offered THIS seafarer, typed in locally and compared with the market band; it is income to him, not a charge from us' },
  // The two below are the ENTIRE price the dist pays for the «unlock» rule added by
  // the no-paywall-language slice (06.09). Both are the browser autoplay concept,
  // in a bundled plugin, and neither is copy about access to a feature.
  { re: /Web Audio is unlocked on the user's "Start watch" gesture/g,
    why: 'the BNWAS provenance REPORT describing the browser AUTOPLAY policy — a Web Audio context is «unlocked» by a user gesture; it is the platform’s own term for sound being allowed to start, in a document no screen renders' },
  { re: /\/\/ unlock audio on the user gesture/g,
    why: 'the one line of BNWAS code that does exactly that, in a comment — the same Web Audio autoplay concept, and comments reach no screen' },
];

// [family, label, pattern] — matched case-insensitively on WORD/PATH boundaries, not
// as naked substrings, so «unsubscribes», «display.» and «/payload» must not fire.
// NOPAY4 proves every one of these still catches purchase copy when it is there.
//
// Н-F, 06.09 — WHY THIS LIST IS NOT A LIST OF SPECIFIC PRICES ANY MORE. The previous
// version priced the invariant at exactly `$10`, `per month`, `/month` and `pricing`,
// and called an upgrade exactly `buy now`, `purchase`, `upgrade to pro`. Supervisor
// pasted an ORDINARY upsell into two live dist files — «Get Skipi PRO … 9.99 USD a
// month», a link to skipi.app/upgrade, and a SKIPI_PRO_UPSELL object in
// skipi-assistant.js — and the harness stayed ALL GREEN 839/0. A second one, written
// in the very words of this rule's own title («Upgrade your account», «Skipi PRO —
// &euro;9.99/mo»), was green too. That is not an obfuscation attack: it is the exact
// shape a real PR adding an upsell would take, and the hardcoded $10 was already
// stale — PRO shipped at $5 historically and the web sells three SKUs today.
// So the price family is now a SHAPE (a currency figure, in symbols or entities or
// codes, and any per-period suffix) rather than one number, and the upgrade family is
// the vocabulary of upselling rather than three fixed phrases. Both mutations are
// nailed down as permanent negative controls in NOPAY4.
//
// Every rule below was run over the whole of dist/ before it was added; each one that
// hit something legitimate was either re-worded or bought with ONE declared exception
// («relief plan», «offered monthly salary»). Deliberately NOT rules: bare «price» and
// «trial» (the source comments that record decision (253) and Guideline 2.2 use them —
// a rule there would allowlist a comment's wording and redden on the next re-word);
// bare «order» (36 legitimate hits: sort order, section order, master's standing
// orders — so only «order now» is a rule); bare «pro» (the «SF Pro» font choice);
// bare «unlock» (11+ live user-facing strings today — that word arrives with the
// no-paywall-language slice that removes them, not before, or this drill would go red
// on shipping copy).
const NOPAY_RULES = [
  // ── the vendor ────────────────────────────────────────────────────────────
  ['word', 'paddle', String.raw`\bpaddle\b`],
  ['word', 'stripe', String.raw`\bstripe\b`],
  // ── the till ──────────────────────────────────────────────────────────────
  ['word', 'checkout', String.raw`\bcheck-?outs?\b`],
  ['word', 'cart', String.raw`\bcarts?\b`],
  ['word', 'order now', String.raw`\border\s+now\b`],
  // ── what is being sold ────────────────────────────────────────────────────
  ['word', 'subscribe', String.raw`\bsubscrib(?:e|es|ed|ing)\b`],
  ['word', 'subscription', String.raw`\bsubscriptions?\b`],
  ['word', 'plan', String.raw`\bplans?\b`],
  // ── the price tag: any figure, in any of the three ways a price is written ─
  // symbol or HTML entity + digits («$10», «€9.99», «&euro;9.99» — the entity is
  // the form Supervisor's own mutation C used, so the rule reads it too);
  ['word', 'price (currency symbol)', String.raw`(?:[$€£]|&(?:dollar|euro|pound|#36|#8364|#163);)\s?\d`],
  // digits next to an ISO code, either order («9.99 USD», «USD 9.99»);
  ['word', 'price (currency code)', String.raw`\d\s*(?:USD|EUR|GBP)\b|\b(?:USD|EUR|GBP)\s?\d`],
  // and the period suffix that turns a figure into a recurring charge.
  ['word', 'price per period', String.raw`\d\s?\/\s?(?:mo|mos|month|months|yr|year)\b`],
  ['word', 'per month', String.raw`\bper\s+month\b`],
  ['word', '/month', String.raw`\/\s?month\b`],
  ['word', 'a month', String.raw`\ba\s+month\b`],
  ['word', 'monthly', String.raw`\bmonthly\b`],
  ['word', 'pricing', String.raw`\bpricing\b`],
  // ── the call to action ────────────────────────────────────────────────────
  ['word', 'buy', String.raw`\bbuys?\b`],
  ['word', 'purchase', String.raw`\bpurchas(?:e|es|ed|ing)\b`],
  ['word', 'upgrade', String.raw`\bupgrad(?:e|es|ed|ing)\b`],
  // «unlock» arrives with the slice that removed it from shipping copy (06.09). It
  // was deliberately NOT a rule before that: 11+ live user-facing strings said
  // «Unlocks after joining a vessel», «Unlocked N of M addresses», «Sea Service
  // unlocks…», and a rule then would have been red on day one. Those strings now say
  // what actually happens — a thing becomes AVAILABLE as the profile fills or when
  // the seafarer joins a vessel — so the word can be forbidden. Next to
  // skipi.app/pricing («$10 per month»), a padlock and the word «unlock» are what
  // made Apple ask whether the app sells digital content (Guideline 2.1(b)).
  // Identifiers are NOT touched by this: \b does not fire inside
  // getSeaServiceUnlockState or fullUnlock, which are logic and must keep their names.
  ['word', 'unlock', String.raw`\bun-?lock(?:s|ed|ing)?\b`],
  ['word', 'get pro', String.raw`\bget\s+pro\b`],
  ['word', 'go pro', String.raw`\bgo\s+pro\b`],
  ['word', 'activate', String.raw`\bactivat(?:e|es|ed|ing|ion)\b`],
  // ── the wall ──────────────────────────────────────────────────────────────
  // Н-D, 06.09: the four words below were named in this rule's own title and were
  // not in the list. «payment», «paywall», «billing» and «free trial» are purchase
  // words with no legitimate use in a maritime app, so they are rules.
  ['word', 'payment', String.raw`\bpayments?\b`],
  ['word', 'paywall', String.raw`\bpaywalls?\b`],
  ['word', 'billing', String.raw`\bbilling\b`],
  ['word', 'free trial', String.raw`\bfree\s+trials?\b`],
  // ── the links ─────────────────────────────────────────────────────────────
  ['host', 'paddle.com', String.raw`\bpaddle\.com\b`],
  ['host', 'cdn.paddle.com', String.raw`\bcdn\.paddle\.com\b`],
  ['host', 'pay.', String.raw`\bpay\.`],
  ['host', '/pay', String.raw`\/pay(?:ments?)?\b`],
  ['host', '/pricing', String.raw`\/pricing\b`],
  ['host', '/app/account#billing', String.raw`\/app\/account#billing`],
];

// remove the declared exceptions (same technique NOPAY5 uses), then count what is left
const nopayScrub = (text) => NOPAY_WORDS_ALLOW.reduce((acc, a) => acc.replace(a.re, (m) => 'X'.repeat(m.length)), text);
const nopayScan = (files, family) => NOPAY_RULES.filter(([fam]) => fam === family).map(([, label, pattern]) => {
  let count = 0;
  const where = [];
  for (const f of files) {
    const scrubbed = nopayScrub(f.text);
    const m = scrubbed.match(new RegExp(pattern, 'gi')) || [];
    if (!m.length) continue;
    count += m.length;
    const at = scrubbed.search(new RegExp(pattern, 'i'));
    where.push(f.file + ' (x' + m.length + '): …' + scrubbed.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ') + '…');
  }
  return { label, count, where };
});

{
  // The title enumerates exactly the rule families below and nothing more — a payment
  // vendor (paddle · stripe), a till (checkout · cart · order now), a thing being sold
  // (subscription · subscribe · plan), a price in any currency (symbol/entity/code +
  // digits, /mo · per month · a month · monthly · pricing), a call to action (buy ·
  // purchase · upgrade · get pro · go pro · activate) and a paywall (payment · paywall
  // · billing · free trial). It said «a price tag, an upgrade» while checking only
  // «$10» and «upgrade to pro» (Supervisor Н-D and Н-F, 06.09) — a title that
  // overpromises is how a drill gets trusted for something it never did, so the rules
  // were widened to the title instead of the title narrowed to the rules.
  section('NOPAY1 — no shipped dist asset names a payment vendor, a checkout, a subscription or plan, a price in any currency, an upgrade call to action, or a paywall');
  for (const h of nopayScan(SHIPPED_TEXT, 'word')) {
    ok(h.count === 0, 'nothing under dist/ says «' + h.label + '»'
      + (h.count ? ' — ' + h.count + ' hit(s): ' + JSON.stringify(h.where) : ''));
  }
}

{
  section('NOPAY2 — and none of them links to a payment host or a billing page');
  for (const h of nopayScan(SHIPPED_TEXT, 'host')) {
    ok(h.count === 0, 'nothing under dist/ links to «' + h.label + '»'
      + (h.count ? ' — ' + h.count + ' hit(s): ' + JSON.stringify(h.where) : ''));
  }
}

{
  section('NOPAY3 — the exception list is honest and current, and the scan is not vacuous');
  for (const a of NOPAY_WORDS_ALLOW) {
    const n = SHIPPED_TEXT.reduce((acc, f) => acc + ((f.text.match(a.re) || []).length), 0);
    ok(n > 0, 'exception still matches a live occurrence, so it is a real exception and not a stale loophole: '
      + a.re + ' (' + n + ' hit(s))');
    ok(a.why.length > 40, 'and it states WHY that occurrence is not about buying: ' + a.re);
  }
  // Н-C, 06.09: «at least 20» let six assets vanish without a red. The set is exact
  // and by name, so a file that DISAPPEARS reddens as loudly as one that appears.
  const expected = [...SHIPPED_EXPECTED].sort();
  const scanned = [...SHIPPED_FILES].sort();
  ok(JSON.stringify(scanned) === JSON.stringify(expected),
    'NOPAY1/NOPAY2 read EXACTLY the ' + expected.length + ' shipped assets they name, by path — never fewer '
    + '(missing: ' + JSON.stringify(expected.filter((f) => !scanned.includes(f)))
    + ', unexpected: ' + JSON.stringify(scanned.filter((f) => !expected.includes(f))) + ')');
  // Н-E, 06.09: and NOTHING under dist/ falls outside BOTH lists. dist/ is walked
  // whole, the scanned set is subtracted, and the remainder must be the declared
  // exclusions — exactly, so a stale exclusion for a file that no longer exists is
  // as red as a new file nobody declared.
  const remainder = DIST_ALL.filter((f) => !SHIPPED_FILES.includes(f)).sort();
  const declared = DIST_NOT_SCANNED.map((x) => x.file).sort();
  ok(JSON.stringify(remainder) === JSON.stringify(declared),
    'every file under dist/ is either scanned or declared unscannable, and every declared exclusion still exists '
    + '(undeclared: ' + JSON.stringify(remainder.filter((f) => !declared.includes(f)))
    + ', stale: ' + JSON.stringify(declared.filter((f) => !remainder.includes(f))) + ')');
  for (const x of DIST_NOT_SCANNED) {
    ok(x.why.length > 40, 'the exclusion states WHY that file cannot carry purchase copy: ' + x.file);
    // -1 when the file is gone: a missing exclusion must be a red line, not an
    // uncaught ENOENT that kills the run before the remaining sections report.
    const abs = path.join(DIST, x.file);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : -1;
    ok(size === 0, 'and the reason is verified, not trusted — ' + x.file
      + (size < 0 ? ' NO LONGER EXISTS' : ' is still empty (' + size + ' bytes)'));
  }
  const bytes = SHIPPED_TEXT.reduce((acc, f) => acc + f.text.length, 0);
  ok(bytes > 500000, 'and those were real reads, not empty ones (' + bytes + ' bytes)');
  for (const must of ['index.html', 'skipi-assistant.js', 'intelligence.js', 'skipi-settings.js', 'plugins/navigation-calculators/index.js']) {
    ok(SHIPPED_TEXT.some((f) => f.file === must), 'the scan reaches ' + must);
  }
}

{
  section('NOPAY4 — negative control: every rule still catches purchase copy, in a bundle that is NOT index.html');
  // If a rule ever stops matching anything, NOPAY1/NOPAY2 stay green while checking
  // nothing. The violation below is injected into skipi-assistant.js — the very file
  // the index.html-only version of this rule could not see (Supervisor Н-A, 06.09).
  const NOPAY_VIOLATION = [
    '<a class="cta" href="https://cdn.paddle.com/checkout">Buy now</a>',
    '<a href="https://pay.skipi.app/pay">Upgrade to Pro — $10/month, billed per month</a>',
    '<a href="https://paddle.com/pricing">Pricing</a>',
    '<a href="https://skipi.app/app/account#billing">manage subscription</a>',
    '<script>Paddle.Checkout.open(); shop.subscribe(); shop.purchase();</script>',
    '<p>Free trial for 7 days, then a payment is taken; the paywall lifts and billing starts.</p>',
    // Н-F, 06.09 — the shapes the old list walked past: a price that is not $10, a
    // period that is not «per month», and the upsell verbs nobody had written down.
    '<p>Choose your PRO plan: 9.99 USD a month, or €99 a year — that is 8.25/mo billed monthly.</p>',
    '<button onclick="cart.add(); stripe.redirectToCheckout();">Order now — Get PRO</button>',
    '<a href="https://skipi.app/upgrade">Go PRO and activate your licence</a>',
    '<p>Unlock every module — one payment unlocks the whole database.</p>',
  ].join('\n');
  const poisoned = SHIPPED_TEXT.map((f) => (f.file === 'skipi-assistant.js'
    ? { file: f.file, text: f.text + '\n' + NOPAY_VIOLATION }
    : f));
  const caught = [...nopayScan(poisoned, 'word'), ...nopayScan(poisoned, 'host')];
  ok(caught.length === NOPAY_RULES.length, 'every declared rule was evaluated (' + caught.length + '/' + NOPAY_RULES.length + ')');
  for (const h of caught) {
    ok(h.count > 0, 'NEGATIVE: the «' + h.label + '» rule catches purchase copy when it is present (not a dead regex)');
    ok(h.where.every((w) => w.startsWith('skipi-assistant.js')), 'NEGATIVE: and it caught it in skipi-assistant.js — the scan really does reach past index.html («' + h.label + '»)');
  }
  // and the same copy pasted into index.html reddens too — both doors, not one
  const inIndex = SHIPPED_TEXT.map((f) => (f.file === 'index.html' ? { file: f.file, text: f.text + '\n' + NOPAY_VIOLATION } : f));
  ok([...nopayScan(inIndex, 'word'), ...nopayScan(inIndex, 'host')].every((h) => h.count > 0),
    'NEGATIVE: the same purchase block placed in index.html reddens every rule as well');
  // ── Supervisor mutation B, nailed down (Н-F, 06.09) ───────────────────────
  // This is not a paraphrase: it is the byte-for-byte upsell Supervisor pasted into
  // two live dist files on 460afeb5, which left the harness ALL GREEN 839/0. It is a
  // permanent control now, so the hole is checked on every run instead of once.
  const MUT_B_HTML = [
    '<div class="pro-upsell" id="proUpsell">',
    '  <h3>Get Skipi PRO</h3>',
    '  <p>Unlimited vessel records, documents and AI answers &mdash; 9.99 USD a month.</p>',
    '  <a class="btn btn-primary" href="https://skipi.app/upgrade" target="_blank" rel="noopener">Get PRO</a>',
    '</div>',
  ].join('\n');
  const MUT_B_JS = '// PRO upsell shown when the daily limit is reached\n'
    + "const SKIPI_PRO_UPSELL={title:'Unlock Skipi PRO',note:'9.99 USD a month, cancel anytime',cta:'Get PRO',href:'https://skipi.app/upgrade'};";
  const mutB = SHIPPED_TEXT.map((f) => {
    if (f.file === 'index.html') return { file: f.file, text: f.text + '\n' + MUT_B_HTML };
    if (f.file === 'skipi-assistant.js') return { file: f.file, text: f.text + '\n' + MUT_B_JS };
    return f;
  });
  const mutBHits = [...nopayScan(mutB, 'word'), ...nopayScan(mutB, 'host')].filter((h) => h.count > 0);
  const mutBLabels = mutBHits.map((h) => h.label).sort();
  for (const must of ['price (currency code)', 'a month', 'upgrade', 'get pro']) {
    ok(mutBLabels.includes(must),
      'NEGATIVE (Supervisor mutation B — an ordinary «Get Skipi PRO … 9.99 USD a month» upsell): the «' + must
      + '» rule reddens on it (labels: ' + JSON.stringify(mutBLabels) + ')');
  }
  ok(mutBHits.some((h) => h.where.some((w) => w.startsWith('index.html')))
    && mutBHits.some((h) => h.where.some((w) => w.startsWith('skipi-assistant.js'))),
    'NEGATIVE: and it is caught in BOTH files the mutation touched — the markup in index.html and the SKIPI_PRO_UPSELL object in skipi-assistant.js');

  // ── Supervisor mutation C, nailed down (Н-F, 06.09) ───────────────────────
  // The same finding's second half: copy written in the very words of the NOPAY1
  // title, with a euro price spelled as an HTML entity. Also ALL GREEN before.
  const MUT_C_HTML = [
    '<section id="proPlans">',
    '  <h3>Upgrade your account</h3>',
    '  <p>Skipi PRO &mdash; &euro;9.99/mo. Cancel anytime.</p>',
    '  <a href="https://skipi.app/upgrade">Upgrade</a>',
    '</section>',
  ].join('\n');
  const mutC = SHIPPED_TEXT.map((f) => (f.file === 'index.html' ? { file: f.file, text: f.text + '\n' + MUT_C_HTML } : f));
  const mutCLabels = [...nopayScan(mutC, 'word'), ...nopayScan(mutC, 'host')].filter((h) => h.count > 0).map((h) => h.label).sort();
  for (const must of ['upgrade', 'price (currency symbol)', 'price per period']) {
    ok(mutCLabels.includes(must),
      'NEGATIVE (Supervisor mutation C — «Upgrade your account · Skipi PRO &euro;9.99/mo»): the «' + must
      + '» rule reddens on it (labels: ' + JSON.stringify(mutCLabels) + ')');
  }

  // NEGATIVE CONTROL — a rule that reddens everything gets switched off by the first
  // person in a hurry, so the legitimate look-alikes must stay green. Every string
  // below is real copy or real code from this dist.
  const lookalikes = [{
    file: 'control.js',
    text: 'Minimum salary per month; unsubscribes from host theme; display.reset(); '
      + 'fetch("/payload"); local purchasing power index; hostApi.theme.subscribe(cb); '
      // Н-F, 06.09: the two declared exceptions and the words deliberately left out
      // of the rules — sort order, master’s standing orders, the SF Pro font.
      + 'Check internet access, joining window, relief plan, and repatriation terms; '
      + 'Type an offered monthly salary; var order=[]; { id: \'devices\', order: 200 }; '
      + 'company SMS or master standing orders; label: \'SF Pro\', value: \'"SF Pro Text"\';',
  }];
  const controlHits = [...nopayScan(lookalikes, 'word'), ...nopayScan(lookalikes, 'host')].filter((h) => h.count > 0);
  ok(controlHits.length === 0,
    'NEGATIVE CONTROL: «unsubscribes», «display.», «/payload», the salary label, the theme pub/sub, «relief plan», '
    + '«offered monthly salary», sort order, standing orders and the SF Pro font all stay green (offenders: '
    + JSON.stringify(controlHits.map((h) => h.label)) + ')');
  // …and the deliberate cost of the widened price rule, stated out loud rather than
  // discovered later: ANY currency figure is now a price, «$100» included. The salary
  // lens prints wage figures as «USD p25-p75», never with a symbol, so this costs the
  // dist nothing today; the day it does, that is a declared exception, not a deletion.
  const dollarHits = nopayScan([{ file: 'control.js', text: 'total $100 due' }], 'word').filter((h) => h.count > 0);
  ok(dollarHits.length === 1 && dollarHits[0].label === 'price (currency symbol)',
    'NEGATIVE: a bare «$100» now reddens the price rule — the old list only knew «$10» (offenders: '
    + JSON.stringify(dollarHits.map((h) => h.label)) + ')');
}

{
  section('NOPAY7 — no shipped asset gates a feature behind a padlock or the word «unlock» (Guideline 2.1(b), 06.09)');
  // Reviewer path proved by the manager on the simulator: first screen → Demo →
  // «Got it, start» → ☰ → My Vessel = FOUR taps, no login, no vault, no profile. That
  // screen showed six padlocked tiles and «Plugins unlock after you join a vessel
  // crew». Read next to skipi.app/pricing, that is a paywall — and we are answering
  // Apple in writing that nothing in the app is paid. The answer has to match the
  // screen, so the padlock and the word are gone from the copy.
  const padlocks = SHIPPED_TEXT
    .map((f) => ({ file: f.file, n: (f.text.match(/\u{1F512}/gu) || []).length, gate: (f.text.match(/(?:tile|module|plugin|card)-lock|mv-tile-lock/g) || []).length }))
    .filter((x) => x.gate > 0);
  ok(padlocks.length === 0, 'no shipped asset marks a module tile with a lock badge (offenders: ' + JSON.stringify(padlocks) + ')');
  ok(!/mv-tile-lock/.test(HTML), 'the .mv-tile-lock badge and its CSS are gone from dist/index.html entirely, not merely hidden');
  ok(/var lockTitle=esc\(ru\?'[^']*':'Available after you join a vessel'\)/.test(HTML),
    'the My Vessel tiles say WHEN they work («Available after you join a vessel») instead of showing a padlock');
  ok(/class="mv-tile" aria-disabled="true" title="'\+lockTitle\+'"/.test(HTML),
    'and that explanation did not disappear with the badge — it moved onto the tile itself');
  // the remaining 🔒 in the dist all mean ENCRYPTION, and they stay: telling a seafarer
  // his CV went out end-to-end encrypted is the opposite of a paywall.
  const crypto = (HTML.match(/\u{1F512}/gu) || []).length;
  ok(crypto >= 6, 'the encryption padlocks (end-to-end, «sent — encrypted 🔒») are untouched — ' + crypto + ' of them');
  ok(/\u{1F512} End-to-end encrypted/u.test(HTML) && /sent — encrypted \u{1F512}/u.test(HTML), 'and they still say what they mean');
  // the identifiers the supervisor's review put out of bounds must NOT have been renamed
  ok(/async function getSeaServiceUnlockState\(\)/.test(HTML) && (HTML.match(/getSeaServiceUnlockState\(\)/g) || []).length === 7,
    'the gate logic was not touched: getSeaServiceUnlockState + its 6 call sites are all still there (' + (HTML.match(/getSeaServiceUnlockState\(\)/g) || []).length + '/7)');
  ok(/var fullUnlock=\(total>0&&locked===0\);/.test(HTML) && /fullUnlock\?'yes':'no'/.test(HTML),
    'and so is var fullUnlock and its use — this slice changed WORDS, never behaviour');
  // negatives
  const backCopy = HTML.replace('Plugins become available after you join a vessel crew.', 'Plugins unlock after you join a vessel crew.');
  ok((nopayScrub(backCopy).match(/\bun-?lock(?:s|ed|ing)?\b/gi) || []).length === 1,
    'NEGATIVE: putting «Plugins unlock after you join a vessel crew» back turns the unlock rule red');
  const backLock = HTML.replace('<div class="mv-tile" aria-disabled="true" title="', '<div class="mv-tile-lock">🔒</div><div class="mv-tile" aria-disabled="true" title="');
  ok(/mv-tile-lock/.test(backLock), 'NEGATIVE: putting the padlock badge back on the module tiles turns it red too');
  ok((nopayScrub('A more complete profile unlocks more Skipi opportunities').match(/\bun-?lock(?:s|ed|ing)?\b/gi) || []).length === 1
    && (nopayScrub('getSeaServiceUnlockState(); var fullUnlock=true;').match(/\bun-?lock(?:s|ed|ing)?\b/gi) || []).length === 0,
    'NEGATIVE CONTROL: the rule fires on the COPY and stays silent on the identifiers — a rule that renamed functions would have been reverted the first time it broke a gate');
}

{
  section('NOPAY5 — no SHIPPED dist asset claims that anything costs nothing (decision 253)');
  // The first version of this rule was titled «the dists» and read dist/index.html
  // ALONE — while the two strings that actually shipped a price claim sat in
  // dist/skipi-assistant.js. It was green for the wrong reason (Supervisor Н-A,
  // 2026-09-06). It now reads EVERY shipped text asset under dist/, bundles and
  // bundled plugins included.
  // The SAME single walk NOPAY1–NOPAY4 above use: one definition of «what ships», so
  // the two rule families can never drift apart on which files they read.
  const SHIPPED = SHIPPED_ASSETS;
  const shippedText = SHIPPED_TEXT;
  ok(SHIPPED.length >= 10 && shippedText.some((f) => f.file === 'skipi-assistant.js') && shippedText.some((f) => f.file === 'index.html'),
    'the scan really covers the shipped bundles, not just index.html (' + SHIPPED.length + ' files, incl. ' + shippedText.filter((f) => /\.js$/.test(f.file)).length + ' js)');

  // Allowlist = a written promise, with the reason, that this occurrence is not a
  // claim about price. Anything not listed is red.
  const NOPAY_ALLOW = [
    { re: /free[\s-]text/gi, why: '«Free text (optional)» is the LABEL of the free-text review field and the comments around it — it describes an input, not a price' },
    { re: /free[\s-]form/gi, why: '«free-form edits» describes how a field may be filled in — again an input, not a price' },
    { re: /framework-free/gi, why: '«Framework-free (vanilla)» in the @skipi/assistant header comment is a statement about dependencies, and it is a comment, not screen copy' },
    // The ONLY allowlisted user-facing strings, and they are allowed on a condition
    // that is proved below, not on trust: they are @skipi/assistant i18n DEFAULTS for
    // one key, and this home replaces that key through host.getI18n before the module
    // can ever render it. Fixing the vendored bundle itself belongs to the Assistant
    // Lead track; a home may not patch a vendored module in place.
    { re: /today’s free limit/gi, why: '@skipi/assistant built-in default for assistant.error.limit — overridden by this home (proved below), never rendered here' },
    { re: /лимит бесплатных запросов/gi, why: 'the RU half of the same @skipi/assistant default for assistant.error.limit — same override, same proof' },
  ];
  const freeHits = (files) => {
    const out = [];
    for (const f of files) {
      let stripped = f.text;
      NOPAY_ALLOW.forEach(({ re }) => { stripped = stripped.replace(re, 'X'.repeat(9)); });
      for (const m of stripped.match(/\bfree\b|бесплат/gi) || []) out.push(f.file + ': ' + m);
    }
    return out;
  };
  const hits = freeHits(shippedText);
  ok(hits.length === 0, 'no free/бесплат claim in ANY shipped dist asset (hits: ' + JSON.stringify(hits) + ')');
  ok(NOPAY_ALLOW.every((a) => a.why.length > 40), 'every allowlist entry states why it is legitimate');
  ok((HTML.match(/free[\s-]text|free[\s-]form/gi) || []).length >= 4,
    'the allowlist is NOT vacuous — the legitimate phrases really are in the file (' + (HTML.match(/free[\s-]text|free[\s-]form/gi) || []).length + ' of them)');

  // ── the condition the last two allowlist entries stand on ──────────────────
  // @skipi/assistant resolves every key through host.getI18n(key) FIRST
  // (dist/skipi-assistant.js:109-114). If this home stops answering for
  // assistant.error.limit, the module default — with its price claim — reaches the
  // screen, and the two entries above become a hole. So it is proved, per locale.
  const ASSISTANT_JS = fs.readFileSync(path.join(DIST, 'skipi-assistant.js'), 'utf8');
  ok(/if \(typeof host\.getI18n === 'function'\) \{[\s\S]{0,120}?return v;/.test(ASSISTANT_JS),
    'the module really does ask the host first (if this stops being true, the override below stops protecting anything)');
  const gi = HTML.indexOf('getI18n: function(key){');
  const gj = HTML.indexOf('\n            },\n', gi);
  ok(gi > 0 && gj > gi, 'the host getI18n was located in dist/index.html');
  const giSrc = HTML.slice(gi, gj) + '\n            }';
  const askHost = (locale, src) => {
    const ctx = { currentLocale: () => locale, out: null };
    vm.createContext(ctx);
    vm.runInContext('out = ({ ' + src + ' }).getI18n("assistant.error.limit");', ctx);
    return ctx.out;
  };
  for (const loc of ['en', 'ru']) {
    const v = askHost(loc, giSrc);
    ok(typeof v === 'string' && v.length > 10, loc + ': the home answers for assistant.error.limit instead of falling through to the module default (got ' + JSON.stringify(v) + ')');
    ok(typeof v === 'string' && !/\bfree\b|бесплат/i.test(v), loc + ': and its copy carries no claim about price');
    ok(typeof v === 'string' && /limit|лимит/i.test(v), loc + ': while still telling the user what actually happened — a daily cap');
  }
  ok(askHost('en', giSrc) !== askHost('ru', giSrc), 'the two locales really are different strings (the RU branch is not dead code)');

  // ── negatives ─────────────────────────────────────────────────────────────
  // 1. the scan reaches the .js bundles at all — this is the one the old rule failed
  const poisoned = shippedText.map((f) => (f.file === 'skipi-assistant.js'
    ? { file: f.file, text: f.text.replace("'assistant.error.setup':", "'assistant.error.paywall': 'Your free questions are over.',\n      'assistant.error.setup':") }
    : f));
  const poisonedHits = freeHits(poisoned);
  ok(poisonedHits.length === 1 && /skipi-assistant\.js/.test(poisonedHits[0]),
    'NEGATIVE: a price claim added to a bundle OTHER than index.html turns this rule red — the old rule could not see it (0 hits before, ' + poisonedHits.length + ' after: ' + JSON.stringify(poisonedHits) + ')');
  // 2. the allowlisted module defaults are allowed only while the override stands
  const brokenSrc = giSrc.replace(/if\(key === 'assistant\.error\.limit'\)\{[\s\S]*?\n                \}/, '');
  ok(brokenSrc !== giSrc, 'the negative mutation really removed the override');
  ok(askHost('en', brokenSrc) == null,
    'NEGATIVE: drop the host override and the module default — the string this rule allowlists — is what reaches the screen, so the proof above goes red');
  // 3. the classic sites still redden
  ok(freeHits([{ file: 'index.html', text: HTML.replace('An AI assistant for your maritime career', 'A free AI assistant for your maritime career') }]).length === 1,
    'NEGATIVE: putting «A free AI assistant» back into the consent card turns this rule red');
  ok(freeHits([{ file: 'index.html', text: HTML.replace('AI-ассистент по карьере и документам', 'Бесплатный AI-ассистент по карьере и документам') }]).length === 1,
    'NEGATIVE: the Russian «Бесплатный AI-ассистент» turns it red too');
  ok(freeHits([{ file: 'index.html', text: HTML.replace('Personal licence for the seafarer using this device.', 'Closed beta build - free for invited seafarers.') }]).length === 1,
    'NEGATIVE: the old Settings licence line turns it red');
  ok(freeHits([{ file: 'x.html', text: '<div>Free text (optional)</div><div>anonymous free-form edits</div>' }]).length === 0,
    'NEGATIVE CONTROL: the legitimate phrases stay green — a rule that reddens everything gets switched off by the first person in a hurry');
}

{
  section('NOPAY6 — the dists do not announce a demo / pre-release build (App Store Guideline 2.2)');
  const betaHits = (html) => html.match(/closed beta|beta build|beta version|trial version|demo version|бета-верси|бета-тест/gi) || [];
  const hits = betaHits(HTML);
  ok(hits.length === 0, 'no pre-release wording anywhere in dist/index.html (hits: ' + JSON.stringify(hits) + ')');
  ok(/Personal licence for the seafarer using this device\./.test(HTML), 'the Settings licence row says what the licence IS instead');
  ok(betaHits(HTML.replace('Personal licence for the seafarer using this device.', 'Closed beta build.')).length === 1,
    'NEGATIVE: restoring the «Closed beta build» licence line turns this rule red');
  ok(betaHits(HTML.replace('Rate the app and leave a short comment.', 'Rate the beta version and leave a short comment.')).length === 1,
    'NEGATIVE: calling the app a beta version anywhere in the copy turns it red');
}

// Comment stripper shared by REG1 and LEAK1. Both rules are about what reaches a
// SCREEN, and both fixes left a comment explaining the mistake they fixed — a rule
// that cannot tell a warning from the thing it warns about is a rule people delete.
//
// It works LINE BY LINE on purpose. The obvious `/\*[\s\S]*?\*\//` + `//[^\n]*` pair
// is WRONG on this dist and was caught being wrong here: a `/*` that lives inside a
// string literal pairs with the next `*/` thousands of lines away and blanks real
// code in between — the first version of LEAK1 stayed green on the very sentence it
// exists to catch, because that sentence had been erased by the stripper. Whole-line
// comments (`//`, `*` continuation, `/* … */`, `<!-- … -->`) are how this codebase
// actually writes prose, so those lines are dropped; a `/* … */` that sits ON a code
// line is removed within that line; a trailing `//` on a code line is deliberately
// NOT stripped, because `https://` lives on code lines too.
const stripCodeComments = (text) => text.split('\n').map((line) => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('-->')) return '';
  return line.replace(/\/\*[^\n]*?\*\//g, '');
}).join('\n');

{
  section('REG1 — the Register door can never be silent again (the 2.1(b) shape)');
  // invoke() returns a Promise. try{ invoke(...) }catch(e){} catches only a synchronous
  // throw, so on iOS — where open_external_url is a stub returning Err — the rejection
  // went nowhere and the door on the FIRST screen did nothing and said nothing.
  // Supervisor Н-B (06.09): checking for `await` alone was not enough — a second call
  // site kept its own catch, and a catch that silently falls back can go quiet again.
  // The invariant is therefore stronger than «awaited»: there is exactly ONE call site
  // in this file and it is the helper, so a silent catch is not expressible.
  // Supervisor Н-B was fixed inside index.html only. The SECOND silent door was one
  // file away: dist/intelligence.js:271 had its own `try{await invoke(...)}catch{
  // window.open(url,'_blank') }`, and inside a WKWebView window.open() returns null
  // and does nothing — so «source» links on the Information screen were mute on iOS
  // exactly like Register was (RISKS №221b). Reading index.html alone is the same
  // mistake NOPAY made before Н-A. This rule reads EVERY shipped asset.
  const callSites = SHIPPED_TEXT
    .map((f) => ({ file: f.file, n: (f.text.match(/invoke\(\s*'open_external_url'/g) || []).length }))
    .filter((x) => x.n > 0);
  ok(callSites.length === 1 && callSites[0].file === 'index.html' && callSites[0].n === 1,
    'exactly ONE open_external_url call site in the whole shipped dist, and it is in index.html (found: ' + JSON.stringify(callSites) + ')');
  // window.open() is the silent fallback that made the second door mute. It has no
  // business in the app shell at all; the bundled plugins are a declared exception.
  const WINDOW_OPEN_ALLOW = [
    { prefix: 'plugins/', why: 'the bundled navigation-calculators pack ships legacy NGA calculator markup that calls window.open() for its own popups, and the plugin SHIMS those calls into an inline panel of its own; none of it is an external Skipi door, and a home may not rewrite a bundled plugin in place' },
  ];
  const stripJs = stripCodeComments;
  const windowOpens = SHIPPED_TEXT
    .filter((f) => !WINDOW_OPEN_ALLOW.some((a) => f.file.startsWith(a.prefix)))
    .map((f) => ({ file: f.file, n: (stripJs(f.text).match(/window\.open\(/g) || []).length }))
    .filter((x) => x.n > 0);
  ok(windowOpens.length === 0,
    'no shell asset falls back to window.open() — it returns null inside a WKWebView and answers nothing (offenders: ' + JSON.stringify(windowOpens) + ')');
  ok(WINDOW_OPEN_ALLOW.every((a) => a.why.length > 60 && SHIPPED_TEXT.some((f) => f.file.startsWith(a.prefix) && /window\.open\(/.test(f.text))),
    'and the one exception is real, current and explained (the bundled plugins really do contain window.open)');
  const INTEL = SHIPPED_TEXT.find((f) => f.file === 'intelligence.js').text;
  ok(/async function openInformationSource\(url\)\{\s*\n\s*return openExternalUrlSafe\(url\);\s*\n\}/.test(INTEL),
    'the Information «source» link goes through the same answering helper as every other door');
  const calls = [...HTML.matchAll(/invoke\(\s*'open_external_url'/g)];
  ok(calls.length === 1, 'exactly one open_external_url call site in dist/index.html (found ' + calls.length + ')');
  const helper = HTML.slice(HTML.indexOf('async function openExternalUrlSafe('), HTML.indexOf('async function openRegisterPage('));
  ok(helper.length > 100 && helper.includes("invoke('open_external_url'"), 'and that one call site is inside openExternalUrlSafe');
  ok(/await invoke\('open_external_url'/.test(helper), 'it is awaited');
  const tail = helper.slice(helper.indexOf('catch'));
  ok(/catch\s*\(e\)\s*\{/.test(helper) && tail.length > 120, 'its catch is a real block, not catch(e){}');
  ok(/showToast\(/.test(tail) && /writeClipboardText\(/.test(tail),
    'and that block answers on screen with the address, copied to the clipboard — silence is the defect, not the error');
  ok(/async function openRegisterPage\(\)\{[\s\S]{0,300}?openExternalUrlSafe\('https:\/\/assistant\.skipi\.app\/register'\)/.test(HTML),
    'openRegisterPage routes through the helper');
  ok(/async function openDeveloperGroupInvite\(\)\{[\s\S]{0,600}?await openExternalUrlSafe\(DEVELOPER_GROUP_INVITE_URL\);/.test(HTML),
    'so does the developer-invite door (Supervisor Н-B: it used to keep its own catch with a window.open fallback that can be a no-op inside the webview)');
  ok(!/window\.open\(DEVELOPER_GROUP_INVITE_URL/.test(HTML), 'and its old silent fallback is gone, not merely bypassed');
  // both call sites of the audit are still the same two, and both go through that one function
  ok(/function entryForkRegister\(\)\{ openRegisterPage\(\); \}/.test(HTML), 'SITE 1: the Register door of the entry fork calls openRegisterPage');
  ok(/id="lg-register"[^>]*onclick="openRegisterPage\(\);return false;"/.test(HTML), 'SITE 2: the Register link inside the login gate calls openRegisterPage');
  ok(/onclick="openExternalUrlSafe\(/.test(HTML), 'SITE 3: the update banner’s «Download manually» link too');
  // negatives
  const bare = HTML.replace("        await invoke('open_external_url',{url:url});", "        invoke('open_external_url',{url:url});");
  ok(!/await invoke\('open_external_url'/.test(bare.slice(bare.indexOf('async function openExternalUrlSafe('), bare.indexOf('async function openRegisterPage('))),
    'NEGATIVE: dropping the await from the helper turns this rule red');
  const second = HTML.replace('    await openExternalUrlSafe(DEVELOPER_GROUP_INVITE_URL);',
    "    try{await invoke('open_external_url',{url:DEVELOPER_GROUP_INVITE_URL});}catch(e){}");
  ok([...second.matchAll(/invoke\(\s*'open_external_url'/g)].length === 2,
    'NEGATIVE: re-introducing a second call site with its own silent catch turns this rule red (1 site before, ' + [...second.matchAll(/invoke\(\s*'open_external_url'/g)].length + ' after)');
  // and the same, one file away — the byte-for-byte body intelligence.js shipped until 06.09
  const OLD_INTEL = "async function openInformationSource(url){\n    try{await invoke('open_external_url',{url:url});}\n    catch(e){window.open(url,'_blank');}\n}";
  const poisonedDist = SHIPPED_TEXT.map((f) => (f.file === 'intelligence.js'
    ? { file: f.file, text: f.text.replace(/async function openInformationSource\(url\)\{[\s\S]*?\n\}/, OLD_INTEL) }
    : f));
  const poisonedSites = poisonedDist
    .map((f) => ({ file: f.file, n: (f.text.match(/invoke\(\s*'open_external_url'/g) || []).length }))
    .filter((x) => x.n > 0);
  ok(poisonedSites.length === 2,
    'NEGATIVE: putting the old intelligence.js body back gives the dist a SECOND call site and turns this rule red (' + JSON.stringify(poisonedSites) + ')');
  const poisonedOpens = poisonedDist
    .filter((f) => !f.file.startsWith('plugins/'))
    .map((f) => ({ file: f.file, n: (stripJs(f.text).match(/window\.open\(/g) || []).length }))
    .filter((x) => x.n > 0);
  ok(poisonedOpens.length === 1 && poisonedOpens[0].file === 'intelligence.js',
    'NEGATIVE: and its window.open() fallback — the call that does nothing inside a WKWebView — reddens the second half too');
}

{
  section('FONT1 — mobile input fields are 16px, so iOS does not zoom the interface on the first tap');
  const rule = /body\.mobile-mode input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\):not\(\[type="color"\]\),\s*\nbody\.mobile-mode select,\s*\nbody\.mobile-mode textarea \{ font-size:16px; \}/;
  ok(rule.test(HTML), 'one rule raises every text input, select and textarea in mobile mode to 16px');
  // The gate is drawn BEFORE any vault opens, so the class must already be on the body:
  ok(/applyMobileMode\(\);\s*\n\s*await initApiBaseOverride\(\);/.test(HTML),
    'body.mobile-mode is applied in init() before the entry fork / login gate is raised, so the rule covers the very first field the reviewer taps');
  ok(/\.field input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.field select, \.field textarea \{[^}]*font-size:13px/.test(HTML),
    'the 13px desktop rule is still there — this slice did not restyle the desktop, it added a mobile override (and the override comes later in the file, so it wins)');
  ok(HTML.indexOf('body.mobile-mode textarea { font-size:16px; }') > HTML.indexOf('.field input:not([type="checkbox"]):not([type="radio"]), .field select, .field textarea {'),
    'and the override really is declared after the 13px rule (cascade order, not wishful thinking)');
  // negative
  const stripped = HTML.replace(/body\.mobile-mode input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\):not\(\[type="color"\]\),\s*\nbody\.mobile-mode select,\s*\nbody\.mobile-mode textarea \{ font-size:16px; \}/, '');
  ok(!rule.test(stripped), 'NEGATIVE: deleting the 16px rule turns this drill red');
}

{
  section('IOSDOC1 — no dead «open the file» button on iOS (both document commands are Android/desktop-only in Rust)');
  const RUSTDOC = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'commands', 'documents.rs'), 'utf8');
  ok(/#\[cfg\(target_os = "ios"\)\][\s\S]{0,200}?Opening attached files is not\s*\n?\s*wired for iOS yet/.test(RUSTDOC.replace(/\s+/g, ' ').replace(/(.{0,0})/, '$1')) || /Opening attached files is not/.test(RUSTDOC),
    'documents.rs still returns Err for open_document_file on iOS (this drill exists because of that, and must be revisited when it stops being true)');
  ok(/#\[cfg\(not\(target_os = "android"\)\)\][\s\S]{0,220}Built-in PDF preview is only wired for Android/.test(RUSTDOC),
    'and render_document_pdf_preview is implemented for ANDROID ONLY — the audit called it a ready iOS fallback, the bytes say otherwise');
  ok(/async function mobileOpenDocumentFile\(docId\)\{\s*\n[^\n]*\n\s*if\(iosHost\(\)\)return mobileOpenDocumentInApp\(docId\);/.test(HTML),
    'the phone «Open» button short-circuits to the in-app viewer on iOS instead of calling the dead command');
  ok(/async function mobileOpenDocumentInApp\(docId\)\{[\s\S]{0,600}invoke\('read_file_base64'/.test(HTML),
    'the in-app viewer reads the bytes through read_file_base64, which carries no #[cfg] and works on every platform');
  ok(/if\(isMobileMode\(\)&&!iosHost\(\)&&\/\\\.pdf\$\/i\.test/.test(HTML),
    'the Android-only PDF rasteriser is not asked for on iOS (it would answer Err and the screen used to print that Err next to a button that also failed)');
  ok(/function iosHost\(\)\{return hostPlatform==='ios';\}/.test(HTML), 'iosHost() is the single platform test used by all of the above');
  // negative
  const noGuard = HTML.replace('    if(iosHost())return mobileOpenDocumentInApp(docId);\n', '');
  ok(!/async function mobileOpenDocumentFile\(docId\)\{\s*\n[^\n]*\n\s*if\(iosHost\(\)\)return mobileOpenDocumentInApp\(docId\);/.test(noGuard),
    'NEGATIVE: removing the iOS short-circuit turns this drill red');
}

{
  section('AVATAR1 — Settings never prints raw JSON under the avatar (user report B4, 06.09)');
  // @skipi/settings renders the mobile subtitle through valueText(summary,
  // ['subtitle','email','description']) and, when NONE of those keys is present, falls
  // back to JSON.stringify(summary). A seafarer with neither e-mail nor rank filled in
  // therefore read {"displayName":"…","sectionId":"profile","avatarText":"…"} under their
  // own avatar. This drill runs the REAL module function over the REAL host summary.
  const isObjSrc = /function isObject\(value\) \{[\s\S]*?\n  \}\n/.exec(SETTINGS_JS);
  const valSrc = /function valueText\(value, preferredKeys\) \{[\s\S]*?\n  \}\n/.exec(SETTINGS_JS);
  ok(!!isObjSrc && !!valSrc, 'the real valueText/isObject were located in dist/skipi-settings.js');
  const i = HTML.indexOf('function unifiedGetAccountSummary(){');
  const j = HTML.indexOf('\n    }\n', i);
  ok(i > 0 && j > i, 'the host summary builder was located in dist/index.html');
  const summarySrc = HTML.slice(i, j + 6);

  const buildSummary = async (personal, src) => {
    const ctx = {
      tr: () => 'Skipi Seafarer',
      getUiLang: () => 'en',
      invoke: () => Promise.resolve(personal),
      out: null,
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nout = unifiedGetAccountSummary();', ctx);
    return ctx.out;
  };
  const renderSubtitle = (summary) => {
    const ctx = { S: summary, out: null };
    vm.createContext(ctx);
    vm.runInContext(isObjSrc[0] + valSrc[0] + "\nout = valueText(S, ['subtitle', 'email', 'description']);", ctx);
    return ctx.out;
  };

  for (const [label, personal] of [
    ['a brand-new vault (nothing filled in at all)', {}],
    ['a vault with only a name', { first_name: 'Ivan', surname: 'Petrov' }],
    ['a vault with a rank but no e-mail', { first_name: 'Ivan', rank: 'Chief Officer' }],
    ['a vault with an e-mail', { email: 'ivan@example.com' }],
  ]) {
    const summary = await buildSummary(personal, summarySrc);
    const subtitle = renderSubtitle(summary);
    ok(typeof subtitle === 'string' && subtitle.length > 0 && !/[{}"]/.test(subtitle),
      label + ': the module renders a human subtitle, not JSON (got ' + JSON.stringify(subtitle) + ')');
  }
  // negative — put the pre-fix builder back and watch the JSON return
  const brokenSrc = summarySrc.replace(/\n\s*else \{ summary\.subtitle = \(getUiLang\(\)==='ru'\) \? 'Профиль моряка' : 'Seafarer profile'; \}/, '');
  ok(brokenSrc !== summarySrc, 'the negative mutation really removed the fallback');
  const brokenSubtitle = renderSubtitle(await buildSummary({}, brokenSrc));
  ok(/^\{".*\}$/.test(brokenSubtitle),
    'NEGATIVE: without the fallback the module prints the object as JSON under the avatar — exactly what the user reported (got ' + JSON.stringify(brokenSubtitle) + ')');
}

{
  section('TOAST1 — a toast is drawn ABOVE every full-screen gate (the mute «Register» button, 06.09)');
  // Found by tapping, not by reading: on the iPhone 17 Pro Max simulator the manager
  // pressed Register on the FIRST screen and the screen did not change at all. The
  // link had gone into the clipboard and openExternalUrlSafe had raised its toast —
  // the toast was simply painted UNDER the first screen. .skipi-toast-container was
  // z-index:99999 while .mobile-entry-fork and #login-gate-overlay are 100000. On the
  // entry fork that makes EVERY message invisible, not only this one, and «the
  // reviewer taps and nothing happens» is exactly the shape we were rejected for.
  //
  // The rule is therefore not «99999 is wrong»: it is «the toast layer is above every
  // full-screen container this file can raise». Those containers are found, not
  // listed from memory — every `position:fixed` declaration blob that also carries
  // `inset:0`, in CSS rules, inline style attributes and JS cssText alike.
  const declarationBlobs = () => {
    const found = [];
    const re = /position:\s*fixed/g;
    let m;
    while ((m = re.exec(HTML))) {
      const start = m.index;
      let a = start; while (a > 0 && !'{"\''.includes(HTML[a - 1])) a--;
      let b = start; while (b < HTML.length && !'}"\''.includes(HTML[b])) b++;
      const blob = HTML.slice(a, b);
      if (!/inset:\s*0/.test(blob)) continue;
      const z = /z-index:\s*(\d+)/.exec(blob);
      found.push({
        z: z ? Number(z[1]) : NaN,
        where: HTML.slice(Math.max(0, a - 90), a).replace(/\s+/g, ' ').slice(-64),
      });
    }
    return found;
  };
  const fullScreen = declarationBlobs();
  const toastRule = /\.skipi-toast-container \{([^}]*)\}/.exec(HTML);
  const toastZ = toastRule ? Number((/z-index:\s*(\d+)/.exec(toastRule[1]) || [])[1]) : NaN;
  ok(Number.isFinite(toastZ), 'the toast container has a z-index at all (got ' + toastZ + ')');
  ok(/_toastContainer\.className='skipi-toast-container'/.test(HTML),
    'and .skipi-toast-container really is the layer showToast() paints into — not a class nothing uses');
  // Н-C shape: an «at least N» count would let a container disappear in silence. The
  // audit of 06.09 counted 14 full-screen containers in this file; the drill asserts
  // that number, so a NEW gate nobody thought about reddens here instead of shipping
  // as another invisible-toast bug.
  ok(fullScreen.length === 14,
    'exactly the 14 full-screen (position:fixed + inset:0) containers of dist/index.html were found — a new one must be checked against the toast layer, not discovered on a device (got '
    + fullScreen.length + ': ' + JSON.stringify(fullScreen.map((f) => f.where)) + ')');
  ok(fullScreen.every((f) => Number.isFinite(f.z)),
    'every one of them declares a z-index (an implicit one cannot be compared): ' + JSON.stringify(fullScreen.filter((f) => !Number.isFinite(f.z)).map((f) => f.where)));
  const above = fullScreen.filter((f) => !(toastZ > f.z));
  ok(above.length === 0,
    'the toast layer (' + toastZ + ') is strictly above EVERY full-screen container (highest gate: '
    + Math.max(...fullScreen.map((f) => f.z)) + ') — offenders: ' + JSON.stringify(above.map((f) => f.where + ' @ ' + f.z)));
  // the three the card names, by name, so the count above cannot go green on the wrong 14
  for (const [name, re] of [
    ['.mobile-entry-fork', /\.mobile-entry-fork \{([^}]*)\}/],
    ['#login-gate-overlay', /id="login-gate-overlay" style="([^"]*)"/],
    ['#forced-profile-overlay', /id="forced-profile-overlay" style="([^"]*)"/],
  ]) {
    const m = re.exec(HTML);
    const z = m ? Number((/z-index:\s*(\d+)/.exec(m[1]) || [])[1]) : NaN;
    ok(Number.isFinite(z) && toastZ > z, 'a toast is above ' + name + ' (' + z + ' < ' + toastZ + ')');
  }
  // …and it does NOT climb over the early-error trap, which has to stay readable when
  // the app itself is broken. «Above the gates» is the requirement; «above everything»
  // would quietly cover the one banner that exists for the case where nothing works.
  const earlyErr = /id='__early_err__'[\s\S]{0,400}?z-index:(\d+)/.exec(HTML) || /__early_err__[\s\S]{0,600}?z-index:(\d+)/.exec(HTML);
  ok(!!earlyErr && toastZ < Number(earlyErr[1]),
    'and it stays BELOW the early-error trap (' + (earlyErr ? earlyErr[1] : '?') + '), which must stay visible when the app is broken');
  // negative — the exact byte that shipped the bug
  {
    const back = HTML.replace('.skipi-toast-container { position:fixed; top:12px; right:12px; z-index:' + toastZ + ';',
      '.skipi-toast-container { position:fixed; top:12px; right:12px; z-index:99999;');
    ok(back !== HTML, 'the negative mutation really put the old z-index back');
    const oldZ = Number((/\.skipi-toast-container \{[^}]*z-index:\s*(\d+)/.exec(back) || [])[1]);
    ok(oldZ === 99999 && !fullScreen.every((f) => oldZ > f.z),
      'NEGATIVE: restoring z-index:99999 turns this drill red — that value is UNDER .mobile-entry-fork and #login-gate-overlay (100000), which is how the Register toast became invisible');
  }
}

{
  section('IOSURL1 — the Register door actually opens a browser on iOS (App Store 2.1(b))');
  // The frontend half (REG1) can only guarantee that a failure is SAID out loud. This
  // is the other half: on iOS the command used to be a stub that always returned Err,
  // so the reviewer got a toast with an address and still no browser. The behavioural
  // proof is on a device — the manager taps it on the simulator — so what is asserted
  // here are the bytes that make the device behaviour possible, and the security
  // boundary that must NOT have been widened to get there.
  const RUSTV = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'commands', 'vault.rs'), 'utf8');
  const stripRust = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  // Test code does not ship and does not open any file at runtime, and this file's
  // own tests quote both needles below on purpose. Every .rs file in this tree has
  // exactly ONE #[cfg(test)] and it is the trailing module, which is asserted before
  // the cut is used — otherwise a truncation could silently hide production code.
  ok((RUSTV.match(/#\[cfg\(test\)\]/g) || []).length === 1, 'vault.rs has exactly one #[cfg(test)] module, so cutting at it cannot hide production code');
  const CODE = stripRust(RUSTV).split('#[cfg(test)]')[0];
  const iosBranch = (() => {
    const i = CODE.indexOf('#[cfg(target_os = "ios")]\n#[tauri::command]');
    const j = CODE.indexOf('#[cfg(not(any(target_os = "android", target_os = "ios")))]', i);
    return i >= 0 && j > i ? CODE.slice(i, j) : '';
  })();
  ok(iosBranch.length > 100, 'the iOS branch of open_external_url was located in vault.rs');
  ok(!/not wired for iOS yet/.test(CODE), 'the «not wired for iOS yet» stub is gone from the code (it is only described in the comment that explains why it went)');
  ok(/openURL:options:completionHandler:/.test(CODE), 'the iOS branch sends UIApplication the modern openURL: message');
  ok(/sharedApplication/.test(CODE) && /objc_msgSend/.test(CODE), 'through the Objective-C runtime, with no new crate in Cargo.toml (which is not on this route)');
  ok(/run_on_main_thread/.test(iosBranch), 'and it does that on the MAIN thread — UIKit is not thread-safe and a background call is a crash, not a link');
  // the security boundary: same allowlist, all three platforms, checked FIRST
  const branchCount = (CODE.match(/pub fn open_external_url\(/g) || []).length;
  const checkCount = (CODE.match(/if !external_url_is_allowed\(&url\) \{/g) || []).length;
  ok(branchCount === 3 && checkCount === 3, 'all three platform branches (android/ios/desktop) exist and every one gates on the allowlist (' + checkCount + '/' + branchCount + ')');
  const beforeCheck = iosBranch.slice(0, iosBranch.indexOf('if !external_url_is_allowed'));
  ok(iosBranch.includes('if !external_url_is_allowed') && !/objc|msg_send|open_on_main_thread/.test(beforeCheck),
    'on iOS the allowlist is checked BEFORE anything reaches the Objective-C side');
  ok(/EXTERNAL_URL_ALLOWED_SCHEMES: \[&str; 4\] = \["https:\/\/", "http:\/\/", "mailto:", "tel:"\]/.test(CODE),
    'the allowlist itself is UNCHANGED — exactly the four schemes Android already allowed, not one more');
  // the allowlist really is a boundary: run the shipped predicate over the bad schemes
  const schemes = JSON.parse((/EXTERNAL_URL_ALLOWED_SCHEMES: \[&str; 4\] = (\[[^\]]*\])/.exec(CODE) || [])[1].replace(/"/g, '"'));
  const allowed = (u) => schemes.some((p) => u.startsWith(p));
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'intent://evil#Intent;scheme=x;end', 'content://media/external', 'skipi://whatever', 'ftp://example.com', '']) {
    ok(!allowed(bad), 'iOS rejects ' + JSON.stringify(bad) + ' — the same four-scheme boundary as Android');
  }
  for (const good of ['https://assistant.skipi.app/register', 'http://example.com', 'mailto:crew@skipi.app', 'tel:+15551234567']) {
    ok(allowed(good), 'and still allows ' + JSON.stringify(good));
  }
  // negatives
  ok(/not wired for iOS yet/.test(CODE.replace(/pub fn open_external_url\(app: tauri::AppHandle, url: String\) -> Result<\(\), String> \{[\s\S]*?\n\}/, 'pub fn open_external_url(url: String) -> Result<(), String> {\n    Err("Opening external URLs is not wired for iOS yet.".to_string())\n}')),
    'NEGATIVE: putting the iOS stub back turns this drill red');
  const widened = CODE.replace('EXTERNAL_URL_ALLOWED_SCHEMES: [&str; 4] = ["https://", "http://", "mailto:", "tel:"]',
    'EXTERNAL_URL_ALLOWED_SCHEMES: [&str; 5] = ["https://", "http://", "mailto:", "tel:", "file://"]');
  ok(!/EXTERNAL_URL_ALLOWED_SCHEMES: \[&str; 4\] = \["https:\/\/", "http:\/\/", "mailto:", "tel:"\]/.test(widened),
    'NEGATIVE: widening the allowlist by one scheme (file://) turns it red too — wiring iOS is not a licence to open more');
}

{
  section('FEED1 — feedback and diagnostics can actually be written on a phone (RISKS №220b)');
  // Reproduced verbatim on the emulator before the fix:
  //   «Feedback save failed: unable to open database file: ./skipi/feedback.sqlite»
  // dirs::data_dir() is None on Android, the unwrap_or_else fallback made the path
  // RELATIVE, and SQLite could not open it. Not one rating and not one diagnostic
  // ever left a phone. Every other store in this tree already asks the app.
  const rustAll = [];
  (function walkRs(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkRs(p);
      else if (e.name.endsWith('.rs')) rustAll.push(p);
    }
  })(path.join(__dirname, '..', 'src-tauri', 'src'));
  const stripRs = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  ok(rustAll.length >= 8, 'the whole Rust tree is read, not just feedback.rs (' + rustAll.length + ' files)');
  // Same cut as IOSURL1, same reason: the regression tests of feedback.rs quote the
  // forbidden call on purpose, and test code opens no database at runtime.
  const rustProd = rustAll.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return {
      f: path.relative(path.join(__dirname, '..'), f),
      testMods: (raw.match(/#\[cfg\(test\)\]/g) || []).length,
      src: stripRs(raw).split('#[cfg(test)]')[0],
    };
  });
  ok(rustProd.every((x) => x.testMods <= 1),
    'every .rs file has at most one #[cfg(test)] module, so cutting at it cannot hide production code (offenders: '
    + JSON.stringify(rustProd.filter((x) => x.testMods > 1).map((x) => x.f)) + ')');
  const offenders = rustProd.filter((x) => /dirs::data_dir\(\)/.test(x.src)).map((x) => x.f);
  ok(offenders.length === 0,
    'no store in src-tauri resolves its path through dirs::data_dir() any more — the one call site that did was the feedback DB (offenders: ' + JSON.stringify(offenders) + ')');
  const FEEDBACK = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'feedback.rs'), 'utf8').split('#[cfg(test)]')[0];
  ok(/fn feedback_db_path\(app: &tauri::AppHandle\) -> Result<PathBuf, String>/.test(FEEDBACK),
    'feedback_db_path takes the AppHandle it resolves the path from, and can fail honestly instead of silently going relative');
  ok(/\.app_data_dir\(\)/.test(FEEDBACK), 'and it asks app.path().app_data_dir() — the same call vault.rs, agency_mailing.rs and profile.rs already make');
  ok(!/PathBuf::from\("\."\)/.test(stripRs(FEEDBACK)), 'the «.» fallback that produced ./skipi/feedback.sqlite is gone — there is no relative path left to fall back to');
  ok((FEEDBACK.match(/open_feedback_db\(&app\)\?/g) || []).length >= 8,
    'every #[tauri::command] in feedback.rs opens the DB through the handle (' + (FEEDBACK.match(/open_feedback_db\(&app\)\?/g) || []).length + ' call sites)');
  ok(!/open_feedback_db\(\)/.test(FEEDBACK) && !/feedback_db_path\(\)/.test(FEEDBACK), 'and no handle-less caller is left behind');
  // negative
  const back = FEEDBACK.replace(/fn feedback_db_path\(app: &tauri::AppHandle\) -> Result<PathBuf, String> \{[\s\S]*?\n\}/,
    'fn feedback_db_path() -> PathBuf {\n    let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("skipi");\n    dir.join("feedback.sqlite")\n}');
  ok(/dirs::data_dir\(\)/.test(stripRs(back)) && back !== FEEDBACK,
    'NEGATIVE: restoring the dirs::data_dir() path — the exact code that made the DB unopenable on Android — turns this drill red');
}

{
  section('LEAK1 — no shipped asset tells the user the product is unfinished (App Store Guideline 2.1, App Completeness)');
  // Found on the iOS simulator, on the My Vessel screen four taps from the first
  // screen: «Photo upload and sending to the vessel appear AFTER BACKEND — nothing is
  // sent now». Two defects in one sentence: an implementation word in copy written for
  // a seafarer, and the app telling a reviewer in its own words that a feature does
  // not work. That is the article of two of our three rejections.
  // Comments are stripped first: this is about what reaches a SCREEN, and a rule that
  // reddened on every code comment would be switched off within a week.
  const stripCode = stripCodeComments;
  // the stripper is proved, not trusted: it must erase prose and keep code
  ok(stripCode('// backend\nlet a=1; /* backend */ let b=2;\n') .includes('let a=1;')
    && stripCode('// backend\nlet a=1; /* backend */ let b=2;\n').includes('let b=2;')
    && !/backend/.test(stripCode('// backend\nlet a=1; /* backend */ let b=2;\n')),
    'the comment stripper erases comments and keeps code (a stripper that erases code makes every rule below vacuous)');
  ok(/backend/.test(stripCode("h+='Photo upload appears after backend';")),
    'and it does NOT touch a string literal on a code line — which is exactly where the defect lived');
  const LEAK_ALLOW = [
    { re: /No backend endpoint\./g, file: 'plugins/bnwas-time-anchor/REPORT.md',
      why: 'the BNWAS plugin’s provenance REPORT saying what the bundle does NOT do (no network, no backend endpoint) — a developer document that ships inside dist/ but is never rendered on any screen' },
    { re: /comingSoon/g, file: 'plugin-host-ui.js',
      why: 'the vendored @skipi/plugin-host-ui catalog flag and its badge: a truthful status about a THIRD-PARTY plugin in the catalog, not a statement that this app is unfinished; the home may not patch a vendored module in place' },
    { re: /Coming soon/g, file: 'plugin-host-ui.js',
      why: 'the visible half of that same catalog badge, in the same vendored module' },
    { re: /This entity type is coming soon — only Seafarer is available right now\./g, file: 'index.html',
      why: 'the toast of onType(), which has ZERO call sites in the shipped bytes — entity types other than Seafarer were removed from the UI in 0.4.11; the assertion below proves it is unreachable rather than trusting this note' },
  ];
  ok(!/onType\(/.test(HTML.replace('async function onType(v){', '')),
    'the allowlisted «coming soon» toast really is unreachable: onType() has no call site anywhere in dist/index.html');
  const LEAK_RULES = [
    ['backend', String.raw`\bback[\s-]?end\b`],
    ['not implemented', String.raw`\bnot implemented\b`],
    ['coming soon', String.raw`\bcoming soon\b`],
    ['TODO/FIXME in copy', String.raw`\b(?:TODO|FIXME)\b`],
    ['does not work yet', String.raw`\b(?:doesn.t|does not) work yet\b`],
  ];
  const leakScan = (files) => LEAK_RULES.map(([label, pattern]) => {
    const where = [];
    for (const f of files) {
      let t = stripCode(f.text);
      LEAK_ALLOW.forEach((a) => { if (a.file === f.file) t = t.replace(a.re, (m) => 'X'.repeat(m.length)); });
      const m = t.match(new RegExp(pattern, 'gi')) || [];
      if (m.length) where.push(f.file + ' (x' + m.length + ')');
    }
    return { label, where };
  });
  for (const h of leakScan(SHIPPED_TEXT)) {
    ok(h.where.length === 0, 'no shipped asset says «' + h.label + '» in screen copy' + (h.where.length ? ' — ' + JSON.stringify(h.where) : ''));
  }
  for (const a of LEAK_ALLOW) {
    const f = SHIPPED_TEXT.find((x) => x.file === a.file);
    ok(!!f && (f.text.match(a.re) || []).length > 0, 'the exception is real and still there (not a stale loophole): ' + a.file + ' ' + a.re);
    ok(a.why.length > 60, 'and it says why that occurrence is not a confession of an unfinished app: ' + a.file);
  }
  ok(/Photo upload and sending to the vessel become available/.test(HTML) && !/after backend/.test(HTML),
    'the My Vessel note now tells the seafarer WHEN it works instead of naming our architecture');
  ok(/Загрузка фото и отправка на судно становятся доступны/.test(HTML),
    'and the Russian half was fixed with it — it carried the same word');
  // negatives
  ok(leakScan([{ file: 'index.html', text: 'Photo upload and sending to the vessel appear after backend — nothing is sent now.' }])
    .filter((h) => h.where.length).map((h) => h.label).includes('backend'),
    'NEGATIVE: the exact sentence the reviewer could read on My Vessel turns this drill red');
  ok(leakScan([{ file: 'index.html', text: '<p>This screen is not implemented yet, coming soon.</p>' }]).filter((h) => h.where.length).length >= 2,
    'NEGATIVE: «not implemented» / «coming soon» written into index.html copy turns it red');
  ok(leakScan([{ file: 'index.html', text: '// backend TODO: coming soon, not implemented' }]).filter((h) => h.where.length).length === 0,
    'NEGATIVE CONTROL: the same words in a CODE COMMENT stay green — a rule that reddens on comments gets switched off by the first person in a hurry');
}

{
  section('LANG1 — the interface language can be changed without knowing English (user report B6, 06.09; re-shaped by OWNER 06.09)');
  // Owner, looking at the iPad simulator: «эту полосу с выбором языка отсюда можно убрать». The wide
  // row is gone — but DELETING it outright would put bug B6 straight back (the language
  // used to be three taps deep inside Settings → Application, labelled in English, and
  // users did not find it). So the invariant this drill defends is NOT «there is a row»;
  // it is: on the Menu screen there is a VISIBLE language control, it shows the current
  // language in words, and one tap opens the chooser without a trip into Settings.
  const menu = HTML.slice(HTML.indexOf('function renderMobileMenu(){'), HTML.indexOf('function currentUiLangLabel('));
  ok(/data-qa="mobile-menu-language"/.test(menu) === false && /'mobile-menu-language'/.test(menu),
    'the Menu screen still carries the language control (now as a tile in the same icon grid as Profile and Feedback)');
  ok(/mobileMenuIconTile\('mobile-menu-language','openMobileLanguageMenu\(\)'/.test(menu),
    'and tapping it opens the chooser — not Settings, not a screen change');
  ok(/currentUiLangLabel\(\)\)?\n?\s*\+'<\/div>'/.test(menu) || /currentUiLangLabel\(\)/.test(menu),
    'the tile shows the CURRENT language as its own sub-label (the icon carries the state, the way the owner asked)');
  ok(/function currentUiLangLabel\(\)\{[\s\S]{0,300}UI_LANG_OPTIONS\[i\]\[1\]/.test(HTML),
    'that sub-label is the language written in its own language, taken from UI_LANG_OPTIONS');
  ok(/<span class="fam-app-sublabel">/.test(HTML) && /\.fam-app-tile \.fam-app-sublabel \{[^}]*font-size:11px/.test(HTML),
    'and it is really VISIBLE — a styled second line on the tile, not a long-press hint');
  ok(/function openMobileLanguageMenu\(\)\{[\s\S]{0,900}UI_LANG_OPTIONS\.forEach/.test(HTML), 'the chooser lists every configured UI language');
  ok(/function mobileSetUiLang\(lang\)\{[\s\S]{0,240}setUiLang\(lang\);[\s\S]{0,240}renderMobileShell\(\);/.test(HTML), 'choosing one applies it and repaints the shell immediately');
  ok(/\['ru','Русский'\]/.test(HTML), 'Russian is one of them, written in Russian — the user has to recognise it without reading English');
  // and the real render agrees with the bytes: the tile is on the screen, in the grid
  {
    const app = installNavHistory(bootMobile({ seed: {} }));
    await settleVm();
    app.sandbox.mobileShow('menu'); app.runTimers(0);
    const mm = mobileHtml(app.doc);
    ok(mm.includes('data-qa="mobile-menu-language"'), 'LANG1 (render): the language tile really is on the Menu screen');
    ok(/class="fam-app-sublabel">English</.test(mm), 'LANG1 (render): and it prints the current language — English on a default install');
    // the chooser appends itself to <body>; the fake DOM has no insertAdjacentHTML,
    // so capture what the real function emits instead of asserting on a stub screen
    let dlg = '';
    const prevInsert = app.doc.body.insertAdjacentHTML;
    app.doc.body.insertAdjacentHTML = (pos, html) => { dlg += String(html); };
    try { app.sandbox.openMobileLanguageMenu(); } finally { app.doc.body.insertAdjacentHTML = prevInsert; }
    ok(/data-qa="mobile-language-menu"/.test(dlg), 'LANG1 (render): tapping it opens the chooser in place');
    for (const loc of ['ru', 'en', 'tl', 'hi', 'id']) ok(dlg.includes('data-qa="mobile-language-option-' + loc + '"'), 'LANG1 (render): the chooser offers ' + loc);
    ok(!/openSettings\(/.test(dlg), 'LANG1 (render): and it does NOT push the user into Settings to change the language');
  }
  // negatives
  const noTile = HTML.replace(/\+mobileMenuIconTile\('mobile-menu-language'[\s\S]*?currentUiLangLabel\(\)\)\n/, '');
  ok(noTile !== HTML, 'the negative mutation really removed the tile');
  ok(!/mobile-menu-language/.test(noTile.slice(noTile.indexOf('function renderMobileMenu(){'), noTile.indexOf('function currentUiLangLabel('))),
    'NEGATIVE: removing the language control from the Menu screen turns this drill red (that is bug B6 coming back)');
  const noSub = HTML.replace("          currentUiLangLabel())", '          )');
  ok(!/currentUiLangLabel\(\)/.test(noSub.slice(noSub.indexOf('function renderMobileMenu(){'), noSub.indexOf('function currentUiLangLabel('))),
    'NEGATIVE: dropping the current-language sub-label turns it red too — an icon that does not show its state is not a fix');
}


// ===========================================================================
// DEL1–DEL5 — «Delete my Skipi account», the App Store 5.1.1(v) requirement.
//
// Guideline 5.1.1(v): an app that lets a user CREATE an account must let the
// same user DELETE it, and the whole path must be completable INSIDE the app.
// Skipi Seafarer shows a Register door on its first screen, so the rule binds
// the shipping build. Before this slice `delete account` had ZERO occurrences
// in dist/** and src-tauri/src/**.
//
// What the five drills defend, and why each one is here rather than in a
// reviewer's rejection letter:
//   DEL1 the path EXISTS and is reachable in the settings shell the gear
//        really opens — desktop AND mobile — not only on the legacy tab;
//   DEL2 deleting the ACCOUNT never deletes local files or the vault (they
//        are different acts, and the user is told so);
//   DEL3 the confirmation screen says all four true things and promises no
//        deadline the server did not name (rule (324));
//   DEL4 no step of the path leaves the app for a browser;
//   DEL5 the command behaves against the agreed server contract — the three
//        failure codes leave the account alone and SAY so, and the app never
//        invents a completion date.
// ===========================================================================
const AD_SETTLE = async () => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
};
// The delete path's own source, sliced out of index.html by its two comment
// fences, so DEL4 reads exactly the code that runs and nothing around it.
const AD_START = '// ========== Delete Skipi account';
const AD_END = '// ========== Entry fork';
const AD_SRC = HTML.slice(HTML.indexOf(AD_START), HTML.indexOf(AD_END));
// Mount the REAL @skipi/settings shell and open the account section in a chosen
// mode. `create(host, {mode})` is the module's own entry; the host is the one the
// app's adapter built, captured off SkipiSettings.mount during a real
// openUnifiedSettings() — so this is the production host object, not a fixture.
async function adUnifiedHost(app) {
  let captured = null;
  const realMount = app.sandbox.SkipiSettings.mount;
  app.sandbox.SkipiSettings.mount = function (sel, host, opts) {
    captured = { host, opts };
    return realMount.call(this, sel, host, opts);
  };
  app.sandbox.openUnifiedSettings();
  await AD_SETTLE();
  return captured;
}
async function adSectionHtml(app, host, mode) {
  const inst = app.sandbox.SkipiSettings.create(host, { mode });
  inst.mount('#settings-root');
  await AD_SETTLE();
  inst.open('skipi-account');
  await AD_SETTLE();
  const html = String((app.doc.getElementById('settings-root') || {}).innerHTML || '');
  inst.unmount();
  return html;
}

{
  section('DEL1 — Settings really offers «delete my account», in the shell the gear opens, on desktop AND on mobile');
  // The gear (#ri-set, #mb-gear, app-header-settings) calls openSettings(), which the
  // adoption script reroutes to the unified @skipi/settings shell. Putting the delete
  // entry only on the legacy About tab would ship a path nobody — including the
  // reviewer — can reach, so the section is asserted in the REAL shell, both layouts.
  const app = bootApp({ withSettings: true });
  await AD_SETTLE();
  const cap = await adUnifiedHost(app);
  ok(!!cap, 'the gear entry mounted the unified settings shell (host captured)');
  const ids = ((cap && cap.host && cap.host.appSpecificSections) || []).map((s) => s && s.id);
  ok(ids.indexOf('skipi-account') >= 0, 'the adapter registers a «Skipi account» section (got ' + JSON.stringify(ids) + ')');
  for (const mode of ['desktop', 'mobile']) {
    const h = await adSectionHtml(app, cap.host, mode);
    ok(h.includes('data-qa="settings-account"'), 'DEL1 (' + mode + '): the account section renders');
    ok(h.includes('data-qa="account-delete-open"'), 'DEL1 (' + mode + '): and it carries the delete entry');
    ok(/onclick="openAccountDelete\(\)"/.test(h), 'DEL1 (' + mode + '): which opens the in-app confirmation screen');
  }
  // The legacy About tab (the adapter's fail-closed fallback) carries the SAME block,
  // so a user who lands there is not left without a way to delete the account.
  app.sandbox.settingsTab = 'about';
  app.sandbox.renderSettingsBody();
  const legacy = String((app.doc.getElementById('settings-body') || {}).innerHTML || '');
  ok(legacy.includes('data-qa="settings-account"') && legacy.includes('data-qa="account-delete-open"'),
    'DEL1 (legacy fallback tab): the same account block is on the About tab');
  ok(/\['vaults','seafarer','appearance','about'\]/.test(HTML),
    'and «about» is one of the four tabs the MOBILE legacy nav offers, so the fallback is reachable on a phone too');
  // negatives
  const noSection = HTML.replace('appSpecificSections: [ seafarerSection(), accountSection() ],', 'appSpecificSections: [ seafarerSection() ],');
  ok(noSection !== HTML, 'the negative mutation really unregistered the section');
  ok(!/accountSection\(\)\s*\]/.test(noSection),
    'NEGATIVE: dropping the account section from the unified adapter turns DEL1 red — that is 5.1.1(v) coming back');
  const noLegacy = HTML.replace('        h += accountDeleteSectionHtml();\n', '');
  ok(noLegacy !== HTML && !/h \+= accountDeleteSectionHtml\(\);/.test(noLegacy),
    'NEGATIVE: dropping it from the legacy About tab turns the fallback half red as well');
  const noButton = AD_SRC.replace('data-qa="account-delete-open"', 'data-qa="account-something-else"');
  ok(!/data-qa="account-delete-open"/.test(noButton),
    'NEGATIVE: renaming the delete entry hook turns the render assertions red');
}

{
  section('DEL2 — deleting the ACCOUNT never deletes anything on this device');
  // PRESERVE line of the task card. The account lives on assistant.skipi.app; the
  // vault, the documents and their files live on the phone. Wiring the two together
  // «while we are at it» would destroy a seafarer's only copy of his certificates on
  // a mistap, so the Rust command is forbidden from touching the filesystem or the
  // vault lifecycle — checked on the real bytes of the command's own file.
  const FORBIDDEN = [
    ['remove_file', /\bremove_file\b/],
    ['remove_dir / remove_dir_all', /\bremove_dir(_all)?\b/],
    ['close_vault', /\bclose_vault\b/],
    ['forget', /\bforget\b/],
    ['std::fs', /\bstd::fs::/],
    ['fs::remove', /\bfs::remove/],
    ['delete_document / delete_package', /\bdelete_(document|package|work_file|vault)\b/],
  ];
  for (const [label, re] of FORBIDDEN) {
    ok(!re.test(ACCOUNT_DELETE_RS), 'account_delete.rs contains no «' + label + '» call');
  }
  ok(/fn delete_account\(/.test(ACCOUNT_DELETE_RS), 'and the file really is the delete_account command (the scan is not vacuous)');
  ok(/set_vault_info\(conn, key, ""\)/.test(ACCOUNT_DELETE_RS),
    'the ONLY local write is clearing the login session keys — the same three keys app_logout clears');
  ok(/USER_TOKEN_KEY[\s\S]{0,120}USER_EMAIL_KEY[\s\S]{0,120}USER_LOGIN_AT_KEY/.test(ACCOUNT_DELETE_RS),
    'and it is exactly those three keys, named, not a loop over the whole vault_info table');
  ok(/account_delete::delete_account/.test(LIB_RS) && /mod account_delete;/.test(LIB_RS),
    'the command is registered in lib.rs, so the button is wired to real code');
  // negatives — one per forbidden call site, on real mutated bytes
  for (const [label, re] of FORBIDDEN) {
    const injected = ACCOUNT_DELETE_RS.replace(
      'Ok(result)',
      'std::fs::remove_file("x").ok(); std::fs::remove_dir_all("y").ok(); close_vault(); forget(); delete_document("d"); fs::remove_dir("z");\n    Ok(result)'
    );
    ok(injected !== ACCOUNT_DELETE_RS && re.test(injected),
      'NEGATIVE: a local-deletion call added to account_delete.rs turns DEL2 red («' + label + '»)');
  }
  const noCommand = ACCOUNT_DELETE_RS.replace('fn delete_account(', 'fn something_else(');
  ok(!/fn delete_account\(/.test(noCommand),
    'NEGATIVE: and the scan is anchored to the real command — renaming it away is red, not silently green');
}

{
  section('DEL3 — the confirmation screen tells the truth, in both languages, and promises no date the server did not give');
  const app = bootApp({});
  await AD_SETTLE();
  const screens = {};
  for (const lang of ['en', 'ru']) {
    app.sandbox.localStorage.setItem(app.sandbox.UI_LANG_KEY, lang);
    screens[lang] = String(app.sandbox.accountDeleteConfirmHtml());
  }
  // (1) irreversible, and it is the FIRST thing said
  ok(/Deletion is permanent\. Once you confirm it, neither you nor we can bring the account back\./.test(screens.en),
    'EN: the screen opens by saying the deletion is permanent and nobody can undo it');
  ok(/Удаление необратимо: после подтверждения восстановить аккаунт не сможем ни мы, ни вы\./.test(screens.ru),
    'RU: the agreed Russian sentence, verbatim');
  // (2) sign-in stops working everywhere: devices, sessions and tokens
  ok(/all devices, sessions and access tokens/.test(screens.en) && /все устройства, сессии и токены доступа/.test(screens.ru),
    'both: every device, session and access token goes — the account stops working everywhere');
  // (3) the cloud profile goes
  ok(/profile and seafarer questionnaire/.test(screens.en) && /профиль и анкета моряка/.test(screens.ru),
    'both: the synced profile and questionnaire are named as deleted');
  // (4) …and the ONE thing that survives is named, with the reason
  ok(/history of what you paid/.test(screens.en) && /история платежей/.test(screens.ru),
    'both: the one surviving record is named rather than quietly kept');
  ok(/anonymised/.test(screens.en) && /обезличивается/.test(screens.ru),
    'both: and it is stated to be anonymised — no name, no address, no way back to the user');
  // (5) THE separate, visible line: nothing on this device is touched
  for (const lang of ['en', 'ru']) {
    ok(/data-qa="account-delete-local-note"/.test(screens[lang]),
      lang + ': the local-data promise is its OWN block, not a clause inside the wall of text');
    ok(/font-weight:700/.test(screens[lang].slice(screens[lang].indexOf('account-delete-local-note'), screens[lang].indexOf('account-delete-local-note') + 260)),
      lang + ': and it is set in bold — the card says «не мелкий шрифт», so this is checked, not assumed');
  }
  ok(/The documents and the safe on this device stay\./.test(screens.en),
    'EN: the documents and the safe on this device stay — the user deletes those himself');
  ok(/Документы и сейф на этом устройстве остаются\./.test(screens.ru),
    'RU: the same promise, in Russian');
  // (6) confirmation is required, and it is a password field
  ok(/id="account-delete-password"/.test(screens.en) && /type="password"/.test(screens.en),
    'the screen asks for the account password before anything happens');
  ok(/data-qa="account-delete-cancel"/.test(screens.en) && /data-qa="account-delete-confirm"/.test(screens.en),
    'and it offers both a Cancel and an explicit destructive confirm');
  // (7) NO promised deadline anywhere on the screen
  const TIMING = [/\bwithin\s+\d/i, /\b\d+\s*(?:days?|hours?|weeks?|months?)\b/i, /в течение\s+\d/i, /\b\d+\s*(?:дн|час|недел|месяц)/i];
  for (const lang of ['en', 'ru']) {
    for (const re of TIMING) {
      ok(!re.test(screens[lang]), lang + ': the screen promises no deadline of its own (' + re + ')');
    }
  }
  ok(/completes_at\?String\(res\.completes_at\):''/.test(AD_SRC.replace(/\s+/g, '')) || /res&&res\.completes_at/.test(AD_SRC),
    'a completion moment is shown ONLY when the server itself returned completes_at (rule (324))');
  // negatives
  const noNote = screens.ru.replace(/<div data-qa="account-delete-local-note"[\s\S]*?<\/div>/, '');
  ok(!/account-delete-local-note/.test(noNote),
    'NEGATIVE: deleting the «your documents stay on this device» block turns DEL3 red');
  const withDeadline = screens.en.replace('Deletion is permanent.', 'Deletion is permanent and completes within 30 days.');
  ok(TIMING.some((re) => re.test(withDeadline)),
    'NEGATIVE: writing «within 30 days» into the screen turns the no-deadline half red');
  const shortened = screens.ru.replace(/переписка с ассистентом[^;]*;\s*/, '');
  ok(!/переписка с ассистентом/.test(shortened),
    'NEGATIVE: quietly dropping an item from the list of what disappears is red too — the list is the disclosure');
}

{
  section('DEL4 — the whole path is completable inside the app: no browser, no link, no external URL');
  // This is the entire reason the slice exists. A «delete your account» that hands the
  // seafarer a web address is the rejection, not the fix — and the app already has
  // openExternalUrlSafe() one screen away (Register uses it), so the mistake is a
  // single line away at all times.
  const EXTERNAL = [
    ['openExternalUrlSafe', /openExternalUrlSafe\s*\(/],
    ['open_external_url', /open_external_url/],
    ['window.open', /window\.open\s*\(/],
    ['location assignment', /location\.(?:href|assign|replace)\s*[=(]/],
    ['an http(s) address', /https?:\/\//],
    ['an anchor tag', /<a\s/i],
  ];
  for (const [label, re] of EXTERNAL) {
    ok(!re.test(AD_SRC), 'the delete path source contains no ' + label);
  }
  ok(/invoke\('delete_account'/.test(AD_SRC), 'it goes through the native command instead (the scan is not vacuous)');
  const app = bootApp({});
  await AD_SETTLE();
  const screen = String(app.sandbox.accountDeleteConfirmHtml());
  for (const [label, re] of EXTERNAL) {
    ok(!re.test(screen), 'and the rendered confirmation screen contains no ' + label);
  }
  ok(/openExternalUrlSafe/.test(HTML), 'index.html DOES have the external-URL helper elsewhere — this path just refuses to use it');
  // negatives
  const viaBrowser = AD_SRC.replace("invoke('delete_account',{password:pw})", "openExternalUrlSafe('https://assistant.skipi.app/app/account/delete')");
  ok(viaBrowser !== AD_SRC && /openExternalUrlSafe\s*\(/.test(viaBrowser) && /https?:\/\//.test(viaBrowser),
    'NEGATIVE: replacing the native call with a trip to the browser turns DEL4 red');
  const withLink = screen.replace('</h3>', '</h3><a href="https://assistant.skipi.app/account">Delete on the website</a>');
  ok(EXTERNAL.some(([, re]) => re.test(withLink)),
    'NEGATIVE: and so does slipping a «do it on the website» link onto the screen');
}

{
  section('DEL5 — the flow against the agreed server contract: three failures leave the account alone and say so, one success ends signed out');
  const runFlow = async ({ reply, password }) => {
    const app = bootApp({ invokeOverride: async (cmd) => (cmd === 'delete_account' ? reply() : undefined) });
    await AD_SETTLE();
    // Materialise the ids the flow talks to (the fake DOM has no HTML parser).
    const made = {};
    for (const id of ['account-delete-overlay', 'account-delete-password', 'account-delete-error', 'account-delete-confirm']) {
      const el = app.doc.createElement('div');
      el.setAttribute('id', id);
      made[id] = el;
    }
    let inserted = '';
    app.doc.body.insertAdjacentHTML = (pos, h) => { inserted += String(h); };
    const toasts = [];
    app.sandbox.showToast = (m, t) => toasts.push(String(m) + ' [' + String(t) + ']');
    app.sandbox.openAccountDelete();
    made['account-delete-password'].value = password;
    await app.sandbox.confirmAccountDelete();
    await AD_SETTLE();
    return { app, made, inserted, toasts, calls: app.invokeCalls };
  };
  const errText = (r) => String(made0(r).textContent || '');
  const made0 = (r) => r.made['account-delete-error'];

  // the screen really is built by openAccountDelete(), not conjured by the drill
  const empty = await runFlow({ reply: () => ({ deleted: true, completes_at: null }), password: '' });
  ok(empty.inserted.includes('data-qa="account-delete-screen"'), 'openAccountDelete() inserts the confirmation screen into the app itself');
  ok(/Enter your password/i.test(errText(empty)), 'an empty password is refused on the screen, without a round-trip');
  ok(!empty.calls.some(([c]) => c === 'delete_account'), 'and nothing is sent to the server');

  for (const [code, marker] of [[403, /Wrong password/], [429, /Too many attempts/], [401, /expired|revoked/i]]) {
    const failed = await runFlow({
      reply: () => { throw new Error(({
        403: 'Wrong password — the account was NOT deleted. Check the password you use to sign in to Skipi.',
        429: 'Too many attempts — the account was NOT deleted. Wait 15 minutes and try again.',
        401: 'Your sign-in has expired or was revoked. Sign in again, then repeat the deletion.',
      })[code]); },
      password: 'whatever',
    });
    ok(marker.test(errText(failed)), 'HTTP ' + code + ': the reason is shown on the screen (' + marker + ')');
    ok(!failed.calls.some(([c]) => c === 'app_logout'), 'HTTP ' + code + ': and the user is NOT signed out — nothing was deleted');
    ok(failed.toasts.length === 0, 'HTTP ' + code + ': no success toast is shown for a failure');
  }

  const okNull = await runFlow({ reply: () => ({ deleted: true, completes_at: null }), password: 'correct-horse' });
  ok(okNull.calls.some(([c, a]) => c === 'delete_account' && a && a.password === 'correct-horse'), 'the typed password is what reaches the command');
  ok(okNull.toasts.some((t) => /has been deleted/.test(t)), 'success says the account is deleted');
  ok(!okNull.toasts.some((t) => /\d{4}-\d{2}-\d{2}|within|\bdays?\b/i.test(t)),
    'and with completes_at:null it names NO moment at all (rule (324))');
  ok(okNull.calls.some(([c]) => c === 'app_logout'), 'success ends the session — the app returns to its own login gate, in the app');

  const okDated = await runFlow({ reply: () => ({ deleted: true, completes_at: '2026-10-07T00:00:00Z' }), password: 'correct-horse' });
  ok(okDated.toasts.some((t) => t.includes('2026-10-07T00:00:00Z')),
    'and when the SERVER names a completion moment, that moment — the server\'s, not ours — is shown');
  // negative
  const alwaysGreen = AD_SRC.replace("var when=(res&&res.completes_at)?String(res.completes_at):'';", "var when='in 30 days';");
  ok(alwaysGreen !== AD_SRC && /in 30 days/.test(alwaysGreen),
    'NEGATIVE: inventing a deadline in the success toast is a real, catchable mutation of these bytes');
}

{
  section('remote install + offline persistence harness');
  await runRemoteInstallOfflineHarness();
}

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

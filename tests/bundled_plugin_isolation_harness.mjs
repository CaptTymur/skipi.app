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

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

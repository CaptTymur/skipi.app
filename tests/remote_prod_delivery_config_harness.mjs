#!/usr/bin/env node
/* B5 production remote plugin delivery config harness.
   Read-only: validates the shipped Seafarer config against the live signed
   production catalog without mutating repo, catalog, release, or user state. */
'use strict';

import fs from 'node:fs';
import https from 'node:https';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CONFIG_FILE = `${ROOT}/dist/plugin-host-config.js`;
const BOOT_FILE = `${ROOT}/dist/plugin-remote-boot.js`;
const CATALOG_URL = 'https://api.skipi.app/seafarer/releases/plugins/v1/catalog.json';
// The three plugins that also ship BUNDLED. Since 24.11.2026 the route set is the signed
// catalog itself (remoteSlugs '*'), so the live catalog may grow; these three must stay in it.
const BUNDLED_SLUGS = ['bnwas-time-anchor', 'navigation-calculators', 'ecdis-position-reminder'];
const LOADER_FILE = `${ROOT}/dist/plugin-loader.js`;
const EXPECTED_VERSION = '0.4.203';
const EXPECTED_FINGERPRINT = '28e1987f3a533e56f431a4777ac5da9e5797770c552786df3147264d6a3df5d4';

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`OK ${msg}`);
  else { failures += 1; console.error(`FAIL ${msg}`); }
}

function runConfig(localStorageValue) {
  const code = fs.readFileSync(CONFIG_FILE, 'utf8');
  const ctx = { console, window: {} };
  ctx.window.window = ctx.window;
  if (localStorageValue !== undefined) {
    ctx.localStorage = { getItem: (k) => k === 'skipi.remotePluginDelivery' ? localStorageValue : null };
  }
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: CONFIG_FILE });
  return ctx.window;
}

function sortedPublicJwk(jwk) {
  return { crv: jwk.crv, kid: jwk.kid, kty: jwk.kty, x: jwk.x, y: jwk.y };
}

function publicFingerprint(jwk) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedPublicJwk(jwk))).digest('hex');
}

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function semverGte(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function verifySignature(entry, publicJwk) {
  const noSig = {};
  Object.keys(entry).forEach((k) => {
    if (k !== 'signature') noSig[k] = entry[k];
  });
  return crypto.verify(
    'sha256',
    Buffer.from(canonical(noSig), 'utf8'),
    { key: crypto.createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(entry.signature || '', 'base64')
  );
}

function testOffOverrideFailClosed() {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  // SKI No.380 (2026-11-05): the interception moved from window.pluginMountInto to
  // window.SkipiPluginHost.mount, because the product mounts through the module's
  // CLOSURE-local pluginMountInto and never through the global. This drill therefore
  // watches the seam that is really patched. The previous fixture guarded the global —
  // a seam the product never calls, so it could not have observed a patch either way.
  const origMount = function () { throw new Error('boot must not reach the host mount when the flag is off'); };
  const ctx = {
    console,
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: false,
      SKIPI_REMOTE_CONFIG: {},
      SkipiPluginHost: { mount: origMount, unmount() {} }
    }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  ok(!ctx.window.SkipiRemoteRuntime, 'flag OFF path does not create remote runtime');
  ok(!ctx.window.SkipiRemoteList, 'flag OFF path does not create remote catalog list helper');
  ok(ctx.window.SkipiPluginHost.mount === origMount, 'flag OFF leaves the host mount seam UNPATCHED (identity, not behaviour)');
}

// New mechanism, new drill: the dependency gate now requires the seam it actually patches.
// Without it the boot must stay inert instead of half-installing.
function testGateRequiresHostMountSeam() {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  const ctx = {
    console,
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: true,
      SKIPI_REMOTE_CONFIG: { remoteSlugs: [] },
      SkipiPluginLoader: { create: () => ({ getCatalog: () => Promise.resolve({ source: 'network', catalog: {} }) }) },
      SkipiPluginRuntime: { create: () => ({ open() {}, close() {} }) },
      SkipiPluginHost: { unmount() {} } // the mount seam is ABSENT
    },
    document: { getElementById: () => ({ innerHTML: '' }) }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  ok(!ctx.window.SkipiRemoteInstall, 'host without .mount keeps remote delivery inert (dependency gate)');
  ok(!ctx.window.SkipiRemoteRuntime, 'inert gate constructs no remote runtime');
}

async function testCentralCatalogKillSwitchFallsBackBundled() {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  const SLUG = 'navigation-calculators';
  const VER = '0.2.1';
  let bundledMounts = 0;
  let runtimeOpens = 0;
  // Seeded registry + verified skpd.* cache. WITHOUT them the boot takes its
  // «no remote record» early return, and this drill used to assert the kill-switch
  // routing while never reaching the kill-switch branch at all (measured 2026-11-05,
  // SKI No.380): the record is what makes the slug a remote one in the first place.
  const entry = { slug: SLUG, id: 'app.skipi.plugins.' + SLUG, name: 'Navigation Calculators', version: VER };
  const store = new Map([
    ['skipi_remote_plugins_state', JSON.stringify({ [SLUG]: { installed: true, enabled: true, slug: SLUG, id: entry.id, name: entry.name, version: VER, entry } })],
    ['skpd.entry:' + SLUG, JSON.stringify(entry)],
    ['skpd.pack:' + SLUG + '@' + VER, JSON.stringify({ slug: SLUG, version: VER })]
  ]);
  const el = { innerHTML: '' };
  const origMount = (id) => { bundledMounts += 1; return Promise.resolve({ ok: true }); };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: true,
      SKIPI_REMOTE_CONFIG: {
        catalogUrl: 'https://unit.test/catalog.json',
        remoteSlugs: [SLUG],
        host: { id: 'seafarer', version: EXPECTED_VERSION },
        policy: {},
        pinnedPublicKeys: { 'skipi-firstparty-prod-v1': { kid: 'skipi-firstparty-prod-v1' } },
        pinnedPublicKey: { kid: 'skipi-firstparty-prod-v1' }
      },
      SkipiPluginLoader: {
        create: () => ({
          getCatalog: () => Promise.resolve({
            source: 'network',
            catalog: { schema: 'skipi-catalog/1', keyId: 'skipi-firstparty-prod-v1', delivery_enabled: false, plugins: [] }
          }),
          install: () => { throw new Error('central kill-switch must prevent install'); }
        })
      },
      SkipiPluginRuntime: {
        create: () => ({
          open: () => { runtimeOpens += 1; return Promise.resolve({ ok: true }); },
          close: () => {}
        })
      },
      SkipiPluginHost: { mount: origMount, unmount() {} }
    },
    document: { getElementById: () => el }
  };
  ctx.window.window = ctx.window;
  ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  await Promise.resolve();
  await Promise.resolve();
  ok(ctx.window.SkipiRemoteDeliveryStatus().enabled === false, 'central catalog delivery_enabled=false is observed');
  const list = await ctx.window.SkipiRemoteList();
  ok(Array.isArray(list) && list.length === 0, 'central kill-switch hides remote catalog list');
  ok(ctx.window.SkipiPluginHost.mount !== origMount, 'boot patched the host mount seam (the seam the product really calls)');

  // (a) an INSTALLED remote slug under the kill switch: the branch this drill is named for
  await ctx.window.SkipiPluginHost.mount(SLUG, el);
  await Promise.resolve();
  ok(bundledMounts === 1, 'central kill-switch routes an INSTALLED remote slug back to the bundled mount');
  ok(runtimeOpens === 0, 'central kill-switch prevents remote runtime open');

  // (b) a slug with no remote record at all still goes bundled (the pre-existing path)
  store.delete('skipi_remote_plugins_state');
  await ctx.window.SkipiPluginHost.mount(SLUG, el);
  await Promise.resolve();
  ok(bundledMounts === 2, 'a slug without a remote record goes bundled as before');
  ok(runtimeOpens === 0, 'and still never opens the remote runtime');
}

// The REAL loader, a throwaway signing key, a fake catalog: what the policy step lets through.
async function testNetworkPolicy(cfg) {
  const { subtle } = crypto.webcrypto;
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', kp.publicKey); pub.kid = 'unit-key';
  const ctx = { window: {}, TextEncoder, URL, atob, crypto: crypto.webcrypto, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(LOADER_FILE, 'utf8'), ctx, { filename: LOADER_FILE });
  const L = ctx.window.SkipiPluginLoader;
  const sha = (str) => crypto.createHash('sha256').update(str).digest('hex');
  async function verdict(permissions, capabilities, policy) {
    const pack = JSON.stringify({ id: 'app.x', slug: 'x', version: '1.0.0', files: { 'index.js': '', 'index.css': '' } });
    const entry = { id: 'app.x', slug: 'x', version: '1.0.0', packUrl: 'packs/x.json', sha256: sha(pack),
      compat: { host: ['seafarer'], minHostVersion: '0.1.0' }, permissions, capabilities };
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(L.canonical(entry)));
    entry.signature = Buffer.from(sig).toString('base64');
    const catalog = JSON.stringify({ keyId: 'unit-key', plugins: [entry] });
    const mem = new Map();
    const loader = L.create({
      catalogUrl: 'https://unit.test/v1/catalog.json', host: { id: 'seafarer', version: '0.4.199' }, policy: policy || cfg.policy,
      pinnedPublicKeys: { 'unit-key': pub },
      cache: { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k), keys: () => [...mem.keys()] },
      fetch: (url) => Promise.resolve(/catalog\.json$/.test(url) ? catalog : pack),
    });
    return loader.install('x');
  }
  const BASE = { documents: 'none', account: 'none', analytics: 'none', server_upload: false };
  const net = (allow) => Object.assign({}, BASE, { network: { allow } });
  const API = 'https://api.skipi.app/draft-survey/v1/';

  let r = await verdict(['local_storage'], Object.assign({}, BASE, { network: 'none' }));
  ok(r.ok === true, 'NET: an offline plugin (network "none") still installs — the three live plugins are unaffected');
  r = await verdict(['local_storage', 'network'], net([API]));
  ok(r.ok === true, 'NET: network permission + an https allowlist on api.skipi.app installs');
  r = await verdict(['network'], Object.assign({}, BASE, { network: 'none' }));
  ok(r.ok === false && r.stage === 'policy', 'NET: the network permission without an allowlist is rejected');
  r = await verdict(['local_storage'], net([API]));
  ok(r.ok === false && r.stage === 'policy', 'NET: an allowlist without the network permission is rejected');
  for (const [bad, why] of [
    [['https://evil.example/x/'], 'another origin'],
    [['http://api.skipi.app/draft-survey/v1/'], 'plain http'],
    [['https://api.skipi.app.evil.example/'], 'a look-alike origin'],
    [['https://api.skipi.app:8444/'], 'another port'],
    [['https://user:pw@api.skipi.app/'], 'userinfo'],
    [['https://api.skipi.app/x?y=1'], 'a query string'],
    [[API, 'https://evil.example/'], 'one bad entry among good ones'],
    [[], 'an empty list'],
    ['https://api.skipi.app/', 'a string instead of a list'],
  ]) {
    r = await verdict(['network'], net(bad));
    ok(r.ok === false && r.stage === 'policy', 'NET: rejected — ' + why);
  }
  r = await verdict(['network'], net([API]), Object.assign({}, cfg.policy, { networkOrigins: undefined }));
  ok(r.ok === false && r.stage === 'policy', 'NET: a host policy without networkOrigins allows no network at all');
  r = await verdict(['local_storage', 'file_save'], Object.assign({}, BASE, { network: 'none' }));
  ok(r.ok === false && r.stage === 'policy', 'NET: a permission outside maxPermissions (file_save) is still rejected');
  r = await verdict(['local_storage', 'motion', 'keep_awake'], Object.assign({}, BASE, { network: 'none' }));
  ok(r.ok === true, 'MOTION: a plugin asking for motion + keep_awake (the Clinometer) installs');
  r = await verdict(['local_storage'], Object.assign({}, BASE, { network: 'none', documents: 'read' }));
  ok(r.ok === false && r.stage === 'policy', 'NET: documents access is still rejected');
}

// The runtime must be handed the grants of the SIGNED ENTRY, not whatever the pack says of itself.
async function testRuntimeGrantsComeFromSignedEntry() {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  let runtimeCfg = null;
  const entry = { slug: 'x', permissions: ['local_storage', 'network'], capabilities: { network: { allow: ['https://api.skipi.app/draft-survey/v1/'] } } };
  const greedyPack = { files: { 'index.js': '' }, permissions: ['local_storage', 'network', 'file_save'], network: { allow: ['https://evil.example/'] } };
  let installResult = { ok: true, entry, pack: greedyPack, source: 'network/network' };
  const store = new Map();
  const ctx = {
    console: { info() {}, warn() {} }, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: true,
      SKIPI_REMOTE_CONFIG: { catalogUrl: 'https://unit.test/catalog.json', remoteSlugs: '*', host: { id: 'seafarer', version: '0.4.199' }, policy: {}, pinnedPublicKeys: {}, pinnedPublicKey: {} },
      SkipiPluginLoader: { create: () => ({ getCatalog: () => Promise.resolve({ source: 'network', catalog: { plugins: [] } }), install: () => Promise.resolve(installResult) }) },
      SkipiPluginRuntime: { create: (c) => { runtimeCfg = c; return { open: () => Promise.resolve({ ok: true }), close() {} }; } },
      SkipiPluginHost: { mount: () => Promise.resolve({ ok: true }), unmount() {} },
    },
    document: { getElementById: () => ({ innerHTML: '' }) },
  };
  ctx.window.window = ctx.window; ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  ok(!!runtimeCfg && runtimeCfg.host && typeof runtimeCfg.host.net === 'object' && typeof runtimeCfg.host.net.fetch !== 'function',
    'GRANT: the home opts into plugin network with the runtime\'s own safe transport (no custom fetch)');
  ok(!runtimeCfg.host.files, 'GRANT: files are NOT opted in yet (no adapter in this home)');
  const r = await runtimeCfg.loader.install('x');
  ok(r.ok && JSON.stringify(r.pack.permissions) === JSON.stringify(['local_storage', 'network']), 'GRANT: permissions handed to the runtime are the signed entry\'s, not the pack\'s own (file_save dropped)');
  ok(JSON.stringify(r.pack.network) === JSON.stringify({ allow: ['https://api.skipi.app/draft-survey/v1/'] }), 'GRANT: the network allowlist is the signed entry\'s, not the pack\'s own (evil.example dropped)');
  ok(greedyPack.permissions.length === 3 && greedyPack.network.allow[0] === 'https://evil.example/', 'GRANT: the cached pack object itself is not mutated');
  installResult = { ok: true, entry: { slug: 'y', permissions: ['local_storage'], capabilities: { network: 'none' } }, pack: { files: {}, permissions: ['local_storage', 'network'], network: { allow: ['https://api.skipi.app/'] } }, source: 'x' };
  const r2 = await runtimeCfg.loader.install('y');
  ok(r2.ok && !r2.pack.network && r2.pack.permissions.indexOf('network') < 0, 'GRANT: an entry without network yields no network grant, whatever the pack claims');
  installResult = { ok: false, stage: 'integrity', reason: 'sha256 mismatch' };
  const r3 = await runtimeCfg.loader.install('x');
  ok(r3.ok === false && r3.stage === 'integrity', 'GRANT: a failed verification passes through untouched (fail-closed)');
}


// Owner 25.11.2026: the Clinometer runs on the phone's sensors and is for phones only. The plugin
// frame cannot read sensors, so the home serves them (runtime 1.2 host.motion / host.screen) from
// the native commands; a catalog entry with compat.platforms is offered only on those platforms.
async function testMotionAdapterAndPhoneOnlyPlugins() {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  const phoneOnly = { slug: 'marine-clinometer', compat: { host: ['seafarer'], platforms: ['android', 'ios'] } };
  const everywhere = { slug: 'navigation-calculators', compat: { host: ['seafarer'] } };
  function boot(userAgent, native) {
    let runtimeCfg = null; const installs = []; const timers = new Map(); let nextTimer = 0;
    const store = new Map();
    const ctx = {
      console: { info() {}, warn() {} }, setTimeout, clearTimeout,
      setInterval: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
      clearInterval: (id) => { timers.delete(id); },
      navigator: { userAgent },
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      window: {
        FEATURE_REMOTE_PLUGIN_DELIVERY: true,
        SKIPI_REMOTE_CONFIG: { catalogUrl: 'https://unit.test/catalog.json', remoteSlugs: '*', host: { id: 'seafarer', version: '0.4.203' }, policy: {}, pinnedPublicKeys: {}, pinnedPublicKey: {} },
        SkipiPluginLoader: { create: () => ({
          getCatalog: () => Promise.resolve({ source: 'network', catalog: { plugins: [phoneOnly, everywhere] } }),
          install: (slug) => { installs.push(slug); return Promise.resolve({ ok: true, entry: slug === phoneOnly.slug ? phoneOnly : everywhere, pack: { files: {} } }); },
        }) },
        SkipiPluginRuntime: { create: (c) => { runtimeCfg = c; return { open: () => Promise.resolve({ ok: true }), close() {} }; } },
        SkipiPluginHost: { mount: () => Promise.resolve({ ok: true }), unmount() {} },
        __TAURI__: native ? { core: { invoke: native } } : undefined,
      },
      document: { getElementById: () => ({ innerHTML: '' }) },
    };
    ctx.window.window = ctx.window; ctx.window.localStorage = ctx.localStorage;
    store.set('skipi_plugins_unbundled_v1', JSON.stringify({ pending: [] }));
    vm.createContext(ctx);
    vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
    return { win: ctx.window, host: runtimeCfg.host, installs, timers, tickAll: () => [...timers.values()].forEach((fn) => fn()) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36', IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15';

  // ---- phones only ----
  for (const [ua, name] of [[ANDROID, 'Android'], [IPHONE, 'iPhone']]) {
    const b = boot(ua);
    const list = await b.win.SkipiRemoteList();
    ok(list.length === 2 && list.some((e) => e.slug === phoneOnly.slug), 'PHONE: on ' + name + ' a phones-only plugin is offered in the catalog');
    const r = await b.win.SkipiRemoteInstall(phoneOnly.slug, { allowNetwork: true });
    ok(r && r.ok === true && b.installs.includes(phoneOnly.slug), 'PHONE: on ' + name + ' it installs');
  }
  {
    const b = boot(LINUX);
    const list = await b.win.SkipiRemoteList();
    ok(list.length === 1 && list[0].slug === everywhere.slug, 'PHONE: on desktop a phones-only plugin is not offered; plugins without compat.platforms are unaffected');
    const r = await b.win.SkipiRemoteInstall(phoneOnly.slug, { allowNetwork: true });
    ok(r && r.ok === false && r.stage === 'platform' && b.installs.length === 0, 'PHONE: on desktop it is not installed either (the loader is never asked)');
    const r2 = await b.win.SkipiRemoteInstall(everywhere.slug, { allowNetwork: true });
    ok(r2 && r2.ok === true, 'PHONE: other plugins still install on desktop');
  }

  // ---- motion + keep-awake adapters ----
  {
    const calls = []; let rows = [[1000, 0, 0, 9.81, 0, 0, 0]];
    const native = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'plugin_motion_start') return Promise.resolve({ ok: true, rateHz: 50, source: 'android-sensor-manager', platform: 'android', gyro: true });
      if (cmd === 'plugin_motion_drain') return Promise.resolve(rows);
      return Promise.resolve(null);
    };
    const b = boot(ANDROID, native);
    ok(b.host.motion && typeof b.host.motion.start === 'function' && typeof b.host.motion.stop === 'function' && b.host.screen && typeof b.host.screen.keepAwake === 'function',
      'MOTION: the home opts into host.motion and host.screen (runtime 1.2)');
    const pushed = []; let alive = true;
    const res = await b.host.motion.start('marine-clinometer', { rateHz: 50 }, (r) => { pushed.push(r); return alive; });
    ok(res.ok === true && res.rateHz === 50 && res.platform === 'android' && calls[0].cmd === 'plugin_motion_start' && calls[0].args.rateHz === 50, 'MOTION: start asks the native sensors and reports the actual rate');
    ok(b.timers.size === 1, 'MOTION: a drain timer runs while the sensors are on');
    b.tickAll(); await settle();
    ok(pushed.length === 1 && pushed[0] === rows, 'MOTION: drained rows are pushed to the runtime');
    alive = false; rows = [];
    b.tickAll(); await settle();
    ok(b.timers.size === 0 && calls.some((c) => c.cmd === 'plugin_motion_stop'), 'MOTION: once the runtime says the plugin is gone (push → false) the timer and the sensors stop');
    await b.host.motion.start('marine-clinometer', { rateHz: 50 }, () => true);
    b.host.motion.stop('marine-clinometer'); await settle();
    ok(b.timers.size === 0 && calls.filter((c) => c.cmd === 'plugin_motion_stop').length === 2, 'MOTION: stop() stops the timer and the native sensors');
    const k = await b.host.screen.keepAwake('marine-clinometer', 1);
    const last = calls[calls.length - 1];
    ok(k.ok === true && last.cmd === 'plugin_keep_awake' && last.args.on === true, 'MOTION: keepAwake reaches the native command as a boolean');
  }
  {
    const b = boot(LINUX, (cmd) => (cmd === 'plugin_motion_start' ? Promise.resolve({ ok: false, rateHz: 0, source: 'none', platform: 'desktop', gyro: false, reason: 'no-sensors' }) : Promise.resolve(null)));
    const res = await b.host.motion.start('marine-clinometer', { rateHz: 50 }, () => true);
    ok(res.ok === false && res.reason === 'no-sensors' && b.timers.size === 0, 'MOTION: on desktop start answers no-sensors and no timer runs');
    const b2 = boot(LINUX, null);
    const res2 = await b2.host.motion.start('marine-clinometer', { rateHz: 50 }, () => true);
    ok(res2.ok === false && b2.timers.size === 0, 'MOTION: without the native bridge start is refused, nothing throws');
  }
}

// Owner 24.11.2026: «открыл Apps, нажал Драфт-сюрвей — 20 секунд висит Loading». The screen was
// left with the top «‹» button: the plugin's container was destroyed WITHOUT host.unmount, the boot
// still believed the plugin was mounted and answered «already open» into a fresh, empty container.
// And a launch must be LOCAL: an installed plugin opens from the verified cache, not by downloading
// the pack again, and a silent network must not hold the launch.
function bootWithInstalledPlugin(opts) {
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  const SLUG = 'draft-survey', VER = '0.1.0';
  const entry = { slug: SLUG, id: 'app.skipi.plugins.' + SLUG, name: 'Draft Survey', version: VER, permissions: ['local_storage'], capabilities: { network: 'none' } };
  const store = new Map([['skipi_remote_plugins_state', JSON.stringify({ [SLUG]: { installed: true, enabled: true, slug: SLUG, id: entry.id, version: VER, entry } })]]);
  const calls = { opens: 0, closes: 0, installs: [] };
  let runtimeCfg = null, loaderCfg = null;
  const ctx = {
    console: { info() {}, warn() {} }, setTimeout: opts.setTimeout || setTimeout, clearTimeout,
    fetch: opts.fetch, AbortController,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: true,
      SKIPI_REMOTE_CONFIG: { catalogUrl: 'https://unit.test/catalog.json', remoteSlugs: '*', host: { id: 'seafarer', version: EXPECTED_VERSION }, policy: {}, pinnedPublicKeys: {}, pinnedPublicKey: {} },
      SkipiPluginLoader: { create: (c) => { loaderCfg = c; return {
        getCatalog: () => Promise.resolve({ source: 'network', catalog: { plugins: [entry] } }),
        install: (slug, o) => { calls.installs.push(o && o.allowNetwork === false ? 'cache' : 'network'); return Promise.resolve(opts.install ? opts.install(o) : { ok: true, entry, pack: { files: {} }, source: 'x' }); },
      }; } },
      SkipiPluginRuntime: { create: (c) => { runtimeCfg = c; return {
        open: (id, el) => { calls.opens += 1; el.frame = {}; return Promise.resolve({ ok: true }); },
        close: () => { calls.closes += 1; },
      }; } },
      SkipiPluginHost: { mount: () => Promise.resolve({ ok: true }), unmount() {} },
    },
    document: { getElementById: () => null },
  };
  ctx.window.window = ctx.window; ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  const container = () => { const el = { innerHTML: '', frame: null }; el.querySelector = (q) => (q === 'iframe' ? el.frame : null); return el; };
  return { win: ctx.window, calls, SLUG, container, runtimeCfg: () => runtimeCfg, loaderCfg: () => loaderCfg };
}

async function testReopenAfterContainerWasDestroyed() {
  const b = bootWithInstalledPlugin({});
  const first = b.container();
  let r = await b.win.SkipiPluginHost.mount(b.SLUG, first);
  ok(r && r.ok && b.calls.opens === 1, 'REOPEN: the first open mounts the plugin frame');
  r = await b.win.SkipiPluginHost.mount(b.SLUG, first);
  ok(r && r.ok && b.calls.opens === 1, 'REOPEN: a repeated mount into the SAME live container does not remount');
  const second = b.container(); // the screen was left without unmount and rendered again: a new, empty container
  r = await b.win.SkipiPluginHost.mount(b.SLUG, second);
  ok(r && r.ok && b.calls.opens === 2 && !!second.frame, 'REOPEN: a fresh container gets a real frame (no «already open» into an empty box)');
  ok(b.calls.closes >= 1, 'REOPEN: the stale frame is closed before the new one opens');
}

async function testLaunchIsLocal() {
  let b = bootWithInstalledPlugin({});
  let r = await b.runtimeCfg().loader.install(b.SLUG);
  ok(r.ok && JSON.stringify(b.calls.installs) === JSON.stringify(['cache']), 'LOCAL: an installed plugin launches from the verified cache — the pack is not downloaded again');
  b = bootWithInstalledPlugin({ install: (o) => (o && o.allowNetwork === false ? { ok: false, reason: 'pack unavailable (offline and not cached)' } : { ok: true, entry: { slug: 'draft-survey', permissions: [] }, pack: { files: {} }, source: 'network/network' }) });
  r = await b.runtimeCfg().loader.install(b.SLUG);
  ok(r.ok && JSON.stringify(b.calls.installs) === JSON.stringify(['cache', 'network']), 'LOCAL: an empty or damaged cache falls back to the network (verified again)');

  // a silent network: the request never answers — the loader's fetch must give up by itself
  let aborted = false;
  b = bootWithInstalledPlugin({
    setTimeout: (fn) => { Promise.resolve().then(fn); return 0; },
    fetch: (url, init) => new Promise((res, rej) => { init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }),
  });
  ok(typeof b.loaderCfg().fetch === 'function', 'LOCAL: the home gives the loader a fetch with a time limit');
  let failed = false;
  await b.loaderCfg().fetch('https://unit.test/catalog.json').catch(() => { failed = true; });
  ok(failed && aborted, 'LOCAL: a network that does not answer is cut off (the launch falls back to the cache instead of hanging)');
}


// Owner 24.11.2026: Seafarer ships NO bundled plugins — every plugin comes from the catalog.
// «Старым — как было, новым — пусто»: a user who used the formerly bundled plugins gets them
// installed from the catalog on the first online start, with their settings carried over;
// a new user starts with an empty Installed shelf.
function bootForUnbundle(seed, opts) {
  opts = opts || {};
  const bootCode = fs.readFileSync(BOOT_FILE, 'utf8');
  const store = new Map(Object.entries(seed || {}));
  const installs = [];
  const SLUGS = ['bnwas-time-anchor', 'ecdis-position-reminder', 'navigation-calculators', 'draft-survey'];
  const entries = SLUGS.map((slug) => ({ slug, id: 'app.skipi.plugins.' + slug, name: slug, version: '9.9.9', permissions: ['local_storage'], capabilities: { network: 'none' } }));
  const ctx = {
    console: { info() {}, warn() {} }, setTimeout, clearTimeout, AbortController, fetch: () => Promise.reject(new Error('unused')),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } },
    window: {
      FEATURE_REMOTE_PLUGIN_DELIVERY: true,
      SKIPI_REMOTE_CONFIG: { catalogUrl: 'https://unit.test/catalog.json', remoteSlugs: '*', host: { id: 'seafarer', version: EXPECTED_VERSION }, policy: {}, pinnedPublicKeys: {}, pinnedPublicKey: {} },
      SkipiPluginLoader: { create: () => ({
        getCatalog: () => (opts.offline ? Promise.reject(new Error('offline')) : Promise.resolve({ source: 'network', catalog: { plugins: entries } })),
        install: (slug) => { installs.push(slug); if (opts.offline) return Promise.resolve({ ok: false, stage: 'catalog', reason: 'offline' });
          const e = entries.find((x) => x.slug === slug); return Promise.resolve({ ok: true, entry: e, pack: { files: {} }, source: 'network/network' }); },
      }) },
      SkipiPluginRuntime: { create: () => ({ open: () => Promise.resolve({ ok: true }), close() {} }) },
      SkipiPluginHost: { mount: () => Promise.resolve({ ok: true }), unmount() {} },
    },
    document: { getElementById: () => null },
  };
  ctx.window.window = ctx.window; ctx.window.localStorage = ctx.localStorage;
  vm.createContext(ctx);
  vm.runInContext(bootCode, ctx, { filename: BOOT_FILE });
  const reg = () => JSON.parse(store.get('skipi_remote_plugins_state') || '{}');
  return { win: ctx.window, store, installs, reg };
}

async function testUnbundleMigration() {
  // a NEW user: nothing in storage — nothing is installed for them
  let b = bootForUnbundle({});
  await b.win.SkipiRemoteUnbundle();
  ok(b.installs.length === 0 && Object.keys(b.reg()).length === 0, 'UNBUNDLE: a new user gets no plugin installed on their behalf (empty Installed shelf)');
  ok(JSON.parse(b.store.get('skipi_plugins_unbundled_v1')).pending.length === 0, 'UNBUNDLE: and the decision is recorded once');

  // an EXISTING user: opened BNWAS, keeps ECDIS settings, uninstalled the calculators, disabled nothing
  const seed = {
    skipi_plugins_state: JSON.stringify({ 'bnwas-time-anchor': { last_opened_at: '2026-10-01T00:00:00Z' }, 'navigation-calculators': { installed: false }, 'ecdis-position-reminder': { enabled: false } }),
    'skipi_plugin_ecdis-position-reminder_settings': '{"interval":30}',
    'skipi_plugin_bnwas-time-anchor_journal': '[1,2]',
    'skpd_h.bnwas-time-anchor.journal': '[9]',
  };
  b = bootForUnbundle(seed);
  await b.win.SkipiRemoteUnbundle();
  ok(JSON.stringify(b.installs.slice().sort()) === JSON.stringify(['bnwas-time-anchor', 'ecdis-position-reminder']), 'UNBUNDLE: an existing user gets the formerly bundled plugins from the catalog — except the one they had uninstalled');
  ok(b.reg()['bnwas-time-anchor'] && b.reg()['bnwas-time-anchor'].installed && b.reg()['bnwas-time-anchor'].enabled !== false, 'UNBUNDLE: the plugin is installed and enabled');
  ok(b.reg()['ecdis-position-reminder'] && b.reg()['ecdis-position-reminder'].enabled === false, 'UNBUNDLE: a plugin the user had disabled stays disabled');
  ok(!b.reg()['draft-survey'], 'UNBUNDLE: a catalog plugin that was never bundled is not installed on the user\'s behalf');
  ok(b.store.get('skpd_h.ecdis-position-reminder.settings') === '{"interval":30}', 'UNBUNDLE: plugin settings are carried over to the catalog plugin\'s storage');
  ok(b.store.get('skpd_h.bnwas-time-anchor.journal') === '[9]', 'UNBUNDLE: data the catalog version already holds is not overwritten');
  ok(JSON.parse(b.store.get('skipi_plugins_unbundled_v1')).pending.length === 0, 'UNBUNDLE: nothing is left pending after a successful run');
  const n = b.installs.length;
  await b.win.SkipiRemoteUnbundle();
  ok(b.installs.length === n, 'UNBUNDLE: it runs once — a later start installs nothing again');
  // the user uninstalls BNWAS later: it must not come back by itself
  await b.win.SkipiRemoteUninstall('bnwas-time-anchor');
  await b.win.SkipiRemoteUnbundle();
  ok(!b.reg()['bnwas-time-anchor'] && b.installs.length === n, 'UNBUNDLE: a plugin the user removes afterwards does not reinstall itself');

  // OFFLINE on the first start after the update: keep it pending, finish when the network is back
  b = bootForUnbundle(seed, { offline: true });
  await b.win.SkipiRemoteUnbundle();
  const pend = JSON.parse(b.store.get('skipi_plugins_unbundled_v1')).pending.map((x) => x.slug).sort();
  ok(JSON.stringify(pend) === JSON.stringify(['bnwas-time-anchor', 'ecdis-position-reminder']) && Object.keys(b.reg()).length === 0, 'UNBUNDLE: with no network the plugins stay pending (nothing half-installed)');
  ok(b.store.get('skpd_h.ecdis-position-reminder.settings') === '{"interval":30}', 'UNBUNDLE: settings are carried over even before the network is back');
}

(async function main() {
  const win = runConfig();
  const cfg = win.SKIPI_REMOTE_CONFIG;
  const off = runConfig('off');
  const prodKey = cfg.pinnedPublicKeys && cfg.pinnedPublicKeys['skipi-firstparty-prod-v1'];

  ok(win.FEATURE_REMOTE_PLUGIN_DELIVERY === true, 'default FEATURE_REMOTE_PLUGIN_DELIVERY is ON');
  ok(off.FEATURE_REMOTE_PLUGIN_DELIVERY === false, "localStorage 'off' override disables remote delivery");
  testOffOverrideFailClosed();
  testGateRequiresHostMountSeam();

  ok(cfg.catalogUrl === CATALOG_URL, 'catalogUrl is production api.skipi.app path');
  ok(cfg.remoteSlugs === '*', "remoteSlugs is '*': the signed catalog decides which plugins exist (owner 24.11.2026)");
  ok(JSON.stringify(cfg.policy.maxPermissions) === JSON.stringify(['local_storage', 'audio_alert', 'network', 'motion', 'keep_awake']), 'policy grants at most local_storage, audio_alert, network, motion, keep_awake');
  ok(JSON.stringify(cfg.policy.networkOrigins) === JSON.stringify(['https://api.skipi.app']), 'plugin network is bounded to https://api.skipi.app');
  ok(cfg.policy.requireCapabilities.documents === 'none' && cfg.policy.requireCapabilities.account === 'none' && cfg.policy.requireCapabilities.analytics === 'none' && cfg.policy.requireCapabilities.server_upload === false,
    'documents / account / analytics / server_upload stay forbidden');
  await testNetworkPolicy(cfg);
  await testRuntimeGrantsComeFromSignedEntry();
  await testMotionAdapterAndPhoneOnlyPlugins();
  await testReopenAfterContainerWasDestroyed();
  await testLaunchIsLocal();
  await testUnbundleMigration();
  ok(cfg.host && cfg.host.id === 'seafarer', 'host id is seafarer');
  ok(cfg.host && cfg.host.version === EXPECTED_VERSION, 'host version is the plugin-host level 0.4.203 (motion + keep-awake)');

  ok(!!prodKey, 'prod public key is present');
  ok(prodKey && !Object.prototype.hasOwnProperty.call(prodKey, 'd'), 'prod public key has no private d');
  ok(prodKey && publicFingerprint(prodKey) === EXPECTED_FINGERPRINT, 'prod public key fingerprint is unchanged');
  ok(!cfg.pinnedPublicKeys['skipi-firstparty-staging-v1'], 'staging public key is NOT pinned in production config');
  ok(Object.keys(cfg.pinnedPublicKeys || {}).length === 1, 'production config trusts only the prod signing key');
  await testCentralCatalogKillSwitchFallsBackBundled();

  const catalog = JSON.parse((await get(CATALOG_URL)).toString('utf8'));
  ok(catalog.env === 'production', 'live catalog env is production');
  ok(catalog.keyId === 'skipi-firstparty-prod-v1', 'live catalog keyId selects prod key');
  const liveSlugs = (catalog.plugins || []).map((p) => p.slug);
  ok(BUNDLED_SLUGS.every((sl) => liveSlugs.includes(sl)), 'live catalog still carries the three bundled plugins');

  for (const entry of catalog.plugins || []) {
    ok(verifySignature(entry, prodKey), `${entry.slug} signature verifies with pinned prod key`);
    ok(entry.compat && Array.isArray(entry.compat.host) && entry.compat.host.includes('seafarer'), `${entry.slug} compat.host includes seafarer`);
    ok(!entry.compat.minHostVersion || semverGte(EXPECTED_VERSION, entry.compat.minHostVersion), `${entry.slug} minHostVersion <= ${EXPECTED_VERSION}`);
  }

  if (failures) {
    console.error(`REMOTE PROD DELIVERY CONFIG FAIL failures=${failures}`);
    process.exit(1);
  }
  console.log('REMOTE PROD DELIVERY CONFIG OK');
}()).catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});

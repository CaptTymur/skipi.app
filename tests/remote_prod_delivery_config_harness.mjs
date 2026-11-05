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
const EXPECTED_SLUGS = ['bnwas-time-anchor', 'navigation-calculators', 'ecdis-position-reminder'];
const EXPECTED_VERSION = '0.4.165';
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
  ok(JSON.stringify(cfg.remoteSlugs) === JSON.stringify(EXPECTED_SLUGS), 'remoteSlugs exactly match B5 production set');
  ok(!cfg.remoteSlugs.includes('ship-photo-collection'), 'ship-photo-collection is not routed in production');
  ok(cfg.host && cfg.host.id === 'seafarer', 'host id is seafarer');
  ok(cfg.host && cfg.host.version === EXPECTED_VERSION, 'host version is release version 0.4.165');

  ok(!!prodKey, 'prod public key is present');
  ok(prodKey && !Object.prototype.hasOwnProperty.call(prodKey, 'd'), 'prod public key has no private d');
  ok(prodKey && publicFingerprint(prodKey) === EXPECTED_FINGERPRINT, 'prod public key fingerprint is unchanged');
  ok(!cfg.pinnedPublicKeys['skipi-firstparty-staging-v1'], 'staging public key is NOT pinned in production config');
  ok(Object.keys(cfg.pinnedPublicKeys || {}).length === 1, 'production config trusts only the prod signing key');
  await testCentralCatalogKillSwitchFallsBackBundled();

  const catalog = JSON.parse((await get(CATALOG_URL)).toString('utf8'));
  ok(catalog.env === 'production', 'live catalog env is production');
  ok(catalog.keyId === 'skipi-firstparty-prod-v1', 'live catalog keyId selects prod key');
  ok(JSON.stringify((catalog.plugins || []).map((p) => p.slug)) === JSON.stringify(EXPECTED_SLUGS), 'live catalog slug order matches route set');

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

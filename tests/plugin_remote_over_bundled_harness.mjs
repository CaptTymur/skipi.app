// Regression harness for first-party remote delivery over bundled fallback.
//
// Contract:
//   - bundled first-party plugins can appear as remote update candidates;
//   - a newer installed remote pack overrides bundled metadata in Apps;
//   - stale/downgrade or unverified remote state falls back to bundled;
//   - install/update still delegates to the signed loader path that writes
//     skpd.entry:<slug>, skpd.pack:<slug>@<version>, and installed state.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const HTML = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const LOADER = fs.readFileSync(path.join(DIST, 'plugin-loader.js'), 'utf8');
const REMOTE_BOOT = fs.readFileSync(path.join(DIST, 'plugin-remote-boot.js'), 'utf8');
const SLUG = 'navigation-calculators';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
};
const section = (title) => console.log('\n# ' + title);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const START = 'var SKIPI_PLUGIN_CATEGORIES = [';
const END = 'function remotePluginScreenHtml(slug){';
const start = HTML.indexOf(START);
const end = HTML.indexOf(END);
if (start < 0 || end < 0 || end <= start) {
  console.error('could not extract Apps plugin registry block from dist/index.html');
  process.exit(1);
}
const PLUGIN_BLOCK = HTML.slice(start, end);

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => Array.from(map.keys())[i] || null,
    dump: () => Object.fromEntries(map.entries()),
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function jsString(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}
function genEl() {
  return {
    innerHTML: '',
    textContent: '',
    style: {},
    attrs: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
    appendChild() {},
    remove() {},
  };
}

function boot({ catalog = [], remoteSlugs = [SLUG], remoteState = {}, cache = {} } = {}) {
  const storage = makeStorage({
    skipi_remote_plugins_state: JSON.stringify(remoteState),
    ...cache,
  });
  const toasts = [];
  const sandbox = {
    console,
    window: null,
    localStorage: storage,
    navigator: { onLine: true },
    document: {
      getElementById: () => genEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => genEl(),
      body: genEl(),
      head: genEl(),
      documentElement: { getAttribute: () => 'dark', setAttribute() {} },
    },
    setTimeout,
    clearTimeout,
    FEATURE_REMOTE_PLUGIN_DELIVERY: true,
    SKIPI_REMOTE_CONFIG: { remoteSlugs },
    getUiLang: () => 'en',
    esc,
    escAttr: esc,
    jsString,
    famStateChip: () => '',
    showToast: (msg, type) => toasts.push({ msg, type }),
    show() {},
    updateTabs() {},
    shouldUseMobileShell: () => false,
    renderMobileApps() {},
    logError() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const exported = vm.runInContext(`${PLUGIN_BLOCK}
    ;function __setRemoteCatalogForHarness(list){ __remoteCatalogCache = list || []; }
    ;({
      SKIPI_PLUGIN_REGISTRY,
      pluginById,
      pluginInstalledList,
      pluginManageHtml,
      pluginRemoteUpdate,
      remoteStagingSlugs,
      remoteUpdateAvailable,
      remoteConfiguredSlug,
      remoteInstalledEntryFor,
      remoteOverrideEntryFor,
      __setRemoteCatalogForHarness
    });`, sandbox);
  exported.__setRemoteCatalogForHarness(catalog);
  sandbox.pluginRerender = () => { sandbox.__rerenders = (sandbox.__rerenders || 0) + 1; };
  return { ...exported, sandbox, storage, toasts };
}

const newerEntry = {
  slug: SLUG,
  id: 'app.skipi.plugins.navigation-calculators',
  name: 'Navigation Calculators',
  version: '0.2.1',
  category: 'utils',
  icon: '▦',
  toolCount: 8,
  permissions: ['local_storage'],
};
const olderEntry = {
  ...newerEntry,
  version: '0.0.9',
  toolCount: 9,
};

section('static security invariants');
ok(!/return slugs\.filter\(function\(s\)\{ return !bundledPluginById\(s\); \}\);/.test(HTML), 'remoteStagingSlugs no longer drops every bundled slug unconditionally');
ok(/remoteCanOverrideBundled/.test(HTML) && /remoteInstallCacheMatches/.test(HTML), 'bundled override is gated by explicit remote override/cache checks');
ok(/window\.SkipiRemoteInstall\(slug,\{allowNetwork:true\}\)/.test(HTML), 'pluginRemoteUpdate delegates installation to SkipiRemoteInstall');
ok(/var NS = 'skpd\.'/.test(LOADER), 'remote loader default cache namespace is skpd.');
ok(/cache\.set\('entry:' \+ slug, JSON\.stringify\(entry\)\)/.test(LOADER), 'verified install writes skpd.entry:<slug>');
ok(/cache\.set\(cacheKey, packStr\)/.test(LOADER), 'verified pack fetch writes skpd.pack:<slug>@<version>');
ok(/verifyEntry/.test(LOADER) && /pinnedJwks\[keyId\]/.test(LOADER), 'loader keeps catalog signature verification through pinned keys');
ok(/downgrade blocked/.test(LOADER) && /baselineVersion/.test(LOADER), 'loader keeps anti-downgrade against cached/bundled baseline');
ok(/persistInstalled\(entry, pack\)/.test(REMOTE_BOOT) && /installed: true/.test(REMOTE_BOOT), 'remote boot persists skipi_remote_plugins_state installed=true only after loader success');

section('newer catalog candidate is visible while bundled remains fallback before install');
const before = boot({ catalog: [newerEntry] });
ok(before.remoteConfiguredSlug(SLUG), 'navigation-calculators is a configured remote slug');
ok(before.remoteUpdateAvailable(SLUG), 'newer remote catalog version is an update candidate over bundled v0.1.0');
ok(before.remoteStagingSlugs().includes(SLUG), 'staging section exposes the bundled slug as an update candidate');
ok(before.pluginById(SLUG).version === '0.1.0', 'before verified install, pluginById still returns bundled fallback');
ok(/remote-plugin-update-navigation-calculators/.test(before.pluginManageHtml()), 'manage UI renders an Update action for the bundled first-party plugin');

section('install/update writes expected keys and remote overrides bundled');
let installCalled = false;
before.sandbox.SkipiRemoteInstall = async (slug, opts) => {
  installCalled = slug === SLUG && opts && opts.allowNetwork === true;
  before.storage.setItem(`skpd.entry:${slug}`, JSON.stringify(newerEntry));
  before.storage.setItem(`skpd.pack:${slug}@${newerEntry.version}`, JSON.stringify({ slug, id: newerEntry.id, version: newerEntry.version }));
  before.storage.setItem('skipi_remote_plugins_state', JSON.stringify({
    [slug]: {
      installed: true,
      enabled: true,
      slug,
      id: newerEntry.id,
      name: newerEntry.name,
      title: newerEntry.name,
      version: newerEntry.version,
      toolCount: newerEntry.toolCount,
      entry: newerEntry,
    },
  }));
  return { ok: true, entry: newerEntry, pack: { slug, id: newerEntry.id, version: newerEntry.version } };
};
before.pluginRemoteUpdate(SLUG);
await tick();
await tick();
const installed = before.pluginById(SLUG);
ok(installCalled, 'pluginRemoteUpdate called SkipiRemoteInstall(slug, { allowNetwork:true })');
ok(!!before.storage.getItem(`skpd.entry:${SLUG}`), 'install path created skpd.entry:navigation-calculators');
ok(!!before.storage.getItem(`skpd.pack:${SLUG}@0.2.1`), 'install path created skpd.pack:navigation-calculators@0.2.1');
ok(JSON.parse(before.storage.getItem('skipi_remote_plugins_state'))[SLUG].installed === true, 'install path marked skipi_remote_plugins_state.navigation-calculators.installed=true');
ok(installed && installed.remote && installed.version === '0.2.1' && installed.toolCount === 8, 'after verified install, pluginById returns newer remote metadata');
ok(before.pluginInstalledList().some((p) => p.id === SLUG && p.remote && p.version === '0.2.1'), 'Apps installed list shows the remote version, not bundled v0.1.0');

section('downgrade and unverified state fall back to bundled');
const downgrade = boot({
  catalog: [olderEntry],
  remoteState: {
    [SLUG]: { installed: true, enabled: true, slug: SLUG, id: olderEntry.id, name: olderEntry.name, version: olderEntry.version, toolCount: olderEntry.toolCount, entry: olderEntry },
  },
  cache: {
    [`skpd.entry:${SLUG}`]: JSON.stringify(olderEntry),
    [`skpd.pack:${SLUG}@${olderEntry.version}`]: JSON.stringify({ slug: SLUG, id: olderEntry.id, version: olderEntry.version }),
  },
});
ok(!downgrade.remoteUpdateAvailable(SLUG), 'remote version below bundled is not shown as an update');
ok(!downgrade.remoteStagingSlugs().includes(SLUG), 'remote version below bundled is not exposed in staging');
ok(downgrade.pluginById(SLUG).version === '0.1.0' && !downgrade.pluginById(SLUG).remote, 'installed downgrade cannot override bundled fallback');

const unverified = boot({
  catalog: [newerEntry],
  remoteState: {
    [SLUG]: { installed: true, enabled: true, slug: SLUG, id: newerEntry.id, name: newerEntry.name, version: newerEntry.version, toolCount: newerEntry.toolCount, entry: newerEntry },
  },
});
ok(unverified.remoteUpdateAvailable(SLUG), 'newer catalog remains available for a real verified install');
ok(unverified.pluginById(SLUG).version === '0.1.0' && !unverified.pluginById(SLUG).remote, 'remote state without verified skpd.entry/skpd.pack cache cannot override bundled');

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);

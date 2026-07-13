// Runtime presence contract for Seafarer required modules.
//
// The required module list lives only in presence-manifest.json. This harness
// mounts the real dist/index.html into a small DOM, executes the inline app
// scripts, and then drives the app's own navigation functions:
//   - desktop modules bar (#mt-*) through showView(route);
//   - mobile module rail ([data-mview=*]) through mobileShow(route).
// A required module that disappears from the markup, loses its onclick wiring,
// loses its render entry function, or stops switching the route fails the run.
//
//   node tests/seafarer_presence_contract_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'presence-manifest.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const html = fs.readFileSync(path.join(ROOT, manifest.artifact), 'utf8');

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
}

function section(title) {
  console.log('\n# ' + title);
}

function cleanSelector(selector) {
  if (!selector || typeof selector !== 'string') throw new Error('selector must be a string');
  return selector.trim();
}

function parseAttrs(raw) {
  const attrs = {};
  const text = raw || '';
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

class StyleDecl {
  constructor(raw = '') {
    this._props = {};
    raw.split(';').forEach((part) => {
      const idx = part.indexOf(':');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) this.setProperty(key, val);
    });
  }

  setProperty(key, value) {
    const k = String(key || '').trim();
    if (!k) return;
    this._props[k] = String(value ?? '');
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    this[camel] = this._props[k];
  }

  getPropertyValue(key) {
    return this._props[String(key || '').trim()] || '';
  }

  removeProperty(key) {
    const k = String(key || '').trim();
    const old = this._props[k] || '';
    delete this._props[k];
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    delete this[camel];
    return old;
  }

  toString() {
    return Object.entries(this._props).map(([k, v]) => `${k}:${v}`).join(';');
  }
}

class ClassList {
  constructor(raw = '') {
    this._set = new Set(String(raw || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    names.flatMap((n) => String(n).split(/\s+/)).filter(Boolean).forEach((n) => this._set.add(n));
  }

  remove(...names) {
    names.flatMap((n) => String(n).split(/\s+/)).filter(Boolean).forEach((n) => this._set.delete(n));
  }

  contains(name) {
    return this._set.has(name);
  }

  toggle(name, force) {
    if (force === true) {
      this._set.add(name);
      return true;
    }
    if (force === false) {
      this._set.delete(name);
      return false;
    }
    if (this._set.has(name)) {
      this._set.delete(name);
      return false;
    }
    this._set.add(name);
    return true;
  }

  toString() {
    return Array.from(this._set).join(' ');
  }
}

class FakeElement {
  constructor(document, tagName = 'div', attrs = {}, initialHtml = '') {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.parentNode = null;
    this.attrs = { ...attrs };
    this.id = attrs.id || '';
    this.type = attrs.type || '';
    this.value = attrs.value || '';
    this.title = attrs.title || '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.scrollWidth = 0;
    this.clientWidth = 1024;
    this.clientHeight = 768;
    this.classList = new ClassList(attrs.class || '');
    this.style = new StyleDecl(attrs.style || '');
    this._innerHTML = initialHtml;
    this._textContent = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
  }

  get textContent() {
    return this._textContent || this._innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this._innerHTML = this._textContent;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new ClassList(value);
    this.attrs.class = this.classList.toString();
  }

  setAttribute(key, value) {
    const k = String(key);
    const v = String(value ?? '');
    this.attrs[k] = v;
    if (k === 'id') {
      if (this.id) this.ownerDocument._ids.delete(this.id);
      this.id = v;
      this.ownerDocument._ids.set(v, this);
    } else if (k === 'class') {
      this.classList = new ClassList(v);
    } else if (k === 'style') {
      this.style = new StyleDecl(v);
    } else {
      this[k] = v;
    }
  }

  getAttribute(key) {
    const k = String(key);
    if (k === 'class') return this.classList.toString();
    if (k === 'style') return this.style.toString();
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }

  removeAttribute(key) {
    const k = String(key);
    delete this.attrs[k];
    if (k === 'class') this.classList = new ClassList('');
    if (k === 'style') this.style = new StyleDecl('');
  }

  appendChild(child) {
    if (child) {
      this.children.push(child);
      child.parentNode = this;
    }
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child) child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  querySelector(selector) {
    return this.ownerDocument.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.ownerDocument.querySelectorAll(selector);
  }
}

class FakeDocument {
  constructor(sourceHtml) {
    this._ids = new Map();
    this._all = [];
    this._listeners = new Map();
    this.title = '';
    this.documentElement = this._makeElement('html', { id: '__html', lang: 'ru', 'data-theme': 'light' });
    this.head = this._makeElement('head', { id: '__head' });
    this.body = this._makeElement('body', { id: '__body' });
    this.parse(sourceHtml);
  }

  _makeElement(tagName, attrs = {}, initialHtml = '') {
    const el = new FakeElement(this, tagName, attrs, initialHtml);
    this._all.push(el);
    if (el.id) this._ids.set(el.id, el);
    return el;
  }

  parse(sourceHtml) {
    const re = /<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?>/g;
    let m;
    while ((m = re.exec(sourceHtml))) {
      const tag = m[1].toLowerCase();
      if (tag.startsWith('!') || tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') continue;
      const attrs = parseAttrs(m[2] || '');
      if (!attrs.id && !attrs['data-i18n'] && !attrs['data-i18n-title'] && !attrs['data-qa'] && !attrs['data-mview']) continue;
      const close = sourceHtml.indexOf(`</${tag}>`, re.lastIndex);
      const initialHtml = close >= 0 ? sourceHtml.slice(re.lastIndex, close) : '';
      this._makeElement(tag, attrs, initialHtml);
    }
  }

  getElementById(id) {
    return this._ids.get(String(id)) || null;
  }

  createElement(tagName) {
    const el = this._makeElement(tagName, {});
    if (String(tagName).toLowerCase() === 'canvas') {
      el.getContext = () => ({
        drawImage() {},
        fillRect() {},
        clearRect() {},
        getImageData: () => ({ data: [] }),
      });
      el.toDataURL = () => 'data:image/png;base64,';
    }
    return el;
  }

  createTextNode(text) {
    const el = this._makeElement('#text', {});
    el.textContent = text;
    return el;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener() {}

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const s = cleanSelector(selector);
    if (s.startsWith('#')) {
      const el = this.getElementById(s.slice(1));
      return el ? [el] : [];
    }
    const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
    if (attr) {
      const key = attr[1];
      const expected = attr[2];
      return this._all.filter((el) => {
        const actual = el.getAttribute(key);
        return actual !== null && (expected === undefined || actual === expected);
      });
    }
    if (s.startsWith('.')) return this._all.filter((el) => el.classList.contains(s.slice(1)));
    return this._all.filter((el) => el.tagName.toLowerCase() === s.toLowerCase());
  }
}

function installRuntime(sourceHtml) {
  const document = new FakeDocument(sourceHtml);
  const store = new Map();
  const intervalIds = [];

  const tauriInvoke = async (cmd) => {
    if (cmd === 'get_build_info') return { version: '0.0.0-presence-harness', sha: 'presence-harness' };
    if (cmd === 'get_platform') return 'linux';
    if (cmd === 'get_vault_types') return [];
    if (cmd === 'get_last_vault') return null;
    if (cmd === 'get_recent_vaults') return [];
    if (cmd === 'get_optional_categories') return [];
    if (cmd === 'get_settings') return {};
    if (cmd === 'init_app_diagnostics') return {};
    if (cmd === 'app_heartbeat') return {};
    if (cmd === 'record_app_diagnostic') return {};
    if (cmd === 'mark_app_shutdown') return {};
    return {};
  };

  const sandbox = {
    console,
    document,
    navigator: {
      userAgent: 'Node Presence Harness',
      platform: 'Linux x86_64',
      onLine: true,
      clipboard: { writeText: async () => {} },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    location: { hash: '', pathname: '/presence-harness', reload() {} },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    crypto: webcrypto,
    __TAURI__: {
      core: { invoke: tauriInvoke, convertFileSrc: (p) => p },
      invoke: tauriInvoke,
      event: { listen: async () => () => {} },
      window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
    },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    // matches:false => desktop boot path; the mobile pass stubs shouldUseMobileShell.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (...args) => {
      intervalIds.push(args);
      return intervalIds.length;
    },
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    alert() {},
    confirm: () => true,
    prompt: () => null,
    Blob: class Blob {},
    FileReader: class FileReader {},
    Image: class Image {},
    URL: { createObjectURL: () => 'blob:presence-harness', revokeObjectURL() {} },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  const scripts = Array.from(sourceHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .map(([, attrs, code]) => {
      const src = /\ssrc\s*=\s*["']([^"']+)["']/.exec(attrs || '');
      if (!src) return { code, filename: 'dist/index.html#inline' };
      if (['vessel-db.js', 'intelligence.js'].includes(src[1])) {
        return {
          code: fs.readFileSync(path.join(ROOT, 'dist', src[1]), 'utf8'),
          filename: `dist/${src[1]}`,
        };
      }
      return null;
    })
    .filter(Boolean);

  scripts.forEach((script, idx) => {
    try {
      vm.runInContext(script.code, sandbox, { filename: script.filename || `dist/index.html#script-${idx + 1}` });
    } catch (e) {
      throw new Error(`script ${idx + 1} failed: ${e.stack || e.message}`);
    }
  });

  return { sandbox, document, store };
}

function selectorOne(document, selector, label) {
  const el = document.querySelector(cleanSelector(selector));
  ok(!!el, `${label ? label + ': ' : ''}${selector} exists`);
  return el;
}

function displayOf(el) {
  return String(el && (el.style.display || el.getAttribute('display') || '')).trim();
}

function isHidden(el) {
  if (!el) return true;
  if (el.getAttribute('hidden') !== null) return true;
  if (/^(none|hidden)$/i.test(displayOf(el))) return true;
  if (/hidden/i.test(String(el.style.visibility || ''))) return true;
  if (/^(0|0\.0+)$/.test(String(el.style.opacity || ''))) return true;
  if (/\b(?:hidden|is-hidden|internal-tool)\b/.test(el.classList.toString())) return true;
  return false;
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function assertManifestShape() {
  section('manifest');
  ok(manifest.schema_version === 'skipi.presence-manifest.v1', 'schema_version is skipi.presence-manifest.v1');
  ok(manifest.home === 'seafarer', 'manifest home is seafarer');
  ok(typeof manifest.artifact === 'string' && manifest.artifact === 'dist/index.html', 'manifest points at dist/index.html');
  ok(Array.isArray(manifest.required_modules) && manifest.required_modules.length > 0, 'manifest has required_modules');
  const ids = new Set();
  for (const mod of manifest.required_modules || []) {
    ok(!!mod.id && !ids.has(mod.id), `module id is unique: ${mod.id}`);
    ids.add(mod.id);
    ok(!!mod.name, `${mod.id} has a name`);
    ok(!!(mod.desktop_navigation || mod.mobile_navigation), `${mod.id} declares at least one navigation surface`);
  }
}

// Render entry points must exist BEFORE they are stubbed for the navigation
// drive; a module whose renderer was deleted fails here even if its tab is
// still in the markup.
function assertRenderFunctions(sandbox) {
  section('render entry points');
  for (const mod of manifest.required_modules) {
    for (const nav of [mod.desktop_navigation, mod.mobile_navigation]) {
      if (!nav || !nav.render_function) continue;
      ok(typeof sandbox[nav.render_function] === 'function', `${mod.name}: ${nav.render_function} is a function`);
    }
  }
}

// Heavy view renderers need real vault state; navigation wiring does not.
// Stub them AFTER assertRenderFunctions so the drive below only proves the
// nav -> route -> active-state contract.
function installNavigationStubs(sandbox) {
  const noop = () => {};
  for (const mod of manifest.required_modules) {
    for (const nav of [mod.desktop_navigation, mod.mobile_navigation]) {
      if (nav && nav.render_function) sandbox[nav.render_function] = noop;
    }
  }
  Object.assign(sandbox, {
    showDashboard: noop,
    renderDoc: noop,
    updateProfileCompletionChip: noop,
    mobileRefreshProfileMeter: noop,
    mobileUpdateModuleRailHint: noop,
    mobileScrollMainTop: noop,
    renderMobileHome: noop,
  });
}

async function assertDesktopNavigation(document, sandbox, mod) {
  const nav = mod.desktop_navigation;
  if (!nav) return;
  const el = selectorOne(document, nav.nav_selector, mod.name);
  if (!el) return;
  ok(!isHidden(el), `${mod.name}: desktop tab is not hidden`);
  ok(String(el.getAttribute('onclick') || '').includes(`showView('${nav.route}')`), `${mod.name}: desktop tab calls showView('${nav.route}')`);
  ok(typeof sandbox.showView === 'function', `${mod.name}: showView is executable`);
  sandbox.showView(nav.route);
  await settle();
  ok(sandbox.currentView === nav.route, `${mod.name}: currentView switched to ${nav.route}`);
  ok(el.classList.contains('active'), `${mod.name}: desktop tab is active`);
}

async function assertMobileNavigation(document, sandbox, mod) {
  const nav = mod.mobile_navigation;
  if (!nav) return;
  const el = selectorOne(document, nav.nav_selector, mod.name);
  if (!el) return;
  ok(!isHidden(el), `${mod.name}: mobile rail button is not hidden`);
  ok(String(el.getAttribute('onclick') || '').includes(`mobileShow('${nav.route}')`), `${mod.name}: mobile rail button calls mobileShow('${nav.route}')`);
  ok(typeof sandbox.mobileShow === 'function', `${mod.name}: mobileShow is executable`);
  sandbox.mobileShow(nav.route);
  await settle();
  ok(sandbox.mobileView === nav.route, `${mod.name}: mobileView switched to ${nav.route}`);
  ok(el.classList.contains('active'), `${mod.name}: mobile rail button is active`);
  const bottomNav = document.getElementById('mobile-bottom-nav');
  const expected = nav.hides_bottom_nav ? 'none' : 'flex';
  ok(!!bottomNav && displayOf(bottomNav) === expected, `${mod.name}: mobile bottom nav display is ${expected}`);
}

assertManifestShape();

const runtime = installRuntime(html);
await settle();

section('runtime app mount');
ok(!!runtime.document.getElementById('scr-welcome'), 'welcome screen markup mounted');
ok(!!runtime.document.getElementById('modules-bar'), 'desktop modules bar exists');
ok(!!runtime.document.getElementById('mobile-module-rail'), 'mobile module rail exists');
ok(!!runtime.document.getElementById('mobile-bottom-nav'), 'mobile bottom nav exists');
ok(typeof runtime.sandbox.showView === 'function', 'app showView function is loaded');
ok(typeof runtime.sandbox.mobileShow === 'function', 'app mobileShow function is loaded');

assertRenderFunctions(runtime.sandbox);
installNavigationStubs(runtime.sandbox);
await settle();

section('desktop modules bar');
for (const mod of manifest.required_modules) {
  await assertDesktopNavigation(runtime.document, runtime.sandbox, mod);
}

section('mobile module rail');
runtime.sandbox.shouldUseMobileShell = () => true;
for (const mod of manifest.required_modules) {
  await assertMobileNavigation(runtime.document, runtime.sandbox, mod);
}

section('my contribution UI — feature flag and fixtures');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  ok(typeof sandbox.trustContributionEnabled === 'function', 'trustContributionEnabled helper exists');
  ok(typeof sandbox.trustContributionDemoModeEnabled === 'function', 'trustContribution demo gate helper exists');
  ok(typeof sandbox.trustContributionLoadSummary === 'function', 'trustContribution summary loader exists');
  ok(typeof sandbox.showContribution === 'function', 'desktop My contribution renderer exists');
  ok(typeof sandbox.renderMobileContribution === 'function', 'mobile My contribution renderer exists');
  ok(sandbox.trustContributionEnabled() === false, 'feature flag defaults OFF');
  const tab = document.getElementById('mt-contribution');
  ok(!!tab && String(tab.style.display || tab.getAttribute('style') || '').includes('none'), 'desktop entry is hidden by default');
  sandbox.showDashboard = () => {
    const host = document.getElementById('scr-content');
    if (host) host.innerHTML = '<div data-qa="dashboard-stub"></div>';
  };
  sandbox.showView('contribution');
  await settle();
  ok(sandbox.currentView !== 'contribution', 'flag-off cannot navigate to My contribution');
  ok(!String((document.getElementById('scr-content') || {}).innerHTML || '').includes('data-qa="my-contribution-screen"'), 'flag-off screen is absent');

  let fetchCalls = 0;
  sandbox.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 599, json: async () => ({}), text: async () => '' };
  };
  sandbox.updateProfileCompletionChip = () => {};
  store.set('skipi_seafarer_my_contribution', '1');
  sandbox.showView('contribution');
  await settle();
  let h = String((document.getElementById('scr-content') || {}).innerHTML || '');
  ok(h.includes('data-qa="my-contribution-screen"'), 'non-demo fail-closed screen renders');
  ok(h.includes('data-mode="unavailable"') && h.includes('data-network="unavailable"'), 'non-demo live-off state is unavailable, not fixture');
  ok(h.includes('data-qa="my-contribution-unavailable"'), 'non-demo live-off state shows honest unavailable copy');
  ok(!/data-mode="fixture"|SKP-SF-DEMO|9123456|9345678|9456789|9567890/i.test(h), 'non-demo live-off state contains no fixture identity or demo vessel IMO');
  ok(fetchCalls === 0, 'non-demo live-off performs no network fetches');

  sandbox.mobileIsDemo = true;
  for (const fixture of ['provisional', 'verified_contributor', 'established_contributor']) {
    store.set('skipi_seafarer_my_contribution_fixture', fixture);
    sandbox.showView('contribution');
    await settle();
    h = String((document.getElementById('scr-content') || {}).innerHTML || '');
    ok(h.includes('data-qa="my-contribution-screen"'), `${fixture}: desktop screen renders`);
    ok(h.includes(`data-qa="my-contribution-band-key"`) && h.includes(fixture), `${fixture}: band key renders`);
    ok(h.includes('data-mode="fixture"'), `${fixture}: fixture mode is explicit`);
    ok(h.includes('data-network="none"'), `${fixture}: fixture mode declares network none`);
    ok(!/(score_mean|score_lower_bound|confidence|final_review_weight|token_id|raw_payload|payload_hash|email_hash|signature_raw)/i.test(h), `${fixture}: no score/hash/token/payload fields in desktop HTML`);
    ok(!/(approved|rejected|blacklist|legal|rating|оценка моряка|рейтинг моряка)/i.test(h), `${fixture}: banned wording absent`);
  }
  ok(fetchCalls === 0, 'fixture mode performs no network fetches');
}

section('my contribution UI — live summary happy path');
{
  const { sandbox, store } = installRuntime(html);
  await settle();
  const apiCalls = [];
  store.set('skipi_seafarer_my_contribution', '1');
  store.set('skipi_seafarer_my_contribution_live', '1');
  sandbox.trustContributionCreateSession = async () => 'self-session-token';
  sandbox.apiFetch = async (url, opts = {}) => {
    apiCalls.push({ url: String(url), auth: String((opts.headers || {}).Authorization || '') });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        subject_id: 'SKP-SF-LIVE-0001',
        policy_version: 'trust-band-v0.1',
        score_algorithm_version: 'trust-score-v0.1',
        band: { key: 'verified_contributor', label_ru: 'Подтверждённый участник', label_en: 'Verified contributor' },
        summary: { confirmed_event_count: 1, recent_365d_event_count: 1, last_anchor_at: '2026-07-12T10:00:00Z' },
        reasons: [{ code: 'eligible_anchor_history', label_ru: 'Есть подтверждённая история.', label_en: 'Confirmed history exists.' }],
        what_is_missing: [],
        events: [{
          event_id: 'evt-live-1',
          date: '2026-07-12T10:00:00Z',
          kind: 'vessel_checkin',
          vessel_imo: '7654321',
          issuer_type: 'crewing',
          status: 'accepted',
          counts_toward_contribution: true,
          reason_codes: ['eligible_anchor_history'],
        }],
        visibility: { company_visible: false, numeric_score_visible: false },
      }),
      text: async () => '',
    };
  };
  const summary = await sandbox.trustContributionLoadSummary();
  ok(summary.subject_id === 'SKP-SF-LIVE-0001', 'live summary subject is returned');
  ok(summary._fixture === false && summary._unavailable === false, 'live summary is neither fixture nor unavailable');
  ok(apiCalls.length === 1 && apiCalls[0].url === '/api/me/trust-summary' && /Bearer self-session-token/.test(apiCalls[0].auth), 'live summary fetches authenticated endpoint');
  const h = sandbox.trustContributionHtml(summary, { compact: false });
  ok(h.includes('data-mode="live"') && h.includes('data-network="api"'), 'live summary renders as API mode');
  ok(h.includes('7654321') && !/9123456|SKP-SF-DEMO/i.test(h), 'live summary renders live event without demo fixture values');
}

section('my contribution UI — mobile compact view');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  sandbox.shouldUseMobileShell = () => true;
  sandbox.mobileIsDemo = true;
  store.set('skipi_seafarer_my_contribution', '1');
  store.set('skipi_seafarer_my_contribution_fixture', 'established_contributor');
  ok(sandbox.trustContributionEnabled() === true, 'mobile feature flag is readable');
  sandbox.renderMobileProfile();
  await settle();
  let m = String((document.getElementById('mobile-main') || {}).innerHTML || '');
  ok(String(sandbox.renderMobileProfile).includes('my-contribution-mobile-entry'), 'mobile Profile renderer contains the flagged My contribution entry');
  sandbox.mobileShow('contribution');
  await settle();
  m = String((document.getElementById('mobile-main') || {}).innerHTML || '');
  ok(m.includes('data-qa="my-contribution-screen"'), 'mobile compact contribution screen renders');
  ok(m.includes('established_contributor'), 'mobile compact screen renders selected fixture band');
  ok(!m.includes('data-qa="my-contribution-events"'), 'mobile compact view omits the full event journal');
  ok(!/(score_mean|score_lower_bound|confidence|final_review_weight|token_id|raw_payload|payload_hash|email_hash|signature_raw)/i.test(m), 'mobile compact view omits score/hash/token/payload fields');
  ok(!/(approved|rejected|blacklist|legal|rating|оценка моряка|рейтинг моряка)/i.test(m), 'mobile compact wording guard is clean');
}

section('recovery email bind UI — feature flag and fixture mode');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  ok(typeof sandbox.recoveryBindEnabled === 'function', 'recoveryBindEnabled helper exists');
  ok(typeof sandbox.recoveryBindPanelHtml === 'function', 'recoveryBindPanelHtml renderer exists');
  ok(sandbox.recoveryBindEnabled() === false, 'recovery bind flag defaults OFF');
  sandbox.openSettings('vaults');
  await settle();
  let settingsHtml = String((document.getElementById('settings-body') || {}).innerHTML || '');
  ok(!settingsHtml.includes('data-qa="recovery-bind-section"'), 'flag-off recovery section is absent from settings');

  let fetchCalls = 0;
  sandbox.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 599, json: async () => ({}), text: async () => '' };
  };
  store.set('skipi_seafarer_recovery_bind', '1');
  sandbox.openSettings('vaults');
  await settle();
  settingsHtml = String((document.getElementById('settings-body') || {}).innerHTML || '');
  ok(settingsHtml.includes('data-qa="recovery-bind-section"'), 'flag-on recovery section renders in settings');
  ok(settingsHtml.includes('data-network="none"'), 'fixture recovery section declares network none');
  ok(/не логин|not your login/i.test(settingsHtml), 'copy states email is not login');
  ok(fetchCalls === 0, 'fixture recovery settings performs no network fetches');
  ok(!/(approved|rejected|blacklist|legal|рейтинг моряка|оценка моряка)/i.test(settingsHtml), 'recovery settings wording guard is clean');

  const token = sandbox.recoveryBindGenerateToken();
  ok(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){7,}$/.test(token), 'recovery token is grouped base32 and >=128 bits');
}

section('recovery email bind UI — live payload safety');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  store.set('skipi_seafarer_recovery_bind', '1');
  store.set('skipi_seafarer_recovery_bind_live', '1');
  sandbox.recoveryBindState.step = 'code';
  sandbox.recoveryBindState.email = 'sailor@example.test';
  sandbox.recoveryBindState.challengeId = 'challenge-0123456789abcdef';
  sandbox.recoveryBindState.token = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567';
  const rawToken = sandbox.recoveryBindState.token;

  const saved = document.createElement('input');
  saved.setAttribute('id', 'recovery-token-saved');
  saved.checked = false;
  const code = document.createElement('input');
  code.setAttribute('id', 'recovery-code-input');
  code.value = '123456';

  const fetchBodies = [];
  sandbox.recoveryBindContext = async () => ({ vault_user_id: 'u_self_demo', public_seafarer_id: 'sf_self_demo_01' });
  sandbox.trustContributionCreateSession = async () => 'self-session-token';
  sandbox.invoke = async (cmd) => {
    if (cmd === 'sign_identity_recovery_payload') return 'signed-recovery-payload';
    return {};
  };
  sandbox.apiFetch = async (url, opts = {}) => {
    fetchBodies.push(String(opts.body || ''));
    return { ok: true, status: 200, json: async () => ({ recovery_status: 'active', binding_id: 'binding-demo-1' }), text: async () => '' };
  };

  await sandbox.recoveryBindComplete();
  await settle();
  ok(fetchBodies.length === 0, 'blob is not uploaded until saved-token checkbox is checked');
  saved.checked = true;
  await sandbox.recoveryBindComplete();
  await settle();
  ok(fetchBodies.length === 1, 'live complete sends one API payload after checkbox');
  const body = fetchBodies.join('\n');
  ok(!body.includes(rawToken), 'raw recovery token is never sent to server');
  ok(!body.includes('sailor@example.test'), 'raw email is not sent in bind complete payload');
  ok(body.includes('recovery_blob') && body.includes('ciphertext_b64'), 'bind complete sends encrypted recovery blob metadata');
}

section('lost-device recovery UI — feature flag and fixture mode');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  ok(typeof sandbox.recoveryLostEnabled === 'function', 'recoveryLostEnabled helper exists');
  ok(typeof sandbox.recoveryLostPanelHtml === 'function', 'lost-device recovery renderer exists');
  ok(sandbox.recoveryLostEnabled() === false, 'lost-device recovery flag defaults OFF');
  sandbox.openSettings('vaults');
  await settle();
  let settingsHtml = String((document.getElementById('settings-body') || {}).innerHTML || '');
  ok(!settingsHtml.includes('data-qa="lost-recovery-section"'), 'flag-off lost-device recovery section is absent');

  let fetchCalls = 0;
  sandbox.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 599, json: async () => ({}), text: async () => '' };
  };
  store.set('skipi_seafarer_recovery_lost_device', '1');
  store.set('skipi-seafarer-recovery-bind-status-v1', JSON.stringify({ status: 'active', subject_id: 'SKP-SF-FIXTURE', vault_user_id: 'fixture-vault-user', binding_id: 'fixture-binding' }));
  sandbox.openSettings('vaults');
  await settle();
  settingsHtml = String((document.getElementById('settings-body') || {}).innerHTML || '');
  ok(settingsHtml.includes('data-qa="lost-recovery-section"'), 'flag-on lost-device recovery section renders');
  ok(settingsHtml.includes('data-network="none"'), 'fixture lost-device section declares network none');
  ok(settingsHtml.includes('data-qa="lost-recovery-old-device-notice"'), 'old-device cancel notice renders when recovery binding is active');
  ok(/not a login|не логин/i.test(settingsHtml), 'lost-device copy states email is recovery, not login');
  ok(fetchCalls === 0, 'fixture lost-device settings performs no network fetches');
  ok(!/(approved|rejected|blacklist|legal|fraud|rating|оценка моряка|рейтинг моряка)/i.test(settingsHtml), 'lost-device recovery wording guard is clean');

  const compact = sandbox.recoveryLostPanelHtml(true);
  ok(compact.includes('data-qa="lost-recovery-section"'), 'mobile compact lost-device panel renders');

  const email = document.createElement('input');
  email.setAttribute('id', 'lost-recovery-email-input');
  email.value = 'sailor@example.test';
  await sandbox.recoveryLostStart();
  await settle();
  const code = document.createElement('input');
  code.setAttribute('id', 'lost-recovery-code-input');
  code.value = '123456';
  await sandbox.recoveryLostVerifyCode();
  await settle();
  const token = document.createElement('input');
  token.setAttribute('id', 'lost-recovery-token-input');
  token.value = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567';
  sandbox.recoveryLostShow('token');
  await sandbox.recoveryLostReleaseBlob();
  await settle();
  ok(sandbox.recoveryLostState.step === 'done', 'fixture lost-device recovery reaches local done step');
  ok(fetchCalls === 0, 'fixture lost-device flow remains zero-fetch');
}

section('lost-device recovery UI — live payload safety');
{
  const { sandbox, document, store } = installRuntime(html);
  await settle();
  store.set('skipi_seafarer_recovery_lost_device', '1');
  store.set('skipi_seafarer_recovery_lost_device_live', '1');
  sandbox.recoveryLostState.challengeId = 'lost-challenge-0123456789abcdef';
  sandbox.recoveryLostState.step = 'token';
  const rawToken = 'LOST-TOKEN-ABCD-EFGH-IJKL-MNOP-QRST-UVWX';
  const token = document.createElement('input');
  token.setAttribute('id', 'lost-recovery-token-input');
  token.value = rawToken;
  const fixturePlain = sandbox.recoveryBindUtf8Bytes(JSON.stringify({ schema: 'skipi.identity.recovery_blob.v1', purpose: 'same-key-restore', fixture: true }));
  const fetchBodies = [];
  sandbox.recoveryBindContext = async () => ({ vault_user_id: 'u_self_demo', public_seafarer_id: 'sf_self_demo_01' });
  sandbox.invoke = async (cmd) => {
    if (cmd === 'sign_identity_recovery_payload') return 'signed-lost-recovery-payload';
    return {};
  };
  sandbox.apiFetch = async (url, opts = {}) => {
    fetchBodies.push(`${url}\n${String(opts.body || '')}`);
    if (String(url).includes('/release-blob')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'released',
          recovery_blob: {
            alg: 'AES-256-GCM-fixture-fallback',
            kdf: 'fixture',
            salt: '',
            nonce: 'fixture',
            ciphertext_b64: sandbox.recoveryBindToBase64(fixturePlain),
            hash: 'fixture-hash',
          },
        }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'completed' }), text: async () => '' };
  };

  await sandbox.recoveryLostReleaseBlob();
  await settle();
  ok(sandbox.recoveryLostState.step === 'done', 'live lost-device release decrypts blob locally before done');
  await sandbox.recoveryLostComplete('add');
  await settle();
  sandbox.recoveryLostState.challengeId = 'lost-challenge-0123456789abcdef';
  await sandbox.recoveryLostCancel();
  await settle();
  const body = fetchBodies.join('\n');
  ok(body.includes('/api/identity/recovery/release-blob'), 'release-blob endpoint is called in live mode');
  ok(body.includes('"recovery_token_present":true'), 'release payload sends only token-presence flag');
  ok(!body.includes(rawToken), 'raw lost-device recovery token is never sent to server');
  ok(body.includes('/api/identity/recovery/complete'), 'complete endpoint is called after local unlock');
  ok(body.includes('/api/identity/recovery/cancel'), 'old-device cancel endpoint is available');
  ok(!/(ciphertext_b64.*LOST-TOKEN|raw_token|recovery_token":)/i.test(body), 'live payloads do not include token material');
}

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

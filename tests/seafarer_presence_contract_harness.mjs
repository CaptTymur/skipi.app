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
    .filter(([, attrs]) => !/\ssrc\s*=/.test(attrs || ''))
    .map(([, , code]) => code);

  scripts.forEach((code, idx) => {
    try {
      vm.runInContext(code, sandbox, { filename: `dist/index.html#script-${idx + 1}` });
    } catch (e) {
      throw new Error(`inline script ${idx + 1} failed: ${e.stack || e.message}`);
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

console.log('\n' + (fail === 0 ? 'ALL GREEN' : 'FAILURES') + `: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

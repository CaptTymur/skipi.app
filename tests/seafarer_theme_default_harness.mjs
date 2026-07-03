// Fresh-install light theme contract for Seafarer.
//
// The app must first-launch in LIGHT theme: empty localStorage boots light
// even when the OS reports prefers-color-scheme: dark, an explicitly saved
// dark preference still boots dark, Reset appearance returns to light, and
// the plugin host theme bridge reports light on fresh launch (including its
// fallback paths). The harness mounts the real dist/index.html, executes the
// real inline scripts per scenario with a seeded localStorage and a
// controllable matchMedia, and asserts on the app's own boot result.
//
//   node tests/seafarer_theme_default_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');

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
  // Unlike the presence harness, documentElement mirrors the REAL <html> tag
  // attributes from dist/index.html: the pre-JS first paint theme is part of
  // this contract.
  constructor(sourceHtml) {
    this._ids = new Map();
    this._all = [];
    this._listeners = new Map();
    this.title = '';
    const htmlTag = /<html(\s[^>]*)?>/i.exec(sourceHtml);
    const htmlAttrs = parseAttrs(htmlTag ? htmlTag[1] : '');
    this.documentElement = this._makeElement('html', { id: '__html', ...htmlAttrs });
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
      if (tag.startsWith('!') || tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'html') continue;
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
    const s = String(selector || '').trim();
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

// Boots the real inline scripts with a seeded localStorage and a controllable
// prefers-color-scheme. Injects a capture-only SkipiPluginRuntime so
// bundledRuntime() hands us the real plugin host config (theme bridge).
function installRuntime(sourceHtml, { seed = {}, prefersDark = false } = {}) {
  const document = new FakeDocument(sourceHtml);
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const captured = { hostConfig: null };

  const tauriInvoke = async (cmd) => {
    if (cmd === 'get_build_info') return { version: '0.0.0-theme-harness', sha: 'theme-harness' };
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
      userAgent: 'Node Theme Harness',
      platform: 'Linux x86_64',
      onLine: true,
      clipboard: { writeText: async () => {} },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    location: { hash: '', pathname: '/theme-harness', reload() {} },
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
    matchMedia: (query) => ({
      matches: /prefers-color-scheme:\s*dark/.test(String(query)) ? prefersDark : false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    SkipiPluginRuntime: {
      create(config) {
        captured.hostConfig = config && config.host ? config.host : null;
        return { open() {}, close() {}, destroy() {} };
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    alert() {},
    confirm: () => true,
    prompt: () => null,
    Blob: class Blob {},
    FileReader: class FileReader {},
    Image: class Image {},
    URL: { createObjectURL: () => 'blob:theme-harness', revokeObjectURL() {} },
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

  return { sandbox, document, store, captured };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function themeAttr(document) {
  return document.documentElement.getAttribute('data-theme');
}

function bridgeThemeGet(sandbox, captured) {
  const runtime = sandbox.bundledRuntime ? sandbox.bundledRuntime() : null;
  if (!runtime || !captured.hostConfig || !captured.hostConfig.theme) return null;
  return captured.hostConfig.theme.get();
}

function inlineScriptSource() {
  return Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, attrs]) => !/\ssrc\s*=/.test(attrs || ''))
    .map(([, , code]) => code)
    .join('\n');
}

function assertStaticMarkup() {
  section('static markup: pre-JS first paint is light');
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  const attrs = parseAttrs(htmlTag ? htmlTag[1] : '');
  ok(!!htmlTag, '<html> tag found');
  ok(attrs['data-theme'] === 'light', '<html> carries static data-theme="light"');
  const js = inlineScriptSource();
  const darkFallbacks = js.match(/\|\|\s*'dark'/g) || [];
  ok(darkFallbacks.length === 0, `no ||'dark' fallback literals in inline scripts (found ${darkFallbacks.length})`);
  const darkCatch = js.match(/catch\s*\([^)]*\)\s*\{\s*return\s*'dark'/g) || [];
  ok(darkCatch.length === 0, `no catch-path 'dark' returns in inline scripts (found ${darkCatch.length})`);
}

async function assertFreshInstallLight() {
  section('fresh install: empty localStorage + OS prefers dark -> boots light');
  const { sandbox, document, store, captured } = installRuntime(html, { seed: {}, prefersDark: true });
  await settle();
  ok(themeAttr(document) === 'light', `data-theme after boot is light (got ${themeAttr(document)})`);
  ok(!store.has('skipi-theme'), 'boot does not silently persist a theme choice');
  ok(bridgeThemeGet(sandbox, captured) === 'light', 'plugin host theme bridge reports light on fresh launch');

  sandbox.settingsTab = 'appearance';
  let renderErr = null;
  try {
    sandbox.renderSettingsBody();
  } catch (e) {
    renderErr = e;
  }
  ok(!renderErr, `renderSettingsBody(appearance) renders${renderErr ? ': ' + renderErr.message : ''}`);
  const body = document.getElementById('settings-body');
  const bodyHtml = body ? body.innerHTML : '';
  ok(/<option value="light" selected>/.test(bodyHtml), 'settings picker shows Light selected on fresh install');
  ok(/<option value="dark"/.test(bodyHtml), 'Dark remains available as a user choice');
  ok(/<option value="system"/.test(bodyHtml), 'System remains available as a user choice');
}

async function assertSavedDarkPreserved() {
  section('saved preference: explicit dark still boots dark');
  const { sandbox, document, captured } = installRuntime(html, { seed: { 'skipi-theme': 'dark' }, prefersDark: false });
  await settle();
  ok(themeAttr(document) === 'dark', `data-theme after boot is dark (got ${themeAttr(document)})`);
  ok(bridgeThemeGet(sandbox, captured) === 'dark', 'plugin host theme bridge reports dark for saved dark preference');
}

async function assertSavedSystemFollowsOs() {
  section('saved preference: explicit system follows the OS');
  const dark = installRuntime(html, { seed: { 'skipi-theme': 'system' }, prefersDark: true });
  await settle();
  ok(themeAttr(dark.document) === 'dark', `system + OS dark boots dark (got ${themeAttr(dark.document)})`);
  const light = installRuntime(html, { seed: { 'skipi-theme': 'system' }, prefersDark: false });
  await settle();
  ok(themeAttr(light.document) === 'light', `system + OS light boots light (got ${themeAttr(light.document)})`);
}

async function assertResetReturnsLight() {
  section('reset appearance: returns to light, not dark');
  const { sandbox, document, store } = installRuntime(html, { seed: { 'skipi-theme': 'dark' }, prefersDark: true });
  await settle();
  ok(themeAttr(document) === 'dark', 'precondition: saved dark boots dark');
  let resetErr = null;
  try {
    sandbox.resetAppearance();
  } catch (e) {
    resetErr = e;
  }
  ok(!resetErr, `resetAppearance() runs${resetErr ? ': ' + resetErr.message : ''}`);
  ok(!store.has('skipi-theme'), 'reset clears the stored theme choice');
  ok(themeAttr(document) === 'light', `data-theme after reset is light (got ${themeAttr(document)})`);
}

async function assertUserCanStillChooseDark() {
  section('user choice: setTheme(dark) still switches to dark');
  const { sandbox, document, store } = installRuntime(html, { seed: {}, prefersDark: false });
  await settle();
  ok(themeAttr(document) === 'light', 'precondition: fresh boot is light');
  sandbox.setTheme('dark');
  ok(store.get('skipi-theme') === 'dark', 'setTheme persists the dark choice');
  ok(themeAttr(document) === 'dark', `data-theme after setTheme is dark (got ${themeAttr(document)})`);
}

async function assertFallbackPathsAreLight() {
  section('fallback paths: bridge and _resolvedTheme degrade to light');
  const { sandbox, document, captured } = installRuntime(html, { seed: {}, prefersDark: true });
  await settle();
  ok(bridgeThemeGet(sandbox, captured) === 'light', 'precondition: bridge reports light');
  document.documentElement.removeAttribute('data-theme');
  ok(bridgeThemeGet(sandbox, captured) === 'light', 'bridge falls back to light when data-theme is absent');
  document.documentElement.getAttribute = () => {
    throw new Error('boom');
  };
  ok(bridgeThemeGet(sandbox, captured) === 'light', 'bridge catch path falls back to light');
  sandbox.matchMedia = () => {
    throw new Error('no matchMedia');
  };
  ok(sandbox._resolvedTheme('system') === 'light', "_resolvedTheme('system') without matchMedia resolves light");
}

assertStaticMarkup();
await assertFreshInstallLight();
await assertSavedDarkPreserved();
await assertSavedSystemFollowsOs();
await assertResetReturnsLight();
await assertUserCanStillChooseDark();
await assertFallbackPathsAreLight();

console.log('');
if (fail > 0) {
  console.error(`FAILURES: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

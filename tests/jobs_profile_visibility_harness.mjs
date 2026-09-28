// Published crewing profiles inside the existing Jobs module — P2/S2b.
//
//   node tests/jobs_profile_visibility_harness.mjs
//
// WHAT THIS HOLDS
//
// The crewing side publishes a matching PROFILE (a rank + a vessel type + the
// certificates and extra requirements it wants). The seafarer must see it
// inside the Jobs module he already has — as a section of that screen, not a
// new screen — and only when four separate things are KNOWN. An unknown value
// is never a match. That rule has four call sites and each one gets its own
// assertion here:
//
//   U1  the profile's rank is unknown            -> that profile is not shown
//   U2  the profile's vessel type is unknown     -> that profile is not shown
//   U3  the seafarer's readiness is off OR unset -> the SECTION is not shown
//   U4  the seafarer's own rank or vessel type
//       is unset                                 -> the SECTION is not shown
//
// U4 is an inversion that exists in the shipped product on the neighbouring
// feed: `fetch_jobs` puts a filter in the query string only when the string is
// non-empty (`commands/jobs.rs`, `.filter(|s| !s.is_empty())`), and a server
// that answers an absent filter by not filtering hands a half-filled profile
// EVERY row there is. This surface refuses before the network instead.
//
// FIVE THINGS THIS HARNESS IS BUILT NOT TO GET WRONG
//
//  1. READINESS IS EXPRESSED BY MORE THAN ONE TOGGLE. `ready_for_offers` is
//     written by two profile checkboxes, the mobile wizard, two tab toggles and
//     the derived `jobsReadinessGate` (which writes `false` itself), and the
//     feed is closed at five points (`showJobs`, `loadJobsFeed`,
//     `checkNewJobsBackground`, `prewarmJobsFeedIfReady`, the mobile branch).
//     A probe that watches one desktop toggle is blind to the mobile path and
//     to the background poll. So this harness does not claim "readiness works";
//     it names the call sites the SECTION is loaded from, asserts that the set
//     is exactly those, and drives the rule at each of them.
//  2. `readyProfileMissingListHtml` IS A TRAP OF THE NAME. It exists in five
//     places and lists what the SEAFARER'S OWN profile is missing — not what a
//     crewing profile requires. Reusing it by name similarity produces a
//     plausible wrong screen, so it is asserted ABSENT from the new code.
//  3. "THE RESPONSE PARSES" IS NOT "THE USER SEES IT".
//     `VacancyPublic.compliance_profile_snapshot` has existed server-side for a
//     while with zero occurrences in `dist/` and `src-tauri/` — a parse test
//     would have been green over a completely invisible surface. Every
//     visibility assertion below reads the product's own rendered HTML after
//     the real `showJobs()` ran.
//  4. THE DESKTOP FEED CARD BODY IS NOT LOCALISED (`renderJobsFeed`: one
//     `tr(`, zero `getUiLang()`, literal Apply/Hide/months/Crewing:). There are
//     TWO localisation mechanisms in this file — inline tables keyed on
//     `getUiLang()` and the `tr()` dictionary — and a probe that sees one is
//     blind to the other. New strings here go through BOTH, and both are
//     asserted, in RU and in EN, on the rendered screen.
//  5. The Rust type must not make a NULL criterion fatal. `PublicVacancy.rank`
//     is a bare `String`: one profile with a null rank in that list would make
//     serde drop the WHOLE list and empty Jobs. Every criterion on the new
//     type is optional, and that is asserted.
//
// MEASUREMENT BOUNDARY, stated rather than implied: this is a source contract
// plus a DOM-shimmed run of the real inline scripts of `dist/index.html`. It is
// not a browser, not a build, and it does not reach the network or the server.
// `dist/vessel-db.js` (`loadVesselReviewContributionStats`,
// `renderReviewNudgeCard`) is stubbed — it is unrelated to this contract and
// outside the four files this task may touch.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
const jobsRs = fs.readFileSync(path.join(ROOT, 'src-tauri/src/commands/jobs.rs'), 'utf8');
const libRs = fs.readFileSync(path.join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ok  ' + msg);
  } else {
    fail++;
    failures.push(msg);
    console.error('  FAIL ' + msg);
  }
}

function section(title) {
  console.log('\n# ' + title);
}

// Body of the first `function name(` / `async function name(` (brace matched).
function fnBody(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function rustFnBody(src, name) {
  const re = new RegExp(`fn\\s+${name}\\s*[<(]`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function countOf(haystack, needle) {
  return (haystack.split(needle).length - 1);
}

// ---------------------------------------------------------------- DOM shim --

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw || ''))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

class StyleDecl {
  constructor(raw = '') {
    this._props = {};
    String(raw).split(';').forEach((part) => {
      const idx = part.indexOf(':');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      if (key) this.setProperty(key, part.slice(idx + 1).trim());
    });
  }
  setProperty(key, value) {
    const k = String(key || '').trim();
    if (!k) return;
    this._props[k] = String(value ?? '');
    this[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this._props[k];
  }
  getPropertyValue(key) { return this._props[String(key || '').trim()] || ''; }
  removeProperty(key) {
    const k = String(key || '').trim();
    const old = this._props[k] || '';
    delete this._props[k];
    return old;
  }
  toString() { return Object.entries(this._props).map(([k, v]) => `${k}:${v}`).join(';'); }
}

class ClassList {
  constructor(raw = '') { this._set = new Set(String(raw || '').split(/\s+/).filter(Boolean)); }
  add(...n) { n.flatMap((x) => String(x).split(/\s+/)).filter(Boolean).forEach((x) => this._set.add(x)); }
  remove(...n) { n.flatMap((x) => String(x).split(/\s+/)).filter(Boolean).forEach((x) => this._set.delete(x)); }
  contains(n) { return this._set.has(n); }
  toggle(n, force) {
    if (force === true) { this._set.add(n); return true; }
    if (force === false) { this._set.delete(n); return false; }
    if (this._set.has(n)) { this._set.delete(n); return false; }
    this._set.add(n); return true;
  }
  toString() { return Array.from(this._set).join(' '); }
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
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
    this.scrollTop = 0;
    this.clientWidth = 1024;
    this.clientHeight = 768;
    this.offsetWidth = 1024;
    this.classList = new ClassList(attrs.class || '');
    this.style = new StyleDecl(attrs.style || '');
    this._innerHTML = initialHtml;
    this._textContent = '';
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v ?? ''); }
  get textContent() { return this._textContent || this._innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  set textContent(v) { this._textContent = String(v ?? ''); this._innerHTML = this._textContent; }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new ClassList(v); }
  setAttribute(k, v) {
    const key = String(k);
    const val = String(v ?? '');
    this.attrs[key] = val;
    if (key === 'id') {
      if (this.id) this.ownerDocument._ids.delete(this.id);
      this.id = val;
      this.ownerDocument._ids.set(val, this);
    } else if (key === 'class') this.classList = new ClassList(val);
    else if (key === 'style') this.style = new StyleDecl(val);
    else this[key] = val;
  }
  getAttribute(k) {
    const key = String(k);
    if (key === 'class') return this.classList.toString();
    if (key === 'style') return this.style.toString();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
  removeAttribute(k) { delete this.attrs[String(k)]; }
  appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c) c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentHTML(_pos, markup) { this._innerHTML += String(markup ?? ''); }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 }; }
  querySelector(s) { return this.ownerDocument.querySelector(s); }
  querySelectorAll(s) { return this.ownerDocument.querySelectorAll(s); }
}

class FakeDocument {
  constructor(sourceHtml) {
    this._ids = new Map();
    this._all = [];
    this._listeners = new Map();
    this.title = '';
    const htmlTag = /<html(\s[^>]*)?>/i.exec(sourceHtml);
    this.documentElement = this._makeElement('html', { id: '__html', ...parseAttrs(htmlTag ? htmlTag[1] : '') });
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
      if (!attrs.id && !attrs['data-qa'] && !attrs['data-i18n']) continue;
      const close = sourceHtml.indexOf(`</${tag}>`, re.lastIndex);
      this._makeElement(tag, attrs, close >= 0 ? sourceHtml.slice(re.lastIndex, close) : '');
    }
  }
  getElementById(id) { return this._ids.get(String(id)) || null; }
  createElement(tagName) {
    const el = this._makeElement(tagName, {});
    if (String(tagName).toLowerCase() === 'canvas') {
      el.getContext = () => ({ drawImage() {}, fillRect() {}, clearRect() {}, getImageData: () => ({ data: [] }) });
      el.toDataURL = () => 'data:image/png;base64,';
    }
    return el;
  }
  createTextNode(t) { const el = this._makeElement('#text', {}); el.textContent = t; return el; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(selector) {
    const s = String(selector || '').trim();
    if (s.startsWith('#')) { const el = this.getElementById(s.slice(1)); return el ? [el] : []; }
    const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
    if (attr) {
      return this._all.filter((el) => {
        const actual = el.getAttribute(attr[1]);
        return actual !== null && (attr[2] === undefined || actual === attr[2]);
      });
    }
    if (s.startsWith('.')) return this._all.filter((el) => el.classList.contains(s.slice(1)));
    return this._all.filter((el) => el.tagName.toLowerCase() === s.toLowerCase());
  }
}

// ------------------------------------------------------------------ fixture --

// A profile the seafarer DOES match: same rank, same vessel type. The server
// has already done the normalised matching — the client's job is to know that
// an unknown value is not a match and to show what else is required.
const PROFILE_MATCH = {
  profile_id: 'prof-match-0001',
  crewing_id: 'crewing-alpha',
  published_version: 7,
  rank: 'Second Officer',
  vessel_type: 'Bulk Carrier',
  mandatory_certs: ['stcw_basic_safety', 'gmdss_goc', 'cert_not_in_catalog'],
  extra_requirements: [
    { id: 'tanker_experience', label: 'At least 12 months on bulk carriers', weight: 3 },
  ],
};

const PROFILE_NO_RANK = { ...PROFILE_MATCH, profile_id: 'prof-norank-0002', rank: null };
const PROFILE_NO_VESSEL = { ...PROFILE_MATCH, profile_id: 'prof-novt-0003', vessel_type: '   ' };
const PROFILE_NO_VERSION = { ...PROFILE_MATCH, profile_id: 'prof-nover-0004', published_version: null };

const CATALOG = {
  positions: [],
  vessel_types: [],
  certs: [
    { id: 'stcw_basic_safety', label: 'STCW Basic Safety Training', category: 'STCW', has_expiry: true },
    { id: 'gmdss_goc', label: 'GMDSS General Operator Certificate', category: 'STCW', has_expiry: true },
  ],
};

// One held certificate, one required-but-absent, one requirement the catalog
// has never heard of. Exactly the three states the surface must be able to say.
const DOCUMENTS = [
  { id: 'doc-1', template_id: 'stcw_basic_safety', file_name: 'stcw.pdf', is_permanent: true },
];

const PERSONAL_READY = {
  surname: 'Rudov',
  first_name: 'Tymur',
  date_of_birth: '1980-01-01',
  place_of_birth: 'Odesa',
  nationality: 'Ukraine',
  phones: '+100000000',
  email: 'seafarer@example.test',
  rank: 'Second Officer',
  preferred_vessel_types: 'Bulk Carrier',
  nearest_airport: 'ODS',
  nearest_intl_airport: 'IEV',
  available_from: '2026-11-01',
  min_salary: '4500',
  home_address: 'Test street 1',
  ready_for_offers: 'true',
};

const WORK_HISTORY = [
  { vessel_name: 'MV Harness', position: 'Third Officer', sign_on: '2022-01-01', sign_off: '2022-08-01' },
];

function makeInvoke(state) {
  return async (cmd, args) => {
    state.calls.push([cmd, args]);
    switch (cmd) {
      case 'get_seafarer_personal': return JSON.parse(JSON.stringify(state.personal));
      case 'set_seafarer_personal':
        Object.assign(state.personal, (args && args.fields) || {});
        state.writes.push((args && args.fields) || {});
        return {};
      case 'fetch_published_profiles':
        if (state.profilesThrow) throw new Error('published profiles unavailable');
        return JSON.parse(JSON.stringify(state.profiles));
      case 'get_documents':
        if (state.documentsThrow) throw new Error('vault locked');
        return JSON.parse(JSON.stringify(state.documents));
      case 'get_work_history': return JSON.parse(JSON.stringify(WORK_HISTORY));
      case 'get_jobs_readiness_status': return { document_missing: [] };
      case 'get_profile_status': return { required: [] };
      case 'fetch_jobs': return [];
      case 'get_my_identity': return {};
      case 'register_my_pubkey': return {};
      case 'get_build_info': return { version: '0.0.0-jobs-harness', sha: 'jobs-harness' };
      case 'get_platform': return 'linux';
      case 'get_vault_types': return [];
      case 'get_last_vault': return null;
      case 'get_recent_vaults': return [];
      case 'get_optional_categories': return [];
      case 'get_settings': return {};
      default: return {};
    }
  };
}

function boot(opts = {}) {
  const state = {
    calls: [],
    writes: [],
    personal: JSON.parse(JSON.stringify(opts.personal || PERSONAL_READY)),
    profiles: opts.profiles || [],
    documents: opts.documents === undefined ? DOCUMENTS : opts.documents,
    documentsThrow: !!opts.documentsThrow,
    profilesThrow: !!opts.profilesThrow,
  };
  const document = new FakeDocument(html);
  const store = new Map([
    ['skipi-ui-language', opts.lang || 'en'],
    ['skipi-theme', 'light'],
    ['skipi-catalog', JSON.stringify({ fetched_at: Date.now(), version: 1, payload: CATALOG })],
  ]);
  const invoke = makeInvoke(state);

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document,
    navigator: { userAgent: 'Node Jobs Harness', platform: 'Linux x86_64', onLine: true, clipboard: { writeText: async () => {} } },
    location: { hash: '', pathname: '/jobs-harness', href: 'app://jobs-harness', reload() {} },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: webcrypto,
    __TAURI__: {
      core: { invoke, convertFileSrc: (p) => p },
      invoke,
      event: { listen: async () => () => {} },
      window: { getCurrentWindow: () => ({ setTitle: async () => {} }) },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    SkipiPluginRuntime: { create: () => ({ open() {}, close() {}, destroy() {} }) },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    scrollTo() {},
    alert() {},
    confirm: () => true,
    prompt: () => null,
    Blob: class Blob {},
    FileReader: class FileReader {},
    Image: class Image {},
    URL: { createObjectURL: () => 'blob:jobs-harness', revokeObjectURL() {} },
    // dist/vessel-db.js — outside this task's four files, stubbed on purpose.
    loadVesselReviewContributionStats: async () => ({}),
    renderReviewNudgeCard: () => '',
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, attrs]) => !/\ssrc\s*=/.test(attrs || ''))
    .forEach(([, , code], idx) => {
      try {
        vm.runInContext(code, sandbox, { filename: `dist/index.html#script-${idx + 1}` });
      } catch (e) {
        throw new Error(`inline script ${idx + 1} failed: ${e.stack || e.message}`);
      }
    });

  // The Jobs screen writes its sections with innerHTML; the shim keeps
  // innerHTML as a string and does not build children from it, so the section
  // host is pre-created here exactly as the browser would have it.
  const profilesHost = document.createElement('div');
  profilesHost.setAttribute('id', 'jobs-profiles-host');
  const feedHost = document.createElement('div');
  feedHost.setAttribute('id', 'jobs-feed');

  return { sandbox, document, store, state, profilesHost, feedHost };
}

async function settle(turns = 80) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// Runs the real Jobs screen entry point and returns what is on screen.
async function renderJobsScreen(opts = {}) {
  const booted = boot(opts);
  let error = null;
  try {
    await booted.sandbox.showJobs();
  } catch (e) {
    error = e;
  }
  await settle();
  const screen = booted.document.getElementById('scr-content');
  return {
    ...booted,
    error,
    screenHtml: screen ? screen.innerHTML : '',
    sectionHtml: booted.profilesHost.innerHTML,
  };
}

// ------------------------------------------------- S. source-level contract --

section('S. the client actually asks the published-profiles surface');

ok(/#\[tauri::command\]\s*pub fn fetch_published_profiles/.test(jobsRs),
  'S1 jobs.rs exposes a fetch_published_profiles command');
ok(jobsRs.includes('/api/published-profiles'),
  'S2 jobs.rs calls GET /api/published-profiles (the profiles surface, not the vacancy board)');
ok(/jobs::fetch_published_profiles/.test(libRs),
  'S3 lib.rs registers jobs::fetch_published_profiles in the invoke handler');

const publishedStruct = (() => {
  const i = jobsRs.indexOf('pub struct PublishedProfile {');
  if (i < 0) return null;
  const open = jobsRs.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < jobsRs.length; j++) {
    if (jobsRs[j] === '{') depth++;
    else if (jobsRs[j] === '}') { depth--; if (depth === 0) return jobsRs.slice(open + 1, j); }
  }
  return null;
})();
ok(publishedStruct !== null, 'S4 jobs.rs declares a PublishedProfile struct for the surface');
if (publishedStruct) {
  // The B4 lesson, from the neighbouring type: `PublicVacancy.rank` is a bare
  // `String`, so ONE row with a null rank makes serde fail the whole list and
  // Jobs goes empty. Every criterion here is optional; "absent" must arrive as
  // a value this code can refuse, not as a parse error for everyone else.
  ['rank', 'vessel_type', 'published_version'].forEach((field) => {
    const re = new RegExp(`pub ${field}:\\s*Option<`);
    ok(re.test(publishedStruct), `S5 PublishedProfile.${field} is Option<..> — one null criterion cannot empty the whole list`);
  });
  ok(/#\[serde\(default\)\]/.test(publishedStruct), 'S6 PublishedProfile defaults absent fields instead of failing the parse');
}

const fetchProfilesBody = rustFnBody(jobsRs, 'fetch_published_profiles');
ok(fetchProfilesBody !== null, 'S7 fetch_published_profiles body found');
if (fetchProfilesBody) {
  // U4, native call site: refuse BEFORE the request. `fetch_jobs` above omits
  // an empty filter from the query string; a surface that answers an absent
  // filter by not filtering would then return everything.
  const guardIdx = fetchProfilesBody.search(/is_empty\(\)/);
  const requestIdx = fetchProfilesBody.indexOf('/api/published-profiles');
  ok(guardIdx >= 0 && requestIdx >= 0 && guardIdx < requestIdx,
    'S8 U4 native: an empty rank or vessel type is refused BEFORE the request is built');
  ok(/return Ok\(Vec::new\(\)\)|return Ok\(vec!\[\]\)/.test(fetchProfilesBody),
    'S9 U4 native: the refusal answers with an empty list, it does not fall through to an unfiltered query');
}

section('S. the vacancy board is untouched (IMO filter not weakened, no invented IMO)');

const fetchJobsBody = rustFnBody(jobsRs, 'fetch_jobs');
ok(fetchJobsBody !== null && fetchJobsBody.includes('/api/vacancies?limit=100'),
  'S10 fetch_jobs still reads /api/vacancies unchanged');
ok(countOf(html, 'jobsConcreteVesselItems(') >= 5,
  'S11 the client still filters the vacancy feed on a concrete vessel in five places');
const imoLiterals = (jobsRs.match(/\b\d{7}\b/g) || []).filter((n) => n !== '1000000');
ok(imoLiterals.length === 0, `S12 jobs.rs invents no IMO number (found ${imoLiterals.join(',') || 'none'})`);

// ------------------------------------------------- D. dist wiring contracts --

section('D. the section lives inside the existing Jobs screen and nowhere else');

const showJobsBody = fnBody(html, 'showJobs');
ok(showJobsBody !== null, 'D1 showJobs() found');
ok(showJobsBody !== null && showJobsBody.includes('jobs-profiles-host'),
  'D2 showJobs() emits the published-profiles section host inside the Jobs screen');
ok(showJobsBody !== null && /loadJobsProfiles\(/.test(showJobsBody),
  'D3 showJobs() loads the published profiles');

const mobileJobsBody = fnBody(html, 'mobileRenderJobsContent');
ok(mobileJobsBody !== null && mobileJobsBody.includes('jobs-profiles-host'),
  'D4 the mobile Jobs branch carries the same section host (readiness rule holds on both paths)');
const renderMobileJobsBody = fnBody(html, 'renderMobileJobs');
ok(renderMobileJobsBody !== null && /loadJobsProfiles\(/.test(renderMobileJobsBody),
  'D5 the mobile Jobs branch loads the published profiles through the same loader');

// The set of call sites is named, not assumed: a sixth one appearing without a
// readiness check is the way this rule quietly stops holding.
const loaderCallSites = countOf(html, 'loadJobsProfiles(') - countOf(html, 'function loadJobsProfiles(');
ok(loaderCallSites === 2,
  `D6 the section is loaded from exactly two call sites, desktop and mobile (found ${loaderCallSites})`);

const loaderBody = fnBody(html, 'loadJobsProfiles');
ok(loaderBody !== null, 'D7 loadJobsProfiles() found');
if (loaderBody) {
  // Trap of the name: readyProfileMissingListHtml lists what the SEAFARER'S
  // OWN profile lacks. It is not the crewing profile's requirements.
  ok(!loaderBody.includes('readyProfileMissingListHtml'),
    'D8 the loader does not reuse readyProfileMissingListHtml (that list is the seafarer\'s own gaps)');
}
const sectionBody = fnBody(html, 'jobsProfilesSectionHtml');
ok(sectionBody !== null, 'D9 jobsProfilesSectionHtml() found');
if (sectionBody) {
  ok(!sectionBody.includes('readyProfileMissingListHtml'),
    'D10 the section renderer does not reuse readyProfileMissingListHtml');
  ok(!sectionBody.includes('requirements_matrix'),
    'D11 the requirement surface is computed from the profile snapshot, not from the seafarer\'s requirements matrix');
}

section('D. both localisation mechanisms carry the new strings');

const uiStrings = html.slice(html.indexOf('var UI_STRINGS'), html.indexOf('function getUiLang()'));
const enBlock = uiStrings.slice(uiStrings.indexOf('en:{'), uiStrings.indexOf('ru:{'));
const ruBlock = uiStrings.slice(uiStrings.indexOf('ru:{'), uiStrings.indexOf('tl:{') > 0 ? uiStrings.indexOf('tl:{') : uiStrings.length);
const NEW_KEYS = [
  'jobs.profiles.title',
  'jobs.profiles.sub',
  'jobs.profiles.empty',
  'jobs.profiles.requirements',
  'jobs.profiles.unknown_note',
  'jobs.profiles.version',
  'jobs.profiles.error',
  'jobs.profiles.no_requirements',
];
NEW_KEYS.forEach((k) => {
  ok(enBlock.includes(`'${k}'`), `D12 tr() dictionary carries ${k} in EN`);
  ok(ruBlock.includes(`'${k}'`), `D13 tr() dictionary carries ${k} in RU`);
});
if (sectionBody) {
  ok(sectionBody.includes('tr('), 'D14 the section renderer uses the tr() dictionary mechanism');
  ok(sectionBody.includes('getUiLang('), 'D15 the section renderer also uses the inline getUiLang() mechanism (the desktop card body around it is not localised at all)');
}

// ------------------------------------------- V. what the seafarer can see --

section('V. control — a matching published profile is visible on the Jobs screen');

const control = await renderJobsScreen({ profiles: [PROFILE_MATCH] });
ok(!control.error, `V0 showJobs() runs${control.error ? ': ' + control.error.message : ''}`);
ok(control.screenHtml.includes('jobs-profiles-host'),
  'V1 the Jobs screen contains the published-profiles section (a section of Jobs, not a new screen)');
ok(control.sectionHtml.includes(PROFILE_MATCH.profile_id) || control.sectionHtml.includes('Second Officer'),
  'V2 the matching published profile is rendered in the section');
ok(control.sectionHtml.includes('Bulk Carrier'),
  'V3 the profile\'s vessel type criterion is on screen');
const askedWith = control.state.calls.filter((c) => c[0] === 'fetch_published_profiles').map((c) => c[1]);
ok(askedWith.length === 1, `V4 the surface is asked exactly once per screen render (got ${askedWith.length})`);
ok(askedWith.length > 0 && String(askedWith[0].rank || '').trim() === 'Second Officer'
   && String(askedWith[0].vesselType || askedWith[0].vessel_type || '').trim() === 'Bulk Carrier',
  'V5 the request carries the seafarer\'s OWN rank and vessel type (a non-matching seafarer gets a different answer)');

section('V. U1 — a profile whose rank is unknown is not shown');

const u1 = await renderJobsScreen({ profiles: [PROFILE_NO_RANK, PROFILE_MATCH] });
ok(!u1.sectionHtml.includes(PROFILE_NO_RANK.profile_id),
  'V6 U1 the rank-less profile is absent from the section');
ok(u1.sectionHtml.includes(PROFILE_MATCH.profile_id) || u1.sectionHtml.includes('Second Officer'),
  'V7 U1 one bad row does not take the good one down with it (the whole list still renders)');

section('V. U2 — a profile whose vessel type is unknown is not shown');

const u2 = await renderJobsScreen({ profiles: [PROFILE_NO_VESSEL, PROFILE_MATCH] });
ok(!u2.sectionHtml.includes(PROFILE_NO_VESSEL.profile_id),
  'V8 U2 the vessel-type-less profile is absent from the section');
ok(u2.sectionHtml.includes(PROFILE_MATCH.profile_id) || u2.sectionHtml.includes('Second Officer'),
  'V9 U2 the good row still renders beside it');

section('V. the criteria shown are the ones that were PUBLISHED, not live values');

const uSnap = await renderJobsScreen({ profiles: [PROFILE_NO_VERSION, PROFILE_MATCH] });
ok(!uSnap.sectionHtml.includes(PROFILE_NO_VERSION.profile_id),
  'V10 a row with no published version is not snapshot-backed and is not shown');
ok(uSnap.sectionHtml.includes('data-profile-version="7"'),
  'V11 the published version of the criteria is on screen (they belong to a publication, not to the live row)');

section('V. U3 — readiness off OR unset: the section is not shown at all');

for (const [label, personal] of [
  ['off', { ...PERSONAL_READY, ready_for_offers: 'false' }],
  ['unset', (() => { const p = { ...PERSONAL_READY }; delete p.ready_for_offers; return p; })()],
]) {
  const u3 = await renderJobsScreen({ personal, profiles: [PROFILE_MATCH] });
  ok(u3.sectionHtml === '', `V12 U3 (${label}) the section is empty — not an empty state, no section`);
  ok(!u3.screenHtml.includes('jobs-profiles-host'), `V13 U3 (${label}) the Jobs screen does not even emit the section host`);
  ok(u3.state.calls.filter((c) => c[0] === 'fetch_published_profiles').length === 0,
    `V14 U3 (${label}) the surface is never asked while readiness is not an explicit yes`);
}

section('V. U4 — the seafarer\'s own rank or vessel type unset: the section is not shown at all');

for (const [label, patch] of [
  ['no rank', { rank: '' }],
  ['no vessel type', { preferred_vessel_types: '' }],
  ['whitespace rank', { rank: '   ' }],
]) {
  const personal = { ...PERSONAL_READY, ...patch };
  const u4 = await renderJobsScreen({ personal, profiles: [PROFILE_MATCH] });
  ok(u4.sectionHtml === '', `V15 U4 (${label}) the section is empty`);
  ok(u4.state.calls.filter((c) => c[0] === 'fetch_published_profiles').length === 0,
    `V16 U4 (${label}) the surface is never asked without both of the seafarer's own criteria`);
}

// The loader's own guard, driven directly: the screen path above also passes
// through jobsReadinessGate, which would hide the section for its own reasons.
// This asserts the rule at THIS call site, so removing it here is red even
// though the neighbouring gate still exists.
section('V. U3/U4 at the loader\'s own call site, independent of jobsReadinessGate');

for (const [label, personal] of [
  ['readiness unset', (() => { const p = { ...PERSONAL_READY }; delete p.ready_for_offers; return p; })()],
  ['readiness off', { ...PERSONAL_READY, ready_for_offers: 'false' }],
  ['own rank unset', { ...PERSONAL_READY, rank: '' }],
  ['own vessel type unset', { ...PERSONAL_READY, preferred_vessel_types: '' }],
]) {
  const booted = boot({ personal, profiles: [PROFILE_MATCH] });
  booted.profilesHost.innerHTML = 'PRE-EXISTING';
  let err = null;
  try {
    await booted.sandbox.loadJobsProfiles(JSON.parse(JSON.stringify(personal)));
  } catch (e) { err = e; }
  await settle();
  ok(!err, `V17 (${label}) loadJobsProfiles runs${err ? ': ' + err.message : ''}`);
  ok(booted.profilesHost.innerHTML === '', `V18 (${label}) the loader clears the section rather than leaving it standing`);
  ok(booted.state.calls.filter((c) => c[0] === 'fetch_published_profiles').length === 0,
    `V19 (${label}) the loader asks nothing`);
}

// ------------------------------------ R. "what else this profile requires" --

section('R. the requirement surface — have / missing / unknown, and unknown is not have');

const req = await renderJobsScreen({ profiles: [PROFILE_MATCH] });
ok(req.sectionHtml.includes('STCW Basic Safety Training'),
  'R1 a required certificate the seafarer holds is named');
ok(req.sectionHtml.includes('GMDSS General Operator Certificate'),
  'R2 a required certificate the seafarer does not hold is named');
ok(req.sectionHtml.includes('At least 12 months on bulk carriers'),
  'R3 the crewing\'s free-form extra requirement is named');
ok(/data-req-state="have"/.test(req.sectionHtml),
  'R4 the held certificate is marked as held');
ok(/data-req-state="missing"/.test(req.sectionHtml),
  'R5 the absent certificate is marked as absent');
ok(/data-req-state="unknown"/.test(req.sectionHtml),
  'R6 a requirement the app cannot verify is marked UNKNOWN, not held');
ok(countOf(req.sectionHtml, 'data-req-state="have"') === 1,
  `R7 exactly one requirement is claimed as held (got ${countOf(req.sectionHtml, 'data-req-state="have"')})`);

// The vault could not be read: nothing may be claimed as held.
const reqUnknown = await renderJobsScreen({ profiles: [PROFILE_MATCH], documentsThrow: true });
ok(countOf(reqUnknown.sectionHtml, 'data-req-state="have"') === 0,
  'R8 when the documents cannot be read, NOTHING is marked as held');
ok(countOf(reqUnknown.sectionHtml, 'data-req-state="unknown"') >= 3,
  'R9 when the documents cannot be read, every requirement is unknown');
ok(reqUnknown.sectionHtml.length > 0 && reqUnknown.screenHtml.includes('jobs-profiles-host'),
  'R10 an unreadable vault hides no profile — it only makes the answers unknown');

section('R. being listed is not the same as meeting the requirements — and it says so');

for (const [lang, phrase] of [['en', 'does not mean'], ['ru', 'не означает']]) {
  const r = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang });
  ok(r.sectionHtml.toLowerCase().includes(phrase),
    `R11 (${lang}) the section says on screen that being listed is not full compliance`);
}

// ------------------------------------------------------- L. RU/EN on screen --

section('L. the new strings are real in both languages on the rendered screen');

const en = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'en' });
const ru = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'ru' });
ok(/[Ѐ-ӿ]/.test(ru.sectionHtml), 'L1 the RU render contains Cyrillic in the section');
ok(!/[Ѐ-ӿ]/.test(en.sectionHtml), 'L2 the EN render contains no Cyrillic in the section');
ok(en.sectionHtml !== ru.sectionHtml, 'L3 the two renders actually differ');
ok(ru.sectionHtml.includes('неизвестно'), 'L4 the RU render says "неизвестно" for what cannot be verified');
ok(en.sectionHtml.toLowerCase().includes('unknown'), 'L5 the EN render says "unknown" for what cannot be verified');

section('L. an error on the surface is a visible, localised failure — not a silent empty section');

for (const [lang, marker] of [['en', /[A-Za-z]/], ['ru', /[Ѐ-ӿ]/]]) {
  const e = await renderJobsScreen({ profiles: [], profilesThrow: true, lang });
  ok(e.sectionHtml.length > 0 && marker.test(e.sectionHtml),
    `L6 (${lang}) a failing surface renders a localised message instead of nothing`);
}

console.log('');
if (fail > 0) {
  console.error(`FAILURES (${fail}):`);
  failures.forEach((f) => console.error('  - ' + f));
  console.error(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

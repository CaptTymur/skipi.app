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
const cargoToml = fs.readFileSync(path.join(ROOT, 'src-tauri/Cargo.toml'), 'utf8');
// Every .rs file of the crate, so "exactly once in src-tauri/src" is a claim
// about the crate and not about one file that happens to be open.
const allRustSrc = (function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.rs')) acc.push([full, fs.readFileSync(full, 'utf8')]);
  }
  return acc;
})(path.join(ROOT, 'src-tauri/src'), []);

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

// Line comments are not code paths. A gate is asserted over code, so the prose
// that explains WHY the gate exists cannot fail the assertion that enforces it.
function withoutLineComments(src) {
  return String(src || '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

function countOf(haystack, needle) {
  return (haystack.split(needle).length - 1);
}

// The brace-matched block that OPENS at the first `{` at or after `marker`.
// Used where a claim is positional — "this token is inside that block" — because
// a substring search over the whole file answers a different question.
function blockAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = src.indexOf('{', at + marker.length - 1);
  if (open < 0) return null;
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

// The innermost brace-block that CONTAINS `index` — the mirror of `blockAfter`,
// walking backwards. A claim about what a lock is held ACROSS is positional in
// exactly this way, and a substring search over the function answers a
// different question.
function enclosingBlock(src, index) {
  let depth = 0;
  let open = -1;
  for (let i = index; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(open + 1, i);
    }
  }
  return null;
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

// STANDS IN FOR `vault_info`, AND THE FACT THAT IT OUTLIVES `boot()` IS THE TEST.
// The harness rebuilds localStorage on every boot, so a response id kept there
// would look stable inside one run and be gone after a restart — the exact
// difference this map exists to expose. Keyed by profile id, like the real
// `profile_response_id:<profile_id>` rows.
const VAULT_RESPONSE_IDS = new Map();
let vaultIdCounter = 0;

// THREE VAULT STATES, and the middle one is the whole point of the S4d gate.
// `IDENTITY_ID_NO_KEY` is reachable in the shipped product — a restored backup
// carries the id and not the server-side identity, and so does every vault that
// claimed an id through the legacy settings tab — and in it the respond button
// answers 401 with no way left to fix it.
const IDENTITY_READY = {
  public_seafarer_id: 'SKP-HARNESS-0001',
  identity_key_registered_at: '2026-09-29T00:00:00Z',
};
const IDENTITY_NONE = { public_seafarer_id: '', identity_key_registered_at: '' };
const IDENTITY_ID_NO_KEY = { public_seafarer_id: 'SKP-HARNESS-0001', identity_key_registered_at: '' };

function makeInvoke(state) {
  return async (cmd, args) => {
    state.calls.push([cmd, args]);
    switch (cmd) {
      case 'jobs_response_endpoint':
        // A build that cannot say which server it talks to is a REAL state, not
        // a hypothetical: the command is infallible in Rust today, and the guards
        // that depend on it are written fail-closed precisely so that a future
        // where it is not cannot quietly become a write into production.
        if (state.endpointThrows) throw new Error('command not registered');
        return state.endpoint;
      case 'ensure_profile_response_id': {
        if (state.responseIdThrows) throw new Error('No vault open');
        const pid = String((args && args.profileId) || '');
        // Exactly what the Rust command does: return the stored id, and only
        // mint one when there is none.
        if (!VAULT_RESPONSE_IDS.has(pid)) {
          vaultIdCounter += 1;
          VAULT_RESPONSE_IDS.set(pid, `11111111-2222-4333-8444-00000000000${vaultIdCounter}`);
        }
        return VAULT_RESPONSE_IDS.get(pid);
      }
      case 'get_downloads_dir': return '/tmp/jobs-harness-downloads';
      case 'export_redacted_cv_pdf':
        if (state.cvThrows) throw new Error('vault locked');
        return {};
      case 'submit_profile_response':
        state.submits.push((args && { ...args, cvBase64: undefined }) || {});
        if (state.submitThrows) throw new Error(state.submitThrows);
        return state.submitAck;
      // The pair the respond button needs: an id the agency answers to, and an
      // identity the server has on file for this vault. The default is a vault
      // that has both, because that is the state every assertion written before
      // S4d was written in.
      case 'seafarer_identity_entry_state':
        if (state.identityStateThrows) throw new Error('No vault open');
        return JSON.parse(JSON.stringify(state.identity));
      case 'ensure_seafarer_identity':
        state.ensureCalls.push(args || {});
        if (state.ensureThrows) throw new Error(state.ensureThrows);
        return JSON.parse(JSON.stringify(state.ensureResult));
      case 'get_matchable_profile':
        return { user_id: 'harness-vault-user', public_seafarer_id: state.identity.public_seafarer_id };
      case 'register_my_identity_pubkey': return {};
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
      case 'get_feedback_prompt_state':
        // The state a build on its THIRD launch with no rating submitted gets
        // back (feedback.rs, FIRST_PROMPT_LAUNCHES = 3) — i.e. the one that
        // opens the dialog with nobody asking.
        return JSON.parse(JSON.stringify(state.feedbackPromptState));
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
    submits: [],
    endpoint: opts.endpoint === undefined ? { base: 'https://api.skipi.app', stand: false } : opts.endpoint,
    endpointThrows: !!opts.endpointThrows,
    submitAck: opts.submitAck === undefined
      ? { delivered: true, response_id: 'r', profile_id: 'p', crewing_id: 'c', published_version: 7, intake_id: 'intake-0001', content_sha256: 'abc', created_at: '2026-09-28T00:00:00Z' }
      : opts.submitAck,
    submitThrows: opts.submitThrows || '',
    cvThrows: !!opts.cvThrows,
    responseIdThrows: !!opts.responseIdThrows,
    identity: opts.identity === undefined ? { ...IDENTITY_READY } : { ...opts.identity },
    identityStateThrows: !!opts.identityStateThrows,
    feedbackPromptState: opts.feedbackPromptState === undefined
      ? { should_prompt: true } : opts.feedbackPromptState,
    ensureCalls: [],
    ensureThrows: opts.ensureThrows || '',
    ensureResult: opts.ensureResult === undefined
      ? {
          public_seafarer_id: 'SKP-HARNESS-0002',
          identity_key_registered_at: '2026-09-29T00:10:00Z',
          identity_key_status: 'registered',
          claim_status: 'created',
          trust_level: 'identity_claimed',
        }
      : opts.ensureResult,
  };
  // TIMERS ARE STILL NEVER RUN BY THIS SHIM — they are only RECORDED, which
  // changes nothing for every assertion written before this line. One driver
  // then runs the ONE callback it names (the 90-second rating prompt); turning
  // timers on globally would fire update checks and the forced-profile overlay
  // in every other test.
  const scheduled = [];
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
    setTimeout: (fn, ms) => { scheduled.push([fn, Number(ms) || 0]); return scheduled.length; },
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

  // Same reason as the two hosts above: the shim keeps innerHTML as a string and
  // does not build children from it, so the nodes the respond flow writes into
  // are pre-created here exactly as a browser would already have them.
  const respondNodes = new Map();
  for (const pid of (opts.respondFor || [])) {
    const status = document.createElement('div');
    status.setAttribute('id', 'jobs-respond-status-' + pid);
    const btn = document.createElement('button');
    btn.setAttribute('id', 'jobs-respond-btn-' + pid);
    respondNodes.set(pid, { status, btn });
  }

  return { sandbox, document, store, state, profilesHost, feedHost, respondNodes, scheduled };
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

// Runs the REAL respond handler of the real inline scripts and returns the
// status line it left on screen, plus every invoke it made.
async function runRespond(opts = {}) {
  const pid = opts.profileId || PROFILE_MATCH.profile_id;
  const booted = boot({ ...opts, respondFor: [pid] });
  let error = null;
  try {
    await booted.sandbox.jobsRespondToProfile(pid);
  } catch (e) {
    error = e;
  }
  await settle();
  const nodes = booted.respondNodes.get(pid);
  return {
    ...booted,
    error,
    statusHtml: nodes ? nodes.status.innerHTML : '',
    statusState: nodes ? nodes.status.getAttribute('data-respond-state') : null,
    buttonDisabled: nodes ? nodes.btn.disabled : null,
    submits: booted.state.submits,
  };
}

// Renders the real Jobs screen for a vault that cannot respond yet, then runs
// the REAL identity handler the step's button is wired to, and returns what the
// section looks like afterwards.
//
// The two nodes are pre-created for the same reason `runRespond` pre-creates
// its own: the shim keeps innerHTML as a string and does not build children
// from it, so the status line and the button the handler writes into are put
// where a browser would already have them.
async function runEnsureIdentity(opts = {}) {
  const pid = opts.profileId || PROFILE_MATCH.profile_id;
  const rendered = await renderJobsScreen({
    profiles: [PROFILE_MATCH],
    identity: IDENTITY_NONE,
    ...opts,
  });
  const status = rendered.document.createElement('div');
  status.setAttribute('id', 'jobs-identity-status-' + pid);
  const btn = rendered.document.createElement('button');
  btn.setAttribute('id', 'jobs-identity-btn-' + pid);
  let ensureError = null;
  try {
    await rendered.sandbox.jobsEnsureSkipiId(pid);
  } catch (e) {
    ensureError = e;
  }
  await settle();
  return {
    ...rendered,
    ensureError,
    statusHtml: status.innerHTML,
    statusState: status.getAttribute('data-respond-state'),
    buttonDisabled: btn.disabled,
    sectionHtml: rendered.profilesHost.innerHTML,
  };
}

// Runs the REAL "Join the crew" confirmation of the real inline scripts, far
// enough to see WHICH identity registration it chose. The signing step after it
// is left to fail: nothing asserted here depends on the join completing, and a
// completed join would post to `/api/onboard/crew/accept` through `apiFetch`.
async function runJoinAccept(opts = {}) {
  const booted = boot(opts);
  await settle();
  booted.state.calls.length = 0;   // startup is not what this measures
  booted.sandbox.myVessel.stage = 'confirm';
  booted.sandbox.myVessel.acceptCode = 'HARNESS-CODE';
  booted.sandbox.myVessel.resolved = { vessel_name: 'MV Harness', vessel_imo: '9000001' };
  let error = null;
  try { await booted.sandbox.myVesselAccept(); } catch (e) { error = e; }
  await settle();
  return {
    ...booted,
    error,
    calls: booted.state.calls.map((c) => c[0]),
    stage: booted.sandbox.myVessel.stage,
    blocked: String(booted.sandbox.myVessel.error || ''),
  };
}

// Runs the REAL diagnostics reporter, by the same door `window.onerror` uses.
async function runDiagnostic(opts = {}) {
  const booted = boot(opts);
  await settle();
  booted.state.calls.length = 0;
  await booted.sandbox.reportAppDiagnostic('js_error', 'error', 'harness probe', { stack: 'harness' });
  await settle();
  return { ...booted, calls: booted.state.calls.map((c) => c[0]) };
}

// The STARTUP report, which is the one nobody presses: `init()` calls
// `startAppDiagnostics()` on its own, and a previous session that did not close
// cleanly is posted from there.
async function runStartup(opts = {}) {
  const booted = boot(opts);
  await settle();
  return { ...booted, calls: booted.state.calls.map((c) => c[0]) };
}

// Runs the REAL rating prompt the way the product does: `loadVault` calls
// `maybePromptForFeedback`, which schedules ONE 90-second callback. The callback
// is found by its delay and run here — no other timer of the app is touched.
async function runFeedbackPrompt(opts = {}) {
  const booted = boot(opts);
  await settle();
  booted.state.calls.length = 0;
  booted.scheduled.length = 0;
  booted.sandbox.maybePromptForFeedback('harness');
  const timer = booted.scheduled.find(([, ms]) => ms === 90000);
  // A SHIM ARTIFACT, dropped on purpose and named rather than worked around:
  // FakeDocument parses every `<tag id=...>` it finds in the file, including the
  // markup that lives INSIDE an inline script as a string literal. So
  // `#app-feedback-overlay` "exists" before anything opened it, and the
  // product's own "a dialog is already up" check would return before reaching
  // the guard — which would make the two refusals below green over nothing.
  // That is what the release control (N18b) is here to catch, and it did.
  booted.document._ids.delete('app-feedback-overlay');
  // The product's own callback swallows everything; so does this.
  if (timer) { try { await timer[0](); } catch (e) { /* as the product does */ } }
  await settle();
  return {
    ...booted,
    scheduledMs: timer ? timer[1] : null,
    calls: booted.state.calls.map((c) => c[0]),
    // `insertAdjacentHTML` keeps markup as a string in this shim, so the dialog
    // is read where the product wrote it rather than through getElementById.
    dialogOpened: String(booted.document.body.innerHTML).includes('id="app-feedback-overlay"'),
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


// ════════════════════════════════════════════════════════════════════════════
// P2/S4b — the response, and the stand address of a service build.
//
// MEASUREMENT BOUNDARY OF THIS HALF, stated before the assertions so no line
// below is read as more than it is: these are SOURCE contracts over Rust text
// plus DOM-shimmed runs of the real inline scripts. Nothing here compiles the
// crate, so "the compile-time base reaches the binary" is NOT proven here — it
// is proven on the built `.so`. Nothing here reaches the network either, so
// "the response goes only to the stand" is proven as the ABSENCE OF ANY PATH to
// another host in the code that builds the request, not by watching packets.
// ════════════════════════════════════════════════════════════════════════════

section('T. the stand address of a service build (DECISIONS (855))');

const standResolver = blockAfter(jobsRs, 'fn jobs_test_api_base()');
ok(standResolver !== null, 'T0 jobs.rs declares a jobs_test_api_base() resolver');

// (1) The resolver is inside `#[cfg(debug_assertions)]` — POSITIONALLY, not by
// the attribute existing somewhere in the file.
const cfgBlock = standResolver && blockAfter(standResolver, '#[cfg(debug_assertions)]');
ok(cfgBlock !== null, 'T1 the resolver carries a #[cfg(debug_assertions)] block');
ok(cfgBlock !== null && cfgBlock.includes('option_env!("SKIPI_JOBS_TEST_BASE")'),
  'T1b the compile-time lookup is INSIDE that cfg block (a release build does not compile it)');

// P5: positional release-cleanliness, because a substring search cannot tell
// "inside the cfg block" from "next to it".
const optionEnvHits = allRustSrc
  .map(([f, src]) => [f, countOf(src, 'option_env!("SKIPI_JOBS_TEST_BASE")')])
  .filter(([, n]) => n > 0);
const optionEnvTotal = optionEnvHits.reduce((a, [, n]) => a + n, 0);
ok(optionEnvTotal === 1,
  `T2 option_env!("SKIPI_JOBS_TEST_BASE") occurs exactly once in src-tauri/src (found ${optionEnvTotal} in ${optionEnvHits.map(([f]) => path.basename(f)).join(',') || 'nothing'})`);

// The hook is only out of the release build while `[profile.release]` leaves
// debug-assertions at its default false. One line in Cargo.toml would ship it,
// so the absence of that line is asserted rather than assumed.
const releaseProfile = blockAfter(cargoToml.replace(/\r/g, ''), '[profile.release]');
ok(!/\[profile\.release\]/.test(cargoToml) || !/debug[-_]assertions\s*=\s*true/.test(String(releaseProfile || cargoToml)),
  'T3 Cargo.toml has no [profile.release] that turns debug-assertions on (the hook stays out of the release build)');

// (2) The host list is exact and nothing is read from the runtime environment.
if (cfgBlock) {
  ok(cfgBlock.includes('"127.0.0.1" | "10.0.2.2"'),
    'T4 the host list is exactly {127.0.0.1, 10.0.2.2}');
  ok(!/[*]|starts_with|contains|ends_with/.test(cfgBlock),
    'T5 the host check has no wildcard and no prefix/substring match');
  ok(!cfgBlock.includes('std::env::var') && !cfgBlock.includes('env::var'),
    'T6 the stand address is compile-time only — nothing is read from the process environment');
  // All EIGHT predicates of the already-accepted exemplar
  // (commands/account_sync.rs:93-100). The card said seven; the named range
  // holds eight, and the source is the authority.
  [
    ['scheme() == "http"', 'scheme is http'],
    ['port().is_some()', 'a port is mandatory'],
    ['username().is_empty()', 'no username'],
    ['password().is_none()', 'no password'],
    ['path() == "/"', 'no path'],
    ['query().is_none()', 'no query'],
    ['fragment().is_none()', 'no fragment'],
  ].forEach(([needle, what]) => {
    ok(cfgBlock.includes(needle), `T7 the exemplar's predicate is repeated: ${what}`);
  });
}

// (3) In the NON-PRODUCTION branch there is no production host, under any of
// its names. The branch is no longer "the stand branch": since the pilot build
// (section U) a stand and the pilot reach it through one predicate, and the
// assertion follows the predicate rather than the old wording.
const standBranch = blockAfter(
  String(blockAfter(jobsRs, 'fn response_bases()') || ''),
  'if let Some(only) = jobs_non_production_base()'
);
ok(standBranch !== null, 'T8 response_bases() has a non-production branch');
['api_bases()', 'PRIMARY_API', 'RU_API', 'api.skipi.app', 'api-ru.skipi.app'].forEach((needle) => {
  ok(standBranch !== null && !standBranch.includes(needle),
    `T9 the non-production branch does not mention ${needle}`);
});
ok(standBranch !== null && /return\s+vec!\[\s*only\s*\]/.test(standBranch),
  'T10 with a stand OR the pilot compiled in the base list is EXACTLY ONE base — the production hosts are not in it to fall back to');

// (4) The POST of the response has no path to a production base when the stand
// fails. Enumerated, because "it does not" is only worth what the enumeration
// covers: every helper in api.rs that walks api_bases() is named here, and the
// response path must call none of them.
const submitBody = rustFnBody(jobsRs, 'submit_profile_response');
const mintBody = rustFnBody(jobsRs, 'mint_self_session');
const senderBody = rustFnBody(jobsRs, 'send_on_response_bases');
ok(submitBody !== null && mintBody !== null && senderBody !== null,
  'T11 the response path (submit_profile_response, mint_self_session, send_on_response_bases) is present');
['api::get_json', 'api::post_json', 'api::post_empty', 'api::post_json_empty', 'api::api_bases', 'api_bases()']
  .forEach((needle) => {
    ok(submitBody !== null && !submitBody.includes(needle),
      `T12 submit_profile_response does not call ${needle} (every one of them walks api_bases())`);
    ok(mintBody !== null && !mintBody.includes(needle),
      `T13 mint_self_session does not call ${needle}`);
  });
ok(senderBody !== null && countOf(senderBody, 'response_bases()') === 1,
  'T14 the one sender of this path takes its bases from response_bases() and from nowhere else');
ok(senderBody !== null && /if idx \+ 1 < bases\.len\(\)/.test(senderBody),
  'T15 a transport error moves on only while another base exists — with a stand there is none, so the error is returned');
ok(senderBody !== null && !/retryable|is_server_error/.test(senderBody),
  'T16 an HTTP answer ends the walk: a stand 4xx/5xx is not re-asked of a different host');

// The GET side obeys the same rule, and the release build keeps today's path.
const getBranch = blockAfter(
  String(rustFnBody(jobsRs, 'get_json_for_response_path') || ''),
  'if jobs_non_production_base().is_some()'
);
ok(getBranch !== null, 'T17 the published-profiles GET branches on the SAME one predicate as the POST side');
ok(getBranch !== null && !/api_bases|PRIMARY_API|RU_API|api\.skipi\.app/.test(getBranch),
  'T18 the GET non-production branch mentions no production host either');
// The whole point of U: this branch must not narrow back to the stand alone, or
// an installed pilot build would read the published profiles from PRODUCTION
// while responding to the pilot.
ok(!String(rustFnBody(jobsRs, 'get_json_for_response_path') || '').includes('jobs_test_api_base()'),
  'T17b and it does not branch on the stand alone — a pilot build would otherwise GET from production');
ok(String(rustFnBody(jobsRs, 'get_json_for_response_path') || '').includes('api::get_json'),
  'T19 with no stand the GET is today\'s api::get_json — the release build cannot tell the difference');

section('U. the PILOT address an INSTALLED build may carry (DECISIONS (869))');

// WHY THIS EXISTS, measured rather than assumed. The installed release reaches
// only `api.skipi.app:443` — the shared production server — and the surface this
// slice is accepted on is not there: with `/health` 200 on both as the
// calibration, `/api/published-profiles` answered 404 on production and 200 on
// the pilot at `api.skipi.app:8444` (2026-09-29). Without a compiled-in pilot
// address there is nowhere to show the scenario on a build the owner installs.
//
// MEASUREMENT BOUNDARY, stated before the assertions. Everything in this section
// is a SOURCE contract over Rust text plus DOM-shimmed runs of the real inline
// scripts. That the COMPILED binary really carries the address — and that a build
// without the variable does not — is proven on the built artefact with `grep -a`,
// not here. Nothing here reaches the network.

const PILOT_ENDPOINT = { base: 'https://api.skipi.app:8444', stand: false, pilot: true };

const pilotResolver = rustFnBody(jobsRs, 'jobs_pilot_api_base');
ok(pilotResolver !== null, 'U0 jobs.rs declares a jobs_pilot_api_base() resolver');
const pilotCode = withoutLineComments(String(pilotResolver || ''));

// (1) It is NOT behind a cfg. The stand resolver is, which is exactly why it
// does not exist in the build the owner installs and why a second one is needed.
const pilotDeclAt = jobsRs.indexOf('fn jobs_pilot_api_base()');
const beforePilotLines = jobsRs.slice(0, Math.max(pilotDeclAt, 0)).split('\n')
  .filter((l) => l.trim() !== '' && !/^\s*\/\//.test(l));
const lineBeforePilot = (beforePilotLines[beforePilotLines.length - 1] || '').trim();
ok(pilotDeclAt >= 0 && !/#\[\s*cfg/.test(lineBeforePilot),
  `U1 no cfg attribute stands over the pilot resolver — it must exist in a release build (line before it: ${lineBeforePilot || '<none>'})`);
ok(!pilotCode.includes('#[cfg'),
  'U1b and there is no cfg block inside it either');

// (2) Compile-time, once, and with NO address of its own. A build without the
// variable therefore has nothing to fall back to and is today's build.
const pilotEnvHits = allRustSrc
  .map(([f, src]) => [f, countOf(src, 'option_env!("SKIPI_PILOT_API_BASE")')])
  .filter(([, n]) => n > 0);
const pilotEnvTotal = pilotEnvHits.reduce((a, [, n]) => a + n, 0);
ok(pilotEnvTotal === 1,
  `U2 option_env!("SKIPI_PILOT_API_BASE") occurs exactly once in src-tauri/src (found ${pilotEnvTotal} in ${pilotEnvHits.map(([f]) => path.basename(f)).join(',') || 'nothing'})`);
ok(countOf(pilotCode, 'option_env!') === 1,
  'U2b the address has exactly ONE source, and it is the compile-time variable');
ok(!/https?:\/\//.test(pilotCode),
  'U3 the resolver holds no url literal — with the variable absent there is no address to fall back to, so that build is byte-for-byte today\'s path');
ok(!/env::var/.test(pilotCode),
  'U3b nothing is read from the process environment: an Android process cannot be handed a variable, and a runtime door would be a second way in that this harness cannot see');

// (3) THE VALIDATION IS STRICTER THAN THE STAND'S, and that is the point: this
// one reaches the shipped binary.
ok(pilotCode.includes('url.scheme() == "https"'),
  'U4 the scheme must be https');
ok(!/scheme\(\)\s*==\s*"http"(?!s)/.test(pilotCode),
  'U4b plain http is accepted nowhere in it (the stand allows it; this must not)');
ok(!/starts_with|ends_with|contains\(/.test(pilotCode),
  'U4c no prefix, suffix or substring matching anywhere in the validation');
ok(pilotCode.includes('url.host_str() == Some("api.skipi.app")'),
  'U5 the host is ONE exact literal — api.skipi.app and nothing else');
ok(countOf(pilotCode, '"api.skipi.app"') === 1,
  'U5b that literal occurs exactly once, so a second host cannot hide beside it');
ok(!/matches!\s*\(\s*url\.host_str/.test(pilotCode),
  'U5c the host is not matched against a SET — one literal, compared with ==');
ok(!/[*]/.test(pilotCode), 'U5d and no wildcard');
ok(pilotCode.includes('url.port().is_some()'),
  'U6 a port is MANDATORY');
ok(pilotCode.includes('url.port() != Some(443)'),
  'U7 and it may not be 443 — an address naming the production port is refused outright, so "Pilot build" on the screen can never mean production');
[
  ['url.username().is_empty()', 'no username'],
  ['url.password().is_none()', 'no password'],
  ['url.path() == "/"', 'no path'],
  ['url.query().is_none()', 'no query'],
  ['url.fragment().is_none()', 'no fragment'],
].forEach(([needle, what]) => {
  ok(pilotCode.includes(needle), `U8 the predicate is present: ${what}`);
});
ok(!/unwrap_or|unwrap\(\)|expect\(/.test(pilotCode),
  'U9 there is no default that turns a refused address into a base');
ok(String(pilotResolver || '').trim().endsWith('None'),
  'U9b and the fallthrough is None — a refused address is no address, never production');

// (4) ONE branch point, so "can this build write to production" has one function
// to read and the two callers cannot drift apart.
const nonProd = rustFnBody(jobsRs, 'jobs_non_production_base');
ok(nonProd !== null, 'U10 jobs.rs has ONE function answering "is a non-production base compiled in"');
const nonProdCode = withoutLineComments(String(nonProd || ''));
ok(nonProdCode.includes('jobs_test_api_base()') && nonProdCode.includes('jobs_pilot_api_base()'),
  'U10b it reads both resolvers');
ok(nonProdCode.indexOf('jobs_test_api_base()') < nonProdCode.indexOf('jobs_pilot_api_base()'),
  'U10c in the required order: stand (debug) first, then pilot');
['api_bases()', 'PRIMARY_API', 'RU_API', 'api.skipi.app', 'api-ru.skipi.app'].forEach((needle) => {
  ok(!nonProdCode.includes(needle), `U10d and it names no production host: ${needle}`);
});
const pilotCallSites = allRustSrc
  .map(([f, src]) => [path.basename(f), countOf(withoutLineComments(src), 'jobs_pilot_api_base()')])
  .filter(([, n]) => n > 0);
const pilotCallTotal = pilotCallSites.reduce((a, [, n]) => a + n, 0);
ok(pilotCallTotal === 3,
  `U11 jobs_pilot_api_base occurs exactly three times in the crate — the definition and its TWO callers (found ${pilotCallTotal} in ${pilotCallSites.map(([f]) => f).join(',') || 'nothing'})`);
ok(withoutLineComments(String(rustFnBody(jobsRs, 'jobs_response_endpoint') || '')).includes('jobs_pilot_api_base()'),
  'U11b one caller is the endpoint the screen is drawn from');
ok(nonProdCode.includes('jobs_pilot_api_base()'),
  'U11c the other is the single branch point — there is no third');

// (5) THREE STATES on the wire, not two.
const epStruct = blockAfter(jobsRs, 'pub struct JobsResponseEndpoint');
ok(epStruct !== null && /pub\s+pilot\s*:\s*bool/.test(epStruct),
  'U12 JobsResponseEndpoint carries a pilot flag of its own');
ok(epStruct !== null && /pub\s+stand\s*:\s*bool/.test(epStruct),
  'U12b and stand keeps its own field, so nothing that already reads it changed meaning underneath');
const epFn = withoutLineComments(String(rustFnBody(jobsRs, 'jobs_response_endpoint') || ''));
ok(countOf(epFn, 'stand: true') === 1 && countOf(epFn, 'pilot: true') === 1,
  'U12c exactly one returned state is the stand and exactly one is the pilot');
ok(countOf(epFn, 'stand: false') === 2 && countOf(epFn, 'pilot: false') === 2,
  'U12d and the third — the production build — sets neither');
ok(epFn.indexOf('jobs_test_api_base()') < epFn.indexOf('jobs_pilot_api_base()'),
  'U12e stand is answered before pilot here too, so a debug build on a stand is never reported as a pilot');

// (6) WHAT A PILOT BUILD COULD STILL SEND PAST THE PILOT — enumerated, because
// "nothing goes past" is worth exactly what the enumeration covers. Five places
// in dist ask which server this build talks to. FOUR of them decide a write that
// would otherwise leave through `api::api_bases()` — i.e. to PRODUCTION — and
// every one of them must read the PAIR: reading `stand` alone would answer
// "this is the release build, go ahead" on the build the owner installs.
const ENDPOINT_READERS = ['skipiDiagnosticsMayLeave', 'skipiFeedbackPromptAllowed',
  'skipiRegisterJoinIdentity', 'skipiPublishMessagingPubkey', 'loadJobsProfiles'];
const endpointReadSites = countOf(html, "invoke('jobs_response_endpoint')");
ok(endpointReadSites === ENDPOINT_READERS.length,
  `U13 exactly ${ENDPOINT_READERS.length} places in dist/index.html ask which server this build talks to (found ${endpointReadSites}) — a new one appears here as a mismatch`);
ENDPOINT_READERS.forEach((fn) => {
  ok(String(fnBody(html, fn) || '').includes("invoke('jobs_response_endpoint')"),
    `U13b ${fn} is one of them`);
});
const WRITE_DECIDERS = ENDPOINT_READERS.filter((f) => f !== 'loadJobsProfiles');
WRITE_DECIDERS.forEach((fn) => {
  const body = withoutLineComments(String(fnBody(html, fn) || '')).replace(/\s+/g, '');
  ok(body.includes('ep.stand===true||ep.pilot===true'),
    `U14 ${fn} decides from BOTH flags`);
  ok(!body.replace('ep.stand===true||ep.pilot===true', '').includes('ep.stand'),
    `U14b ${fn} has no SECOND, single-flag reading of ep.stand left beside it`);
});
// `loadJobsProfiles` decides nothing: it hands the endpoint to the renderer.
ok(!withoutLineComments(String(fnBody(html, 'loadJobsProfiles') || '')).includes('register_my'),
  'U14c the fifth reader writes nothing — it only passes the endpoint to the section renderer');

// (7) WHAT A PILOT BUILD STILL SENDS TO PRODUCTION — said here, asserted at I10.
//
// "The whole slice speaks to the pilot" is true of THIS SLICE and of nothing
// else in the file. Two calls moved onto `response_bases()`: the
// published-profiles GET and the response POST. The other Jobs features of
// jobs.rs were production-only before and are production-only still — the
// vacancy feed, the mailing-request calls, the vessel projection and the recent
// reviews, and the counter; TWO OF THOSE ARE WRITES. A pilot build sends them to
// production exactly as today's build does.
//
// That set is already enumerated by I10 (`API_BASELINE`), which turns a NEW
// direct api:: caller into a red line. It is NOT repeated here: a second copy of
// the same check is not a second guarantee, and it would drift from the first.
// This paragraph exists so a reader of the pilot section is not left to infer
// that compiling in a pilot moved anything but these two calls.

section('A. the self-session signature: a narrow signer, not an oracle');

ok(/#\[tauri::command\]\s*pub fn sign_self_session_challenge/.test(jobsRs),
  'A1 jobs.rs defines the sign_self_session_challenge command');
ok(/jobs::sign_self_session_challenge/.test(libRs),
  'A2 lib.rs registers it (the dist invoke is no longer dead)');
const signBody = rustFnBody(jobsRs, 'sign_self_session_challenge');
ok(signBody !== null, 'A3 signer body found');
if (signBody) {
  ok(signBody.includes('crate::identity::vault_signing_key'),
    'A4 it signs with the vault\'s Ed25519 IDENTITY key — the key the server verifies against, not the X25519 messaging key');
  ok(signBody.includes('SELF_SESSION_PAYLOAD_KEYS'),
    'A5 the payload key set must be exactly the server\'s seven — an arbitrary object is not signed');
  ok(signBody.includes('SELF_SESSION_SCHEMA') && signBody.includes('SELF_SESSION_AUDIENCE'),
    'A6 schema and audience are checked, so another schema\'s bytes cannot be signed here');
  ok(/field\("vault_user_id"\) != own_user_id/.test(signBody),
    'A7 the challenge must name THIS vault\'s identity, derived from the key and never taken from the caller');
  ok(!/unwrap_or|unwrap\(\)/.test(signBody.replace(/unwrap_or_else\(\|e\| e\.into_inner\(\)\)/g, '')
       .replace(/\.unwrap_or_default\(\)/g, '')),
    'A8 the signer has no fallback that turns a refusal into a signature');
  ok(!/to_bytes\(\)\s*\)\s*;?\s*$/.test(signBody.split('\n').filter((l) => /secret|private/i.test(l)).join('\n') || 'x'),
    'A9 no secret-key material is returned');
}
const canonBody = rustFnBody(jobsRs, 'canonical_self_session_bytes');
ok(canonBody !== null && /sort_by/.test(canonBody),
  'A10 the signed bytes sort the keys (the server signs json.dumps(sort_keys=True))');
ok(canonBody !== null && canonBody.includes("push(',')") && canonBody.includes("push(':')"),
  'A11 the signed bytes use the compact separators (",", ":")');
const asciiBody = rustFnBody(jobsRs, 'json_ascii_string');
ok(asciiBody !== null && /encode_utf16/.test(asciiBody) && /\\\\u\{:04x\}/.test(asciiBody),
  'A12 non-ASCII is escaped \\uXXXX, as ensure_ascii=True writes it');

section('B. the button lives in the existing section, and the warning comes BEFORE it');

const respondHtmlBody = fnBody(html, 'jobsProfileRespondHtml');
ok(respondHtmlBody !== null, 'B1 jobsProfileRespondHtml() found');
ok(String(fnBody(html, 'jobsProfilesSectionHtml') || '').includes('jobsProfileRespondHtml('),
  'B2 the respond block is rendered by the EXISTING profiles section — not a new screen');

const withBtn = await renderJobsScreen({ profiles: [PROFILE_MATCH] });
const irrevAt = withBtn.sectionHtml.indexOf('data-qa="jobs-respond-irreversible"');
const btnAt = withBtn.sectionHtml.indexOf('data-qa="jobs-respond-btn"');
ok(irrevAt >= 0, 'B3 the "cannot be withdrawn" line is on the rendered screen');
ok(btnAt >= 0, 'B4 the respond button is on the rendered screen');
ok(irrevAt >= 0 && btnAt >= 0 && irrevAt < btnAt,
  'B5 it is rendered BEFORE the button — read while the choice is still open, not as a toast afterwards');
ok(withBtn.sectionHtml.includes('jobsRespondToProfile('),
  'B6 the button is wired to the respond handler');

for (const [lang, needle] of [['en', 'cannot be withdrawn'], ['ru', 'Отозвать отклик нельзя']]) {
  const r = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang });
  ok(r.sectionHtml.includes(needle), `B7 (${lang}) the irreversibility sentence is localised on the rendered screen`);
}
['jobs.profiles.respond', 'jobs.profiles.respond_irreversible', 'jobs.profiles.respond_sending',
 'jobs.profiles.respond_ok', 'jobs.profiles.respond_failed', 'jobs.profiles.respond_gone',
 'jobs.profiles.respond_already', 'jobs.profiles.respond_conflict',
 'jobs.profiles.respond_ack_version', 'jobs.profiles.respond_stand'].forEach((k) => {
  ok(enBlock.includes(`'${k}'`), `B8 tr() carries ${k} in EN`);
  ok(ruBlock.includes(`'${k}'`), `B9 tr() carries ${k} in RU`);
});
if (respondHtmlBody) {
  ok(respondHtmlBody.includes('tr('), 'B10 the respond block uses the tr() dictionary mechanism');
  ok(respondHtmlBody.includes('getUiLang('), 'B11 the respond block also uses the inline getUiLang() mechanism');
}

// The service build says which host it spoke to, so a screenshot records it.
const standScreen = await renderJobsScreen({ profiles: [PROFILE_MATCH], endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(standScreen.sectionHtml.includes('http://127.0.0.1:8099'),
  'B12 a service build prints the base it is talking to, inside the respond block');
const prodScreen = await renderJobsScreen({ profiles: [PROFILE_MATCH], endpoint: { base: 'https://api.skipi.app', stand: false } });
ok(!prodScreen.sectionHtml.includes('jobs-respond-stand'),
  'B13 a build with no stand prints no stand line');

// THE PILOT BUILD IS NOT A SERVICE BUILD, and the screen must not say it is.
// The owner ACCEPTS on this build; the line he reads is the only record of which
// server the app was speaking to while he did.
const pilotScreen = await renderJobsScreen({ profiles: [PROFILE_MATCH], endpoint: PILOT_ENDPOINT });
ok(pilotScreen.sectionHtml.includes('data-qa="jobs-respond-pilot"'),
  'B14 a pilot build prints a line of its own inside the respond block');
ok(pilotScreen.sectionHtml.includes('https://api.skipi.app:8444'),
  'B14b and it names the server, port and all, so a screenshot records it');
ok(!pilotScreen.sectionHtml.includes('jobs-respond-stand'),
  'B15 and it does NOT print the service-build line');
ok(!prodScreen.sectionHtml.includes('jobs-respond-pilot'),
  'B15b while the production build still prints neither');
for (const [lang, service, pilot] of [
  ['en', 'Service build', 'Pilot build - talking to'],
  ['ru', 'Служебная сборка', 'Пилотная сборка — сервер'],
]) {
  const r = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang, endpoint: PILOT_ENDPOINT });
  ok(r.sectionHtml.includes(pilot),
    `B16 (${lang}) the pilot build is named by its own sentence: ${pilot}`);
  ok(!r.sectionHtml.includes(service),
    `B17 (${lang}) and it is NEVER called a service build — the owner must see what he is accepting on`);
}
['jobs.profiles.respond_pilot'].forEach((k) => {
  ok(enBlock.includes(`'${k}'`), `B18 tr() carries ${k} in EN`);
  ok(ruBlock.includes(`'${k}'`), `B18b tr() carries ${k} in RU`);
});
ok(!enBlock.includes("'jobs.profiles.respond_pilot':'Service build")
   && !ruBlock.includes("'jobs.profiles.respond_pilot':'Служебная сборка"),
  'B19 and neither dictionary defines the pilot sentence as the service one');

section('C. success is the SERVER\'S answer — and both halves of it');

// The sandbox `fetch` answers {ok:true,status:200,json:()=>({})} by default, so
// a check on `resp.ok` would be green over nothing. This path never touches
// fetch at all, and that is asserted; what it does check is the acknowledgement.
const respondBody = fnBody(html, 'jobsRespondToProfile');
ok(respondBody !== null, 'C0 jobsRespondToProfile() found');
ok(respondBody !== null && !/\bapiFetch\(/.test(respondBody) && !/(?<![A-Za-z_])fetch\(/.test(respondBody),
  'C1 the respond path calls neither fetch nor apiFetch — apiFetch\'s transport-error branch retries ANY method against api.skipi.app');

const okRun = await runRespond({});
ok(okRun.statusState === 'ok', `C2 a server acknowledgement with delivered:true and an intake_id is success (state=${okRun.statusState})`);
ok(/received your response/i.test(okRun.statusHtml), 'C3 and the success sentence is what is shown');

const noDelivered = await runRespond({ submitAck: { response_id: 'r', intake_id: 'intake-1', published_version: 7 } });
ok(noDelivered.statusState === 'error',
  `C4 a 2xx body WITHOUT delivered is not success (state=${noDelivered.statusState})`);
ok(!/received your response/i.test(noDelivered.statusHtml),
  'C5 and not one word of success is on screen');

const falseDelivered = await runRespond({ submitAck: { delivered: false, intake_id: 'intake-1' } });
ok(falseDelivered.statusState === 'error', 'C6 delivered:false is not success');

const noIntake = await runRespond({ submitAck: { delivered: true, published_version: 7 } });
ok(noIntake.statusState === 'error',
  `C7 delivered:true with NO intake_id is not success — the id names the row an agency will open (state=${noIntake.statusState})`);
ok(!/received your response/i.test(noIntake.statusHtml), 'C8 and no success word is shown for it');

const thrown = await runRespond({ submitThrows: 'server returned 503: response could not be stored, retry' });
ok(thrown.statusState === 'error', 'C9 an exception is a refusal');
ok(/NOT delivered/.test(thrown.statusHtml), 'C10 the refusal is shown as a WORD of refusal, not a bare code');
ok(!/received your response/i.test(thrown.statusHtml), 'C11 an exception leaves ZERO words of success on screen');
ok(thrown.buttonDisabled === false, 'C12 a retryable refusal re-enables the button — the retry is the same response id');

for (const [lang, needle] of [['en', 'NOT delivered'], ['ru', 'НЕ доставлен']]) {
  const r = await runRespond({ lang, submitThrows: 'boom' });
  ok(r.statusHtml.includes(needle), `C13 (${lang}) the refusal is localised`);
}

// 201 the first time, 200 on a replay — BOTH success. A client that demanded
// 201 would show a legitimate retry as a failure, so the status code is not
// consulted anywhere on this path.
ok(respondBody !== null && !/\b201\b/.test(withoutLineComments(respondBody)),
  'C14 the client does not gate success on status 201 (the server answers 200 on a replay of the same response id)');
ok(submitBody !== null && !/\b201\b/.test(withoutLineComments(submitBody)),
  'C15 nor does the Rust half — success is read from the body, so 201 and 200 are the same answer');
ok(submitBody !== null && /\(200\.\.300\)\.contains/.test(submitBody),
  'C16 the Rust half accepts the whole 2xx range and then demands the acknowledgement');
ok(submitBody !== null && /"delivered"/.test(submitBody) && /"intake_id"/.test(submitBody),
  'C17 the Rust half refuses a 2xx that does not confirm storage — two independent refusals, client and Rust');

section('C. the tombstone: our own sentence, never the server\'s wrong one');

// THIS BRANCH IS NOW PRODUCED BY NOTHING, and that is the finding of S4e rather
// than a gap here: the server answers a document its agency deleted with the
// SAME sentence as an ordinary content conflict, on purpose, so no word reaches
// a client that means "deleted". The branch and its sentence are kept for the
// day the server can say it; what a 409 means TODAY is asserted in section Q.
// It is exercised by injecting the token, which is the only way in.
const gone = await runRespond({ submitThrows: 'RESPONSE_NO_LONGER_ACCEPTED' });
ok(gone.statusState === 'gone', `C18 a 409 tombstone has its own state (got ${gone.statusState})`);
ok(/no longer accepted/i.test(gone.statusHtml), 'C19 and its own sentence');
ok(!/already accepted with different content/i.test(gone.statusHtml),
  'C20 the server\'s own 409 wording is NOT repeated — it says the content differed, which is not what happened');
ok(!/[Ee]vent already/.test(html),
  'C21 that sentence is nowhere in the client at all');
ok(gone.buttonDisabled === true,
  'C22 a tombstone does not re-enable the button: an endless retry cannot succeed and must not be offered');
ok(submitBody !== null && /answer\.status == 409/.test(submitBody)
   && /response_conflict_token\(&answer\.body\)/.test(submitBody)
   && !/return Err\(format!\("server returned \{\}: \{\}", answer\.status, answer\.body\)\);[\s\S]*answer\.status == 409/.test(submitBody),
  'C23 the Rust half turns a 409 into a MARKER read from the server\'s words and never hands the body on, so no sentence of the server can leak through');

section('E. the response id survives a restart, and a retry is the SAME response');

ok(/#\[tauri::command\]\s*pub fn ensure_profile_response_id/.test(jobsRs),
  'E1 jobs.rs owns the response id');
ok(/jobs::ensure_profile_response_id/.test(libRs), 'E2 lib.rs registers it');
const ensureBody = rustFnBody(jobsRs, 'ensure_profile_response_id');
ok(ensureBody !== null && ensureBody.includes('crate::db::get_vault_info_value')
   && ensureBody.includes('crate::db::set_vault_info'),
  'E3 it is stored in the vault\'s vault_info table — a file on disk, which is why it survives the process');
ok(ensureBody !== null && ensureBody.includes('uuid::Uuid::new_v4'),
  'E4 the id is a hyphenated UUID: ASCII-safe, because the server puts it in a MIME boundary');
ok(respondBody !== null && !/localStorage/.test(respondBody),
  'E5 the client does not keep the id in localStorage — that is the WebView\'s, cleared with app data');
ok(respondBody !== null && /invoke\('ensure_profile_response_id'/.test(respondBody),
  'E6 the client asks the vault for the id instead of minting one');
ok(respondBody !== null && !/randomUUID|Math\.random/.test(respondBody),
  'E7 the client mints no id of its own, so a retry cannot become a second response');

// The double boot. VAULT_RESPONSE_IDS outlives boot() exactly as the vault file
// outlives the process; localStorage does not, which is the whole point.
VAULT_RESPONSE_IDS.clear();
const firstBoot = await runRespond({ submitThrows: 'network: connection reset' });
const secondBoot = await runRespond({});
const idFirst = String((firstBoot.submits[0] || {}).responseId || '');
const idSecond = String((secondBoot.submits[0] || {}).responseId || '');
ok(idFirst.length > 0 && idSecond.length > 0,
  `E8 both attempts put a response id in the request (${idFirst || 'none'} / ${idSecond || 'none'})`);
ok(idFirst === idSecond,
  `E9 after a RESTART the retry carries THE SAME id in the request — one response, not two (${idFirst} vs ${idSecond})`);
ok(/^[\x20-\x7e]+$/.test(idSecond) && !/[^A-Za-z0-9-]/.test(idSecond),
  `E10 the id is ASCII-safe and MIME-boundary-safe (${idSecond})`);

// And twice inside ONE boot, which is the broken-connection retry.
const twice = boot({ profiles: [PROFILE_MATCH], respondFor: [PROFILE_MATCH.profile_id], submitThrows: 'network: reset' });
{
  const nodes = twice.respondNodes.get(PROFILE_MATCH.profile_id);
  await twice.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
  await settle();
  twice.state.submitThrows = '';
  nodes.btn.disabled = false;
  await twice.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
  await settle();
  const ids = twice.state.submits.map((x) => String(x.responseId || ''));
  ok(ids.length === 2, `E11 two attempts were made in one session (got ${ids.length})`);
  ok(ids.length === 2 && ids[0] === ids[1], `E12 and both carried the same response id (${ids.join(' vs ')})`);
}

section('P. the version is SHOWN from the acknowledgement, and never SENT');

const sent = (okRun.submits[0] || {});
ok(Object.keys(sent).length > 0, 'P1 a submission was made');
['publishedVersion', 'published_version', 'version'].forEach((k) => {
  ok(!(k in sent), `P2 the request carries no ${k} — the server's ProfileResponseSubmit is extra="forbid" and would answer 422`);
});
ok(submitBody !== null && !/"published_version"/.test(submitBody),
  'P3 the Rust body has no published_version key either');
const bodyBlock = submitBody && blockAfter(submitBody, 'let mut body = serde_json::json!(');
ok(submitBody !== null && /"response_id"/.test(submitBody) && /"contact"/.test(submitBody)
   && /"cv_content_type"/.test(submitBody) && /"cv_base64"/.test(submitBody),
  'P4 the request carries exactly the fields the server\'s schema declares');
ok(/published_version/.test(respondBody || ''),
  'P5 the client reads published_version FROM the acknowledgement');
ok(/delivered against published version 7|доставлен для опубликованной версии 7/.test(okRun.statusHtml),
  `P6 and shows it on screen after a confirmed delivery (${okRun.statusHtml.replace(/<[^>]+>/g, '').slice(0, 90)})`);
const ruOk = await runRespond({ lang: 'ru' });
ok(/доставлен для опубликованной версии 7/.test(ruOk.statusHtml), 'P7 in RU as well');

// Contact and identity are the vault's, not the caller's: a client that could
// name the contact could deliver a CV under someone else's address.
ok(submitBody !== null && /get_vault_info_value\(conn, "personal_email"\)/.test(submitBody),
  'P8 the contact is read from the vault, not accepted as an argument');
ok(submitBody !== null && /get_vault_info_value\(conn, "skipi_public_seafarer_id"\)/.test(submitBody),
  'P9 the seafarer identity the response is delivered as is the vault\'s own');
ok(submitBody !== null && /vault_signing_key/.test(submitBody),
  'P10 and it is the key in the vault that proves it');

// ════════════════════════════════════════════════════════════════════════════
// I. THE IDENTITY THE RESPOND BUTTON REQUIRES (S4d — №562 and №563)
//
// MEASUREMENT BOUNDARY, said before the assertions rather than implied. This
// section measures the DESKTOP client gap: source contracts over Rust and JS
// text plus DOM-shimmed runs of the real inline scripts. It compiles nothing,
// reaches no network, and — see the header of this file — knows nothing about
// Android. The mobile LAYOUT is reached by construction (one loader, two call
// sites, counted below); that this layout is what a Pixel shows is not
// something any assertion here can say.
// ════════════════════════════════════════════════════════════════════════════

section('I. the seafarer can obtain the identity the respond button requires');

const identityRustBody = rustFnBody(jobsRs, 'ensure_seafarer_identity');
const stateBody = rustFnBody(jobsRs, 'seafarer_identity_entry_state');
const stepSrc = fnBody(html, 'jobsIdentityStepBody');
const respondSrc = fnBody(html, 'jobsProfileRespondHtml');
const ensureJs = fnBody(html, 'jobsEnsureSkipiId');
const publisherJs = fnBody(html, 'skipiPublishMessagingPubkey');

ok(identityRustBody !== null, 'I0 jobs.rs defines ensure_seafarer_identity');
ok(stepSrc !== null, 'I0b dist defines the identity step');
ok(ensureJs !== null, 'I0c dist defines the handler its button calls');

// ---- I1: with neither half, the step stands where the button would ---------
const noId = await renderJobsScreen({ profiles: [PROFILE_MATCH], identity: IDENTITY_NONE });
ok(noId.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'I1 a vault with no Skipi ID gets the step that obtains one, inside the respond block');
ok(!noId.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'I1b INSTEAD of a respond button that would refuse on the client and send nothing');

// ---- I2: with both halves, the step is gone and the button is back ---------
const withId = await renderJobsScreen({ profiles: [PROFILE_MATCH] });
ok(!withId.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'I2 a vault that can be spoken for is not asked for an identity it already has');
ok(withId.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'I2b and it gets the respond button');

// ---- I8 (A-1): the gate is the PAIR, never the public id alone -------------
// `POST /claim` issues the id and writes NO identity key; the self-session the
// response path mints looks the key up FIRST and refuses without it. Gating on
// the id would hide the step in the one state where it is still needed.
const idNoKey = await renderJobsScreen({ profiles: [PROFILE_MATCH], identity: IDENTITY_ID_NO_KEY });
ok(idNoKey.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'I8 a public id WITHOUT a registered identity still gets the step — the state a restored backup is in');
ok(!idNoKey.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'I8b and not a respond button that would answer 401 with nowhere left to go');
const markerAt = String(identityRustBody || '').indexOf('IDENTITY_KEY_REGISTERED_AT, &registered_at');
const keyPostAt = String(identityRustBody || '').indexOf('"/api/seafarer-identity/identity-key"');
ok(keyPostAt >= 0 && markerAt > keyPostAt,
  'I8c the marker that opens the respond button is written only AFTER the server accepted the identity');
ok(/if key_answer\.status == 409/.test(String(identityRustBody || '')),
  'I8d 409 — this vault is already bound to a different identity — is a refusal, not a success');
// COUNTED, NOT LOCATED, and the difference is a defect that got through: I8c
// reads the POSITION of one literal, so a SECOND write of the same marker —
// three lines inside the `status == 409` branch, which comes after the POST —
// leaves the first write exactly where it was and I8c green. That mutation
// restores defect A-1 whole (a vault with no identity on the server gets the
// respond button) through the branch S4d itself added.
const markerWrites = countOf(String(identityRustBody || ''), 'IDENTITY_KEY_REGISTERED_AT');
ok(markerWrites === 1,
  `I8f the marker that opens the respond button is written in EXACTLY ONE place in this command (found ${markerWrites})`);
ok(!String(identityRustBody || '').includes('"skipi_identity_key_registered_at"'),
  'I8g and it is never spelled out as a raw key, which would walk straight past the count above');
ok(/"registered"/.test(String(identityRustBody || '')) && /"exists"/.test(String(identityRustBody || '')),
  'I8e registered and exists are BOTH success, so a legitimate repeat is not shown as a failure');

// ---- I3: one decision, one place -------------------------------------------
ok(String(respondSrc || '').includes('jobsIdentityStepBody('),
  'I3 the respond block itself decides between the step and the button');
ok(String(respondSrc || '').includes('data-qa="jobs-respond-btn"'),
  'I3b and the same function renders the button — the two are branches of one decision');
const stepCallSites = countOf(html, 'jobsIdentityStepBody(') - countOf(html, 'function jobsIdentityStepBody(');
ok(stepCallSites === 1,
  `I3c the step body has exactly ONE call site — a second copy is a second answer to "may he respond" (found ${stepCallSites})`);

// ---- I4 (F-1): the loader still has exactly two call sites ------------------
// Counted by CALLS, not by the two `#jobs-profiles-host` markup sites: the
// refusals that keep this section closed live in the loader, and a third caller
// is how they stop holding.
const identityLoaderSites = countOf(html, 'loadJobsProfiles(') - countOf(html, 'function loadJobsProfiles(');
ok(identityLoaderSites === 2,
  `I4 loadJobsProfiles is called from exactly two places, desktop and mobile (found ${identityLoaderSites})`);
ok(String(ensureJs || '').includes('jobsProfilesRerenderIdentity('),
  'I4b success re-draws the section from what is already on screen instead of adding a third caller');

// ---- I5: the step never says "key", in either language ---------------------
// SCOPED TO THE STEP'S OWN MARKUP, deliberately. `key` occurs legitimately
// dozens of times in this document (recovery key, API key); an assertion over
// the file would either be red forever or be written so loosely it catches
// nothing. Both branches of the step are rendered by the real function.
for (const lang of ['en', 'ru']) {
  const booted = boot({ lang });
  const branches = [
    ['button', booted.sandbox.jobsIdentityStepBody('p-1', { ...IDENTITY_NONE, missing: [] })],
    ['missing fields', booted.sandbox.jobsIdentityStepBody('p-1', { ...IDENTITY_NONE, missing: ['first_name', 'surname', 'date_of_birth'] })],
  ];
  branches.forEach(([what, markup]) => {
    ok(!/key/i.test(markup), `I5 (${lang}, ${what}) the step never says "key" — a seafarer is asked for a Skipi ID, not for cryptography`);
    ok(!/ключ/i.test(markup), `I5b (${lang}, ${what}) nor "ключ"`);
    ok(markup.length > 0, `I5c (${lang}, ${what}) the step actually rendered something`);
  });
}

// ---- I6: the step exists in both languages, on the rendered screen ---------
const IDENTITY_KEYS = [
  'jobs.profiles.identity_why',
  'jobs.profiles.identity_get',
  'jobs.profiles.identity_working',
  'jobs.profiles.identity_failed',
  'jobs.profiles.identity_duplicate',
  'jobs.profiles.identity_taken',
  'jobs.profiles.identity_need_profile',
  'jobs.profiles.identity_open_profile',
  'jobs.profiles.identity_field_first_name',
  'jobs.profiles.identity_field_surname',
  'jobs.profiles.identity_field_dob',
];
IDENTITY_KEYS.forEach((k) => {
  ok(enBlock.includes(`'${k}'`), `I6 tr() carries ${k} in EN`);
  ok(ruBlock.includes(`'${k}'`), `I6b tr() carries ${k} in RU`);
});
// tr() falls back to EN for a missing key, so a deleted RU line is SILENT in
// the dictionary and visible only on the rendered screen. Hence both.
ok(noId.sectionHtml.includes('Get my Skipi ID'),
  'I6c the step is in English on the rendered English screen');
const ruNoId = await renderJobsScreen({ profiles: [PROFILE_MATCH], identity: IDENTITY_NONE, lang: 'ru' });
ok(ruNoId.sectionHtml.includes('Получить Skipi ID'),
  'I6d and in Russian on the Russian one — not the English fallback');

// ---- I7: a refusal is the product's sentence, never the server's -----------
const rawRefusal = await runEnsureIdentity({ ensureThrows: 'server returned 500: boom from /api/seafarer-identity/claim' });
ok(!/boom|500|api\/seafarer-identity/.test(rawRefusal.statusHtml),
  'I7 the raw refusal is not printed at the seafarer');
ok(rawRefusal.statusHtml.includes('could not be set up'),
  `I7b the product says its own sentence instead (${rawRefusal.statusHtml.replace(/<[^>]+>/g, '').slice(0, 80)})`);
ok(rawRefusal.statusState === 'error', 'I7c and it is shown as a failure');

// ---- I9 (A-2): possible_duplicate is a 200 OK that is NOT a success --------
// The server answers a duplicate fingerprint with 200 and a NULL id. Writing
// that empty id into the vault — the way the profile-side claim does — would
// leave the screen pressing a button that succeeds and changes nothing, and
// this product has no recovery flow to send him to.
const dup = await runEnsureIdentity({ ensureThrows: 'IDENTITY_CLAIM_DUPLICATE' });
ok(dup.statusHtml.includes('already exists'),
  'I9 a duplicate identity claim is refused with its own sentence, not a silent no-op');
ok(!dup.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'I9b and the respond button does not appear on it');
const emptyGuardAt = String(identityRustBody || '').indexOf('if issued.is_empty()');
const writeIdAt = String(identityRustBody || '').indexOf('"skipi_public_seafarer_id", &issued');
ok(emptyGuardAt >= 0 && writeIdAt > emptyGuardAt,
  'I9c the public id is written to the vault only AFTER an empty one has been refused');
const dupBranch = blockAfter(String(identityRustBody || ''), 'if issued.is_empty()');
ok(dupBranch !== null && dupBranch.includes('Err(IDENTITY_CLAIM_DUPLICATE'),
  'I9d an empty id on a 200 returns a refusal — not Ok, and not the empty string the profile-side claim stores');

// ---- I10 (C-1 / №563): the single-base rule, by ENUMERATION ---------------
// `rustFnBody` reads ONE function and does not look inside what it calls, so an
// assertion shaped like "the command body has no api::" is green the moment the
// request moves into a helper. This enumerates every function of the file
// instead: a helper that reaches production is a NEW name in this set.
const jobsFnNames = Array.from(jobsRs.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/g)).map((m) => m[1]);
const API_SENDERS = ['api::get_json', 'api::post_json', 'api::post_empty', 'api::post_json_empty', 'api::api_bases'];
const fnsReachingApi = jobsFnNames
  .filter((n) => API_SENDERS.some((s) => withoutLineComments(rustFnBody(jobsRs, n) || '').includes(s)))
  .sort();
const API_BASELINE = ['bump_counter', 'fetch_jobs', 'fetch_mailing_requests', 'fetch_recent_vessel_reviews',
  'fetch_vessel_projection', 'get_json_for_response_path', 'mailing_request_send_click', 'response_bases'];
ok(JSON.stringify(fnsReachingApi) === JSON.stringify(API_BASELINE.slice().sort()),
  `I10 the ONLY functions of jobs.rs that reach api:: are the pre-existing public-board ones — the identity path is not among them (found ${fnsReachingApi.join(',')})`);
['ensure_seafarer_identity', 'seafarer_identity_entry_state'].forEach((n) => {
  const body = withoutLineComments(rustFnBody(jobsRs, n) || '');
  API_SENDERS.concat(['api_bases()']).forEach((s) => {
    ok(!body.includes(s), `I10b ${n} does not call ${s} (every one of them walks api_bases())`);
  });
});
ok(countOf(String(identityRustBody || ''), 'send_on_response_bases(') === 2,
  'I10c both requests of the identity path go through the one sender, and there are exactly two of them');
ok(/"\/api\/seafarer-identity\/claim"/.test(String(identityRustBody || ''))
   && /"\/api\/seafarer-identity\/identity-key"/.test(String(identityRustBody || '')),
  'I10d and those two are the claim and the identity registration');

// ---- I11 (C-4): no second sender may be introduced -------------------------
// "Only over response_bases()" still permits writing a NEW sender that walks
// something else, which would bypass T15/T16 entirely. So the senders of this
// file are enumerated too. `fetch_skipi_info_index` talks to skipi.info, which
// is not the Skipi API at all and has no bases to walk.
const fnsThatSend = jobsFnNames
  .filter((n) => withoutLineComments(rustFnBody(jobsRs, n) || '').includes('.send()'))
  .sort();
ok(JSON.stringify(fnsThatSend) === JSON.stringify(['fetch_skipi_info_index', 'send_on_response_bases']),
  `I11 exactly one sender walks Skipi API bases and it is send_on_response_bases (found ${fnsThatSend.join(',')})`);

// ---- I12 (C-2): the step calls the NEW command, not the old ones ----------
// The cheapest way to make every assertion above green and still write into
// production is to wire the button to `claimSkipiIdentity()`, which exists, is
// global, shows a toast, re-renders — and goes through api_bases().
ok(String(stepSrc || '').includes('jobsEnsureSkipiId('),
  'I12 the step button is wired to the new handler');
ok(!String(stepSrc || '').includes('claimSkipiIdentity('),
  'I12b and not to the legacy claim that walks api_bases()');
ok(noId.sectionHtml.includes('jobsEnsureSkipiId('),
  'I12c the wiring is on the rendered screen, not only in the source');
ok(!noId.sectionHtml.includes('claimSkipiIdentity('),
  'I12d and the legacy claim is not');
ok(String(ensureJs || '').includes("invoke('ensure_seafarer_identity')"),
  'I12e the handler invokes the command that speaks only to response_bases()');
['claim_seafarer_identity', 'register_my_identity_pubkey'].forEach((cmd) => {
  ok(!String(ensureJs || '').includes(cmd), `I12f and never ${cmd}`);
});
const drove = await runEnsureIdentity({});
const droveCalls = drove.state.calls.map((c) => c[0]);
ok(droveCalls.includes('ensure_seafarer_identity'),
  'I12g pressing the step really invokes it (the handler was run, not read)');
ok(!droveCalls.includes('claim_seafarer_identity') && !droveCalls.includes('register_my_identity_pubkey'),
  'I12h and neither of the two commands that address production');
ok(drove.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'I12i and after a confirmed pair the respond button is what stands there');
ok(!drove.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'I12j with the step gone');

// ---- I13 (B-1): the messaging key is not published by a service build -----
// A THIRD key, and nothing above would have caught it: `register_my_pubkey`
// (X25519) goes through api::post_json_empty -> api_bases(), and OPENING the
// Jobs screen fires it. On a phone that list is production only, so a service
// build was writing a synthetic record into the live product before the
// seafarer touched anything.
const directPubkeyCalls = countOf(html, "invoke('register_my_pubkey')");
ok(directPubkeyCalls === 1,
  `I13 the messaging key is published from exactly ONE place in this file (found ${directPubkeyCalls})`);
ok(String(publisherJs || '').includes("invoke('jobs_response_endpoint')"),
  'I13b and that place asks which server this build talks to before publishing anything');
ok(/nonprod!==false/.test(String(publisherJs || '').replace(/\s+/g, '')),
  'I13c a build that is not production — or one that cannot tell — publishes nothing');
const standOpen = await renderJobsScreen({ profiles: [PROFILE_MATCH], endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(!standOpen.state.calls.some((c) => c[0] === 'register_my_pubkey'),
  'I13d opening Jobs on a service build publishes no messaging key to production');
ok(withId.state.calls.some((c) => c[0] === 'register_my_pubkey'),
  'I13e and a release build still publishes it — unchanged, byte for byte');
const pilotOpen = await renderJobsScreen({ profiles: [PROFILE_MATCH], endpoint: PILOT_ENDPOINT });
ok(!pilotOpen.state.calls.some((c) => c[0] === 'register_my_pubkey'),
  'I13f nor does the PILOT build the owner installs — that key leaves through api_bases(), i.e. to production, and reaching the pilot on the response path does not move it');

// ---- I14 (C-3): the commands are registered ------------------------------
ok(/jobs::ensure_seafarer_identity/.test(libRs),
  'I14 lib.rs registers ensure_seafarer_identity (an unregistered command is an invoke that always throws)');
ok(/jobs::seafarer_identity_entry_state/.test(libRs),
  'I14b lib.rs registers seafarer_identity_entry_state');

// ---- I15 (E-2): the step draws its OWN list of missing profile fields -----
// `readyProfileMissingListHtml` answers a different question and is asserted
// absent from this surface elsewhere in this file; "say which fields are
// missing" is a direct invitation to reuse it by name similarity.
ok(!withoutLineComments(String(stepSrc || '')).includes('readyProfileMissingListHtml'),
  'I15 the step does not reuse readyProfileMissingListHtml (that list is the seafarer\'s own jobs gaps)');

// MEASURED ON THE FUNCTION, NOT ON THE SCREEN, AND THE REASON IS A FINDING.
// `fpRequiredKeys` — the Jobs readiness gate — already requires surname,
// first_name and date_of_birth, and `showJobs` turns readiness OFF and emits no
// `#jobs-profiles-host` at all when any of them is missing (the mobile branch
// does the same). So this branch cannot be reached through the Jobs screen
// today: it is the fallback for a profile that empties out between the loader
// and the press, and for the Rust refusal that would otherwise be a raw error.
// Rendering the screen to assert it would assert nothing, so the real renderer
// is called directly and the boundary is stated instead of implied.
const missingBooted = boot({});
const missingStep = missingBooted.sandbox.jobsIdentityStepBody('p-1',
  { ...IDENTITY_NONE, missing: ['first_name', 'date_of_birth'] });
ok(missingStep.includes('data-qa="jobs-identity-missing"'),
  'I16 a profile missing the fields an identity is issued from says WHICH, before anything is asked of the server');
ok(missingStep.includes('First name') && missingStep.includes('Date of birth'),
  'I16b and names exactly the missing ones');
ok(!missingStep.includes('Surname'),
  'I16c and not the ones that are filled in');
ok(!missingStep.includes('data-qa="jobs-identity-btn"'),
  'I16d the button that could only earn a 422 is not offered');
ok(missingStep.includes('openSettings('),
  'I16e and there is a way to the profile from here');
ok(String(fnBody(html, 'loadJobsProfiles') || '').includes('jobsIdentityMissingProfileFields(sp)'),
  'I16f the loader is what fills that list, from the profile it already holds');

// ---- I17: the identity is the vault's own, and nothing may substitute it ---
ok(String(identityRustBody || '').includes('crate::identity::user_id_for_pubkey'),
  'I17 the vault_user_id is DERIVED from the key, not read back from a row anything could have written');
const ensureSig = (/pub fn ensure_seafarer_identity\s*\(([\s\S]*?)\)\s*->/.exec(jobsRs) || [])[1] || '';
ok(/^\s*state:\s*tauri::State<crate::AppState>,?\s*$/.test(ensureSig),
  'I17b the command takes only the app state — there is no argument a WebView script could substitute an identity with');
ok(String(identityRustBody || '').includes('crate::identity::identity_key_register_message'),
  'I17c the self-signature is over the server\'s own registration message');
ok(String(identityRustBody || '').includes('signing.sign('),
  'I17d and it is really signed — the authenticity gate is not weakened anywhere here');
const claimJsonBlock = blockAfter(String(identityRustBody || ''), 'let claim_body = serde_json::json!');
const claimKeys = (String(claimJsonBlock || '').match(/"([a-z_]+)"\s*:/g) || []).map((s) => s.replace(/[":\s]/g, ''));
ok(JSON.stringify(claimKeys.slice().sort()) === JSON.stringify(['date_of_birth', 'first_name', 'last_name', 'nationality_code', 'vault_user_id']),
  `I17e the claim carries EXACTLY the five fields of a schema that is extra="forbid" (found ${claimKeys.join(',')})`);
ok(stateBody !== null && !/reqwest|send_on_response_bases|api::/.test(String(stateBody || '')),
  'I17f the state the screen reads is a vault read with no network in it at all');

// ---- I18: the vault mutex is not held across a request ---------------------
// Every request of this path is bounded by the client's 20-second timeout and
// `send_on_response_bases` walks EVERY base on a transport error, so one lock
// around both requests blocks every other vault command for up to 40 s against
// a stand and up to 80 s against the two production bases — an app that has
// frozen, on the phone, in the week it is being driven by hand.
//
// MEASURED POSITIONALLY, not by keyword: for each `state.conn.lock()` the block
// that CONTAINS it is taken, and a request inside that block is the defect. A
// single lock at the top of the function makes that block the whole body, which
// is exactly how this read before S4e.
function locksSpanningNetwork(body) {
  const src2 = String(body || '');
  const out = [];
  let from = 0;
  for (;;) {
    const at = src2.indexOf('state.conn.lock()', from);
    if (at < 0) break;
    from = at + 1;
    // No enclosing `{` inside the body means the lock was taken at the TOP
    // LEVEL of the function — so the block it is held for is the whole body,
    // which is exactly the shape this assertion exists to catch. It is not a
    // parse failure and must not be reported as one.
    const block = enclosingBlock(src2, at) === null ? src2 : enclosingBlock(src2, at);
    if (/send_on_response_bases\s*\(|\.send\s*\(/.test(withoutLineComments(block))) out.push('SPANS');
  }
  return out;
}
['ensure_seafarer_identity', 'submit_profile_response'].forEach((fn) => {
  const body = rustFnBody(jobsRs, fn) || '';
  const bad = locksSpanningNetwork(body);
  ok(bad.length === 0,
    `I18 ${fn} never holds the vault lock across a request (found ${bad.length}: ${bad.join(',') || 'none'})`);
});
const identityLocks = countOf(withoutLineComments(String(identityRustBody || '')), 'state.conn.lock()');
ok(identityLocks === 3,
  `I18b it takes that lock three separate times — read, the claim answer, the marker (found ${identityLocks})`);
ok(countOf(withoutLineComments(String(rustFnBody(jobsRs, 'submit_profile_response') || '')), 'state.conn.lock()') === 1,
  'I18c and the command it copies takes it once, before the network — the shape is the file\'s, not this function\'s');

// ════════════════════════════════════════════════════════════════════════════
// N. A SERVICE BUILD WRITES NOTHING INTO THE LIVE PRODUCT — S4e.
//
// `api::api_bases()` takes its only override from a RUNTIME variable an Android
// process cannot be given (`src-tauri/src/api.rs`), so on a phone that list is
// exactly `[api.skipi.app, api-ru.skipi.app]`. Every command that walks it
// writes into the product real seafarers use. S4d closed the identity claim,
// the identity key and the messaging key. Two surfaces were left, and one of
// them fires with nobody touching it.
//
// MEASUREMENT BOUNDARY, stated rather than implied: this asserts WHICH COMMAND
// IS INVOKED, in a DOM shim. It compiles nothing, reaches no network and does
// not measure a phone.
// ════════════════════════════════════════════════════════════════════════════

section('N. "Join the crew" no longer writes an immutable identity into production');

// The record `register_my_identity_pubkey` writes is first-writer-wins: a
// different key for the same vault is a 409 forever, so a single accidental tap
// on a service build could never be taken back.
const directJoinKeyCalls = countOf(html, "invoke('register_my_identity_pubkey')");
ok(directJoinKeyCalls === 1,
  `N1 the vault identity key is registered from exactly ONE place in this file (found ${directJoinKeyCalls})`);
const joinJs = fnBody(html, 'skipiRegisterJoinIdentity');
ok(joinJs !== null, 'N1b and that place is the guard, not the flow');
ok(String(joinJs || '').includes("invoke('jobs_response_endpoint')"),
  'N2 it asks which server this build talks to before registering anything');
ok(String(joinJs || '').includes("invoke('ensure_seafarer_identity')"),
  'N2b a service build registers the same key through the command that speaks only to response_bases()');
ok(!withoutLineComments(String(fnBody(html, 'myVesselAccept') || '')).includes("invoke('register_my_identity_pubkey')"),
  'N2c and the accept flow itself no longer invokes the production registration directly');

const joinRelease = await runJoinAccept({});
ok(joinRelease.calls.includes('register_my_identity_pubkey') && !joinRelease.calls.includes('ensure_seafarer_identity'),
  `N3 a release build joins exactly as it always did (called ${joinRelease.calls.join(',')})`);
const joinStand = await runJoinAccept({ endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(joinStand.calls.includes('ensure_seafarer_identity') && !joinStand.calls.includes('register_my_identity_pubkey'),
  `N4 a service build registers the same key on the stand and nothing in production (called ${joinStand.calls.join(',')})`);
const joinPilot = await runJoinAccept({ endpoint: PILOT_ENDPOINT });
ok(joinPilot.calls.includes('ensure_seafarer_identity') && !joinPilot.calls.includes('register_my_identity_pubkey'),
  `N4b and so does the PILOT build — one tap of "Join the crew" would otherwise write an IMMUTABLE, first-writer-wins identity into the live product (called ${joinPilot.calls.join(',')})`);
const joinUnknown = await runJoinAccept({ endpointThrows: true });
ok(!joinUnknown.calls.includes('register_my_identity_pubkey') && !joinUnknown.calls.includes('ensure_seafarer_identity'),
  'N5 a build that cannot tell which server it talks to registers nothing, anywhere');
ok(joinUnknown.stage === 'blocked' && /Nothing was joined|Ничего не присоединено/.test(joinUnknown.blocked),
  'N5b and says so with the sentence this flow already had — nothing was joined');

section('N. the telemetry that posts BY ITSELF stops at a service build');

// ENUMERATED FROM RUST, not listed by hand. `rustFnBody` reads one function and
// does not look inside what it calls, and feedback.rs is built in exactly that
// shape: record_app_diagnostic -> store_diagnostic -> sync_diagnostic_to_server
// -> api::post_json_empty. An assertion of the form "this command has no api::"
// would be green over every one of them. So reachability is computed: start
// from every function naming an api:: sender, add every function that calls one
// of those, repeat. A NEW sender appears here as a NEW NAME.
const feedbackRs = (allRustSrc.find(([p]) => p.endsWith('feedback.rs')) || [])[1] || '';
function rustFnNamesOf(src2) {
  return Array.from(src2.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/g)).map((m) => m[1]);
}
function apiReachingFns(src2) {
  const names = rustFnNamesOf(src2);
  const bodies = new Map(names.map((n) => [n, withoutLineComments(rustFnBody(src2, n) || '')]));
  const set = new Set(names.filter((n) => /\bapi::[a-z_]+\s*\(/.test(bodies.get(n) || '')));
  for (;;) {
    const before = set.size;
    for (const n of names) {
      if (set.has(n)) continue;
      const b = bodies.get(n) || '';
      for (const t of set) {
        if (new RegExp('\\b' + t + '\\s*\\(').test(b)) { set.add(n); break; }
      }
    }
    if (set.size === before) break;
  }
  return set;
}
const feedbackReaching = apiReachingFns(feedbackRs);
const feedbackSenders = Array.from(feedbackRs.matchAll(/#\[(?:tauri::)?command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g))
  .map((m) => m[1]).filter((c) => feedbackReaching.has(c)).sort();
ok(JSON.stringify(feedbackSenders) === JSON.stringify(['init_app_diagnostics', 'record_app_diagnostic', 'submit_app_feedback']),
  `N6 the commands of feedback.rs that can reach the network are exactly the three known ones (found ${feedbackSenders.join(',')})`);
// `app_heartbeat` and `mark_app_shutdown` are NOT in that set and are therefore
// not behind the guard: they write to the local sqlite and reach no network.
ok(!feedbackSenders.includes('app_heartbeat') && !feedbackSenders.includes('mark_app_shutdown'),
  'N6b the two local-only commands are not senders, which is why they are left alone');
// `submit_app_feedback` IS a sender and is deliberately NOT guarded here: it
// fires only when a person taps "send" on the rating dialog, and refusing it
// needs a sentence to that person — a copy decision, reported to the manager
// rather than taken inside this slice. Named so it cannot be forgotten.

const DIAGNOSTIC_SENDERS = ['record_app_diagnostic', 'init_app_diagnostics'];
DIAGNOSTIC_SENDERS.forEach((cmd) => {
  ok(countOf(html, `invoke('${cmd}'`) === 1,
    `N7 ${cmd} is invoked from exactly one place in this file`);
});
const diagGuardJs = fnBody(html, 'skipiDiagnosticsMayLeave');
ok(diagGuardJs !== null, 'N8 there is one guard, named');
ok(String(diagGuardJs || '').includes("invoke('jobs_response_endpoint')"),
  'N8b and it asks which server this build talks to');
ok(/returnnonprod===false/.test(String(diagGuardJs || '').replace(/\s+/g, '')),
  'N8c unknown is not "no": only a build that KNOWS it is the production build reports');
['reportAppDiagnostic', 'startAppDiagnostics'].forEach((fn) => {
  ok(withoutLineComments(String(fnBody(html, fn) || '')).includes('skipiDiagnosticsMayLeave('),
    `N9 ${fn} passes through the guard`);
});

const relDiag = await runDiagnostic({});
ok(relDiag.calls.includes('record_app_diagnostic'),
  `N10 a release build still reports an error, unchanged (called ${relDiag.calls.join(',')})`);
const standDiag = await runDiagnostic({ endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(!standDiag.calls.includes('record_app_diagnostic'),
  'N11 a service build reports nothing — and it generates errors by construction');
const pilotDiag = await runDiagnostic({ endpoint: PILOT_ENDPOINT });
ok(!pilotDiag.calls.includes('record_app_diagnostic'),
  'N11b nor does the pilot build — nothing here waits for a tap, and every report would carry install_id, version and a stack into the live product');
const unknownDiag = await runDiagnostic({ endpointThrows: true });
ok(!unknownDiag.calls.includes('record_app_diagnostic'),
  'N12 nor does a build that cannot say which server it is talking to');

// The report NOBODY presses: `init()` calls `startAppDiagnostics()` itself, and
// a previous session that did not close cleanly is posted from there before the
// seafarer has touched anything at all.
const relStart = await runStartup({});
ok(relStart.calls.includes('init_app_diagnostics'),
  'N13 a release build still opens its diagnostics session at startup');
const standStart = await runStartup({ endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(!standStart.calls.includes('init_app_diagnostics'),
  'N14 a service build posts no unclean_shutdown report into the live product at startup');
const pilotStart = await runStartup({ endpoint: PILOT_ENDPOINT });
ok(!pilotStart.calls.includes('init_app_diagnostics'),
  'N14b nor does the pilot build, which the owner will start many times over');
const unknownStart = await runStartup({ endpointThrows: true });
ok(!unknownStart.calls.includes('init_app_diagnostics'),
  'N15 and neither does a build that cannot tell');
// NOT ASSERTED, and said instead of faked: `setInterval` is a stub in this
// shim, so the heartbeat and the lag timer never tick here. Their commands are
// local-only (N6b), which is why nothing about them is claimed.

section('N. a service build does not ASK for a rating by itself');

// WHY THIS IS NOT PRECAUTION: `get_feedback_prompt_state` answers should_prompt
// on the THIRD launch with no rating submitted (feedback.rs,
// FIRST_PROMPT_LAUNCHES = 3), and `loadVault` schedules this dialog 90 seconds
// after a vault opens. Ten cycles on a phone pass that mark many times over, and
// what the dialog collects goes to production through `submit_app_feedback`.
// The cure is not a refusal a person would have to be told about: the dialog is
// simply not RAISED. Nothing shown is nothing to be wrong about.
const promptGuardJs = fnBody(html, 'skipiFeedbackPromptAllowed');
ok(promptGuardJs !== null, 'N16 the automatic prompt has a guard of its own, named');
ok(String(promptGuardJs || '').includes("invoke('jobs_response_endpoint')"),
  'N16b which asks which server this build talks to');
ok(/returnnonprod===false/.test(String(promptGuardJs || '').replace(/\s+/g, '')),
  'N16c and is fail-closed on the unknown, the same shape as the other two guards');
const promptBody = String(fnBody(html, 'maybePromptForFeedback') || '');
const guardAt = withoutLineComments(promptBody).indexOf('skipiFeedbackPromptAllowed(');
const stateAskAt = withoutLineComments(promptBody).indexOf("invoke('get_feedback_prompt_state'");
ok(guardAt >= 0 && stateAskAt >= 0 && guardAt < stateAskAt,
  'N17 and it is asked BEFORE the prompt state, which is not a pure read — a "yes" spends a 14-day cooldown');

const promptRelease = await runFeedbackPrompt({});
ok(promptRelease.scheduledMs === 90000,
  `N18 the prompt is really scheduled by the product, 90 s after a vault opens (got ${promptRelease.scheduledMs})`);
ok(promptRelease.dialogOpened,
  'N18b CONTROL — on a release build the dialog still opens by itself, exactly as before');
ok(promptRelease.calls.includes('get_feedback_prompt_state'),
  'N18c and it still asks the state that decides it');

const promptStand = await runFeedbackPrompt({ endpoint: { base: 'http://127.0.0.1:8099', stand: true } });
ok(!promptStand.dialogOpened,
  'N19 a service build never raises it — the rating it would collect goes to the live product');
ok(!promptStand.calls.includes('get_feedback_prompt_state'),
  'N19b and does not even ask, so no cooldown is spent on a build nobody is rating');

const promptPilot = await runFeedbackPrompt({ endpoint: PILOT_ENDPOINT });
ok(!promptPilot.dialogOpened,
  'N19c nor does the pilot build raise it — the rating it collects goes to production through submit_app_feedback');
ok(!promptPilot.calls.includes('get_feedback_prompt_state'),
  'N19d and it does not even ask, so no 14-day cooldown is spent on a build nobody is rating');
const promptUnknown = await runFeedbackPrompt({ endpointThrows: true });
ok(!promptUnknown.dialogOpened,
  'N20 and neither does a build that cannot say which server it is talking to');
ok(!promptUnknown.calls.includes('get_feedback_prompt_state'), 'N20b nor does it ask');

// THE MANUAL DOOR IS NOT TOUCHED, and that is asserted rather than promised: a
// person tapping "Rate Skipi Seafarer" acted on purpose. Only the automatic
// path is closed.
ok(!withoutLineComments(String(fnBody(html, 'openFeedbackDialog') || '')).includes('skipiFeedbackPromptAllowed('),
  'N21 the dialog itself carries no guard — a person who taps still gets it');
ok(html.includes("openFeedbackDialog(\\'about\\')") || html.includes("openFeedbackDialog('about')"),
  'N21b the About screen still offers the manual rating button');
ok(html.includes("openFeedbackDialog(\\'mobile-top-feedback\\')") || html.includes("openFeedbackDialog('mobile-top-feedback')"),
  'N21c and so does the mobile feedback menu');
const openDialogSites = countOf(html, 'openFeedbackDialog(') - countOf(html, 'function openFeedbackDialog(');
ok(openDialogSites === 3,
  `N21d exactly three ways in: two manual and the automatic one this guard closes (found ${openDialogSites})`);

section('Q. one 409 is not four — a repeat says what really happened');

// MEASURED LIVE 2026-09-29: a second press answered 409 on a stand where
// `candidate_intake_tombstones` was 0, the intake was alive and one row stood in
// `profile_responses` — and the screen said the agency had removed what the
// response was delivered into. Four refusals of this route share the status
// code; the words are the only thing that separates them.
const conflictTokenBody = rustFnBody(jobsRs, 'response_conflict_token');
ok(conflictTokenBody !== null, 'Q1 jobs.rs has one named place that classifies a 409');
ok(submitBody !== null && /response_conflict_token\(&answer\.body\)/.test(submitBody),
  'Q2 and the response path hands it THE SERVER\'S OWN BODY, which is where the words are');
ok(!/RESPONSE_NO_LONGER_ACCEPTED/.test(jobsRs),
  'Q3 no 409 is read as a deleted document any more — the server has no word that means it');
const conflictTokens = Array.from(new Set(
  Array.from(String(conflictTokenBody || '').matchAll(/RESPONSE_[A-Z_]+/g)).map((m) => m[0]))).sort();
ok(JSON.stringify(conflictTokens) === JSON.stringify(['RESPONSE_ALREADY_DELIVERED', 'RESPONSE_CONFLICT_UNKNOWN']),
  `Q4 the classification is a CLOSED SET of two markers (found ${conflictTokens.join(',')})`);
ok(jobsRs.includes('const INTAKE_CONTENT_CONFLICT: &str = "event already accepted with different content"'),
  'Q5 the one word it matches is the server\'s own sentence, byte for byte');
ok(/ifbody\.contains\(INTAKE_CONTENT_CONFLICT\)\{RESPONSE_ALREADY_DELIVERED\}else\{RESPONSE_CONFLICT_UNKNOWN\}/
    .test(String(conflictTokenBody || '').replace(/\s+/g, '')),
  'Q6 and the fallback is the marker that CLAIMS NOTHING — fail-closed on a body this build does not know');

const already = await runRespond({ submitThrows: 'RESPONSE_ALREADY_DELIVERED' });
ok(already.statusState === 'gone', `Q7 a repeat has its own state (got ${already.statusState})`);
ok(/already been delivered/i.test(already.statusHtml), 'Q8 and its own sentence: the response is already on record');
ok(!/removed/i.test(already.statusHtml),
  'Q9 it does NOT say the agency removed anything — no word the client holds says that');
ok(already.buttonDisabled === true,
  'Q10 and the button is not re-offered: the same id rebuilt into different bytes can only earn the same 409');

const unknown409 = await runRespond({ submitThrows: 'RESPONSE_CONFLICT_UNKNOWN' });
ok(unknown409.statusState === 'gone', 'Q11 a conflict this build cannot name still ends the attempt');
ok(/did not accept/i.test(unknown409.statusHtml), 'Q12 with a sentence that is true of every one of them');
ok(!/removed/i.test(unknown409.statusHtml) && !/delivered/i.test(unknown409.statusHtml),
  'Q13 claiming neither a delivery nor a removal — the two things it does not know');

for (const [lang, needle] of [['en', 'already been delivered'], ['ru', 'уже доставлен']]) {
  const r = await runRespond({ lang, submitThrows: 'RESPONSE_ALREADY_DELIVERED' });
  ok(r.statusHtml.includes(needle), `Q14 (${lang}) the repeat sentence is localised`);
}
for (const [lang, needle] of [['en', 'did not accept'], ['ru', 'не приняло']]) {
  const r = await runRespond({ lang, submitThrows: 'RESPONSE_CONFLICT_UNKNOWN' });
  ok(r.statusHtml.includes(needle), `Q15 (${lang}) so is the one that names nothing`);
}

console.log('');
if (fail > 0) {
  console.error(`FAILURES (${fail}):`);
  failures.forEach((f) => console.error('  - ' + f));
  console.error(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

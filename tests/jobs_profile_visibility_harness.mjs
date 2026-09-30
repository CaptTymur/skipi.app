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

// "This markup makes no AFFIRMATIVE claim of X" — every occurrence of the word
// must be part of the one negative phrase that is allowed to contain it. A bare
// `!/x/i` cannot express that: it reads "not x" as "x".
function claimsOnly(markup, wordRe, allowedPhrase) {
  const stripped = String(markup || '').split(allowedPhrase).join(' ');
  return !wordRe.test(stripped);
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

// Whitespace-insensitive source, so that a multi-line call reads the same as a
// one-line one and a reformat cannot turn a held property into a red line. Five
// of the eight identity writes are multi-line calls, which is exactly how a
// one-line grep came to miss them.
function tight(s) {
  return String(s || '').replace(/\s+/g, '');
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
  profile_id: '81d508ff-23fb-4c85-a14b-8f6151df1e1a',   // MEASURED, and a UUID
  // MEASURED: the agency half of this row is the live server's own bytes.
  crewing_id: 'dcdc1fa4-5187-4801-a365-ade399601ae7',
  crewing_name: 'Aegean Crew Services',
  crewing_jurisdiction: 'GR',
  crewing_trust_status: 'active',
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

// ---- W. who receives an irreversible response (P2/V5c) ---------------------
//
// THE IDENTITIES BELOW ARE MEASURED, not invented. They are the two rows a
// LIVE server answered on 2026-09-29T17:02:32Z (see LIVE_BODY at the foot of
// this file for the captured answer itself). What is still constructed here is
// the REQUIREMENTS half — `published_version`, `mandatory_certs` and
// `extra_requirements` are chosen to exercise have / missing / unknown against
// the catalog above, and the live rows do not carry that spread. Which half is
// which is said out loud so the next reader does not have to guess.
const CREWING_ALPHA_ID = 'dcdc1fa4-5187-4801-a365-ade399601ae7';   // MEASURED
const CREWING_BRAVO_ID = '322dc865-60a1-4ded-a816-20bb3ac9c4d8';   // MEASURED

// A second agency, so "the seafarer can tell WHICH agency" is measured by two
// rows that differ, not by one row that happens to carry a string.
const PROFILE_OTHER_AGENCY = {
  ...PROFILE_MATCH,
  profile_id: '3f51ec8e-34f9-4375-8120-9d2c56b9c77f',   // MEASURED
  crewing_id: CREWING_BRAVO_ID,
  crewing_name: 'Limassol Marine Manning',
  crewing_jurisdiction: 'CY',
  crewing_trust_status: 'trial',
};

// SYNTHETIC, and said so: the live surface sends the jurisdiction already
// upper-cased, so the client's own normalisation cannot be proven on it. This
// row exists to prove that one line of behaviour and nothing else.
const PROFILE_LOWERCASE_JUR = {
  ...PROFILE_MATCH,
  profile_id: 'prof-lowercase-jur-0007',
  crewing_jurisdiction: 'gr',
};

// SYNTHETIC, and said so: a name of nothing but whitespace. The live server has
// never sent one, but `crewing_name` is a free-form string a crewing writes
// itself through `PATCH /api/crewings/{id}/profile`, so " " is reachable by a
// counterparty rather than by an accident. A blank is not a name.
const PROFILE_BLANK_NAME = {
  ...PROFILE_MATCH,
  profile_id: 'prof-blankname-0008',
  crewing_name: '   ',
};

// THE OLD SERVER, which is the one the pilot is running until the other half of
// this contract is deployed: the three fields simply are not in the answer.
// This row is not a hypothetical — it is today's production shape.
const PROFILE_NO_AGENCY_FIELDS = (() => {
  const p = { ...PROFILE_MATCH, profile_id: 'prof-oldsrv-0006' };
  delete p.crewing_name;
  delete p.crewing_jurisdiction;
  delete p.crewing_trust_status;
  return p;
})();

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

// The row-name suffix of a non-production base, WRITTEN OUT BY HAND from the
// card: trimmed, no trailing slash, lower case. Not read from jobs.rs on
// purpose — see the boundary note in section X.
function identityScopeOf(base) {
  return String(base || '').trim().replace(/\/+$/, '').toLowerCase();
}

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
      // WHAT THE VAULT ALREADY HOLDS ABOUT DELIVERED RESPONSES (№605). The
      // five conditions that make a receipt this vault's, this registry's,
      // this profile's and this response's are checked IN RUST — this stub
      // stands for a command that has already applied them, and the JS side's
      // own contract is what it does with the answer.
      //
      // `receiptsThrow` is a REAL state and not decoration: the command is new,
      // so a build whose WebView is newer than its binary answers "not
      // registered", and the loader must then draw today's screen rather than
      // no screen.
      case 'jobs_response_receipts':
        state.receiptCalls.push((args && args.profileIds) || null);
        if (state.receiptsThrow) throw new Error('command not registered');
        return JSON.parse(JSON.stringify(state.receipts));
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
      case 'seafarer_identity_entry_state': {
        if (state.identityStateThrows) throw new Error('No vault open');
        // THE RUST COMMAND'S CONTRACT FOR THE SCOPED ROWS (V12c), restated here
        // BY HAND from the task card and deliberately NOT derived from jobs.rs:
        // a stub that read the rule out of the file it is checking would compare
        // the code with itself. On a stand or the pilot the command answers the
        // rows bound to THAT base; on production it answers the global rows.
        //
        // Only a test that models a per-base vault (`identityByBase`) gets that
        // answer. Every test written before this card passes no such model and
        // is answered exactly as it was.
        if (state.identityByBase) {
          const ep = state.endpoint || {};
          if (ep.stand === true || ep.pilot === true) {
            const forBase = state.identityByBase[identityScopeOf(ep.base)] || IDENTITY_NONE;
            return JSON.parse(JSON.stringify(forBase));
          }
        }
        return JSON.parse(JSON.stringify(state.identity));
      }
      case 'ensure_seafarer_identity':
        state.ensureCalls.push(args || {});
        if (state.ensureThrows) throw new Error(state.ensureThrows);
        return JSON.parse(JSON.stringify(state.ensureResult));
      case 'get_matchable_profile':
        // profile.rs:1005/1020 reads the BARE, GLOBAL row and this card does not
        // touch it — so what the join screen gets is the identity of whichever
        // registry issued it, never the one bound to the base in use.
        return {
          user_id: 'harness-vault-user',
          public_seafarer_id: (state.identityGlobal || state.identity).public_seafarer_id,
        };
      case 'get_identity_trust_status':
        if (state.trustThrows) throw new Error('vault locked');
        return JSON.parse(JSON.stringify(state.trust));
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
    // The receipts the vault holds. EMPTY BY DEFAULT, so every assertion
    // written before this card is answered exactly as it was: no receipt is the
    // state of every vault that has not delivered anything.
    receipts: opts.receipts === undefined ? {} : opts.receipts,
    receiptsThrow: !!opts.receiptsThrow,
    receiptCalls: [],
    cvThrows: !!opts.cvThrows,
    responseIdThrows: !!opts.responseIdThrows,
    identity: opts.identity === undefined ? { ...IDENTITY_READY } : { ...opts.identity },
    // The per-base vault, absent unless a test models it (see the stub above).
    identityByBase: opts.identityByBase === undefined ? null : opts.identityByBase,
    // The GLOBAL rows, which on a non-production build are the ones ANOTHER
    // registry wrote. Absent unless a test distinguishes them.
    identityGlobal: opts.identityGlobal === undefined ? null : opts.identityGlobal,
    identityStateThrows: !!opts.identityStateThrows,
    // What `get_identity_trust_status` answers. The default is the state in
    // which the legacy "Claim Skipi Seafarer ID" button IS drawn today: a vault
    // with a fingerprint and no server identity at all.
    trust: opts.trust === undefined
      ? {
          status: 'unique',
          user_id: 'harness-vault-user',
          identity_fingerprint: 'idfp1_harnessfixture',
          fingerprint_version: 1,
          server_identity: {},
          profile: { name: 'Tymur Rudov', date_of_birth: '1980-01-01', nationality: 'Ukraine' },
          possible_duplicates: [],
          linked_copies: [],
        }
      : opts.trust,
    trustThrows: !!opts.trustThrows,
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
  const booted = boot({ profiles: [PROFILE_MATCH], ...opts, respondFor: [pid] });
  // THE SCREEN IS RENDERED BEFORE THE HANDLER RUNS, and that is not decoration.
  // In the product the only way to reach `jobsRespondToProfile` is a button
  // `jobsProfilesSectionHtml` drew, and drawing it is what records the profiles
  // in `jobsProfilesLastRender`. Calling the handler over a screen that was
  // never rendered measured a state no seafarer can be in — and from V7 on it
  // measures the wrong thing outright, because the handler now REFUSES when it
  // cannot find the profile it is about to speak for.
  try {
    await booted.sandbox.showJobs();
  } catch (e) { /* what a failed render does to the respond path is section V's claim, not this one */ }
  await settle();
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

// Renders the real Jobs screen, then presses the REAL identity step handler, and
// returns the section BEFORE and AFTER the press. The two snapshots are the
// measurement: "a refusal did not move the decision" is a claim about the
// difference between them, and it is worth nothing without the calibration that
// a SUCCESS does move it.
async function pressIdentityStep(opts = {}) {
  const pid = opts.profileId || PROFILE_MATCH.profile_id;
  const rendered = await renderJobsScreen({ profiles: [PROFILE_MATCH], ...opts });
  const before = rendered.profilesHost.innerHTML;
  // Same reason the other drivers pre-create their nodes: the shim keeps
  // innerHTML as a string, so the status line and the button the handler writes
  // into are put where a browser would already have them.
  const status = rendered.document.createElement('div');
  status.setAttribute('id', 'jobs-identity-status-' + pid);
  const btn = rendered.document.createElement('button');
  btn.setAttribute('id', 'jobs-identity-btn-' + pid);
  const callsBefore = rendered.state.calls.map((c) => c[0]);
  let pressError = null;
  try {
    await rendered.sandbox.jobsEnsureSkipiId(pid);
  } catch (e) {
    pressError = e;
  }
  await settle();
  return {
    ...rendered,
    before,
    after: rendered.profilesHost.innerHTML,
    callsBefore,
    callsAfter: rendered.state.calls.map((c) => c[0]),
    statusHtml: status.innerHTML,
    pressError,
  };
}

// Runs the REAL identity-trust card of the settings screen — the one that draws
// the legacy "Claim Skipi Seafarer ID" button — through whichever of its two
// callers is asked for.
//
// A SHIM ARTIFACT USED ON PURPOSE, and named so it is not mistaken for the
// product: FakeDocument registers every `id=` it finds in the file, including
// the markup that lives inside an inline script as a string literal. So both
// hosts (`#vault-identity-trust`, `#mobile-identity-trust`) exist before
// anything opened that screen, which is what lets this driver call the real
// loader without walking the settings UI.
async function renderTrustCard(opts = {}) {
  const booted = boot(opts);
  await settle();
  const host = booted.document.getElementById(
    opts.compact ? 'mobile-identity-trust' : 'vault-identity-trust');
  let error = null;
  try {
    if (opts.compact) await booted.sandbox.mobileRefreshIdentityTrust();
    else await booted.sandbox.loadIdentityTrustStatus();
  } catch (e) {
    error = e;
  }
  await settle();
  return { ...booted, error, host, html: host ? host.innerHTML : null };
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
  // V12c: the one new pair of strings this card adds. Without this line the
  // localisation checks below would not look at it and the green would be empty.
  'jobs.profiles.identity_server_own',
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
// V12c adds the SIXTH: `skipiNonProductionBuild`, which decides whether the
// legacy "Claim Skipi Seafarer ID" button — a write to `api::api_bases()`, i.e.
// to production — is drawn at all. It is a write decider and reads the pair.
const ENDPOINT_READERS = ['skipiDiagnosticsMayLeave', 'skipiFeedbackPromptAllowed',
  'skipiRegisterJoinIdentity', 'skipiPublishMessagingPubkey', 'loadJobsProfiles',
  'skipiNonProductionBuild'];
const endpointReadSites = countOf(html, "invoke('jobs_response_endpoint')");
ok(endpointReadSites === ENDPOINT_READERS.length,
  `U13 exactly ${ENDPOINT_READERS.length} places in dist/index.html ask which server this build talks to (found ${endpointReadSites}) — a new one appears here as a mismatch`);
ENDPOINT_READERS.forEach((fn) => {
  ok(String(fnBody(html, fn) || '').includes("invoke('jobs_response_endpoint')"),
    `U13b ${fn} is one of them`);
});
const WRITE_DECIDERS = ENDPOINT_READERS.filter((f) => f !== 'loadJobsProfiles');
ok(WRITE_DECIDERS.length === 5,
  `U13c five of the six decide a write that would otherwise leave for production (found ${WRITE_DECIDERS.length})`);
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
  // Same reason as in runRespond above: the section is rendered first, because
  // that is what puts this profile where the handler looks for its recipient.
  await twice.sandbox.showJobs();
  await settle();
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
ok(submitBody !== null
  && tight(submitBody).includes('get_vault_info_value(conn,&identity_vault_key(&endpoint,KEY_PUBLIC_SEAFARER_ID)'),
  'P9 the seafarer identity the response is delivered as is the vault\'s own — and (V12c) the row of the registry being delivered to');
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
// V12c moved the WRITES of the claim answer and of the registration marker out of
// the command and behind two functions, so that a test can run the whole recorded
// sequence against an in-memory vault. The properties asserted below did not
// change; the place they are asserted over did, and these two bodies are it.
const claimWriterBody = String(rustFnBody(jobsRs, 'write_identity_claim_answer') || '');
const markerWriterBody = String(rustFnBody(jobsRs, 'write_identity_key_marker') || '');

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
const markerAt = String(identityRustBody || '').indexOf('write_identity_key_marker(');
const keyPostAt = String(identityRustBody || '').indexOf('"/api/seafarer-identity/identity-key"');
ok(keyPostAt >= 0 && markerAt > keyPostAt,
  'I8c the marker that opens the respond button is written only AFTER the server accepted the identity');
ok(tight(markerWriterBody).includes('identity_vault_key(endpoint,IDENTITY_KEY_REGISTERED_AT)'),
  'I8c2 (V12c) and the marker it writes belongs to the server that accepted it, not to every server');
ok(/if key_answer\.status == 409/.test(String(identityRustBody || '')),
  'I8d 409 — this vault is already bound to a different identity — is a refusal, not a success');
// COUNTED, NOT LOCATED, and the difference is a defect that got through: I8c
// reads the POSITION of one literal, so a SECOND write of the same marker —
// three lines inside the `status == 409` branch, which comes after the POST —
// leaves the first write exactly where it was and I8c green. That mutation
// restores defect A-1 whole (a vault with no identity on the server gets the
// respond button) through the branch S4d itself added.
// V12c: the marker is written by ONE function, and the command calls it ONCE.
// The mutation this catches is unchanged — a second marker write inside the
// `status == 409` branch would leave the first exactly where it is and I8c green,
// and it would restore defect A-1 whole.
const markerWrites = countOf(String(identityRustBody || ''), 'write_identity_key_marker(');
ok(markerWrites === 1,
  `I8f the marker that opens the respond button is written in EXACTLY ONE place in this command (found ${markerWrites})`);
ok(countOf(markerWriterBody, 'set_vault_info(') === 1,
  `I8f2 and the function it calls writes exactly one row (found ${countOf(markerWriterBody, 'set_vault_info(')})`);
ok(countOf(String(identityRustBody || ''), 'IDENTITY_KEY_REGISTERED_AT') === 0,
  'I8f3 and the command itself no longer names the marker row — there is one door to it');
// GENERALISED FROM THAT ONE ROW TO ALL EIGHT (delta R1), because I8f3 closes a
// ROW and the hole is the SHAPE. One line added to a command body —
// `crate::db::set_vault_info(conn, KEY_IDENTITY_MESSAGE, …)`, the CONSTANT and
// not the literal, outside the two extracted writers — writes a GLOBAL row and
// was caught by nothing: X8 counts the LITERAL, which lives in the `const` and
// is therefore already exactly one; X8b greps RAW key strings; X12f is a lower
// bound `>= 8` and a bare write adds no `identity_vault_key(` to count; and the
// Rust tests drive the two writers directly. Measured with that line in:
// cargo 176/0 and this harness 759/0 — nothing went red.
//
// The invariant, therefore: inside a COMMAND body none of the eight constants
// may appear except as the argument of `identity_vault_key(` — the one door. The
// two writers are deliberately outside this loop: they reach the same door
// through their own local `row(` closure, which is what the calibration below
// uses to prove this probe can see an occurrence that does NOT go through it.
// I8f3 is kept, not replaced: for the marker it asserts zero occurrences of any
// kind, which is stricter than "only through the door".
const EIGHT_KEY_CONSTS = ['KEY_PUBLIC_SEAFARER_ID', 'KEY_IDENTITY_CLAIM_STATUS',
  'KEY_IDENTITY_DUPLICATE', 'KEY_IDENTITY_TRUST_LEVEL', 'KEY_IDENTITY_MESSAGE',
  'KEY_IDENTITY_LAST_CLAIM_AT', 'KEY_IDENTITY_RECOVERY_KEY', 'IDENTITY_KEY_REGISTERED_AT'];
function unscopedKeyConsts(body) {
  const flat = withoutLineComments(String(body || '')).replace(/\s+/g, '');
  const out = [];
  EIGHT_KEY_CONSTS.forEach((c) => {
    const total = countOf(flat, c);
    const scoped = countOf(flat, 'identity_vault_key(&endpoint,' + c + ')');
    if (total !== scoped) out.push(`${c}: ${total} named, ${scoped} through the one function`);
  });
  return out;
}
['ensure_seafarer_identity', 'submit_profile_response', 'seafarer_identity_entry_state'].forEach((fn) => {
  const bare = unscopedKeyConsts(rustFnBody(jobsRs, fn));
  ok(bare.length === 0,
    `I8f4 (R1) ${fn} names none of the eight rows except through identity_vault_key( (${bare.join(' | ') || 'none'})`);
});
const i8f5 = unscopedKeyConsts(claimWriterBody);
ok(i8f5.length === 7,
  `I8f5 CALIBRATION — the same probe DOES see the seven constants the claim writer reaches through its own row( closure instead (found ${i8f5.length}), so I8f4 is not green over a blind probe`);
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
// V12c: the refusal and the write live in `write_identity_claim_answer`, in the
// order they were in before. The claim is the same claim.
const emptyGuardAt = claimWriterBody.indexOf('if issued.is_empty()');
const writeIdAt = tight(claimWriterBody).indexOf('row(KEY_PUBLIC_SEAFARER_ID),issued');
ok(emptyGuardAt >= 0 && writeIdAt >= 0
  && tight(claimWriterBody).indexOf('ifissued.is_empty()') < writeIdAt,
  'I9c the public id is written to the vault only AFTER an empty one has been refused');
const dupBranch = blockAfter(claimWriterBody, 'if issued.is_empty()');
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
// `jobs_response_receipts` is in this list from the day it was written, and it
// has no request in it at all. That is the point of pinning it here: the reader
// of №605 answers from the vault, and the invariant says it will stay that way.
['ensure_seafarer_identity', 'submit_profile_response', 'jobs_response_receipts'].forEach((fn) => {
  const body = rustFnBody(jobsRs, fn) || '';
  const bad = locksSpanningNetwork(body);
  ok(bad.length === 0,
    `I18 ${fn} never holds the vault lock across a request (found ${bad.length}: ${bad.join(',') || 'none'})`);
});
const identityLocks = countOf(withoutLineComments(String(identityRustBody || '')), 'state.conn.lock()');
ok(identityLocks === 3,
  `I18b it takes that lock three separate times — read, the claim answer, the marker (found ${identityLocks})`);
// THREE, and each one is named, for the same reason `I18b` counts three next
// door: №605 added two vault writes to this command and a count of one would
// have been red on an honest implementation.
//
// THE COUNT IS NOT COSMETIC AND IT IS NOT WEAKENED BY BEING RAISED. The
// tempting way to keep this green at one was to move `lock()` + `set_vault_info`
// into a helper function — and `rustFnBody` does not follow a call, so BOTH I18
// and I18c would have gone blind while reading green. That is exactly "do the
// card honestly and break the guard", so the writes stay INLINE here, each in
// its own narrow block after the request, and this number rises to say so.
// Mutation D15 is the proof: move either write into a helper and this drops to
// one.
const submitLocks = countOf(withoutLineComments(String(rustFnBody(jobsRs, 'submit_profile_response') || '')), 'state.conn.lock()');
ok(submitLocks === 3,
  `I18c it takes that lock three separate times — the identity read before the network, the receipt on the server's acknowledgement, the receipt on the classified 409 (found ${submitLocks})`);

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

// ════════════════════════════════════════════════════════════════════════════
// P2/V5c — WHO the irreversible response goes to.
//
// The owner's words: before responding, the seafarer must see a COMPREHENSIBLE
// NAME of the receiving agency — not a UUID and not a conditional label
// ("Agency A / B" was put to him and refused).
//
// MEASUREMENT BOUNDARY, stated before the assertions: the three fields below
// are read from a FIXTURE in this file. The server half of the contract is
// written in parallel and nothing here has met it. So these assertions prove
// (a) the client renders a name it is given, (b) it survives an answer without
// the fields, and (c) no id reaches the screen — they do NOT prove the two
// halves agree. That is proven only by parsing a RAW ANSWER OF THE LIVE SERVER,
// and until that has been run this contract is one half, not one contract.
// ════════════════════════════════════════════════════════════════════════════

section('W. the agency is named before the irreversible response (P2/V5c)');

// A probe is worth nothing until it is shown to fire on a fact already known.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// THIS PROBE USED TO READ THE WHOLE MARKUP, AND THAT WAS THE WRONG PROBE.
// It passed only because the invented fixture gave `profile_id` a readable
// value. The LIVE surface uses a UUID there too, and the card legitimately
// carries it in `data-profile-id`, in the respond button's DOM id and in its
// onclick — none of which a seafarer reads. The owner's rule is about what he
// SEES, so the claim is made over visible text; and `crewing_id`, the id he
// refused to be shown in place of a name, is asserted absent from EVERYTHING,
// attributes included. Two different claims, two different scopes.
function visibleText(markup) {
  return String(markup || '').replace(/<[^>]*>/g, ' ');
}
ok(UUID_RE.test(JSON.stringify(PROFILE_MATCH)),
  'W0 CALIBRATION — the UUID probe does find a UUID in the bytes it is given');
ok(!UUID_RE.test(visibleText('<div data-profile-id="81d508ff-23fb-4c85-a14b-8f6151df1e1a">Crewing: someone</div>')),
  'W0b CALIBRATION — visibleText hides a UUID that lives only in an attribute');
ok(UUID_RE.test(visibleText('<div>81d508ff-23fb-4c85-a14b-8f6151df1e1a</div>')),
  'W0c CALIBRATION — and still finds one that is actually printed for the reader');

const agencyEn = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'en' });
const agencyRu = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'ru' });

ok(agencyEn.sectionHtml.includes('Aegean Crew Services'),
  'W1 the agency NAME is on the card (EN)');
ok(agencyRu.sectionHtml.includes('Aegean Crew Services'),
  'W2 and on the RU card too — a proper name is not dropped by the other locale');
ok(agencyEn.sectionHtml.includes('GR') && agencyRu.sectionHtml.includes('GR'),
  'W3 the jurisdiction is beside it in both locales (MEASURED: the live answer sends "GR")');
const lowerJur = await renderJobsScreen({ profiles: [PROFILE_LOWERCASE_JUR], lang: 'en' });
ok(lowerJur.sectionHtml.includes('GR') && !lowerJur.sectionHtml.includes('registered in gr'),
  'W3b the client still upper-cases one that arrives lower-cased (SYNTHETIC — the live answer never does)');

// The owner refused a conditional label. A UUID is the other thing he refused.
for (const [lang, r] of [['en', agencyEn], ['ru', agencyRu]]) {
  ok(!UUID_RE.test(visibleText(r.sectionHtml)),
    `W4 (${lang}) no UUID is PRINTED anywhere in the section`);
  ok(!r.sectionHtml.includes(CREWING_ALPHA_ID),
    `W4b (${lang}) and the crewing id is absent from the markup ENTIRELY, attributes included`);
}

// "A name is on screen" and "the seafarer can tell WHICH agency" are different
// claims. Two rows of two agencies is what separates them.
const twoAgencies = await renderJobsScreen({ profiles: [PROFILE_MATCH, PROFILE_OTHER_AGENCY], lang: 'en' });
ok(twoAgencies.sectionHtml.includes('Aegean Crew Services')
   && twoAgencies.sectionHtml.includes('Limassol Marine Manning'),
  'W5 two profiles of two different agencies carry two different names');
ok(!UUID_RE.test(visibleText(twoAgencies.sectionHtml)),
  'W5b and no id is printed while doing it');
ok(!twoAgencies.sectionHtml.includes(CREWING_ALPHA_ID) && !twoAgencies.sectionHtml.includes(CREWING_BRAVO_ID),
  'W5c neither crewing id appears in the markup at all');

// The counterparty is named in the SAME WORDS as the block directly above it.
// Two neighbouring blocks on one screen calling the counterparty two different
// things is the defect this assertion exists to prevent.
ok(agencyEn.sectionHtml.includes('Crewing:'),
  'W6 the EN card uses the same word the vacancy block above it uses ("Crewing:")');
ok(agencyRu.sectionHtml.includes('Крюинг:'),
  'W6b and the RU card uses that word localised, not a second word for the same thing');
ok(agencyEn.sectionHtml.includes('job-trust-badge'),
  'W7 the trust mark reuses the vacancy block\'s own badge class, not a new one');

// WHERE it is matters: the requirement is "before the irreversible response".
const crewingAt = agencyEn.sectionHtml.indexOf('data-qa="jobs-profile-crewing"');
const respondAt = agencyEn.sectionHtml.indexOf('data-qa="jobs-profile-respond"');
ok(crewingAt >= 0, 'W8 the card carries a named agency block');
ok(crewingAt >= 0 && respondAt >= 0 && crewingAt < respondAt,
  'W9 and it is rendered BEFORE the respond block — read while the choice is still open');

// A trial publisher is not a verified one, and the words must not say it is.
const trialEn = await renderJobsScreen({ profiles: [PROFILE_OTHER_AGENCY], lang: 'en' });
const trialRu = await renderJobsScreen({ profiles: [PROFILE_OTHER_AGENCY], lang: 'ru' });
ok(/trial/i.test(trialEn.sectionHtml), 'W10 (en) a trial publisher is said to be on trial');
ok(/пробн/i.test(trialRu.sectionHtml), 'W10b (ru) and so it is in Russian');
// THIS PROBE WAS NAIVE AND IS NOW PRECISE, and the change is declared rather
// than quietly made. `!/verified/i` reads the HONEST NEGATIVE sentence V7 puts
// on this badge ("name not verified by Skipi") as an affirmative claim of
// verification, so it would have gone red over text that says the opposite of
// what it was written to forbid. What it was defending is that the trial card
// makes no AFFIRMATIVE claim, and that is what is asserted now: every
// occurrence of the word must be part of the negative phrase, so an affirmative
// "Verified by Skipi" still fails it. Calibrated in section Z below on both a
// string that must fire and one that must not.
ok(claimsOnly(trialEn.sectionHtml, /verified/i, 'not verified by Skipi'),
  'W11 (en) and it makes NO affirmative claim of verification — every "verified" on it is part of the negative sentence');
ok(claimsOnly(trialRu.sectionHtml, /проверен/i, 'не проверено Skipi'),
  'W11b (ru) same');
ok(/verified/i.test(agencyEn.sectionHtml) && /проверен/i.test(agencyRu.sectionHtml),
  'W12 while an active agency IS called verified — the two states are told apart');

section('W. the answer of the server that is running TODAY still renders');

// Until the server half ships, the pilot answers without these three fields.
// The neighbouring `CandidateProfileRankSummary` has no defaults and a missing
// key there kills the parse of the WHOLE list; this surface must not repeat it.
const oldSrvEn = await renderJobsScreen({ profiles: [PROFILE_NO_AGENCY_FIELDS], lang: 'en' });
const oldSrvRu = await renderJobsScreen({ profiles: [PROFILE_NO_AGENCY_FIELDS], lang: 'ru' });
ok(!oldSrvEn.error, `W13 the screen still renders on an answer without the fields${oldSrvEn.error ? ': ' + oldSrvEn.error.message : ''}`);
ok(oldSrvEn.sectionHtml.includes('Second Officer'),
  'W14 the row is still shown — a missing agency name does not remove the profile');
ok(oldSrvEn.sectionHtml.indexOf('data-qa="jobs-profile-crewing"') >= 0,
  'W15 and the agency line is still there, saying something rather than nothing');
ok(!UUID_RE.test(visibleText(oldSrvEn.sectionHtml)) && !oldSrvEn.sectionHtml.includes(CREWING_ALPHA_ID),
  'W16 the id is NOT substituted for the missing name — that is the thing the owner refused');
ok(/not available/i.test(oldSrvEn.sectionHtml),
  'W17 (en) it says plainly that the name is not available');
ok(/недоступно/i.test(oldSrvRu.sectionHtml),
  'W17b (ru) and says it in Russian — an honest sentence, not an empty slot');
ok(!/[Ѐ-ӿ]/.test(oldSrvEn.sectionHtml),
  'W18 the EN render of that sentence carries no Cyrillic (both locales are real)');

// One bad row must not take a good one down with it, on this field too.
const mixed = await renderJobsScreen({ profiles: [PROFILE_NO_AGENCY_FIELDS, PROFILE_OTHER_AGENCY], lang: 'en' });
ok(mixed.sectionHtml.includes('Limassol Marine Manning'),
  'W19 a row without agency fields beside a row with them: the named one still renders');

section('W. the Rust type cannot be made fatal by a missing agency field');

// EXACT, and not `'pub struct PublishedProfile'`: `PublishedProfileRequirement`
// is declared FIRST in this file, so the loose marker matched that struct and
// reported the three fields missing from a type that never had them. The probe
// was wrong before the code was, which is the only reason this comment exists.
const publishedProfileStruct = blockAfter(jobsRs, 'pub struct PublishedProfile {');
ok(publishedProfileStruct !== null, 'W20 jobs.rs declares the PublishedProfile type');
ok(String(publishedProfileStruct || '').includes('pub profile_id: String'),
  'W20b CALIBRATION — and the block read is that struct, not PublishedProfileRequirement beside it');
// Doc comments are stripped first. The field name appears inside the prose
// that explains it (`crewing_trust_status` names itself while contrasting with
// the vacancy field), and a probe that reads prose as a declaration measures
// the comment, not the type.
const profileStructCode = withoutLineComments(publishedProfileStruct || '');
ok(/#\[serde\(default\)\]\s*pub crewing_id:/.test(profileStructCode),
  'W20c CALIBRATION — the attribute probe fires on a field that already had the attribute');
ok(!/#\[serde\(default\)\]\s*pub profile_id:/.test(profileStructCode),
  'W20d CALIBRATION — and does not fire on profile_id, which deliberately has none');
for (const field of ['crewing_name', 'crewing_jurisdiction', 'crewing_trust_status']) {
  ok(new RegExp('pub ' + field + '\\s*:').test(profileStructCode),
    `W21 PublishedProfile carries ${field}`);
  // POSITIONAL: the attribute is the thing immediately before THIS field, not
  // somewhere above it. Nothing may stand between them.
  ok(new RegExp('#\\[serde\\(default\\)\\]\\s*pub ' + field + '\\s*:').test(profileStructCode),
    `W22 ${field} is declared with #[serde(default)] — an old server's silence is not a parse error`);
  ok(new RegExp('pub ' + field + '\\s*:\\s*Option<').test(profileStructCode),
    `W23 ${field} is an Option — absent is a value this client can render, not a failure`);
}

// The vacancy block is a different item and is not touched by this one.
const vacancyIdentity = fnBody(html, 'jobsCrewingIdentityHtml');
ok(vacancyIdentity !== null && !vacancyIdentity.includes('crewing_name'),
  'W24 the vacancy block\'s own identity renderer is left exactly as it was');


// ════════════════════════════════════════════════════════════════════════════
// P2/V5c — THE COLOUR OF A TRIAL PUBLISHER, on BOTH blocks of the Jobs screen.
//
// `.job-trust-badge` is green by default (the "verified" colour). `trial` used
// to get no modifier class in EITHER block — not in `jobsProfileCrewingTrust`
// here, and not in `jobsCrewingIdentityHtml` on the vacancy feed, whose chain
// only knows `legacy`, `pending`/`unknown` and `block`/`scam`. So an unvetted
// agency wore a verified-coloured pill directly above a button whose result
// cannot be withdrawn. The WORDS were already honest ("Publisher on a trial
// period"); only the colour lied.
//
// BOTH blocks are asserted, and that is the requirement rather than symmetry:
// changing one half would put ONE agency in TWO colours on ONE screen, which is
// the defect the shared shape exists to prevent.
//
// MEASUREMENT BOUNDARY: the cascade claim below is read from the ORDER of the
// rules in the stylesheet. The three modifiers have equal specificity (0,2,0),
// so source order decides — that is the CSS rule, not an approximation. It is
// still not a browser: no layout, no computed colour, is measured here.
// ════════════════════════════════════════════════════════════════════════════

section('X. a trial publisher is not painted as a verified one (both blocks)');

// The class attribute of the badge, or null if no badge was rendered at all.
function badgeClassOf(markup) {
  const m = /<span class="([^"]*job-trust-badge[^"]*)"/.exec(String(markup || ''));
  return m ? m[1] : null;
}

ok(badgeClassOf('<span class="job-trust-badge warn">x</span>') === 'job-trust-badge warn',
  'X0 CALIBRATION — the badge probe reads the class off a badge it is given');
ok(badgeClassOf('<div>Crewing: someone, no badge at all</div>') === null,
  'X0b CALIBRATION — and returns null where there is no badge, so "no warn" cannot pass on nothing');

const trustBox = boot({ lang: 'en' });
await settle();

// --- the profile card (this task's own renderer) ---
const profileBadge = (status) => badgeClassOf(
  trustBox.sandbox.jobsProfileCrewingHtml({ crewing_name: 'Aegean Crew Services', crewing_trust_status: status }));

ok(profileBadge('active') === 'job-trust-badge',
  `X1 profile card: an ACTIVE agency keeps the plain green badge (got ${profileBadge('active')})`);
ok(String(profileBadge('legacy')).includes('legacy') && !String(profileBadge('legacy')).includes('warn'),
  `X2 profile card: a LEGACY agency keeps its own badge and is not warned about (got ${profileBadge('legacy')})`);
ok(String(profileBadge('trial')).includes('warn'),
  `X3 profile card: a TRIAL publisher is marked warn (got ${profileBadge('trial')})`);
ok(profileBadge('trial') !== 'job-trust-badge',
  'X4 profile card: and is NOT left on the default green — the colour of "verified"');
ok(profileBadge('who-knows') === null && profileBadge(undefined) === null,
  'X5 profile card: a status this build cannot justify still renders NO badge at all');

// --- the vacancy feed card (the block directly above the section) ---
const vacancyBadge = (status, label) => badgeClassOf(
  trustBox.sandbox.jobsCrewingIdentityHtml(
    { crewing_ref: 'Aegean Crew Services', crewing_jurisdiction: 'gr',
      crewing_trust_status: status, crewing_trust_label: label || 'label' },
    trustBox.sandbox.esc));

ok(vacancyBadge('verified') === 'job-trust-badge',
  `X6 vacancy card: a VERIFIED agency keeps the plain green badge (got ${vacancyBadge('verified')})`);
ok(String(vacancyBadge('verified_legacy')).includes('legacy') && !String(vacancyBadge('verified_legacy')).includes('warn'),
  `X7 vacancy card: verified_legacy keeps its own badge (got ${vacancyBadge('verified_legacy')})`);
ok(String(vacancyBadge('trial')).includes('warn'),
  `X8 vacancy card: a TRIAL publisher is marked warn HERE TOO (got ${vacancyBadge('trial')})`);
ok(vacancyBadge('trial') !== 'job-trust-badge',
  'X9 vacancy card: and is not left on the default green — one agency, one colour, on one screen');

// The neighbours of that chain, asserted because this edit is inside it.
ok(String(vacancyBadge('pending')).includes('warn'), 'X10 vacancy card: pending still warns');
ok(String(vacancyBadge('unknown')).includes('warn'), 'X11 vacancy card: unknown still warns');
ok(String(vacancyBadge('scam')).includes('blocked'), 'X12 vacancy card: scam is still blocked');
ok(String(vacancyBadge('blocked')).includes('blocked'), 'X13 vacancy card: blocked is still blocked');

// BLOCKED MUST STAY STRONGER THAN WARN. `trial_blocked` is a synthetic value no
// server sends; it exists to force both classes onto one badge so the ordering
// can be measured instead of assumed.
const bothClasses = String(vacancyBadge('trial_blocked'));
ok(bothClasses.includes('blocked'),
  `X14 a status that is both trial and blocked still carries the blocked class (got ${bothClasses})`);
const cssWarnAt = html.indexOf('.job-trust-badge.warn');
const cssBlockedAt = html.indexOf('.job-trust-badge.blocked');
ok(cssWarnAt > 0 && cssBlockedAt > 0, 'X15 both modifier rules exist in the stylesheet');
ok(cssBlockedAt > cssWarnAt,
  'X16 and .blocked is declared AFTER .warn — equal specificity, so blocked wins the cascade');



// ════════════════════════════════════════════════════════════════════════════
// Y — THE ANSWER OF A LIVE SERVER, rendered by the real screen.
//
// Everything above this line about the agency fields was true of a fixture. The
// bytes below are not a fixture: they are the body a running server returned to
// GET /api/published-profiles?rank=Second Officer&vessel_type=Bulk Carrier,
// ANONYMOUS (the way a seafarer reaches it), status 200, captured
// 2026-09-29T17:02:32Z. Server side: skipi-server PR #32, head 6690fc86.
//
// The Rust half of this meeting is asserted in the crate itself
// (`live_published_profiles_contract` in src-tauri/src/commands/jobs.rs), where
// the type the product actually uses parses these same bytes. This section is
// the other half: what the seafarer's screen DOES with them.
//
// BOUNDARY: the capture stored the body as parsed JSON, so these are the
// answer's VALUES re-serialised — key names, types and values are the server's,
// whitespace and key order are not the wire's.
// ════════════════════════════════════════════════════════════════════════════

section('Y. the live server answer, on the real screen');

const LIVE_BODY = JSON.parse('{"items":[{"profile_id":"3f51ec8e-34f9-4375-8120-9d2c56b9c77f","crewing_id":"322dc865-60a1-4ded-a816-20bb3ac9c4d8","crewing_name":"Limassol Marine Manning","crewing_jurisdiction":"CY","crewing_trust_status":"trial","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":[],"extra_requirements":[]},{"profile_id":"81d508ff-23fb-4c85-a14b-8f6151df1e1a","crewing_id":"dcdc1fa4-5187-4801-a365-ade399601ae7","crewing_name":"Aegean Crew Services","crewing_jurisdiction":"GR","crewing_trust_status":"active","published_version":1,"rank":"Second Officer","vessel_type":"Bulk Carrier","mandatory_certs":["stcw_basic","gmdss"],"extra_requirements":[{"id":"x1","label":"Tanker endorsement","weight":5,"category":"endorsement","description":null}]}]}');
const LIVE_ITEMS = LIVE_BODY.items;

ok(Array.isArray(LIVE_ITEMS) && LIVE_ITEMS.length === 2,
  `Y0 CALIBRATION — the captured body is real JSON and carried two rows (got ${LIVE_ITEMS.length})`);
ok(LIVE_ITEMS.every((p) => Object.keys(p).length === 10),
  'Y0b CALIBRATION — each live row carries ten keys, the three new ones among them');

// The card block that contains a given agency name, so a per-row claim is made
// about THAT row and not about the section as a whole.
function cardOf(sectionHtml, name) {
  const parts = String(sectionHtml || '').split('<div class="jobs-profile-card"');
  return parts.find((c) => c.includes(name)) || null;
}

const liveEn = await renderJobsScreen({ profiles: LIVE_ITEMS, lang: 'en' });
const liveRu = await renderJobsScreen({ profiles: LIVE_ITEMS, lang: 'ru' });

ok(!liveEn.error, `Y1 the real screen renders the live answer${liveEn.error ? ': ' + liveEn.error.message : ''}`);
for (const [lang, r] of [['en', liveEn], ['ru', liveRu]]) {
  ok(r.sectionHtml.includes('Aegean Crew Services') && r.sectionHtml.includes('Limassol Marine Manning'),
    `Y2 (${lang}) both agencies the live server named are on screen, by name`);
  ok(r.sectionHtml.includes('GR') && r.sectionHtml.includes('CY'),
    `Y3 (${lang}) each carries the jurisdiction the server sent`);
  ok(!UUID_RE.test(visibleText(r.sectionHtml)),
    `Y4 (${lang}) no UUID is printed — and on the live surface profile_id and crewing_id are BOTH UUIDs`);
  for (const p of LIVE_ITEMS) {
    ok(!r.sectionHtml.includes(p.crewing_id),
      `Y5 (${lang}) the crewing id of ${p.crewing_name} is absent from the markup entirely`);
  }
}

// The colour, per row, on measured data: the active agency green, the trial one
// warned. This is the claim that was made on a fixture and is now made on the
// server's own answer.
const aegeanCard = cardOf(liveEn.sectionHtml, 'Aegean Crew Services');
const limassolCard = cardOf(liveEn.sectionHtml, 'Limassol Marine Manning');
ok(aegeanCard !== null && limassolCard !== null, 'Y6 both live rows rendered their own card');
ok(aegeanCard !== limassolCard, 'Y6b and they are two different cards, not one matched twice');
ok(badgeClassOf(aegeanCard) === 'job-trust-badge',
  `Y7 the ACTIVE agency (Aegean Crew Services) keeps the plain green badge (got ${badgeClassOf(aegeanCard)})`);
ok(String(badgeClassOf(limassolCard)).includes('warn'),
  `Y8 the TRIAL agency (Limassol Marine Manning) is warned (got ${badgeClassOf(limassolCard)})`);
ok(badgeClassOf(limassolCard) !== 'job-trust-badge',
  'Y9 and is NOT left on the colour of verified — measured on the live answer, not on a fixture');

// The server running the pilot before this contract shipped: the same answer
// with the three keys gone.
const liveOldShape = LIVE_ITEMS.map((p) => {
  const q = { ...p };
  delete q.crewing_name; delete q.crewing_jurisdiction; delete q.crewing_trust_status;
  return q;
});
const liveOld = await renderJobsScreen({ profiles: liveOldShape, lang: 'en' });
ok(!liveOld.error && liveOld.sectionHtml.includes('Second Officer'),
  'Y10 the same rows without the three keys still render — the list is not lost');
ok((liveOld.sectionHtml.match(/not available/gi) || []).length === 2,
  'Y11 and BOTH rows say so honestly, rather than one of them showing an id');
ok(!UUID_RE.test(visibleText(liveOld.sectionHtml)),
  'Y12 with still no id printed anywhere');


// ════════════════════════════════════════════════════════════════════════════
// Z — P2/V7. The owner, 2026-09-30, two sentences and nothing else:
//
//   «Без названия агентства отклик блокировать, причину показать рядом.
//    Для пробного агентства явно указывать, что название не проверено Skipi.»
//
// TWO BEHAVIOURS, AND THEY ARE NOT THE SAME KIND OF CLAIM.
//
//  1. NO NAME, NO RESPONSE. The server the pilot runs TODAY answers without
//     `crewing_name` — section W renders that very answer — and until V7 that
//     answer still produced a working "Respond with Skipi" button: an
//     irreversible delivery of a CV and a contact to a counterparty this app
//     could not name. The refusal must therefore be REAL, not a grey button.
//     `disabled` in the markup is asserted, but it is the weaker half and never
//     the whole claim: the strong one RUNS THE CODE THE BUTTON'S OWN `onclick`
//     ATTRIBUTE CARRIES and counts the submissions that followed.
//  2. THE TRIAL BADGE SPEAKS ABOUT THE NAME. It said "Publisher on a trial
//     period", which is a statement about WHEN the agency published — not about
//     whether anyone checked what it calls itself. The seafarer reads that name
//     as identification, so the badge has to say plainly that Skipi has not
//     verified it. Same agency line, same badge, no third element and no third
//     vocabulary.
//
// NOT TOUCHED, deliberately: the `active` wording (a separate decision), the
// server's own trust vocabulary, the vacancy block, and the route that issues
// trial tokens — an explicit owner prohibition of 2026-09-30, not an omission.
//
// MEASUREMENT BOUNDARY, stated rather than implied: a DOM-shimmed run of the
// real inline scripts of `dist/index.html`. No browser, no layout, no network.
// Whether the longer badge wraps badly on a 360 px phone is NOT measured by any
// assertion below and is reported as unmeasured.
// ════════════════════════════════════════════════════════════════════════════

section('Z. a trial publisher is told to be unverified BY NAME, not by period');

// The text INSIDE the badge, so "it is said in the badge that already exists"
// is a claim about that element and not about the card somewhere.
function badgeTextOf(markup) {
  const m = /<span class="[^"]*job-trust-badge[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(String(markup || ''));
  return m ? m[1] : null;
}
ok(badgeTextOf('<span class="job-trust-badge warn">Trial publisher</span>') === 'Trial publisher',
  'Z0 CALIBRATION — the badge-text probe reads the words out of a badge it is given');
ok(badgeTextOf('<div>Crewing: someone, no badge at all</div>') === null,
  'Z0b CALIBRATION — and returns null where there is no badge, so an empty claim cannot pass');

// The inner text of one `data-qa` div. NOT blockAfter(): that one matches
// BRACES — it is the Rust-struct reader — and returns null on every piece of
// HTML it is given, so an assertion built on it would have been green over
// nothing had it been written the other way round.
function qaDivText(markup, qa) {
  const at = String(markup || '').indexOf('data-qa="' + qa + '"');
  if (at < 0) return null;
  const open = String(markup).indexOf('>', at);
  const close = String(markup).indexOf('</div>', open);
  if (open < 0 || close < 0) return null;
  return String(markup).slice(open + 1, close);
}
ok(qaDivText('<div data-qa="zz" style="x">hello</div><div>after</div>', 'zz') === 'hello',
  'Z0e CALIBRATION — the qa-div probe reads the text out of the div it names');
ok(qaDivText('<div data-qa="other">hello</div>', 'zz') === null,
  'Z0f CALIBRATION — and returns null when that div is absent, so "the reason is there" cannot pass on nothing');
ok(!claimsOnly('<b>Verified by Skipi</b>', /verified/i, 'not verified by Skipi'),
  'Z0c CALIBRATION — claimsOnly still FIRES on an affirmative "Verified by Skipi"');
ok(claimsOnly('<b>name not verified by Skipi</b>', /verified/i, 'not verified by Skipi'),
  'Z0d CALIBRATION — and does not fire on the honest negative sentence');

const zTrialEn = await renderJobsScreen({ profiles: [PROFILE_OTHER_AGENCY], lang: 'en' });
const zTrialRu = await renderJobsScreen({ profiles: [PROFILE_OTHER_AGENCY], lang: 'ru' });
const zActiveEn = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'en' });
const zActiveRu = await renderJobsScreen({ profiles: [PROFILE_MATCH], lang: 'ru' });

const zTrialBadgeEn = badgeTextOf(zTrialEn.sectionHtml);
const zTrialBadgeRu = badgeTextOf(zTrialRu.sectionHtml);
ok(zTrialBadgeEn !== null && zTrialBadgeRu !== null, 'Z1 the trial card still carries the badge it already had');
ok(/\bname\b/i.test(String(zTrialBadgeEn)) && /not verified by Skipi/i.test(String(zTrialBadgeEn)),
  `Z2 (en) the badge says the NAME is not verified by Skipi (got "${zTrialBadgeEn}")`);
ok(/названи/i.test(String(zTrialBadgeRu)) && /не проверено Skipi/i.test(String(zTrialBadgeRu)),
  `Z2b (ru) and says it in Russian (got "${zTrialBadgeRu}")`);
ok(!/[Ѐ-ӿ]/.test(String(zTrialBadgeEn)), 'Z2c the EN badge carries no Cyrillic — both locales are real, not one');

// It is about the NAME, and the seafarer is not left to infer that from a date.
// The period wording is kept (nothing the owner asked to keep was dropped), but
// it is no longer the ONLY thing the badge says.
ok(/trial/i.test(String(zTrialBadgeEn)) && /пробн/i.test(String(zTrialBadgeRu)),
  'Z3 the trial state is still named — the period fact is not lost, only no longer alone');

// SAME LINE, SAME BADGE, NO THIRD ELEMENT. The statement lives inside the badge
// of the agency block that was already there.
ok(zTrialEn.sectionHtml.indexOf('data-qa="jobs-profile-crewing"') >= 0,
  'Z4 the agency block is the same block as before');
ok((zTrialEn.sectionHtml.match(/job-trust-badge/g) || []).length === 1,
  'Z4b exactly ONE badge on the card — no second mark was invented beside it');
ok(!/data-qa="jobs-(?:trust|agency|name)-/.test(zTrialEn.sectionHtml),
  'Z4c and no new agency element was added under a new data-qa name');

// The green case is a separate owner decision and is untouched by this one.
ok(badgeTextOf(zActiveEn.sectionHtml) === 'Verified by Skipi',
  `Z5 the ACTIVE agency's badge is left exactly as it was, word for word (got "${badgeTextOf(zActiveEn.sectionHtml)}")`);
ok(badgeTextOf(zActiveRu.sectionHtml) === 'Крюинг проверен Skipi',
  `Z5b and in RU too (got "${badgeTextOf(zActiveRu.sectionHtml)}")`);
ok(String(badgeClassOf(zTrialEn.sectionHtml)).includes('warn')
   && badgeClassOf(zActiveEn.sectionHtml) === 'job-trust-badge',
  'Z6 the two colours are still the two colours — this change is about words, not about the pill');
ok(claimsOnly(zTrialEn.sectionHtml, /verified/i, 'not verified by Skipi')
   && claimsOnly(zTrialRu.sectionHtml, /проверен/i, 'не проверено Skipi'),
  'Z7 and the trial card still makes no affirmative claim of verification anywhere on it');

section('Z. no name of the recipient — the response does not leave');

// Two ways the name can be missing, and the second is reachable by a
// counterparty rather than by an accident.
const NO_NAME_CASES = [
  ["today's pilot server sends no agency keys at all", PROFILE_NO_AGENCY_FIELDS],
  ['a crewing wrote a name of nothing but spaces', PROFILE_BLANK_NAME],
];

for (const [why, profile] of NO_NAME_CASES) {
  for (const lang of ['en', 'ru']) {
    const r = await renderJobsScreen({ profiles: [profile], lang });
    const tag = `${lang}, ${why}`;

    // THE CARD STAYS. Hiding the profile would take a real opportunity off the
    // seafarer's screen to solve a problem that is ours, not his.
    ok(!r.error && r.sectionHtml.includes('Second Officer') && r.sectionHtml.includes('Bulk Carrier'),
      `Z10 (${tag}) the profile is still ON SCREEN — a missing name does not delete the opportunity`);
    ok(r.sectionHtml.includes('data-qa="jobs-profile-crewing"'),
      `Z10b (${tag}) and the agency line is still drawn, saying what it can`);

    // The button is rendered and dead.
    const btnTag = /<button[^>]*data-qa="jobs-respond-btn"[^>]*>/.exec(r.sectionHtml);
    ok(btnTag !== null, `Z11 (${tag}) the respond button is still rendered, so the refusal is read where the action was`);
    ok(btnTag !== null && /\sdisabled(\s|>|=)/.test(btnTag[0]),
      `Z11b (${tag}) and it is disabled in the markup`);

    // THE REASON IS BESIDE THE BUTTON — literally the next element, not
    // somewhere else on the card. "Next to it" is asserted as adjacency.
    ok(r.sectionHtml.includes('</button><div data-qa="jobs-respond-blocked"'),
      `Z12 (${tag}) the reason is the element IMMEDIATELY after the button — read at the place of refusal`);

    const blocked = qaDivText(r.sectionHtml, 'jobs-respond-blocked');
    ok(blocked !== null, `Z12b (${tag}) the reason block is readable`);
    if (lang === 'en') {
      ok(/cannot be sent/i.test(String(blocked)) && /cannot name the agency/i.test(String(blocked)),
        `Z13 (en, ${why}) the reason is a sentence: it cannot be sent, because the app cannot name the agency`);
      ok(!/[Ѐ-ӿ]/.test(String(blocked)), `Z13b (en, ${why}) in English, with no Cyrillic in it`);
    } else {
      ok(/отправить нельзя/i.test(String(blocked)) && /не может назвать агентство/i.test(String(blocked)),
        `Z13 (ru, ${why}) и по-русски — отправить нельзя, приложение не может назвать агентство`);
    }

    // The thing the owner refused in V5c must not creep back in as a substitute.
    ok(!UUID_RE.test(visibleText(r.sectionHtml)),
      `Z14 (${tag}) and no id is printed in place of the name it does not have`);
  }
}

// ---------------------------------------------------------------------------
// THE REFUSAL IS REAL. This does not call a function of the harness's choosing:
// it reads the `onclick` attribute off the rendered button and executes exactly
// that source in the page's own context. A refusal that is only `disabled` in
// the markup passes every assertion above and fails every one below.
// ---------------------------------------------------------------------------
async function clickRespondButton(opts = {}) {
  const profile = opts.profile || PROFILE_MATCH;
  const pid = String(profile.profile_id);
  const rendered = await renderJobsScreen({ profiles: [profile], lang: opts.lang || 'en' });
  // The two nodes a browser would already have — the same reason boot() and
  // runEnsureIdentity() pre-create theirs: the shim keeps innerHTML as a string.
  const status = rendered.document.createElement('div');
  status.setAttribute('id', 'jobs-respond-status-' + pid);
  const btn = rendered.document.createElement('button');
  btn.setAttribute('id', 'jobs-respond-btn-' + pid);
  const m = /<button[^>]*data-qa="jobs-respond-btn"[^>]*\sonclick="([^"]*)"/.exec(rendered.sectionHtml);
  const onclick = m ? m[1] : null;
  const before = rendered.state.calls.length;
  let error = null;
  if (onclick) {
    try { await vm.runInContext(onclick, rendered.sandbox, { filename: 'button-onclick' }); }
    catch (e) { error = e; }
  }
  await settle();
  return {
    ...rendered,
    onclick,
    error,
    statusHtml: status.innerHTML,
    statusState: status.getAttribute('data-respond-state'),
    buttonDisabled: btn.disabled,
    submits: rendered.state.submits,
    callsAfterClick: rendered.state.calls.slice(before).map((c) => c[0]),
  };
}

// POSITIVE PATH FIRST, and it is the calibration of everything after it: if a
// named agency did not deliver here, "nothing was delivered" below would be
// measuring a broken button rather than a working refusal.
const zClickNamed = await clickRespondButton({ profile: PROFILE_MATCH, lang: 'en' });
ok(zClickNamed.onclick !== null && zClickNamed.onclick.includes('jobsRespondToProfile'),
  `Z20 CALIBRATION — a NAMED agency renders a button whose onclick really calls the handler (${zClickNamed.onclick})`);
ok(zClickNamed.submits.length === 1,
  `Z21 CALIBRATION/POSITIVE — clicking it delivers exactly one response (got ${zClickNamed.submits.length})`);
ok(zClickNamed.statusState === 'ok',
  `Z21b and the screen says so from the server's acknowledgement (state=${zClickNamed.statusState})`);
ok(!zClickNamed.sectionHtml.includes('data-qa="jobs-respond-blocked"'),
  'Z22 the named card carries no refusal block at all — the block is not shown to someone who can respond');
const zNamedBtn = /<button[^>]*data-qa="jobs-respond-btn"[^>]*>/.exec(zClickNamed.sectionHtml);
ok(zNamedBtn !== null && !/\sdisabled(\s|>|=)/.test(zNamedBtn[0]),
  'Z22b and its button is not disabled — the block did not switch responding off in general');

for (const [why, profile] of NO_NAME_CASES) {
  const r = await clickRespondButton({ profile, lang: 'en' });
  ok(r.onclick !== null,
    `Z23 (${why}) the disabled button still carries an onclick, so there IS something to click programmatically`);
  ok(r.submits.length === 0,
    `Z24 (${why}) running that onclick delivered NOTHING (got ${r.submits.length} submissions)`);
  ok(!r.callsAfterClick.includes('submit_profile_response'),
    `Z24b (${why}) submit_profile_response was never called`);
  ok(!r.callsAfterClick.includes('export_redacted_cv_pdf'),
    `Z24c (${why}) and no CV was written to disk on the way — the refusal is BEFORE the export, not after it`);
  ok(!r.callsAfterClick.includes('ensure_profile_response_id'),
    `Z24d (${why}) and no response id was minted, so a later named retry is still a first response`);
  ok(/cannot be sent/i.test(r.statusHtml),
    `Z25 (${why}) and the click leaves the reason on the status line, so a programmatic press is answered rather than ignored`);
  ok(r.buttonDisabled === true,
    `Z25b (${why}) the button stays disabled afterwards`);
}

// The blocked state must not be produced by the LANGUAGE of the check either:
// a Russian screen refuses on the same fact and delivers on the same fact.
const zClickNamedRu = await clickRespondButton({ profile: PROFILE_MATCH, lang: 'ru' });
const zClickBlankRu = await clickRespondButton({ profile: PROFILE_BLANK_NAME, lang: 'ru' });
ok(zClickNamedRu.submits.length === 1,
  `Z26 (ru) a named agency still receives the response on a Russian screen (got ${zClickNamedRu.submits.length})`);
ok(zClickBlankRu.submits.length === 0 && /отправить нельзя/i.test(zClickBlankRu.statusHtml),
  'Z26b (ru) and an unnamed one is refused on it, in Russian');

// ONE PREDICATE, TWO CALL SITES. If the renderer and the handler each decided
// for themselves what "has a name" means, they would drift, and the drift would
// look like a working button that refuses — or a dead button that sends.
const zRespondHtmlSrc = fnBody(html, 'jobsProfileRespondHtml');
const zRespondHandlerSrc = fnBody(html, 'jobsRespondToProfile');
ok(zRespondHtmlSrc !== null && /jobsProfileRecipientName\(/.test(zRespondHtmlSrc),
  'Z30 the renderer asks the one predicate whether the recipient has a name');
ok(zRespondHandlerSrc !== null && /jobsProfileRecipientName\(/.test(zRespondHandlerSrc),
  'Z30b and so does the handler — one answer to one question, in one place');
// BOTH indices must be REAL. `-1 < 5` is true, so an ordering probe written
// without this line is green on a handler that does not consult the predicate
// at all — which is exactly the state this file is in while these tests are
// still red, and exactly the mutation (a) is meant to catch.
const zPredAt = zRespondHandlerSrc === null ? -1 : zRespondHandlerSrc.indexOf('jobsProfileRecipientName(');
const zVaultAt = zRespondHandlerSrc === null ? -1 : zRespondHandlerSrc.indexOf("invoke('ensure_profile_response_id'");
ok(zPredAt >= 0 && zVaultAt >= 0 && zPredAt < zVaultAt,
  `Z30c and the handler asks it BEFORE it asks the vault for anything (predicate@${zPredAt}, vault@${zVaultAt})`);



// ------------ X. THE IDENTITY BELONGS TO THE REGISTRY THAT ISSUED IT (V12c) --
//
// WHAT WENT WRONG. `skipi_public_seafarer_id` was ONE row of `vault_info`, so a
// vault that had been given an identity by one registry believed it had one on
// every registry: on the pilot the entry step was already satisfied, the claim
// was skipped, and the response path then minted a self-session against a host
// that had never heard of that id. The EIGHT rows that hold WHAT A REGISTRY
// ANSWERED now carry the base in their name on a stand and on the pilot; on
// production the names are byte-for-byte today's.
//
// MEASUREMENT BOUNDARY, stated rather than implied. Node cannot run the Rust, so
// this section has two kinds of assertion and they are not interchangeable:
//
//   * BEHAVIOURAL — the real inline scripts of `dist/index.html` driven through
//     the DOM shim, with `seafarer_identity_entry_state` answering per base.
//     That stub is the Rust command's CONTRACT restated BY HAND from the card
//     and deliberately NOT derived from `jobs.rs`: a probe that reads the rule
//     out of the file it is checking compares the code with itself.
//   * SOURCE CONTRACT — claims about the text of `jobs.rs`: which function
//     decides the row name, that the production branch returns the bare name,
//     and that no bare literal of the eight reaches `set_vault_info` in that
//     file at all.
//
// WHAT IS NOT CLAIMED HERE. That the eight production rows survive a full pass,
// and that base A survives base B, is BEHAVIOUR of the vault and is proven in
// Rust (`registry_scoped_identity` in `src-tauri/src/commands/jobs.rs`) against
// an in-memory vault. This section does not pretend to it.
//
// ONE MORE BOUNDARY: `identity_fingerprint` and `identity_fingerprint_version`
// are written GLOBALLY and on the non-production path as well, on purpose —
// `sync_identity_fingerprint` describes the PERSON, not the registry. The norm
// asserted here is therefore "none of the EIGHT", never "nothing global".

section('X. the row name is decided by the base, by one function, from nothing a server said');

const EIGHT_ROWS = [
  'skipi_public_seafarer_id',
  'skipi_identity_claim_status',
  'skipi_identity_duplicate',
  'skipi_identity_trust_level',
  'skipi_identity_message',
  'skipi_identity_last_claim_at',
  'skipi_identity_recovery_key',
  'skipi_identity_key_registered_at',
];

const PILOT_EP = { base: 'https://api.skipi.app:8444', stand: false, pilot: true };
const STAND_EP = { base: 'http://127.0.0.1:8099', stand: true, pilot: false };
const PROD_EP = { base: 'https://api.skipi.app', stand: false, pilot: false };
// The identity ANOTHER registry issued, sitting in the global rows — the exact
// state the owner's vault is in.
const OTHER_REGISTRY_IDENTITY = {
  public_seafarer_id: 'SKP-SF-OTHER-REGISTRY-0001',
  identity_key_registered_at: '2026-09-20T00:00:00Z',
};
const THIS_REGISTRY_IDENTITY = {
  public_seafarer_id: 'SKP-SF-PILOT-0001',
  identity_key_registered_at: '2026-09-30T00:00:00Z',
};

// Comments are not code, and the test module is not the product. Every source
// claim below is made over the product half of the file with the prose removed,
// and `Flat` collapses whitespace so a multi-line call reads the same as a
// one-line one — the exact trap that hid five of the eight writes from a grep.
const jobsRsCode = withoutLineComments(jobsRs);
const jobsRsTestAt = jobsRsCode.indexOf('#[cfg(test)]');
const jobsRsProduct = jobsRsTestAt >= 0 ? jobsRsCode.slice(0, jobsRsTestAt) : jobsRsCode;
const jobsRsFlat = jobsRsProduct.replace(/\s+/g, ' ');
const profileRsFlat = withoutLineComments(
  (allRustSrc.find(([f]) => f.endsWith('commands/profile.rs')) || ['', ''])[1],
).replace(/\s+/g, ' ');
const identityRsFlat = withoutLineComments(
  (allRustSrc.find(([f]) => f.endsWith('src/identity.rs')) || ['', ''])[1],
).replace(/\s+/g, ' ');

ok(jobsRsTestAt > 0, 'X0 the product half of jobs.rs is separated from its test modules');
ok(profileRsFlat.length > 1000 && identityRsFlat.length > 1000,
  'X0b profile.rs and identity.rs were found (the calibration of X8c depends on them)');

// ---- the one deciding function -------------------------------------------
const keyFn = withoutLineComments(String(rustFnBody(jobsRs, 'identity_vault_key') || ''));
ok(keyFn.length > 0, 'X0c jobs.rs defines identity_vault_key');
ok(countOf(jobsRsProduct, 'fn identity_vault_key') === 1,
  'X0d exactly one function decides the row name');

// ---- TEST 6: an empty row for THIS base brings the existing step back -------
const x6pilot = await renderJobsScreen({
  profiles: [PROFILE_MATCH], endpoint: PILOT_EP,
  identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {}, lang: 'en',
});
ok(x6pilot.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'X6 (card 6) pilot base, no row for it: the EXISTING identity step is drawn');
ok(x6pilot.sectionHtml.includes('data-qa="jobs-identity-btn"'),
  'X6b and the existing button is on it');
ok(!x6pilot.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'X6c and the respond button is not offered while the identity of this server is missing');
ok(x6pilot.sectionHtml.includes('This server keeps its own Skipi ID'),
  'X6d and the one new sentence says why he is asked again (EN, on the rendered screen)');
const x6pilotRu = await renderJobsScreen({
  profiles: [PROFILE_MATCH], endpoint: PILOT_EP,
  identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {}, lang: 'ru',
});
ok(x6pilotRu.sectionHtml.includes('data-qa="jobs-identity-step"')
  && x6pilotRu.sectionHtml.includes('У этого сервера свой Skipi ID'),
  'X6e and the same screen in Russian, in Russian');
const x6stand = await renderJobsScreen({
  profiles: [PROFILE_MATCH], endpoint: STAND_EP,
  identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {}, lang: 'en',
});
ok(x6stand.sectionHtml.includes('data-qa="jobs-identity-btn"'),
  'X6f a stand behaves the same way — the rule is the pair of flags, not the pilot alone');
// CALIBRATION: the new sentence is NOT shown on the production build, where the
// Skipi ID really is obtained once.
const x6prod = await renderJobsScreen({
  profiles: [PROFILE_MATCH], endpoint: PROD_EP, identity: IDENTITY_NONE, lang: 'en',
});
ok(x6prod.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'X6g CALIBRATION — on production the step is drawn for an empty vault exactly as before');
ok(!x6prod.sectionHtml.includes('This server keeps its own Skipi ID'),
  'X6h and the new sentence is absent there, so it is not a second sentence for everyone');
// SOURCE (mutation M2: the global row always). The scoped name must be
// reachable, and it must be reached through the pair of flags.
ok(/if\s+endpoint\.stand\s*\|\|\s*endpoint\.pilot/.test(keyFn),
  'X6i the decision is the PAIR of flags, as everywhere else in this contract');
ok(keyFn.includes('format!('),
  'X6j and a non-production base really produces a name of its own');
// SOURCE (mutation M7: skip the claim when the row is empty). The positive path
// has to be reachable, or the step would be drawn for ever and do nothing.
const ensureRust = withoutLineComments(String(rustFnBody(jobsRs, 'ensure_seafarer_identity') || ''));
const ensureFlat = ensureRust.replace(/\s+/g, ' ');
ok(ensureFlat.includes('let public_seafarer_id = vault_text(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID));'),
  'X6k ensure_seafarer_identity reads the row of the base it is about to speak to');
ok(ensureFlat.includes('let claim_request = if public_seafarer_id.is_empty() {'),
  'X6l and builds a claim exactly when that row is empty');

// ---- TEST 7: a filled row for this base hides the step, as today -----------
const x7 = await renderJobsScreen({
  profiles: [PROFILE_MATCH], endpoint: PILOT_EP,
  identityGlobal: OTHER_REGISTRY_IDENTITY,
  identityByBase: { [identityScopeOf(PILOT_EP.base)]: THIS_REGISTRY_IDENTITY },
  lang: 'en',
});
ok(!x7.sectionHtml.includes('data-qa="jobs-identity-step"'),
  'X7 (card 7) pilot base WITH its own row: the step is not drawn');
ok(x7.sectionHtml.includes('data-qa="jobs-respond-btn"'),
  'X7b and the respond button is what he sees instead');
ok(!x7.sectionHtml.includes('This server keeps its own Skipi ID'),
  'X7c and the new sentence is gone with the step it belongs to');
// SOURCE (mutation M12: scoped on one half of the pair only). The entry state
// reads BOTH halves through the one function.
const stateRust = withoutLineComments(String(rustFnBody(jobsRs, 'seafarer_identity_entry_state') || ''));
const stateFlat = stateRust.replace(/\s+/g, ' ');
ok(stateFlat.includes('vault_text(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID))'),
  'X7d the entry state reads the id through the one function');
ok(tight(stateRust).includes('vault_text(conn,&identity_vault_key(&endpoint,IDENTITY_KEY_REGISTERED_AT)'),
  'X7e and the registration marker through the same one — a half-bound pair is the state that loops');

// ---- TEST 8: the production path is EXACTLY today's ------------------------
// The names are LITERALS here. A test that read them out of the new code would
// be comparing the code with itself.
EIGHT_ROWS.forEach((name) => {
  ok(countOf(jobsRsProduct, `"${name}"`) === 1,
    `X8 (card 8) "${name}" is written in exactly one place in jobs.rs (found ${countOf(jobsRsProduct, `"${name}"`)})`);
});
// The bare-key patterns, checked over WHITESPACE-COLLAPSED source so that a
// multi-line call cannot hide — five of these eight writes are multi-line, and
// that is precisely what a one-line grep missed.
function bareKeyPatterns(n) {
  return [
    `set_vault_info(conn, "${n}"`, `set_vault_info( conn, "${n}"`,
    `get_vault_info_value(conn, "${n}"`, `get_vault_info_value( conn, "${n}"`,
    `vault_text(conn, "${n}"`, `vault_text( conn, "${n}"`,
  ];
}
EIGHT_ROWS.forEach((name) => {
  const hits = bareKeyPatterns(name).filter((p) => jobsRsFlat.includes(p));
  ok(hits.length === 0,
    `X8b no bare, unscoped access to "${name}" is left in jobs.rs (${hits.join(' | ') || 'none'})`);
});
// CALIBRATION OF THE PROBE ITSELF: the same patterns MUST be found where a bare
// access really does live. profile.rs and identity.rs keep the global rows on
// purpose (they are the production reader and the legacy claim), and this card
// does not touch them. If these two lines went green-empty, X8b above would be
// green over a blind probe.
ok(bareKeyPatterns('skipi_identity_claim_status').some((p) => profileRsFlat.includes(p)),
  'X8c CALIBRATION — the bare-key probe does find the bare write that legitimately lives in profile.rs');
ok(bareKeyPatterns('skipi_public_seafarer_id').some((p) => identityRsFlat.includes(p)),
  'X8d CALIBRATION — and the bare read that legitimately lives in identity.rs');
// The production branch itself: the bare name is returned, and it is returned
// OUTSIDE the non-production branch (mutation M1: scoped always).
const x8if = keyFn.search(/if\s+endpoint\.stand\s*\|\|\s*endpoint\.pilot/);
const x8scoped = keyFn.indexOf('format!(');
const x8bare = keyFn.indexOf('name.to_string()');
ok(x8if >= 0 && x8scoped > x8if && x8bare > x8scoped,
  `X8e the production build gets the bare name, after the non-production branch (if@${x8if}, scoped@${x8scoped}, bare@${x8bare})`);
// And nothing about the eight rows leaked into the files this card may not touch.
['commands/profile.rs', 'commands/messaging.rs', 'src/identity.rs'].forEach((f) => {
  const entry = allRustSrc.find(([p]) => p.endsWith(f));
  ok(entry !== undefined && !entry[1].includes('identity_vault_key'),
    `X8f ${f} is untouched by the binding — it keeps reading the global rows, as the card requires`);
});

// ---- TEST 9: nothing is claimed until a person presses something -----------
const x9 = await pressIdentityStep({
  endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
});
ok(x9.callsBefore.filter((c) => c === 'ensure_seafarer_identity').length === 0,
  `X9 (card 9) drawing the screen claims nothing (${x9.callsBefore.filter((c) => c === 'ensure_seafarer_identity').length} calls)`);
const x9after = x9.callsAfter.filter((c) => c === 'ensure_seafarer_identity').length;
ok(x9after === 1, `X9b and one press makes exactly one call (${x9after})`);
// THE COUNT IS OVER THE WHOLE BRIDGE, not over one screen: `ensure` has a SECOND
// call site (`skipiRegisterJoinIdentity`), and a probe that watched only the Jobs
// screen would report zero while the join was claiming.
const x9startup = await runStartup({
  endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
});
ok(x9startup.calls.filter((c) => c === 'ensure_seafarer_identity').length === 0,
  'X9c and starting the app claims nothing from either call site');
ok(countOf(html, "invoke('ensure_seafarer_identity')") === 2,
  `X9d there are exactly two call sites of the command in dist (found ${countOf(html, "invoke('ensure_seafarer_identity')")}) — a third appears here`);

// ---- TEST 10: a refusal moves the decision in NEITHER direction ------------
// CALIBRATION FIRST: on success the section really does change. Without this
// line every refusal below would be green over a screen that never changes.
const x10ok = await pressIdentityStep({
  endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
  ensureResult: { ...THIS_REGISTRY_IDENTITY, identity_key_status: 'registered', claim_status: 'created', trust_level: 'identity_claimed' },
});
ok(x10ok.before !== x10ok.after,
  'X10 CALIBRATION — a successful press really does redraw the section');
ok(x10ok.after.includes('data-qa="jobs-respond-btn"'),
  'X10b CALIBRATION — and what replaces the step is the respond button');
const REFUSALS = [
  ['403 with a body', 'identity claim returned 403: {"detail":"forbidden"}'],
  ['403 with another body', 'identity claim returned 403: {"detail":"identity unknown"}'],
  ['500', 'identity claim returned 500: internal error'],
  ['transport error', 'error sending request for url (https://api.skipi.app:8444)'],
  ['the product\'s own duplicate marker', 'IDENTITY_CLAIM_DUPLICATE'],
];
for (const [what, message] of REFUSALS) {
  const r = await pressIdentityStep({
    endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
    ensureThrows: message,
  });
  ok(r.before === r.after,
    `X10c (${what}) the part of the screen that decides the step is byte-identical after the refusal`);
  ok(r.after.includes('data-qa="jobs-identity-step"'),
    `X10d (${what}) the step is still the step — a refusal does not promote him`);
  ok(!r.after.includes('data-qa="jobs-respond-btn"'),
    `X10e (${what}) and no respond button appeared`);
}
// SOURCE (mutation M5): nothing derived from an answer can reach the decision.
['status', 'body', 'answer', 'claim', 'serde_json', 'send_on_response_bases', 'reqwest'].forEach((word) => {
  ok(!keyFn.includes(word),
    `X10f the row-name decision cannot see "${word}" — it has no way to read a server's reply`);
});

// ---- TEST 11: the same base never issues a second identity ----------------
ok(tight(ensureRust).includes('letclaim_request=ifpublic_seafarer_id.is_empty(){'),
  'X11 (card 11) the claim is built on EXACTLY the emptiness of this base\'s row, with nothing or-ed onto it');
ok(ensureFlat.includes('} else { None };'),
  'X11a and a row that is already there builds NO claim request at all');
const x11claimBlock = blockAfter(ensureRust, 'if let Some(claim_body) = claim_request');
ok(x11claimBlock !== null && x11claimBlock.includes('"/api/seafarer-identity/claim"'),
  'X11b and the claim POST lives INSIDE that conditional, so "no request" is structural');
ok(countOf(ensureRust, '"/api/seafarer-identity/claim"') === 1,
  `X11c there is exactly one place that can claim (found ${countOf(ensureRust, '"/api/seafarer-identity/claim"')})`);
ok(!x7.sectionHtml.includes('data-qa="jobs-identity-btn"'),
  'X11d and the screen of a vault that already has this registry\'s row offers no second press');
// BOUNDARY: that the row is actually THERE after the first pass is Rust
// behaviour, proven by `registry_scoped_identity::test_2_...` — not here.

// ---- TEST 12: claim, key, session and response read ONE value -------------
const submitRust = withoutLineComments(String(rustFnBody(jobsRs, 'submit_profile_response') || ''));
const submitFlat = submitRust.replace(/\s+/g, ' ');
ok(submitFlat.includes('get_vault_info_value(conn, &identity_vault_key(&endpoint, KEY_PUBLIC_SEAFARER_ID))'),
  'X12 (card 12) the response reads the id of the base it is delivering to');
ok(submitFlat.includes('mint_self_session(&state, &client, &vault_user_id, &public_seafarer_id)'),
  'X12b and the self-session is minted for THAT value, not for a second read');
ok(ensureFlat.includes('"public_seafarer_id": public_seafarer_id,'),
  'X12c the identity-key registration sends the value the claim just wrote');
ok(ensureFlat.includes('write_identity_claim_answer(conn, &endpoint, &claim, &issued)?;'),
  'X12d and the claim answer is recorded under the rows of that same base');
ok(ensureFlat.includes('write_identity_key_marker(conn, &endpoint, &registered_at)?;'),
  'X12e as is the marker that says the key is registered there');
ok(countOf(jobsRsProduct, 'identity_vault_key(') >= 8,
  `X12f every access goes through the one function (found ${countOf(jobsRsProduct, 'identity_vault_key(')} uses)`);

// ---- TEST 13: the join screen — the watchdog, not the fix ------------------
// Test 9 CANNOT express this: the join calls `ensure_seafarer_identity` by the
// front door, from another screen and on another tap, so an assertion about the
// Jobs button holds while the join is doing its own thing.
const x13 = await runJoinAccept({
  endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
});
const x13sign = x13.state.calls.find(([c]) => c === 'onboard_crew_sign_accept');
ok(x13sign !== undefined,
  'X13 (card 13) the join reaches the point of signing for an identity');
ok(x13sign !== undefined && x13sign[1] && x13sign[1].publicSeafarerId === OTHER_REGISTRY_IDENTITY.public_seafarer_id,
  `X13b and the id it signs for is the GLOBAL one — another registry's (${x13sign && x13sign[1] && x13sign[1].publicSeafarerId})`);
ok(x13sign !== undefined && x13sign[1] && x13sign[1].publicSeafarerId !== THIS_REGISTRY_IDENTITY.public_seafarer_id,
  'X13c so joining a crew on the pilot still cannot work — this card did not change that, and does not claim to');
ok(String(x13.blocked || '').length > 0 && x13.stage !== 'linked',
  `X13d nothing was joined (stage=${x13.stage})`);
ok(x13.calls.includes('ensure_seafarer_identity'),
  'X13e the join registers through the command that speaks only to the base in use');
['register_my_identity_pubkey', 'claim_seafarer_identity'].forEach((cmd) => {
  ok(!x13.calls.includes(cmd),
    `X13f and never through ${cmd}, which writes the GLOBAL rows through api_bases()`);
});
// CALIBRATION: on a production build the join takes the other path, so the probe
// above is demonstrably able to tell the two apart.
const x13prod = await runJoinAccept({ endpoint: PROD_EP });
ok(x13prod.calls.includes('register_my_identity_pubkey') && !x13prod.calls.includes('ensure_seafarer_identity'),
  'X13g CALIBRATION — a production build still takes the legacy registration, and the probe sees the difference');
// SOURCE: where the join's id comes from, named so the next reader does not have
// to infer it.
ok(profileRsFlat.includes('"public_seafarer_id": g("skipi_public_seafarer_id")'),
  'X13h get_matchable_profile still reads the bare global row (profile.rs, outside this card\'s four files)');

// ---- TEST 14: the legacy Claim button is a production write ----------------
// THE REGRESSION THIS CARD CREATES. Before the binding, the first successful
// `ensure` filled the global row and this button disappeared. A non-production
// build no longer writes that row, so without a gate the button would be drawn
// for ever — on a screen the owner can reach on Android — and one press would
// create the identity of a real person in the live product.
const x14prod = await renderTrustCard({ endpoint: PROD_EP });
ok(x14prod.html !== null, 'X14 the settings identity card renders');
ok(x14prod.html.includes('claimSkipiIdentity()'),
  'X14b CALIBRATION — on the production build the button is drawn exactly as before');
for (const [what, ep] of [['pilot', PILOT_EP], ['stand', STAND_EP]]) {
  const r = await renderTrustCard({ endpoint: ep });
  ok(r.html !== null && !r.html.includes('claimSkipiIdentity()'),
    `X14c (${what}) the button that writes to production is not drawn on a build that talks elsewhere`);
  ok(r.html !== null && r.html.includes('mobile-card-title'),
    `X14d (${what}) and the rest of the card is still there — the gate removed a button, not a screen`);
}
const x14unknown = await renderTrustCard({ endpointThrows: true });
ok(x14unknown.html !== null && !x14unknown.html.includes('claimSkipiIdentity()'),
  'X14e a build that cannot say which server it talks to draws no such button either — unknown is not "no"');
for (const [what, ep] of [['production', PROD_EP], ['pilot', PILOT_EP]]) {
  const r = await renderTrustCard({ endpoint: ep, compact: true });
  ok(r.html !== null && !r.html.includes('claimSkipiIdentity()'),
    `X14f (${what}, compact) the mobile card never offered it and still does not`);
}
const x14fn = withoutLineComments(String(fnBody(html, 'identityTrustHtml') || ''));
ok(/else\s+if\s*\(\s*!compact\s*&&\s*nonprod\s*===\s*false\s*\)/.test(x14fn.replace(/\s+/g, ' ')),
  'X14g the gate is written as the pair-flag answer, next to the !compact it keeps');
['loadIdentityTrustStatus', 'mobileRefreshIdentityTrust'].forEach((fn) => {
  const body = withoutLineComments(String(fnBody(html, fn) || ''));
  ok(body.includes('skipiNonProductionBuild('),
    `X14h ${fn} asks which server this build talks to before drawing the card`);
});

// ---- TEST 15: one server is ONE row name, whatever its case ---------------
// `jobs_pilot_api_base` validates a PARSED url — and `Url::parse` lower-cases
// scheme and host — but returns the RAW string. So `https://API.skipi.app:8444`
// is a legal pilot base that would otherwise produce a SECOND row name for one
// server: the row would read empty, the step would come back, and a SECOND claim
// would be made in the same registry — which is forbidden, DECISIONS (904).
ok(keyFn.includes('to_ascii_lowercase()'),
  'X15 (card 15) the row name is built from a case-folded base');
const x15fold = keyFn.indexOf('to_ascii_lowercase()');
ok(x15fold >= 0 && x15fold > x8if,
  'X15b and the folding lives inside the one deciding function, on its non-production branch');
const pilotBaseFn = withoutLineComments(String(rustFnBody(jobsRs, 'jobs_pilot_api_base') || ''));
ok(pilotBaseFn.includes("trim_end_matches('/')"),
  'X15c the resolver itself still normalises exactly as it did');
ok(!/to_ascii_lowercase|to_lowercase/.test(pilotBaseFn),
  'X15d and is NOT case-folded itself — its literals are pinned by U5/U5b, so the folding belongs to the row name alone');
ok(keyFn.includes("trim_end_matches('/')") && keyFn.includes('trim()'),
  'X15e the row name gets the same trim and the same trailing-slash rule as the URL (mutation M11)');
// BOUNDARY: that two spellings really produce one string is Rust behaviour and
// is proven there (`test_1_...`, which compares all four spellings).

// ---- X16: THE PRECONDITION, which is not one of the card's ten -------------
//
// `ensure_seafarer_identity` builds the claim body from
// `required_vault_text(personal_first_name / personal_surname / personal_dob)`
// and REFUSES BEFORE THE NETWORK when any of them is missing — the marker
// `IDENTITY_PROFILE_INCOMPLETE`. On a pilot build this is now reachable where it
// was not before: the step comes back for a vault that already has an identity
// elsewhere, and a vault can carry an id from another registry while its personal
// fields have since been emptied.
//
// WHAT THE SEAFARER READS, named rather than left to the source:
//   EN "Fill these in your profile first - a Skipi ID is issued from them:"
//   RU "Сначала заполните в профиле — из этих данных выдаётся Skipi ID:"
// It is the product's own sentence; the marker itself never reaches the screen.
for (const [lang, sentence] of [['en', 'Fill these in your profile first'],
  ['ru', 'Сначала заполните в профиле']]) {
  const r = await runEnsureIdentity({
    endpoint: PILOT_EP, identityGlobal: OTHER_REGISTRY_IDENTITY, identityByBase: {},
    ensureThrows: 'IDENTITY_PROFILE_INCOMPLETE', lang,
  });
  ok(r.statusHtml.includes(sentence),
    `X16 (${lang}) a vault whose profile no longer carries the fields an identity is issued from reads the product's own sentence`);
  ok(!r.statusHtml.includes('IDENTITY_PROFILE_INCOMPLETE'),
    `X16b (${lang}) and never the marker that crossed from Rust`);
  ok(!r.sectionHtml.includes('data-qa="jobs-respond-btn"'),
    `X16c (${lang}) and no respond button was opened by a refusal`);
}
// And the refusal really is BEFORE the network: the claim body is built from the
// three required fields, and `required_vault_text` is what refuses.
ok(tight(ensureRust).includes('required_vault_text(conn,"personal_first_name")?')
  && tight(ensureRust).includes('required_vault_text(conn,"personal_surname")?')
  && tight(ensureRust).includes('required_vault_text(conn,"personal_dob")?'),
  'X16d the three fields are demanded while the vault lock is still held, before any request');
ok(tight(String(rustFnBody(jobsRs, 'required_vault_text') || '')).includes('Err(IDENTITY_PROFILE_INCOMPLETE.to_string())'),
  'X16e and the refusal is the marker the WebView turns into the sentence above');


// ---- TEST 16 (delta R1): the build's kind is a THREE-state answer, and only
// ONE shape of answer may read as "production" ------------------------------
//
// The ids are R16*, not X16*: the X16 block above is the precondition and that
// name is already taken.
//
// THE DEFECT. `skipiNonProductionBuild` answered
// `!!(ep && (ep.stand===true || ep.pilot===true))`. A thrown command and a
// literal `null` did give `null` — but a SUCCESSFUL invoke that answered `{}`,
// `{stand:"true"}`, `{stand:1}` or any object without the pair gave **false**,
// indistinguishable from a real production build. The gate
// `!compact && nonprod===false` then draws "Claim Skipi Seafarer ID", and that
// button writes through `api::api_bases()` — into the LIVE product. So
// "unknown" collapsed into "production" on the one path where the collapse is
// a write of a real person's identity.
//
// A REACHABLE MECHANISM, named as a mechanism and NOT as a measured fact: this
// same dist/index.html is served by the SaaS web leg with an injected
// `__TAURI__`→HTTP shim (the WEB=DESKTOP wave), and a shim that does not
// implement `jobs_response_endpoint` can answer with an empty object. The shim
// lives in the fleet (`webapp/**`) — another role's scope, NOT measured here.
// Fail-closed must not depend on proving a shape unreachable.
async function buildKindFor(ep) {
  const booted = boot({ endpoint: PROD_EP });
  await settle();
  // The shape under test is installed on the live stub rather than passed to
  // `boot`, because `boot` maps a literal `undefined` option onto its own
  // default endpoint and so cannot express "the command answered nothing".
  booted.state.endpoint = ep;
  const host = booted.document.getElementById('vault-identity-trust');
  const nonprod = await booted.sandbox.skipiNonProductionBuild();
  let error = null;
  try { await booted.sandbox.loadIdentityTrustStatus(); } catch (e) { error = e; }
  await settle();
  return { nonprod, error, html: host ? host.innerHTML : null };
}
const R16_UNKNOWN_SHAPES = [
  ['null', null],
  ['undefined — the command answered nothing', undefined],
  ['{} — the empty object a shim answers with', {}],
  ['{stand:false} — the second flag absent', { stand: false }],
  ['{pilot:false} — the first flag absent', { pilot: false }],
  ['{stand:"false",pilot:"false"} — strings, not booleans', { stand: 'false', pilot: 'false' }],
  ['{stand:0,pilot:0} — numbers, not booleans', { stand: 0, pilot: 0 }],
  ['[] — an array', []],
  ['"production" — a string', 'production'],
  ['42 — a number', 42],
];
for (const [what, ep] of R16_UNKNOWN_SHAPES) {
  const r = await buildKindFor(ep);
  ok(r.nonprod === null,
    `R16a (${what}) the build's kind is UNKNOWN, not "production" (got ${JSON.stringify(r.nonprod) === undefined ? 'undefined' : JSON.stringify(r.nonprod)})`);
  ok(r.html !== null && !r.html.includes('claimSkipiIdentity()'),
    `R16b (${what}) and the button that writes to production is not drawn`);
  ok(r.html !== null && r.html.includes('mobile-card-title'),
    `R16c (${what}) while the rest of the card still renders — unknown removes a button, not a screen`);
}
// CALIBRATION, and the ONLY shape that may read as production: a valid object
// whose two flags are BOTH boolean false. Without this pair of assertions the
// ten refusals above would be green over a driver that cannot see the button
// at all.
const r16prod = await buildKindFor(PROD_EP);
ok(r16prod.nonprod === false,
  'R16d CALIBRATION — an endpoint object whose two flags are both boolean false IS production');
ok(r16prod.html !== null && r16prod.html.includes('claimSkipiIdentity()'),
  'R16e CALIBRATION — and there the button is drawn exactly as it is today, so the ten probes above demonstrably see it');
const r16pilot = await buildKindFor(PILOT_EP);
ok(r16pilot.nonprod === true,
  'R16f a pilot build still answers true — the third state is untouched by this delta');
ok(r16pilot.html !== null && !r16pilot.html.includes('claimSkipiIdentity()'),
  'R16g and still draws no button, as test 14 already required');

// ════════════════════════════════════════════════════════════════════════════
// RC. A DELIVERY THAT HAPPENED IS STILL VISIBLE AFTER A COLD START — №605.
//
// WHAT WAS MEASURED BROKEN, not deduced: on 2026-09-29 a response was delivered
// to the pilot, the app was force-stopped and started cold, and the card came
// back BYTE FOR BYTE the card from before — an active "Respond with Skipi" and
// no trace of the delivery. The server's row survived and so did the response id
// in the vault; only the SCREEN did not, and it could not have: the
// acknowledgement was handed to the WebView and written nowhere.
//
// MEASUREMENT BOUNDARY, stated rather than implied. This section runs the real
// inline scripts in a DOM shim over a stubbed `jobs_response_receipts`. It
// therefore proves WHAT THE SCREEN DOES WITH A RECEIPT and what the handler
// refuses; it compiles nothing, opens no vault and does not prove the five
// conditions that decide whether a receipt is this vault's — those are Rust's,
// pinned by the unit tests in `jobs.rs` and by the source claims at the end of
// this section.
// ════════════════════════════════════════════════════════════════════════════

section('RC. the receipt of a delivered response, restored on the screen (№605)');

const RECEIPT_ACK = {
  source: 'acknowledgement',
  response_id: '11111111-2222-4333-8444-000000000001',
  profile_id: PROFILE_MATCH.profile_id,
  base: 'https://api.skipi.app',
  vault_user_id: 'harness-vault-user',
  subject_id: 'SKP-HARNESS-0001',
  intake_id: 'intake-0001',
  published_version: 7,
  crewing_id: CREWING_ALPHA_ID,
  content_sha256: 'abc',
  server_created_at: '2026-09-28T00:00:00Z',
};
// The 409 receipt, and every optional field really is absent: a conflict body
// carries no intake id, no version and no timestamp, so there is nothing else
// honest to record.
const RECEIPT_ALREADY = {
  source: 'already_on_record',
  response_id: RECEIPT_ACK.response_id,
  profile_id: PROFILE_MATCH.profile_id,
  base: RECEIPT_ACK.base,
  vault_user_id: RECEIPT_ACK.vault_user_id,
  subject_id: RECEIPT_ACK.subject_id,
  intake_id: null,
  published_version: null,
  crewing_id: null,
  content_sha256: null,
  server_created_at: null,
};
const RECEIPT_ACK_NO_VERSION = { ...RECEIPT_ACK, published_version: null };
const mapOf = (r) => ({ [PROFILE_MATCH.profile_id]: r });

const EN_OK = 'The agency received your response.';
const EN_VERSION = 'delivered against published version';
const EN_ALREADY = 'Your response has already been delivered. Pressing again sends nothing new.';
const EN_IRREVERSIBLE = 'A response cannot be withdrawn. Once it is delivered, the agency keeps it.';
const RU_OK = 'Агентство получило ваш отклик.';
const RU_ALREADY = 'Ваш отклик уже доставлен. Повторное нажатие ничего нового не отправит.';

// ---- CALIBRATION FIRST. Without this pair the whole section could be green
// over a driver that cannot see the button at all, and "the receipt hides it"
// would be a claim about nothing.
const rc0 = await renderJobsScreen({ profiles: [PROFILE_MATCH] });
ok(rc0.sectionHtml.includes('data-qa="jobs-respond-btn"')
  && !/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc0.sectionHtml),
  'RC0 CALIBRATION — with NO receipt the button is drawn and LIVE, exactly as today');
ok(rc0.sectionHtml.includes(EN_IRREVERSIBLE),
  'RC0b CALIBRATION — and the sentence about irreversibility is printed, exactly as today');
ok(rc0.sectionHtml.includes('data-qa="jobs-respond-status"')
  && !rc0.sectionHtml.includes(EN_OK) && !rc0.sectionHtml.includes(EN_ALREADY),
  'RC0c CALIBRATION — and the status line is EMPTY: nothing claims a delivery');
ok(!rc0.sectionHtml.includes('data-receipt-source'),
  'RC0d CALIBRATION — and no receipt marker is on the card');

// ---- D10: the screen after a cold start on a CONFIRMED delivery -------------
const rc1 = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ACK) });
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc1.sectionHtml),
  'RC1 (D10) with a receipt the button is DEAD — drawn and disabled, at the place where he pressed');
ok(/data-qa="jobs-respond-btn"[^>]*aria-disabled="true"/.test(rc1.sectionHtml),
  'RC1b and it says so to a screen reader too');
ok(!rc1.sectionHtml.includes(EN_IRREVERSIBLE),
  'RC1c (D10) and the irreversibility warning is NOT printed — that sentence is for a choice still open');
ok(rc1.sectionHtml.includes(EN_OK),
  'RC1d and the status line is PRE-FILLED with the sentence the delivery already earned');
ok(rc1.sectionHtml.includes(EN_VERSION + ' 7'),
  'RC1e and it names the published version the server acknowledged — from the receipt, not from a guess');
ok(rc1.sectionHtml.includes('data-respond-state="ok"'),
  'RC1f and the line carries the same state attribute the handler writes on a delivery');
ok(rc1.sectionHtml.includes('data-receipt-source="acknowledgement"'),
  'RC1g and the card says which kind of receipt restored it');
// The version is the server's or it is absent — never a substitute.
const rc1n = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ACK_NO_VERSION) });
ok(rc1n.sectionHtml.includes(EN_OK) && !rc1n.sectionHtml.includes(EN_VERSION),
  'RC1h a receipt without a version says so by SAYING NOTHING — no invented number');

// ---- the same screen in Russian ---------------------------------------------
const rc2 = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ACK), lang: 'ru' });
ok(rc2.sectionHtml.includes(RU_OK) && /data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc2.sectionHtml),
  'RC2 and the restored screen is in Russian for a Russian seafarer, button equally dead');

// ---- the 409 receipt: the sentence the product ALREADY says ------------------
const rc3 = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ALREADY) });
ok(rc3.sectionHtml.includes(EN_ALREADY),
  'RC3 an already_on_record receipt shows the sentence a repeat press shows today — no new claim');
ok(!rc3.sectionHtml.includes(EN_OK),
  'RC3b and NOT the confirmation sentence: a 409 is not an acknowledgement');
ok(rc3.sectionHtml.includes('data-respond-state="gone"'),
  'RC3c and it keeps the non-retryable state of that refusal');
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc3.sectionHtml) && !rc3.sectionHtml.includes(EN_IRREVERSIBLE),
  'RC3d dead button, no irreversibility warning');
const rc3ru = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ALREADY), lang: 'ru' });
ok(rc3ru.sectionHtml.includes(RU_ALREADY),
  'RC3e and in Russian it is the Russian sentence that already exists');

// ---- fail-closed on every shape that is NOT a receipt -----------------------
// A stub that answered "yes" to anything would make every assertion above
// vacuous, so the refusals are enumerated rather than assumed.
const NOT_RECEIPTS = [
  ['null', null],
  ['undefined — the command answered nothing', undefined],
  ['{} — no row for any profile', {}],
  ['a string', 'delivered'],
  ['an array', []],
  ['a row that is not an object', { [PROFILE_MATCH.profile_id]: 'delivered' }],
  ['a row with no source', { [PROFILE_MATCH.profile_id]: { response_id: 'r' } }],
  ['a source this build does not know', { [PROFILE_MATCH.profile_id]: { source: 'assumed' } }],
  ['a source that LOOKS right but is not', { [PROFILE_MATCH.profile_id]: { source: 'acknowledged' } }],
  ['a receipt for ANOTHER profile', { [PROFILE_OTHER_AGENCY.profile_id]: RECEIPT_ACK }],
];
for (const [what, receipts] of NOT_RECEIPTS) {
  const r = await renderJobsScreen({ profiles: [PROFILE_MATCH], receipts });
  ok(r.sectionHtml.includes('data-qa="jobs-respond-btn"')
    && !/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(r.sectionHtml)
    && r.sectionHtml.includes(EN_IRREVERSIBLE)
    && !r.sectionHtml.includes(EN_OK),
    `RC4 (${what}) is NOT a receipt: today's screen, live button, warning printed, no claim of delivery`);
}
// And a build whose WebView is newer than its binary: the command is not
// registered at all.
const rc5 = await renderJobsScreen({ profiles: [PROFILE_MATCH], receiptsThrow: true });
ok(rc5.sectionHtml.includes('data-qa="jobs-respond-btn"')
  && !/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc5.sectionHtml)
  && rc5.sectionHtml.includes(EN_IRREVERSIBLE),
  'RC5 a command that is not registered leaves TODAY\'S screen, not a broken one');

// ---- the loader really asks, and asks for the rows it is drawing ------------
const rc6 = await renderJobsScreen({ profiles: [PROFILE_MATCH, PROFILE_OTHER_AGENCY], receipts: {} });
ok(rc6.state.receiptCalls.length === 1,
  `RC6 the loader asks the vault ONCE per render (found ${rc6.state.receiptCalls.length})`);
ok(Array.isArray(rc6.state.receiptCalls[0])
  && rc6.state.receiptCalls[0].includes(PROFILE_MATCH.profile_id)
  && rc6.state.receiptCalls[0].includes(PROFILE_OTHER_AGENCY.profile_id),
  'RC6b and it asks about the profiles it is about to draw, not about a fixed one');
// U1/U2 already prove a hidden row is not drawn; this proves it is not asked
// about either — the ids that leave the WebView are the ids on the screen.
const rc6h = await renderJobsScreen({ profiles: [PROFILE_NO_RANK, PROFILE_MATCH], receipts: {} });
ok(Array.isArray(rc6h.state.receiptCalls[0])
  && !rc6h.state.receiptCalls[0].includes(PROFILE_NO_RANK.profile_id),
  'RC6c and a row that is not shown is not asked about');

// ---- D11: THE HANDLER REFUSES, and the grey button is only the visible half --
const rc7 = await runRespond({ receipts: mapOf(RECEIPT_ACK) });
ok(rc7.submits.length === 0,
  `RC7 (D11) a press with a receipt sends NOTHING (found ${rc7.submits.length} submits)`);
const rc7cmds = rc7.state.calls.map((c) => c[0]);
ok(!rc7cmds.includes('export_redacted_cv_pdf'),
  'RC7b (D11) and writes no privacy-reduced CV into the downloads folder — the refusal is before the file');
ok(!rc7cmds.includes('ensure_profile_response_id'),
  'RC7c (D11) and mints nothing in the vault — the refusal is the FIRST block of the handler');
ok(rc7.statusState === 'ok' && rc7.statusHtml.includes(EN_OK),
  'RC7d and the seafarer is told what is true: the agency has his response');
ok(rc7.buttonDisabled === true,
  'RC7e and the button is left dead');
const rc7a = await runRespond({ receipts: mapOf(RECEIPT_ALREADY) });
ok(rc7a.submits.length === 0 && rc7a.statusState === 'gone' && rc7a.statusHtml.includes(EN_ALREADY),
  'RC7f the same for an already_on_record receipt — nothing sent, the existing sentence shown');
// CALIBRATION of the four refusals above: with no receipt this same driver DOES
// reach the network, so RC7 measures the receipt and not a broken driver.
const rc7cal = await runRespond({});
ok(rc7cal.submits.length === 1 && rc7cal.state.calls.map((c) => c[0]).includes('export_redacted_cv_pdf'),
  'RC7g CALIBRATION — without a receipt this driver demonstrably does submit and does write the CV');

// ---- D12: the receipt survives the redraw after an identity claim ------------
const rc8 = boot({ profiles: [PROFILE_MATCH], receipts: mapOf(RECEIPT_ACK), identity: IDENTITY_NONE });
try { await rc8.sandbox.showJobs(); } catch (e) { /* section V's claim, not this one */ }
await settle();
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc8.profilesHost.innerHTML)
  && rc8.profilesHost.innerHTML.includes(EN_OK),
  'RC8 a vault with NO identity still shows the delivery it already made — the receipt is read BEFORE the identity step');
ok(!rc8.profilesHost.innerHTML.includes('data-qa="jobs-identity-step"'),
  'RC8b and it is not asked for a Skipi ID for a response the server already holds');
const rc8redrawn = rc8.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY);
ok(rc8redrawn === true, 'RC8c the identity redraw really ran');
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc8.profilesHost.innerHTML)
  && rc8.profilesHost.innerHTML.includes(EN_OK),
  'RC8d (D12) and AFTER that redraw the receipt is still there — the state does not live only until the first claim');
// And a receipt is read before the OTHER early return too: an answer that can no
// longer name the agency does not erase a delivery that already happened.
const rc8blank = await renderJobsScreen({
  profiles: [{ ...PROFILE_BLANK_NAME, profile_id: PROFILE_MATCH.profile_id }],
  receipts: mapOf(RECEIPT_ACK),
});
ok(rc8blank.sectionHtml.includes(EN_OK)
  && !rc8blank.sectionHtml.includes('data-qa="jobs-respond-blocked"'),
  'RC8e a blank agency name does not un-deliver a delivered response either');

// ---- D17: the same session, without any restart -----------------------------
// THE MIRROR OF №605 AND THE HALF A COLD START HIDES. After a successful
// delivery the vault has a receipt but `jobsProfilesLastRender` was built before
// it existed, so any redraw in the same session would hand back a LIVE
// irreversible button on a response already delivered.
const rc9 = boot({ profiles: [PROFILE_MATCH], receipts: {}, respondFor: [PROFILE_MATCH.profile_id] });
try { await rc9.sandbox.showJobs(); } catch (e) { /* not this claim */ }
await settle();
ok(!/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc9.profilesHost.innerHTML),
  'RC9 CALIBRATION — before the press the button of this very render is live');
await rc9.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
await settle();
ok(rc9.state.submits.length === 1, 'RC9b the press really delivered (the driver is not inert)');
ok(rc9.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY) === true, 'RC9c and a redraw ran afterwards');
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc9.profilesHost.innerHTML)
  && rc9.profilesHost.innerHTML.includes(EN_OK),
  'RC9d (D17) and the redraw shows the delivery — a receipt learned in this session is not lost by a redraw');
// The same for the 409 that produces a receipt, and NOT for the conflict whose
// reason this build does not know.
const rc9c = boot({
  profiles: [PROFILE_MATCH], receipts: {}, respondFor: [PROFILE_MATCH.profile_id],
  submitThrows: 'RESPONSE_ALREADY_DELIVERED',
});
try { await rc9c.sandbox.showJobs(); } catch (e) { /* not this claim */ }
await settle();
await rc9c.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
await settle();
rc9c.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY);
ok(/data-qa="jobs-respond-btn"[^>]*\sdisabled/.test(rc9c.profilesHost.innerHTML)
  && rc9c.profilesHost.innerHTML.includes(EN_ALREADY),
  'RC9e (D17) an already-delivered 409 also survives a redraw in the same session');
const rc9u = boot({
  profiles: [PROFILE_MATCH], receipts: {}, respondFor: [PROFILE_MATCH.profile_id],
  submitThrows: 'RESPONSE_CONFLICT_UNKNOWN',
});
try { await rc9u.sandbox.showJobs(); } catch (e) { /* not this claim */ }
await settle();
await rc9u.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
await settle();
rc9u.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY);
ok(!rc9u.profilesHost.innerHTML.includes(EN_OK) && !rc9u.profilesHost.innerHTML.includes(EN_ALREADY),
  'RC9f (D3) a conflict whose reason this build does not know remembers NOTHING — it is not a delivery');
const rc9t = boot({
  profiles: [PROFILE_MATCH], receipts: {}, respondFor: [PROFILE_MATCH.profile_id],
  submitThrows: 'network: connection refused',
});
try { await rc9t.sandbox.showJobs(); } catch (e) { /* not this claim */ }
await settle();
await rc9t.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
await settle();
rc9t.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY);
ok(!rc9t.profilesHost.innerHTML.includes(EN_OK) && !rc9t.profilesHost.innerHTML.includes(EN_ALREADY),
  'RC9g (D9) a transport failure remembers NOTHING either — a network error is not a delivery');
// A 2xx that is NOT a confirmation must not be remembered as one.
const rc9p = boot({
  profiles: [PROFILE_MATCH], receipts: {}, respondFor: [PROFILE_MATCH.profile_id],
  submitAck: { delivered: true, intake_id: '   ' },
});
try { await rc9p.sandbox.showJobs(); } catch (e) { /* not this claim */ }
await settle();
await rc9p.sandbox.jobsRespondToProfile(PROFILE_MATCH.profile_id);
await settle();
rc9p.sandbox.jobsProfilesRerenderIdentity(IDENTITY_READY);
ok(!rc9p.profilesHost.innerHTML.includes(EN_OK),
  'RC9h (D2) an answer with no intake id is not a delivery on the screen either');

// ---- NOT ONE NEW STRING IN THE DICTIONARY -----------------------------------
// The card's PRESERVE line, measured rather than promised: both sentences the
// restored screen shows already existed in RU and EN before this card.
['jobs.profiles.respond_ok', 'jobs.profiles.respond_already', 'jobs.profiles.respond_ack_version']
  .forEach((k) => {
    ok(enBlock.includes(`'${k}'`) && ruBlock.includes(`'${k}'`),
      `RC10 the sentence the receipt shows is the EXISTING key ${k}, in both languages`);
  });
ok(!/jobs\.profiles\.receipt/.test(html),
  'RC10b and no `jobs.profiles.receipt*` key was invented — zero new dictionary lines');

// ---- SOURCE CLAIMS. What the DOM shim cannot see ----------------------------
//
// BOUNDARY: these read jobs.rs AS TEXT. A property that holds only by the order
// of lines is asserted here AND has an executable unit test in `jobs.rs`, because
// text is not execution — see the receipt module at the foot of that file.
section('RC. the receipt is written only on the server\'s word (source contract)');

const submitSrc = withoutLineComments(String(rustFnBody(jobsRs, 'submit_profile_response') || ''));
ok(submitSrc.length > 0, 'RS0 submit_profile_response found');

// D2 — POSITIONAL: both halves of the check, then the write, then Ok(ack).
const atDelivered = submitSrc.indexOf('"delivered"');
const atIntake = submitSrc.indexOf('intake_id.is_none()');
const atAckWrite = submitSrc.indexOf('receipt_from_acknowledgement');
const atOk = submitSrc.lastIndexOf('Ok(ack)');
ok(atDelivered > 0 && atIntake > atDelivered,
  'RS1 both halves of the confirmation are still checked, in order');
ok(atAckWrite > atIntake,
  'RS2 (D2) the receipt is built AFTER both halves — a 2xx without them writes nothing');
ok(atOk > atAckWrite,
  'RS3 and BEFORE the acknowledgement is returned');
const atSend = submitSrc.indexOf('send_on_response_bases');
ok(atSend > 0 && atAckWrite > atSend,
  'RS4 (D9) and after the request — a transport error leaves through the `?` and never reaches it');

// D3 — the 409 write is under RESPONSE_ALREADY_DELIVERED and nowhere else.
const conflictBlock = withoutLineComments(String(blockAfter(submitSrc, 'if answer.status == 409') || ''));
ok(conflictBlock.length > 0, 'RS5 the 409 branch was found');
ok(conflictBlock.includes('receipt_already_on_record'),
  'RS6 the 409 receipt is written inside that branch');
const alreadyBlock = withoutLineComments(String(blockAfter(conflictBlock, 'if token == RESPONSE_ALREADY_DELIVERED') || ''));
ok(alreadyBlock.includes('receipt_already_on_record') && alreadyBlock.includes('set_vault_info'),
  'RS7 (D3) and only inside the RESPONSE_ALREADY_DELIVERED arm of the classifier');
ok(countOf(conflictBlock, 'set_vault_info') === 1
  && countOf(alreadyBlock, 'set_vault_info') === 1,
  'RS8 (D3) which is the ONLY write in that branch — RESPONSE_CONFLICT_UNKNOWN writes nothing');
ok(!conflictBlock.includes('RESPONSE_CONFLICT_UNKNOWN'),
  'RS8b and the unknown token is not even named on a write path');

// D15 — the writes are INLINE. A helper would make RS1-RS8 and I18/I18c blind,
// because rustFnBody does not follow a call.
ok(countOf(submitSrc, 'set_vault_info') === 2,
  `RS9 (D15) both receipt writes are INLINE in this command (found ${countOf(submitSrc, 'set_vault_info')}) — moved into a helper, every positional claim above goes blind`);

// D4 — the base is part of the key ALWAYS, and no flag decides it.
const keySrc = withoutLineComments(String(rustFnBody(jobsRs, 'response_receipt_key') || ''));
ok(keySrc.includes('normalized_response_base') && keySrc.includes('RESPONSE_RECEIPT_KEY_PREFIX'),
  'RS10 (D4) the row name is built from the normalised base and the profile id');
ok(!/endpoint|stand|pilot|if\s/.test(keySrc),
  'RS10b (D4) with NO branch in it — production is not an exception here, unlike the identity rows');

// D13 — not one non-production predicate reaches the reader's decision.
const readerSrc = withoutLineComments(String(rustFnBody(jobsRs, 'jobs_response_receipts') || ''));
ok(readerSrc.length > 0, 'RS11 jobs_response_receipts found');
ok(!/\.stand|\.pilot|jobs_non_production_base|jobs_test_api_base|jobs_pilot_api_base/.test(readerSrc),
  'RS11b (D13) and it reads NO non-production predicate — BACKLOG №603 does not get a new call site');
ok(/endpoint\.base/.test(readerSrc),
  'RS11c only the base is taken from the endpoint');
const decideSrc = withoutLineComments(String(rustFnBody(jobsRs, 'accepted_response_receipt') || ''));
ok(decideSrc.length > 0, 'RS12 accepted_response_receipt found');
ok(!/\.stand|\.pilot|endpoint|jobs_response_endpoint/.test(decideSrc),
  'RS12b (D13) and the deciding function cannot even see an endpoint — it takes strings');
// D4-D8 — all five conditions, in the one function that decides.
[['base', 'RS13'], ['vault_user_id', 'RS14'], ['subject_id', 'RS15'], ['profile_id', 'RS16'], ['response_id', 'RS17']]
  .forEach(([field, id]) => {
    ok(decideSrc.includes(field),
      `${id} (D4-D8) the decision compares ${field} — remove it and another vault's receipt reads as this one's`);
  });
ok(decideSrc.includes('RECEIPT_SOURCE_ACKNOWLEDGEMENT') && decideSrc.includes('RECEIPT_SOURCE_ALREADY_ON_RECORD'),
  'RS18 and a `source` this build did not write is refused');
ok(readerSrc.includes('RESPONSE_ID_KEY_PREFIX'),
  'RS19 (D7) the response id it compares against is the one in THIS vault');

// D16 — the receipt names the host that ANSWERED. Text here, execution in the
// unit test: on a stand and on the pilot the list is one base, so equality holds
// identically and no screen-level test could ever tell the difference.
const ackBuildSrc = withoutLineComments(String(rustFnBody(jobsRs, 'receipt_from_acknowledgement') || ''));
ok(ackBuildSrc.includes('answer.base'),
  'RS20 (D16) the receipt takes its base from the ANSWER, not from the endpoint');
ok(!/jobs_response_endpoint/.test(ackBuildSrc),
  'RS20b and the builder cannot reach the endpoint at all');
const walkSrc = withoutLineComments(String(rustFnBody(jobsRs, 'send_on_response_bases') || ''));
ok(/base:\s*base\.clone\(\)/.test(walkSrc),
  'RS20c (D16) and the walk records the loop variable — the step that actually answered');
ok(submitSrc.includes('&answer.base') || /response_receipt_key\(&answer\.base/.test(submitSrc),
  'RS20d (D16) and the row it is stored under names that same host');
// AND THE UNIT TEST THAT PROVES D16 MUST BE ABLE TO SEE D16. Measured on
// 2026-09-30: a first version of that test used a production spelling for BOTH
// of its bases, and since `jobs_response_endpoint()` answers the production host
// in a unit build, substituting the endpoint produced a value the test was
// content with — it stayed GREEN under the mutation it is named for, and three
// sibling tests caught it instead. The pilot spelling on the answering side is
// what makes the substitution visible, so it is pinned here rather than left to
// the next person's memory.
const d16Body = String(rustFnBody(jobsRs, 'd16_the_receipt_names_the_host_that_answered_not_the_first_one_tried') || '');
ok(d16Body.length > 0, 'RS20e the unit test named for D16 exists');
ok(/api\.skipi\.app:8444/.test(d16Body) && /"https:\/\/api\.skipi\.app"/.test(d16Body),
  'RS20f (D16) and its two bases are NOT both production spellings — otherwise it cannot see the mutation it is named for');

// D14 — the exact bytes the whole of write site 2 hangs on.
ok(jobsRs.includes('const INTAKE_CONTENT_CONFLICT: &str = "event already accepted with different content";'),
  'RS21 (D14) the server sentence write site 2 depends on is pinned character for character');
// BOUNDARY, said out loud: this pins the CLIENT's copy. It cannot see the server
// change its wording — provenance is `candidate_intake_service.py:105` at
// `ed6627e3`, and if the server changes it, write site 2 stops firing rather
// than starting to lie.
// Over the PRODUCT half with the prose removed: a comment that names the
// constant is not a second reader of it, and counting comments would make this
// line fail on documentation.
ok(countOf(jobsRsProduct, 'INTAKE_CONTENT_CONFLICT') === 2,
  `RS21b and that literal has exactly one user in the product code — the classifier (found ${countOf(jobsRsProduct, 'INTAKE_CONTENT_CONFLICT') - 1})`);

// PRESERVE — the delivery path and the id minting are untouched by this card.
const ensureIdSrc = withoutLineComments(String(rustFnBody(jobsRs, 'ensure_profile_response_id') || ''));
ok(ensureIdSrc.length > 0 && !/receipt/i.test(ensureIdSrc),
  'RS22 PRESERVE — ensure_profile_response_id knows nothing about receipts');
ok(libRs.includes('jobs::jobs_response_receipts'),
  'RS23 the reader is registered, so the WebView can actually call it');
ok(countOf(libRs, 'jobs::jobs_response_receipts') === 1,
  'RS23b exactly once');

console.log('');
if (fail > 0) {
  console.error(`FAILURES (${fail}):`);
  failures.forEach((f) => console.error('  - ' + f));
  console.error(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

#!/usr/bin/env node
// Headless harness for My Vessel crew join when the local profile exists but
// the public Skipi ID has not been claimed yet.
//
// Loads the REAL inline script from dist/index.html and verifies:
// - compact identity card exposes Claim Skipi ID;
// - crew join stops before /api/onboard/crew/accept when public_seafarer_id is
//   missing;
// - the in-flow "Claim Skipi ID and continue" path claims identity, registers
//   the identity key, signs accept, and then posts accept.

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('dist/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let script = scripts[scripts.length - 1];
script = script
  .split('\n')
  .filter((line) => !line.includes('try{loadTheme();') && !line.includes('try{init().catch'))
  .join('\n');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, value: '', innerHTML: '', textContent: '', style: {}, className: '',
      setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, toggle() {} },
      click() { this.clicked = true; },
    });
  }
  return elements.get(id);
}

const storage = new Map();
const invokes = [];
const apiCalls = [];
const toasts = [];
let publicId = null;
let confirmValue = true;

const context = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  localStorage: {
    getItem: (k) => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  window: {},
  document: {
    title: 'Skipi Test',
    body: { appendChild() {} },
    documentElement: {
      getAttribute: () => 'light',
      setAttribute() {},
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
    },
    getElementById: element,
    createElement: () => element(`anon-${elements.size}`),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  },
  navigator: { onLine: true },
  location: { hash: '', pathname: '/' },
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.window = context;
context.addEventListener = () => {};
context.getUiLang = () => 'en';
context.tr = (key) => ({ 'app.name': 'Skipi Seafarer' })[key] || key;

vm.createContext(context);
vm.runInContext(script, context, { filename: 'dist/index.html' });

context.myVesselRerender = () => {};
context.showToast = (msg, kind) => { toasts.push({ msg, kind }); };
context.uiConfirm = async () => confirmValue;
context.invoke = async (cmd, args = {}) => {
  invokes.push({ cmd, args });
  if (cmd === 'get_matchable_profile') {
    return { public_seafarer_id: publicId, user_id: 'vault-test-1', rank_id: 'master', position_id: 'master' };
  }
  if (cmd === 'claim_seafarer_identity') {
    publicId = 'SKP-SF-TEST-01';
    return { public_seafarer_id: publicId, duplicate: false, trust_level: 'identity_claimed' };
  }
  if (cmd === 'get_identity_trust_status') {
    return { status: 'unique', server_identity: publicId ? { public_seafarer_id: publicId } : {} };
  }
  if (cmd === 'register_my_identity_pubkey') {
    return { vault_user_id: 'vault-test-1' };
  }
  if (cmd === 'onboard_crew_sign_accept') {
    assert.equal(args.publicSeafarerId, publicId);
    assert.equal(args.code, 'K7P49QXZ');
    assert.ok(Number.isInteger(args.ts), 'accept signer receives timestamp');
    return { vault_user_id: 'vault-test-1', signature: 'sig-test' };
  }
  if (cmd === 'get_seafarer_personal') {
    return { first_name: 'Tymur', surname: 'Rudov' };
  }
  throw new Error(`unexpected invoke ${cmd}`);
};
context.apiFetch = async (url, opt = {}) => {
  apiCalls.push({ url, opt });
  assert.equal(url, '/api/onboard/crew/accept');
  const body = JSON.parse(opt.body);
  assert.equal(body.public_seafarer_id, publicId);
  assert.equal(body.vault_user_id, 'vault-test-1');
  assert.equal(body.signature, 'sig-test');
  assert.equal(body.code_or_qr_payload, 'K7P49QXZ');
  return {
    ok: true,
    status: 201,
    json: async () => ({ crew_member_id: 'crew-1', vessel_imo: 7533197, status: 'linked' }),
  };
};

function section(name) { console.log(`# ${name}`); }
function ok(cond, msg) { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); }

section('identity card exposes claim in compact mode');
let compact = context.identityTrustHtml({ status: 'unique', server_identity: {} }, true);
ok(compact.includes('claimSkipiIdentity()'), 'compact identity card has claim action');

section('join blocks before accept when Skipi ID is missing');
context.myVessel = {
  stage: 'consent',
  error: '',
  resolved: { vessel_name: 'AVDEEVKA', vessel_imo: 7533197 },
  acceptCode: 'K7P49QXZ',
  membership: null,
};
await context.myVesselAccept();
ok(context.myVessel.stage === 'identity_required', 'missing public ID shows identity_required stage');
ok(apiCalls.length === 0, 'no accept call is made before Skipi ID exists');
ok(context.myVesselInnerHtml().includes('Claim Skipi ID'), 'identity_required screen offers claim and continue');

section('claim and continue posts crew accept');
await context.myVesselClaimIdentityAndContinue();
ok(invokes.some((x) => x.cmd === 'claim_seafarer_identity'), 'claims Skipi ID');
ok(invokes.some((x) => x.cmd === 'register_my_identity_pubkey'), 'registers identity public key');
ok(invokes.some((x) => x.cmd === 'onboard_crew_sign_accept'), 'signs crew accept');
ok(apiCalls.length === 1, 'posts /api/onboard/crew/accept after claim');
ok(context.myVessel.stage === 'joined', 'join finishes as linked');
ok(context.myVessel.membership.vessel_imo === 7533197, 'membership stores vessel IMO');

section('cancel keeps user on identity_required without mutation');
publicId = null;
confirmValue = false;
apiCalls.length = 0;
invokes.length = 0;
context.myVessel.stage = 'identity_required';
await context.myVesselClaimIdentityAndContinue();
ok(context.myVessel.stage === 'identity_required', 'cancel leaves identity_required stage');
ok(!invokes.some((x) => x.cmd === 'claim_seafarer_identity'), 'cancel does not claim identity');
ok(apiCalls.length === 0, 'cancel does not call accept');

console.log('myvessel_identity_join_harness: GREEN');

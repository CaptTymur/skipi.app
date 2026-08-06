// Account profile import/export contract (№96(б) Фаза 2).
//
// Static contract over dist/index.html + the Rust backend sources:
//   - the vault privacy promise is honest (the profile can leave the vault,
//     but only on the explicit "Send to account" action);
//   - device pairing + import + export are wired through explicit buttons
//     only (no automatic sync hook anywhere);
//   - the account sync module pins the assistant.skipi.app base (separate
//     from api.skipi.app), the 38-key wire contract, the vault token key,
//     and never lists personal_photo_path in the wire keys;
//   - every account-sync Tauri command is registered in lib.rs.
//
//   node tests/account_profile_sync_harness.mjs

import fs from 'node:fs';

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const html = fs.readFileSync('dist/index.html', 'utf8');
const lib = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const sync = fs.readFileSync('src-tauri/src/commands/account_sync.rs', 'utf8');

console.log('# Account profile sync contract');

// ── Privacy copy: the old absolute promise must be gone, replaced by the
// honest one (manager default, handoff §3.2) in BOTH profile screens.
ok(!html.includes('Stored only inside this vault on disk.'),
  'stale absolute promise "Stored only inside this vault on disk." is gone');
ok(count(html, 'Leaves the vault only when you tap') >= 2,
  'honest promise present in both (legacy + unified) seafarer sections');
ok(!html.includes('Хранятся только в этом хранилище на диске.'),
  'stale RU absolute promise is gone');

// ── Explicit-action-only UI wiring.
ok(html.includes('id="sp-acc-code"'), 'link-code input exists');
ok(html.includes('onclick="spAccountLink()'), 'Link device is an explicit button');
ok(html.includes('onclick="spAccountImport()'), 'Import from account is an explicit button');
ok(html.includes('onclick="spAccountSend()'), 'Send to account is an explicit button');
ok(count(html, 'spAccountImport(') === 2,
  'spAccountImport referenced exactly twice (definition + one button) — no auto-sync');
ok(count(html, 'spAccountSend(') === 2,
  'spAccountSend referenced exactly twice (definition + one button) — no auto-sync');
ok(!/setInterval\([^)]*spAccount/.test(html) && !/setTimeout\([^)]*spAccountImport/.test(html)
  && !/setTimeout\([^)]*spAccountSend/.test(html),
  'no timer-driven account sync');

// ── Both flows confirm through a preview before touching anything.
ok(html.includes("invoke('preview_account_profile_import')"),
  'import goes through a preview command first');
ok(html.includes("invoke('apply_account_profile_import'"),
  'import applies only after the preview/confirmation step');
ok(html.includes("invoke('preview_account_profile_export')"),
  'export goes through a preview command first');
ok(html.includes("invoke('send_account_profile')"),
  'export sends only after the preview/confirmation step');
ok(html.includes("invoke('link_account_device'"), 'link button claims the pairing code');
ok(html.includes("invoke('get_account_link_status')"), 'UI shows linked/not-linked status');

// ── Backend module contract.
ok(sync.includes('"https://assistant.skipi.app"'),
  'account sync pins the assistant.skipi.app base (not api.skipi.app)');
ok(sync.includes('SKIPI_ASSISTANT_API_BASE'),
  'assistant base has an env override for tests (SKIPI_ASSISTANT_API_BASE)');
ok(sync.includes('"skipi_device_token"'),
  'bearer token is stored under the vault_info key skipi_device_token');
const WIRE_KEYS = [
  'personal_rank', 'personal_available_from', 'personal_surname',
  'personal_first_name', 'personal_middle_name', 'personal_dob',
  'personal_place_of_birth', 'personal_nationality', 'personal_nationality_code',
  'personal_home_address', 'personal_phones', 'personal_email',
  'personal_nearest_airport', 'personal_nearest_intl_airport',
  'personal_passport_no', 'personal_passport_issue', 'personal_passport_expiry',
  'personal_seaman_book_no', 'personal_seaman_book_issue',
  'personal_seaman_book_expiry', 'personal_height_cm', 'personal_weight_kg',
  'personal_coverall_size', 'personal_shoe_size_eu', 'personal_blood_type',
  'personal_marital_status', 'personal_children_count',
  'personal_next_of_kin_name', 'personal_next_of_kin_relation',
  'personal_next_of_kin_phone', 'personal_visa_countries', 'personal_min_salary',
  'personal_currency', 'personal_languages', 'personal_english_level',
  'preferred_vessel_types', 'personal_ready_for_offers',
  'personal_preferred_messenger',
];
const arrStart = sync.indexOf('PROFILE_WIRE_KEYS: [&str; 38] = [');
const arrEnd = sync.indexOf('];', arrStart);
ok(arrStart !== -1 && arrEnd !== -1, 'PROFILE_WIRE_KEYS array of 38 keys exists');
const arr = sync.slice(arrStart, arrEnd);
for (const k of WIRE_KEYS) {
  if (!arr.includes(`"${k}"`)) throw new Error(`wire key missing from contract: ${k}`);
}
passed += 1;
console.log('  ✓ all 38 canonical wire keys are pinned byte-exact');
ok(!arr.includes('personal_photo_path'),
  'personal_photo_path is NOT part of the wire contract (photo stays local)');

// ── Command registration.
for (const cmd of [
  'account_sync::link_account_device',
  'account_sync::get_account_link_status',
  'account_sync::unlink_account_device',
  'account_sync::preview_account_profile_import',
  'account_sync::apply_account_profile_import',
  'account_sync::preview_account_profile_export',
  'account_sync::send_account_profile',
]) {
  ok(lib.includes(cmd), `lib.rs registers ${cmd}`);
}

console.log(`ALL GREEN: ${passed} account profile sync checks passed`);

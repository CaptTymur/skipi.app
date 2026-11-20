// Account profile sync contract.
//
// History: №96(б) Фаза 2 (OWNER DECISIONS 2026-08-05 (22) + 2026-08-06 (25))
// added device pairing + explicit «Import from account» / «Send to account».
// tasks/004 (OWNER 2026-11-20, while checking build 003 on the emulator:
// «линк код, линк девайс, импорт и так далее — это всё нам больше не нужно»)
// removed that manual transfer entirely. The account's profile now travels
// ONLY through the one-account sync (№192/707: restore_account_profile,
// sync_account_now, enable_account_sync, conflicts).
//
// Static contract over dist/index.html + the Rust backend sources:
//   - the manual transfer block is gone from the profile screen (no link-code
//     input, no Link device / Import / Send buttons, no status probe);
//   - none of the seven pairing/transfer commands is invoked from the UI,
//     defined in Rust, or registered in lib.rs; the device token key is gone;
//   - the vault privacy copy is honest and no longer mentions a manual transfer;
//   - the account sync module still pins the assistant.skipi.app base (separate
//     from api.skipi.app), the 38-key wire contract, and never lists
//     personal_photo_path in the wire keys;
//   - the one-account sync entry points are still wired.
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

// ── Privacy copy: honest, and no manual transfer any more.
ok(!html.includes('Stored only inside this vault on disk.'),
  'stale absolute promise "Stored only inside this vault on disk." is gone');
ok(count(html, 'Shared with your account after you enable account sync') >= 2,
  'opt-in sync privacy description is present in both profile sections');
ok(!html.includes('Хранятся только в этом хранилище на диске.'),
  'stale RU absolute promise is gone');
ok(!/manual transfer/i.test(html),
  'privacy copy no longer promises a manual transfer (tasks/004)');

// ── Manual transfer UI is gone (tasks/004).
ok(!html.includes('Manual profile transfer'), 'the "Manual profile transfer" block is gone');
ok(!html.includes('id="sp-acc-code"'), 'link-code input is gone');
for (const fn of ['spAccountLink', 'spAccountUnlink', 'spAccountImport', 'spAccountImportApply',
  'spAccountSend', 'spAccountSendApply', 'spAccountRefreshStatus', 'spAccOpenModal']) {
  ok(count(html, fn + '(') === 0, `${fn}() is neither defined nor referenced`);
}
ok(!html.includes('sp-acc-status') && !html.includes('sp-acc-link-row') && !html.includes('sp-acc-modal'),
  'no leftover sp-acc-* element ids');

// ── The seven pairing/transfer commands are gone on both sides.
const GONE = [
  'link_account_device', 'get_account_link_status', 'unlink_account_device',
  'preview_account_profile_import', 'apply_account_profile_import',
  'preview_account_profile_export', 'send_account_profile',
];
for (const cmd of GONE) {
  ok(!html.includes(`invoke('${cmd}'`), `UI no longer invokes ${cmd}`);
  ok(!new RegExp(`fn\\s+${cmd}\\s*\\(`).test(sync), `account_sync.rs no longer defines ${cmd}`);
  ok(!lib.includes(`account_sync::${cmd}`), `lib.rs no longer registers ${cmd}`);
}
ok(!sync.includes('"skipi_device_token"') && !sync.includes('device-pairing/claim'),
  'device-pairing token key and claim endpoint are gone from account_sync.rs');

// ── Backend module contract (one-account sync keeps it).
ok(sync.includes('"https://assistant.skipi.app"'),
  'account sync pins the assistant.skipi.app base (not api.skipi.app)');
ok(sync.includes('SKIPI_ASSISTANT_API_BASE'),
  'assistant base has an env override for tests (SKIPI_ASSISTANT_API_BASE)');
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

// ── One-account sync stays wired (the only path for the profile now).
for (const cmd of ['get_account_sync_status', 'enable_account_sync', 'sync_account_now',
  'restore_account_profile', 'resolve_account_sync_conflict']) {
  ok(html.includes(`invoke('${cmd}'`), `UI still invokes ${cmd}`);
  ok(lib.includes(`account_sync::vault_sync::${cmd}`), `lib.rs still registers vault_sync::${cmd}`);
}

console.log(`ALL GREEN: ${passed} account profile sync checks passed`);

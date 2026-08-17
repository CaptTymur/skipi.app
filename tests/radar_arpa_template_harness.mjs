// Regression guard: bug #4 — ARPA certificate not recognised from a photo.
//
// Root cause (2026-08-17, Sergey field report). templates.rs curates OCR guides
// only for identity documents (passport / sid / seamans_book). The `radar_arpa`
// profile (a STCW training certificate, has_expiry:false) had NO guide, so its
// recognition fell back to the generic identity-document prompt and returned
// null fields ("No reliable fields were found").
//
// Fix: add a curated `radar_arpa` template and arm it in get_template(). This
// harness locks that the arm exists and the guide carries the certificate-shaped
// field guidance. Failing-first: fails on the pre-fix source (no arm/template).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const templates = readFileSync(join(root, 'src-tauri', 'src', 'templates.rs'), 'utf8');
const profiles = readFileSync(join(root, 'src-tauri', 'src', 'profiles.rs'), 'utf8');

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

console.log('# radar_arpa OCR template contract (bug #4)');

// Sanity: the profile this template serves exists and is expiry-less (so the
// guide must NOT invent an expiry — mirrors the seaman's book rule).
ok(/id:\s*"radar_arpa"/.test(profiles), 'radar_arpa profile exists in profiles.rs');

// 1) get_template must have an arm mapping "radar_arpa" to a template constant.
ok(/"radar_arpa"\s*=>\s*Some\(\s*RADAR_ARPA\s*\)/.test(templates),
  'get_template arms "radar_arpa" => Some(RADAR_ARPA)');

// 2) A RADAR_ARPA template constant must be defined.
const constMatch = templates.match(/const RADAR_ARPA:\s*&str\s*=\s*"([\s\S]*?)";/);
ok(constMatch, 'RADAR_ARPA template constant is defined');
const guide = constMatch[1];

// 3) The guide must be certificate-shaped, not identity-shaped: it must name the
//    ARPA/radar certificate context and the four curated fields.
ok(/ARPA/.test(guide) && /[Rr]adar/.test(guide),
  'guide names the Radar/ARPA certificate context');
ok(/certificate number|certificate no|serial/i.test(guide),
  'guide covers the certificate number field');
ok(/date of issue|issued/i.test(guide),
  'guide covers the date of issue field');
ok(/authority|training (?:centre|center|provider)|issuing body/i.test(guide),
  'guide covers the issuing authority/body field');

// 4) has_expiry:false — the guide must instruct NOT to invent an expiry.
ok(/no expiry|has no expiry|do not (?:invent|guess).{0,40}expiry|null for valid_to/i.test(guide),
  'guide instructs that this certificate has no expiry (do not invent valid_to)');

console.log(`ALL GREEN: ${passed} radar_arpa (bug #4) checks passed`);

// Seafarer Vessel DB source-split contract harness.
//
// The Vessel DB UI is vendored as a lightweight global-script module:
//   dist/vessel-db.js + dist/vessel-db.css
// This harness verifies that required globals/CSS moved out of the monolith
// while the app still loads the vendored files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIST, 'vessel-db.js'), 'utf8');
const css = fs.readFileSync(path.join(DIST, 'vessel-db.css'), 'utf8');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log('  ✓ ' + message);
  } else {
    fail += 1;
    console.error('  ✗ ' + message);
  }
}

function hasDefinition(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?:^|\\n)function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)async\\s+function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)var\\s+${escaped}\\b`)
  ].some((re) => re.test(source));
}

ok(html.includes('<link rel="stylesheet" href="vessel-db.css">'), 'index.html links vessel-db.css');
ok(html.includes('<script src="vessel-db.js"></script>'), 'index.html loads vessel-db.js');
ok(hasDefinition(js, 'vesselReviewHasLocal'), 'vessel-db.js defines vesselReviewHasLocal');
ok(hasDefinition(js, 'mobileLookupVesselByImo'), 'vessel-db.js defines mobileLookupVesselByImo');
ok(hasDefinition(js, 'VESSEL_REVIEWS_API'), 'vessel-db.js defines VESSEL_REVIEWS_API');
ok(hasDefinition(js, 'showVesselDatabase'), 'vessel-db.js defines showVesselDatabase');
ok(css.includes('.vdb-grid'), 'vessel-db.css contains .vdb-grid');
ok(css.includes('.vdb-card'), 'vessel-db.css contains .vdb-card');
ok(!hasDefinition(html, 'vesselReviewHasLocal'), 'index.html no longer defines vesselReviewHasLocal inline');
ok(!hasDefinition(html, 'mobileLookupVesselByImo'), 'index.html no longer defines mobileLookupVesselByImo inline');
ok(!hasDefinition(html, 'VESSEL_REVIEWS_API'), 'index.html no longer defines VESSEL_REVIEWS_API inline');
ok(!html.includes('.vdb-grid {'), 'index.html no longer carries .vdb-grid CSS inline');
ok(!html.includes('.vdb-card {'), 'index.html no longer carries .vdb-card CSS inline');

if (fail) {
  console.error(`\n${fail} Vessel DB contract assertion(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} Vessel DB contract assertions passed`);

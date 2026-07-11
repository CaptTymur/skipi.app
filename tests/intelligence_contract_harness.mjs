// Seafarer Intelligence source-split contract harness.
//
// The Information / Intelligence UI is vendored as a lightweight global-script
// module:
//   dist/intelligence.js + dist/intelligence.css
// This harness verifies that required globals/CSS moved out of the monolith
// while the app still loads the vendored files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(DIST, 'intelligence.js'), 'utf8');
const css = fs.readFileSync(path.join(DIST, 'intelligence.css'), 'utf8');

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

ok(html.includes('<link rel="stylesheet" href="intelligence.css">'), 'index.html links intelligence.css');
ok(html.includes('<script src="intelligence.js"></script>'), 'index.html loads intelligence.js');
ok(hasDefinition(js, 'renderInformationCompassOverview'), 'intelligence.js defines renderInformationCompassOverview');
ok(hasDefinition(js, 'renderMobileInformation'), 'intelligence.js defines renderMobileInformation');
ok(hasDefinition(js, 'loadInformationSnapshot'), 'intelligence.js defines loadInformationSnapshot');
ok(hasDefinition(js, 'showInformation'), 'intelligence.js defines showInformation');
ok(hasDefinition(js, 'INFORMATION_API'), 'intelligence.js defines INFORMATION_API');
ok(css.includes('.info-wrap'), 'intelligence.css contains .info-wrap');
ok(css.includes('.info-head'), 'intelligence.css contains .info-head');
ok(!hasDefinition(html, 'renderInformationCompassOverview'), 'index.html no longer defines renderInformationCompassOverview inline');
ok(!hasDefinition(html, 'renderMobileInformation'), 'index.html no longer defines renderMobileInformation inline');
ok(!hasDefinition(html, 'loadInformationSnapshot'), 'index.html no longer defines loadInformationSnapshot inline');
ok(!hasDefinition(html, 'showInformation'), 'index.html no longer defines showInformation inline');
ok(!hasDefinition(html, 'INFORMATION_API'), 'index.html no longer defines INFORMATION_API inline');
ok(!html.includes('.info-wrap {'), 'index.html no longer carries .info-wrap CSS inline');
ok(!html.includes('.info-head {'), 'index.html no longer carries .info-head CSS inline');

if (fail) {
  console.error(`\n${fail} Intelligence contract assertion(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} Intelligence contract assertions passed`);

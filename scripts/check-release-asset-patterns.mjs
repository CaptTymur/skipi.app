#!/usr/bin/env node
import fs from 'node:fs';

function fail(message) {
  console.error(`RELEASE ASSET PATTERN FAIL: ${message}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const productName = config.productName;
const version = config.version;

if (!productName || !version) {
  fail('src-tauri/tauri.conf.json must define productName and version');
}

// Tauri's desktop bundle assets currently normalize productName spaces to dots.
// The release workflow must therefore select by suffix + version, not by the old
// hard-coded Skipi_ prefix.
const assetStem = productName.trim().replace(/\s+/g, '.');
const signatures = [
  `${assetStem}_${version}_amd64.AppImage.sig`,
  `${assetStem}_${version}_amd64.deb.sig`,
  `${assetStem}-${version}-1.x86_64.rpm.sig`,
  `${assetStem}_${version}_x64-setup.exe.sig`,
  `${assetStem}_${version}_x64_en-US.msi.sig`,
];

function findSigForVersion(suffix) {
  return signatures
    .filter((name) => name.endsWith(`${suffix}.sig`))
    .filter((name) => name.includes(version))
    .sort()[0] || '';
}

const checks = {
  appimage: findSigForVersion('.AppImage'),
  deb: findSigForVersion('.deb'),
  rpm: findSigForVersion('.rpm'),
  exe: findSigForVersion('.exe'),
  msi: findSigForVersion('.msi'),
};

for (const [kind, match] of Object.entries(checks)) {
  if (!match) {
    fail(`no ${kind} signature matched productName=${JSON.stringify(productName)} version=${version}`);
  }
}

if (productName !== 'Skipi' && checks.appimage.startsWith(`Skipi_${version}_`)) {
  fail('AppImage matcher still relies on stale Skipi_ prefix');
}

console.log(`release asset pattern OK productName=${JSON.stringify(productName)} version=${version}`);
for (const [kind, match] of Object.entries(checks)) {
  console.log(`${kind}: ${match}`);
}

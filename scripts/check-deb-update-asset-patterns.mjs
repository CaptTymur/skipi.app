#!/usr/bin/env node
import fs from 'node:fs';
import https from 'node:https';

function fail(message) {
  console.error(`DEB UPDATE ASSET PATTERN FAIL: ${message}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const productName = config.productName;
const version = config.version;

if (!productName || !version) {
  fail('src-tauri/tauri.conf.json must define productName and version');
}

function assetStemFromProductName(name) {
  return String(name).trim().replace(/\s+/g, '.');
}

function debAssetName(name, assetVersion) {
  return `${assetStemFromProductName(name)}_${assetVersion}_amd64.deb`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'skipi-deb-update-asset-check' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function headOk(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'skipi-deb-update-asset-check' } }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        const next = new URL(res.headers.location, url).toString();
        headOk(next, redirects + 1).then(resolve, reject);
        return;
      }
      resolve(res.statusCode === 200);
    });
    req.on('error', reject);
    req.end();
  });
}

const expected = debAssetName(productName, version);
if (!expected.endsWith('_amd64.deb')) {
  fail(`constructed .deb asset has wrong suffix: ${expected}`);
}
if (productName !== 'Skipi' && expected.startsWith(`Skipi_${version}_`)) {
  fail('constructed .deb asset still relies on stale Skipi_ prefix');
}

console.log(`deb update asset pattern OK productName=${JSON.stringify(productName)} version=${version}`);
console.log(`constructed: ${expected}`);

const liveVersion = process.env.CHECK_LIVE_DEB_VERSION;
if (liveVersion) {
  const release = await getJson(`https://api.github.com/repos/CaptTymur/skipi.app/releases/tags/v${liveVersion}`);
  const expectedLive = debAssetName(productName, liveVersion);
  const debAssets = (release.assets || [])
    .filter((asset) => typeof asset.name === 'string' && asset.name.endsWith('_amd64.deb') && asset.name.includes(liveVersion));
  const exact = debAssets.find((asset) => asset.name === expectedLive);
  if (!exact) {
    fail(`live v${liveVersion} release has no expected .deb asset ${expectedLive}; found ${debAssets.map((asset) => asset.name).join(', ') || '(none)'}`);
  }
  if (!await headOk(exact.browser_download_url)) {
    fail(`live .deb asset URL is not HTTP 200: ${exact.browser_download_url}`);
  }
  console.log(`live v${liveVersion} .deb asset OK: ${exact.name}`);
  console.log(`live url: ${exact.browser_download_url}`);
}

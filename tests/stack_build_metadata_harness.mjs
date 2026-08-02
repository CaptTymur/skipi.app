import fs from 'node:fs';

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const html = fs.readFileSync('dist/index.html', 'utf8');
const rust = fs.readFileSync('src-tauri/src/commands/vault.rs', 'utf8');
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const lock = fs.readFileSync('src-tauri/Cargo.lock', 'utf8');
const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));

console.log('# Stack v1 Stage 4 build metadata contract');
ok(html.includes("component: 'Seafarer'"), 'one UI build-metadata input names Seafarer');
ok(html.includes("component_version: '0.4.183'"), 'build-metadata input carries component version 0.4.183');
ok(html.includes("stack_id: 'SKIPI-2026.08-R1'"), 'build-metadata input carries Stack ID');
ok(html.includes("source_identifier: 'unknown'"), 'source identifier starts honest and is not a candidate SHA literal');
ok(html.includes('function setBuildMetadata(info)'), 'runtime build metadata is accepted through one input function');
ok(html.includes("invoke('get_build_info')"), 'build metadata comes from the exact binary at runtime');
ok(html.includes('Skipi Seafarer · Stack SKIPI-2026.08-R1'), 'main header exposes the exact Stack label without Settings');
ok(html.includes('data-qa="desktop-stack-label">Skipi Seafarer · Stack SKIPI-2026.08-R1</div>'), 'loaded desktop main shell exposes the exact Stack label inline');
ok(html.includes('stackAboutSummary()'), 'Settings About is bound to the build-metadata summary');
ok(html.includes('Stack verification unavailable'), 'UI has the required fail-closed verification label');
ok(!/manifest_(?:sha|digest)\s*:\s*['"][0-9a-f]{64}['"]/i.test(html), 'future manifest digest is not hardcoded');

ok(rust.includes('pub component: String'), 'native build metadata includes component');
ok(rust.includes('pub component_version: String'), 'native build metadata includes component version');
ok(rust.includes('pub stack_id: String'), 'native build metadata includes Stack ID');
ok(rust.includes('pub source_identifier: String'), 'native build metadata includes source identifier');
ok(rust.includes('pub verification_status: String'), 'native build metadata includes honest verification status');

ok(cargo.includes('version = "0.4.183"'), 'Cargo package version is 0.4.183');
ok(lock.includes('name = "skipi"\nversion = "0.4.183"'), 'Cargo lock root package version is 0.4.183');
ok(tauri.version === '0.4.183', 'Tauri component version is 0.4.183');
ok(tauri.identifier === 'app.skipi.desktop', 'desktop app identity is preserved');

console.log(`ALL GREEN: ${passed} Stack build-metadata checks passed`);

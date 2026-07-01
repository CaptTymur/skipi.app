import fs from 'node:fs';

let passed = 0;
function ok(cond, msg){
  if(!cond) throw new Error(msg);
  passed++;
  console.log('  ✓ '+msg);
}
function read(path){ return fs.readFileSync(path, 'utf8'); }

const build = read('src-tauri/build.rs');
const rust = read('src-tauri/src/lib.rs') + '\n' + read('src-tauri/src/commands/vault.rs');
const html = read('dist/index.html');

console.log('# build provenance source contract');
ok(build.includes('SKIPI_BUILD_SHA'), 'build.rs accepts explicit SKIPI_BUILD_SHA');
ok(build.includes('GITHUB_SHA'), 'build.rs falls back to CI GITHUB_SHA');
ok(build.includes('git') && build.includes('rev-parse'), 'build.rs falls back to git rev-parse');
ok(build.includes('cargo:rustc-env=SKIPI_BUILD_SHA'), 'build.rs embeds SKIPI_BUILD_SHA into the binary');

console.log('# Tauri command contract');
ok(rust.includes('get_build_info'), 'get_build_info command exists');
ok(rust.includes('option_env!("SKIPI_BUILD_SHA")'), 'command reads build-time SHA only');
ok(rust.includes('short_sha'), 'command returns a short SHA');
ok(rust.includes('vault::get_build_info'), 'command is registered in Tauri handler');

console.log('# visible UI provenance');
ok(html.includes("invoke('get_build_info')"), 'UI loads build info through Tauri');
ok(html.includes('appVersionLabel'), 'UI has version+SHA label helper');
ok(html.includes('data-qa="app-build-sha"'), 'UI exposes a stable app-build-sha QA hook');

console.log(`ALL GREEN: ${passed} provenance checks passed`);

import fs from 'node:fs';
import vm from 'node:vm';

let passed = 0;
function ok(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const html = fs.readFileSync('dist/index.html', 'utf8');
const match = /function stackVerificationState\(info\)\s*\{[\s\S]*?\n\}/.exec(html);
ok(match, 'fail-closed stackVerificationState helper exists');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(match[0], sandbox, { filename: 'dist/index.html#stackVerificationState' });

console.log('# Stack v1 Stage 4 negative control');
const forged = sandbox.stackVerificationState({
  verification_status: 'verified',
  manifest_digest: 'a'.repeat(64),
  manifest_artifact_sha256: 'b'.repeat(64),
  local_artifact_sha256: 'b'.repeat(64),
});
ok(forged !== 'verified', 'forged future manifest fields cannot produce verified');
ok(forged === 'unavailable', 'unsealed/unimplemented verification remains unavailable');
ok(sandbox.stackVerificationState({ verification_status: 'mismatch' }) === 'mismatch', 'explicit mismatch remains visible');
ok(sandbox.stackVerificationState({}) === 'unavailable', 'missing evidence remains unavailable');

console.log(`NEGATIVE CONTROL PASS: ${passed} fail-closed checks passed`);

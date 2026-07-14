import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const archive = join(root, 'src-tauri', 'resources', 'demo-vault.zip');
let passed = 0;

function ok(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`OK: ${message}`);
}

const inspectScript = String.raw`
import json
import os
import sqlite3
import sys
import tempfile
import zipfile

archive = sys.argv[1]
with zipfile.ZipFile(archive) as bundle:
    database = bundle.read("skipi.db")

handle, path = tempfile.mkstemp(suffix=".db")
try:
    with os.fdopen(handle, "wb") as output:
        output.write(database)
    connection = sqlite3.connect(path)
    try:
        values = dict(connection.execute("SELECT key, value FROM vault_info"))
    finally:
        connection.close()
finally:
    os.unlink(path)

print(json.dumps(values, sort_keys=True))
`;

const inspected = spawnSync('python3', ['-c', inspectScript, archive], {
  encoding: 'utf8',
});

ok(inspected.status === 0, `demo-vault.zip is readable (${inspected.stderr.trim() || 'SQLite OK'})`);

let vaultInfo;
try {
  vaultInfo = JSON.parse(inspected.stdout);
} catch (error) {
  console.error(`FAIL: demo vault metadata is not valid JSON: ${error.message}`);
  process.exit(1);
}

// The demo is a Seafarer vault with synthetic data. `is_demo` controls demo-only
// behavior; account_type must remain `seafarer` so the normal Seafarer modules
// are not hidden by loadVault().
ok(vaultInfo.account_type === 'seafarer', 'demo vault uses the Seafarer account type');
ok(vaultInfo.is_demo === '1', 'demo marker remains enabled');
ok(vaultInfo.name === 'Demo Seafarer', 'demo identity remains synthetic');
ok(vaultInfo.personal_first_name === 'Demo', 'demo first name remains synthetic');
ok(vaultInfo.personal_surname === 'Seafarer', 'demo surname remains synthetic');
ok(vaultInfo.personal_email === 'demo@example.com', 'demo email remains synthetic');

const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
const helperMatch = html.match(/function isSeafarerVault\(\)\s*\{[\s\S]*?\n\}/);
ok(Boolean(helperMatch), 'Seafarer account-type helper is present');

const context = vm.createContext({ currentAccountType: '' });
vm.runInContext(helperMatch[0], context);
for (const accountType of ['seafarer', '', null]) {
  context.currentAccountType = accountType;
  ok(context.isSeafarerVault() === true, `account type ${String(accountType)} gets the Seafarer surface`);
}
context.currentAccountType = 'demo';
ok(context.isSeafarerVault() === false, 'legacy demo type must be normalized before frontend routing');
context.currentAccountType = 'crewing';
ok(context.isSeafarerVault() === false, 'non-Seafarer account type stays outside the Seafarer surface');

const helperUses = html.match(/var isSeafarer=isSeafarerVault\(\);/g) || [];
ok(helperUses.length === 2, 'module visibility and view routing share the account-type helper');
ok(!/currentAccountType===['"]seafarer['"]/.test(html.replace(helperMatch[0], '')), 'no duplicate Seafarer account-type checks can drift');

console.log(`demo-vault contract: ${passed} passed, 0 failed`);

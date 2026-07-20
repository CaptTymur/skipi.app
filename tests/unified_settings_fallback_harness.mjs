// Unified Settings fail-closed fallback + honest export/import adapter contract.
//
// Two defects found by the 20.07 cross-model review (Claude + Codex, both
// reproduced dynamically) are pinned here failing-first:
//
//   1. Recursive fallback. The integration script reroutes the bare
//      openSettings() entry to openUnifiedSettings(). Both fail branches
//      (module missing / mount throw) called the bare openSettings() again,
//      so the "fallback" recursed into itself forever (stack exhaustion /
//      endless async mount loop) and the legacy screen never opened.
//      Contract: each fail branch opens the LEGACY screen exactly once via
//      window._legacyOpenSettings(); if that is unavailable, one toast and
//      stop — never re-enter the unified shell.
//
//   2. False success from export/import adapters. The host adapter delegated
//      to legacy exportVaultBackup()/importVaultBackup(), which ALWAYS
//      resolve undefined — on dialog cancel and on error alike (catch ->
//      toast). The vendored module (dist/skipi-settings.js runBusy) shows the
//      "exported"/"imported" success notice on ANY fulfilled promise, so the
//      user saw success without any operation. Contract (module cancelledError
//      + runBusy reject handling): cancel of any step -> reject with
//      error.skipiSettingsCancelled === true (module stays silent); failure ->
//      reject (module shows the error notice); success -> resolve, and import
//      success must still actually open the imported vault (loadVault) with
//      no success signal of the adapter's own.
//
// The harness executes the REAL code from dist/index.html: the legacy backup
// functions and the whole unified-settings integration script run unmodified
// in a VM with stubbed primitives (saveDlg/open/uiPrompt/uiConfirm/invoke/
// showToast/loadVault), the same simulation style as the sibling harnesses.
// A depth limiter on window.openUnifiedSettings bounds the defect-1 recursion
// so the RED run terminates deterministically instead of blowing the stack.
//
//   node tests/unified_settings_fallback_harness.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');

const DEPTH_LIMIT = 25;

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
}

function section(title) {
  console.log('\n# ' + title);
}

// ---- Extract real code from dist/index.html ----

// Whole unified-settings integration script (the adoption block near </body>).
function extractUnifiedScript() {
  const m = /<!--\s*Unified Settings adoption[\s\S]*?-->\s*<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('unified-settings integration <script> not found in dist/index.html');
  return m[1];
}

// One top-level function by header, brace-counted to its closing brace.
function extractFunction(header) {
  const start = html.indexOf(header);
  if (start < 0) throw new Error('function not found in dist/index.html: ' + header);
  const openBrace = html.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting: ' + header);
}

const unifiedScript = extractUnifiedScript();
const legacyFragment = [
  extractFunction('function esc(s)'),
  extractFunction('function cleanVaultFolderPart(value,fallback)'),
  extractFunction('function joinFolderPath(base,child)'),
  extractFunction('function backupTimestamp()'),
  extractFunction('async function exportVaultBackup()'),
  extractFunction('async function importVaultBackup()'),
].join('\n');

// ---- Sandbox ----

function makeOverlayElement(id) {
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

function makeSandbox({ module = null, withLegacy = true, invokeHandlers = {}, dialogs = {} } = {}) {
  const state = {
    legacyCalls: [],       // args of every _legacyOpenSettings (original openSettings) call
    unifiedCalls: 0,       // window.openUnifiedSettings entries (depth limiter)
    mountCalls: 0,
    toasts: [],            // { msg, type }
    invokes: [],           // { cmd, args }
    loadVaultCalls: [],    // { info, overlayOpenAtCall }
    closeSettingsCalls: 0,
    host: null,
  };

  const overlayEl = makeOverlayElement('skipi-settings-overlay');
  const rootEl = makeOverlayElement('settings-root');

  const invoke = (cmd, args) => {
    state.invokes.push({ cmd, args });
    if (Object.prototype.hasOwnProperty.call(invokeHandlers, cmd)) {
      try {
        return Promise.resolve(invokeHandlers[cmd](args));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (cmd === 'get_seafarer_personal' || cmd === 'get_my_identity') return Promise.resolve({});
    if (cmd === 'get_current_vault_path') return Promise.resolve('/vaults/TestVault');
    return Promise.resolve({});
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => (id === 'skipi-settings-overlay' ? overlayEl : id === 'settings-root' ? rootEl : null),
      addEventListener() {},
      documentElement: { getAttribute: () => 'light', setAttribute() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // primitives shared by legacy flows and (post-fix) unified adapters
    invoke,
    saveDlg: dialogs.saveDlg,
    open: dialogs.open,
    uiPrompt: dialogs.uiPrompt || (() => Promise.resolve(null)),
    uiConfirm: dialogs.uiConfirm || (() => Promise.resolve(false)),
    showToast: (msg, type) => state.toasts.push({ msg: String(msg), type: String(type || '') }),
    logError() {},
    loadVault: (info) => {
      state.loadVaultCalls.push({ info, overlayOpenAtCall: overlayEl.classList.contains('open') });
      return Promise.resolve();
    },
    closeSettings: () => { state.closeSettingsCalls++; },
    // i18n / host metadata used by buildHost()
    tr: (k) => String(k),
    getUiLang: () => 'en',
    setUiLang() {},
    UI_LANG_OPTIONS: [['en', 'English'], ['ru', 'Русский']],
    appVersionLabel: () => '0.0.0-harness',
    applyAppearance() {},
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  if (withLegacy) {
    // Stand-in for the legacy top-level openSettings() as it exists BEFORE the
    // integration script reroutes it (the boundary the fallback must reach).
    sandbox.openSettings = function (...args) { state.legacyCalls.push(args); };
  }
  if (module) sandbox.SkipiSettings = module(state);

  vm.createContext(sandbox);
  vm.runInContext(legacyFragment, sandbox, { filename: 'dist/index.html#legacy-backup-fns' });
  vm.runInContext(unifiedScript, sandbox, { filename: 'dist/index.html#unified-settings' });

  // Depth limiter: every unified-shell entry (including the defective
  // fallback's re-entry through the rerouted bare openSettings) passes through
  // window.openUnifiedSettings. Bound it so the RED recursion terminates.
  const realOpenUnified = sandbox.openUnifiedSettings;
  sandbox.openUnifiedSettings = function (...args) {
    state.unifiedCalls++;
    if (state.unifiedCalls > DEPTH_LIMIT) return undefined;
    return realOpenUnified.apply(this, args);
  };

  return { sandbox, state, overlayEl };
}

async function settle(ticks = 400) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

async function outcome(promise) {
  try {
    const value = await promise;
    return { fulfilled: true, value };
  } catch (error) {
    return { fulfilled: false, error };
  }
}

const captureHostModule = (state) => ({
  mount(_sel, host) {
    state.mountCalls++;
    state.host = host;
    return { unmount() {}, ready: Promise.resolve() };
  },
});

// ---- (a) module load failure -> legacy exactly once, no recursion ----

async function assertModuleLoadFailFallsBackOnce() {
  section('module load failure: legacy opens exactly once, no recursion');
  const { sandbox, state } = makeSandbox({ module: null, withLegacy: true });
  sandbox.openSettings(); // the real gear entry point (rerouted by the integration script)
  await settle();
  ok(state.unifiedCalls === 1, `unified shell entered exactly once (got ${state.unifiedCalls}; >1 = fallback recursed into itself)`);
  ok(state.legacyCalls.length === 1, `legacy settings opened exactly once via _legacyOpenSettings (got ${state.legacyCalls.length})`);
  ok(state.toasts.length === 1, `exactly one failure toast (got ${state.toasts.length})`);
  ok(state.toasts.every((t) => t.type === 'error'), 'the failure toast is an error toast, not success');
}

async function assertModuleLoadFailWithoutLegacyIsFailClosed() {
  section('module load failure, no legacy available: one toast, no retry');
  const { sandbox, state } = makeSandbox({ module: null, withLegacy: false });
  sandbox.openUnifiedSettings();
  await settle();
  ok(state.unifiedCalls === 1, `unified shell entered exactly once (got ${state.unifiedCalls})`);
  ok(state.toasts.length === 1, `exactly one toast when no legacy fallback exists (got ${state.toasts.length})`);
}

// ---- (b) mount throw -> legacy once, no repeated mount cycles ----

async function assertMountThrowFallsBackOnce() {
  section('mount throw: legacy opens once, no repeated mount cycles');
  const { sandbox, state, overlayEl } = makeSandbox({
    withLegacy: true,
    module: (state) => ({
      mount() {
        state.mountCalls++;
        throw new Error('mount boom');
      },
    }),
  });
  sandbox.openSettings();
  await settle();
  ok(state.mountCalls === 1, `mount attempted exactly once (got ${state.mountCalls}; >1 = endless async mount loop)`);
  ok(state.legacyCalls.length === 1, `legacy settings opened exactly once after mount failure (got ${state.legacyCalls.length})`);
  ok(!overlayEl.classList.contains('open'), 'unified overlay is closed after mount failure');
}

// ---- (c) export adapter: cancel / error / success ----

async function assertExportContract() {
  section('export adapter: cancel -> silent cancelled reject, error -> reject, success -> resolve');

  // cancel: user dismisses the save dialog
  {
    const { sandbox, state } = makeSandbox({
      module: captureHostModule,
      dialogs: { saveDlg: () => Promise.resolve(null) },
    });
    sandbox.openSettings();
    await settle();
    ok(!!(state.host && typeof state.host.exportVaultBackup === 'function'), 'host adapter captured with exportVaultBackup');
    const res = await outcome(state.host.exportVaultBackup());
    ok(!res.fulfilled, 'cancelled export does NOT fulfill (fulfilled = module shows false "exported" notice)');
    ok(!!(res.error && res.error.skipiSettingsCancelled === true), 'cancelled export rejects with skipiSettingsCancelled marker (module stays silent)');
    ok(!state.invokes.some((i) => i.cmd === 'export_vault_backup'), 'no export_vault_backup invoke after cancel');
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, 'no success toast on cancel');
  }

  // error: backend export fails
  {
    const { sandbox, state } = makeSandbox({
      module: captureHostModule,
      dialogs: { saveDlg: () => Promise.resolve('/tmp/TestVault backup.zip') },
      invokeHandlers: { export_vault_backup: () => { throw new Error('disk full'); } },
    });
    sandbox.openSettings();
    await settle();
    const res = await outcome(state.host.exportVaultBackup());
    ok(!res.fulfilled, 'failed export does NOT fulfill (fulfilled = module shows false success)');
    ok(!!(res.error && !res.error.skipiSettingsCancelled), 'failed export rejects WITHOUT the cancelled marker (module shows the error notice)');
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, 'no success toast on failure');
  }

  // success: real export completes
  {
    const { sandbox, state } = makeSandbox({
      module: captureHostModule,
      dialogs: { saveDlg: () => Promise.resolve('/tmp/TestVault backup.zip') },
      invokeHandlers: { export_vault_backup: (args) => ({ bytes: 1048576, outputPath: args && args.outputPath }) },
    });
    sandbox.openSettings();
    await settle();
    const res = await outcome(state.host.exportVaultBackup());
    ok(res.fulfilled, 'successful export fulfills');
    const call = state.invokes.find((i) => i.cmd === 'export_vault_backup');
    ok(!!(call && call.args && call.args.outputPath === '/tmp/TestVault backup.zip'), 'export_vault_backup invoked with the chosen destination');
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, 'adapter emits no success toast of its own (success notice is the module’s job)');
  }
}

// ---- (d) import adapter: every cancel step, error, success parity ----

function importDialogs({ zip = '/tmp/TestVault backup 2026.zip', parent = '/home/user/vaults', folder = 'Restored vault', confirm = true } = {}) {
  return {
    open: (opts) => Promise.resolve(opts && opts.directory ? parent : zip),
    uiPrompt: () => Promise.resolve(folder),
    uiConfirm: () => Promise.resolve(confirm),
  };
}

async function assertImportContract() {
  section('import adapter: each cancel step silent, error -> reject, success -> vault actually opens');

  const cancelSteps = [
    ['zip picker dismissed', importDialogs({ zip: null })],
    ['parent folder picker dismissed', importDialogs({ parent: null })],
    ['folder name prompt dismissed', importDialogs({ folder: null })],
    ['final confirm declined', importDialogs({ confirm: false })],
  ];
  for (const [label, dialogs] of cancelSteps) {
    const { sandbox, state } = makeSandbox({ module: captureHostModule, dialogs });
    sandbox.openSettings();
    await settle();
    const res = await outcome(state.host.importVaultBackup());
    ok(!res.fulfilled && !!(res.error && res.error.skipiSettingsCancelled === true),
      `cancel (${label}) rejects with skipiSettingsCancelled marker (got ${res.fulfilled ? 'fulfilled = false "imported" notice' : 'reject, marker=' + !!(res.error && res.error.skipiSettingsCancelled)})`);
    ok(!state.invokes.some((i) => i.cmd === 'import_vault_backup'), `cancel (${label}): no import_vault_backup invoke`);
    ok(state.loadVaultCalls.length === 0, `cancel (${label}): no vault load`);
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, `cancel (${label}): no success toast`);
  }

  // error: backend import fails
  {
    const { sandbox, state } = makeSandbox({
      module: captureHostModule,
      dialogs: importDialogs(),
      invokeHandlers: { import_vault_backup: () => { throw new Error('bad zip'); } },
    });
    sandbox.openSettings();
    await settle();
    const res = await outcome(state.host.importVaultBackup());
    ok(!res.fulfilled, 'failed import does NOT fulfill (fulfilled = module shows false "imported" notice)');
    ok(!!(res.error && !res.error.skipiSettingsCancelled), 'failed import rejects WITHOUT the cancelled marker');
    ok(state.loadVaultCalls.length === 0, 'failed import does not open a vault');
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, 'no success toast on failure');
  }

  // success: import completes AND the vault actually opens (legacy parity)
  {
    const info = { path: '/home/user/vaults/Restored vault' };
    const { sandbox, state } = makeSandbox({
      module: captureHostModule,
      dialogs: importDialogs(),
      invokeHandlers: { import_vault_backup: () => info },
    });
    sandbox.openSettings();
    await settle();
    const res = await outcome(state.host.importVaultBackup());
    ok(res.fulfilled, 'successful import fulfills');
    const call = state.invokes.find((i) => i.cmd === 'import_vault_backup');
    ok(!!(call && call.args && call.args.zipPath && call.args.targetPath), 'import_vault_backup invoked with zipPath + targetPath');
    ok(state.loadVaultCalls.length === 1 && state.loadVaultCalls[0].info === info, 'imported vault is actually opened (loadVault(info))');
    ok(state.loadVaultCalls[0].overlayOpenAtCall === false, 'unified overlay is closed before loadVault (module success notice honestly suppressed)');
    ok(state.toasts.filter((t) => t.type === 'success').length === 0, 'adapter emits no success toast of its own');
  }
}

await assertModuleLoadFailFallsBackOnce();
await assertModuleLoadFailWithoutLegacyIsFailClosed();
await assertMountThrowFallsBackOnce();
await assertExportContract();
await assertImportContract();

console.log('');
if (fail > 0) {
  console.error(`FAILURES: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

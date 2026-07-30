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
//   3. Android system Back backgrounds the whole app instead of closing the
//      open unified overlay (28.07 real-tap smoke on v0.4.179). The generated
//      WryActivity maps hardware Back to WebView history: canGoBack()=false ->
//      onBackPressed() -> app is backgrounded. Contract: opening the overlay
//      pushes exactly ONE history marker entry (history.pushState); popping it
//      (system Back -> popstate) closes the overlay through the SAME standard
//      close path as Escape/backdrop; every other close path (Escape, backdrop,
//      module close button) consumes the marker via one history.back() so
//      phantom entries never accumulate; stray popstate events without the
//      marker are a no-op (app navigation untouched).
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const historicalPhotoRef = process.env.SKIPI_PHOTO_HARNESS_REF || '';
const html = historicalPhotoRef
  ? execFileSync('git', ['show', `${historicalPhotoRef}:dist/index.html`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  : fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');

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
  const el = {
    id,
    innerHTML: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    // Minimal '#id' lookup over the element's current innerHTML string — enough
    // for the embed side-effect's "is the form committed to the DOM yet?" probe.
    querySelector: (sel) => {
      const m = /^#([A-Za-z0-9_-]+)$/.exec(String(sel || ''));
      if (!m) return null;
      return el.innerHTML.indexOf('id="' + m[1] + '"') !== -1 ? { id: m[1] } : null;
    },
  };
  return el;
}

function makeSandbox({ module = null, withLegacy = true, invokeHandlers = {}, dialogs = {}, queuedTimers = false, extraElements = null } = {}) {
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

  // Captured event listeners (window + document) so tests can dispatch
  // popstate / keydown into the real handlers registered by the script.
  const winListeners = {};
  const docListeners = {};
  const listenInto = (map) => (type, fn) => { (map[type] = map[type] || []).push(fn); };
  const dispatchInto = (map) => (type, ev) => { for (const fn of map[type] || []) fn(ev || {}); };

  // History stub with an honest depth counter: pushState pushes, back() pops
  // and (like a real browser) fires popstate synchronously into the window
  // listeners — the strictest re-entrancy check for the close path.
  const historyCalls = { pushes: [], backs: 0 };
  let historyDepth = 0;
  const historyStub = {
    pushState: (st) => { historyCalls.pushes.push({ state: st }); historyDepth++; },
    back: () => {
      historyCalls.backs++;
      if (historyDepth > 0) historyDepth--;
      dispatchInto(winListeners)('popstate', { state: null });
    },
  };

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

  // Queued timers (opt-in): the embed side-effect schedules its DOM-commit wait
  // through setTimeout; queuing lets a test commit the rendered markup first
  // and then flush the loop deterministically. Default stays synchronous.
  const timerQueue = [];
  let timerSeq = 1;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => {
        if (extraElements && Object.prototype.hasOwnProperty.call(extraElements, id)) return extraElements[id];
        return id === 'skipi-settings-overlay' ? overlayEl : id === 'settings-root' ? rootEl : null;
      },
      addEventListener: listenInto(docListeners),
      documentElement: { getAttribute: () => 'light', setAttribute() {} },
    },
    addEventListener: listenInto(winListeners),
    removeEventListener() {},
    history: historyStub,
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
    setTimeout: queuedTimers
      ? (fn) => { const id = timerSeq++; timerQueue.push({ id, fn }); return id; }
      : (fn) => { fn(); return 0; },
    clearTimeout: queuedTimers
      ? (id) => { const i = timerQueue.findIndex((t) => t.id === id); if (i >= 0) timerQueue.splice(i, 1); }
      : () => {},
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

  return {
    sandbox,
    state,
    overlayEl,
    rootEl,
    // Run queued timer callbacks (including ones they re-schedule) to quiescence.
    flushTimers: (cap = 500) => {
      let n = 0;
      while (timerQueue.length && n < cap) { const t = timerQueue.shift(); n++; t.fn(); }
      return n;
    },
    history: historyCalls,
    historyDepth: () => historyDepth,
    dispatchWindow: dispatchInto(winListeners),
    dispatchDocument: dispatchInto(docListeners),
    // Simulate the user pressing system Back: the WebView pops the top history
    // entry itself and fires popstate (it does NOT go through history.back()).
    systemBack: () => {
      if (historyDepth > 0) historyDepth--;
      dispatchInto(winListeners)('popstate', { state: null });
    },
  };
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

// ---- (e) system Back (popstate): marker pushed on open, popstate closes overlay ----

const unmountTrackingModule = (state) => ({
  mount(_sel, host) {
    state.mountCalls++;
    state.host = host;
    return { unmount() { state.unmounts = (state.unmounts || 0) + 1; }, ready: Promise.resolve() };
  },
});

async function assertSystemBackClosesOverlay() {
  section('system Back: open pushes ONE history marker, popstate closes the overlay');
  const sb = makeSandbox({ module: unmountTrackingModule });
  const { sandbox, state, overlayEl } = sb;

  sandbox.openSettings(); // real gear entry, rerouted to the unified shell
  await settle();
  ok(overlayEl.classList.contains('open'), 'unified overlay is open');
  ok(sb.history.pushes.length === 1, `exactly one history entry pushed on open (got ${sb.history.pushes.length}; 0 = system Back backgrounds the whole app)`);
  ok(!!(sb.history.pushes[0] && sb.history.pushes[0].state && sb.history.pushes[0].state.skipiUnifiedSettings === true),
    'pushed entry carries the unified-settings marker state');
  ok(sb.historyDepth() === 1, `history depth is 1 while the overlay is open (got ${sb.historyDepth()})`);

  // System Back: WebView pops the marker entry itself, then fires popstate.
  sb.systemBack();
  await settle();
  ok(!overlayEl.classList.contains('open'), 'popstate closes the unified overlay');
  ok((state.unmounts || 0) === 1, `overlay closed through the standard close path — instance unmounted (got ${state.unmounts || 0})`);
  ok(sb.history.backs === 0, `close-from-popstate does NOT call history.back() again (got ${sb.history.backs}; >0 = eats a real app history entry)`);
  ok(sb.historyDepth() === 0, 'no phantom history entries remain after system Back close');

  // Stray popstate without our marker must be a no-op (app navigation untouched).
  sb.dispatchWindow('popstate', { state: null });
  await settle();
  ok(!overlayEl.classList.contains('open') && sb.history.backs === 0 && (state.unmounts || 0) === 1,
    'stray popstate after close is a no-op (no extra back()/unmount)');

  // Re-open pushes a fresh marker; double-open while open does not stack markers.
  sandbox.openSettings();
  await settle();
  ok(overlayEl.classList.contains('open') && sb.history.pushes.length === 2,
    `re-open pushes a fresh marker (got ${sb.history.pushes.length} total pushes)`);
  sandbox.openSettings();
  await settle();
  ok(sb.history.pushes.length === 2 && sb.historyDepth() === 1,
    `double open does not stack markers (pushes=${sb.history.pushes.length}, depth=${sb.historyDepth()})`);

  // Programmatic close (module close button via onClose) consumes the marker.
  const unmountsBefore = state.unmounts || 0;
  sandbox.closeUnifiedSettings();
  await settle();
  ok(!overlayEl.classList.contains('open'), 'programmatic close closes the overlay');
  ok(sb.history.backs === 1, `programmatic close consumes the marker via exactly one history.back() (got ${sb.history.backs})`);
  ok(sb.historyDepth() === 0, 'history depth back to 0 after close (no accumulated entries)');
  ok((state.unmounts || 0) === unmountsBefore + 1,
    `popstate echo from history.back() does not double-close (unmounts ${unmountsBefore}->${state.unmounts || 0})`);
}

// ---- (f) Escape / backdrop close paths remain and consume the marker ----

async function assertEscapeAndBackdropCloseRemain() {
  section('Escape / backdrop close paths remain and consume the history marker');
  const sb = makeSandbox({ module: captureHostModule });
  const { sandbox, overlayEl } = sb;
  sandbox.openSettings();
  await settle();
  ok(overlayEl.classList.contains('open'), 'overlay open before Escape');
  sb.dispatchDocument('keydown', { key: 'Escape' });
  await settle();
  ok(!overlayEl.classList.contains('open'), 'Escape still closes the unified overlay');
  ok(sb.history.backs === 1, `Escape close consumes the history marker via one history.back() (got ${sb.history.backs})`);
  ok(sb.historyDepth() === 0, 'no phantom history entry left after Escape close');

  // Backdrop click-to-close is static markup outside the extracted script —
  // semantic presence check on the real dist/index.html.
  ok(/id="skipi-settings-overlay"[^>]*onclick="if\(event\.target===this\)closeUnifiedSettings\(\);"/.test(html),
    'backdrop click-to-close handler still present on the overlay element');
}

// ---- (g)+(h) seafarer section: FULL profile editor embedded (OWNER PRODUCT-GO 2026-07-29) ----
//
// The unified 'seafarer-profile' section must render the complete existing
// profile editor directly (same markup as the legacy screen, via the shared
// seafarerProfileFormHtml builder) instead of a 4-row summary with an
// "Open full seafarer profile" hand-off button, and openSettings('seafarer')
// deep-links must land in the unified shell, not the legacy editor.

const escapeHtmlStub = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Module stub that emulates the real draw() contract for app-specific sections:
// renderHtml(ctx) is called synchronously and its string return is the DOM markup.
const renderingModule = (state) => ({
  mount(_sel, host, opts) {
    state.mountCalls++;
    state.host = host;
    state.mountOptions = opts || {};
    const sections = (host && host.appSpecificSections) || [];
    const sec = sections.find((s) => s && s.id === 'seafarer-profile') || null;
    state.section = sec;
    if (sec) {
      state.renderedHtml = String(sec.renderHtml({
        language: 'en', theme: 'light', mode: 'desktop',
        escapeHtml: escapeHtmlStub, escapeAttr: escapeHtmlStub,
      }));
    }
    return { unmount() {}, ready: Promise.resolve() };
  },
});

function extractSeafarerFormFns() {
  return [
    extractFunction('function spField(id,label,type)'),
    extractFunction('function seafarerProfileFormHtml()'),
  ].join('\n');
}

async function assertSeafarerSectionEmbedsFullEditor() {
  section('seafarer section: renderHtml IS the full profile editor, summary hop removed');
  let formFns = null;
  try { formFns = extractSeafarerFormFns(); } catch (e) { /* pre-fix dist: builder absent */ }
  ok(!!formFns, 'shared form builder seafarerProfileFormHtml (+spField) present in dist/index.html');

  // A stale LEGACY seafarer form (same sp-* ids, earlier in the document) —
  // closeSettings() never clears #settings-body, only drops the .open class.
  const legacyBody = makeOverlayElement('settings-body');
  legacyBody.innerHTML = '<div class="settings-section"><input id="sp-surname"><div id="sp-photo-box"></div></div>';
  const legacyOverlay = makeOverlayElement('settings-overlay'); // closed: no .open class

  const sb = makeSandbox({
    module: renderingModule,
    queuedTimers: true,
    extraElements: { 'settings-body': legacyBody, 'settings-overlay': legacyOverlay },
  });
  const { sandbox, state, rootEl } = sb;
  if (formFns) vm.runInContext(formFns, sandbox, { filename: 'dist/index.html#seafarer-form-fns' });
  const spLoadCalls = [];
  sandbox.spLoad = () => { spLoadCalls.push(1); };

  sandbox.openSettings(); // bare gear entry -> unified shell
  await settle();
  ok(state.mountCalls === 1, `unified shell mounted (got ${state.mountCalls})`);
  const htmlOut = String(state.renderedHtml || '');
  for (const marker of ['id="sp-photo-box"', 'id="sp-surname"', 'id="sp-rank"', 'id="sp-nearest_airport"', 'id="sp-min_salary"', 'onclick="spSave()"']) {
    ok(htmlOut.indexOf(marker) !== -1, `renderHtml contains full-editor marker ${marker}`);
  }
  ok(htmlOut.indexOf('data-settings-action="open-seafarer-editor"') === -1,
    'NEGATIVE: renderHtml has NO open-seafarer-editor hand-off button');
  ok(htmlOut.indexOf('Open full seafarer profile') === -1,
    'NEGATIVE: renderHtml has NO "Open full seafarer profile" text');

  // Population side effect: only after the markup is committed to the DOM may
  // the scheduled loop clear the stale legacy sp-* copy and call spLoad().
  ok(spLoadCalls.length === 0, 'spLoad NOT called before the form reaches the DOM');
  rootEl.innerHTML = htmlOut; // the real module assigns renderHtml -> innerHTML itself
  const ran = sb.flushTimers();
  ok(ran > 0, `renderHtml scheduled a DOM-commit wait loop (flushed ${ran} timer callbacks)`);
  ok(spLoadCalls.length === 1, `spLoad() called exactly once after the form reached the DOM (got ${spLoadCalls.length})`);
  ok(legacyBody.innerHTML === '', 'stale legacy seafarer form (duplicate sp-* ids earlier in the document) cleared before spLoad');
}

async function assertSeafarerDeepLinkRoutesUnified() {
  section("deep-link: openSettings('seafarer') opens the unified seafarer-profile section, not the legacy editor");
  let formFns = null;
  try { formFns = extractSeafarerFormFns(); } catch (e) {}

  const sb = makeSandbox({ module: renderingModule, queuedTimers: true });
  const { sandbox, state, overlayEl } = sb;
  if (formFns) vm.runInContext(formFns, sandbox, { filename: 'dist/index.html#seafarer-form-fns' });
  sandbox.spLoad = () => {};

  sandbox.openSettings('seafarer');
  await settle();
  ok(state.legacyCalls.length === 0, `legacy editor NOT called for the seafarer deep-link (got ${state.legacyCalls.length} legacy calls)`);
  ok(state.mountCalls === 1, `unified shell mounted for the deep-link (got ${state.mountCalls})`);
  ok(overlayEl.classList.contains('open'), 'unified overlay is open');
  ok(!!(state.mountOptions && state.mountOptions.initialSection === 'seafarer-profile'),
    `mount lands on the seafarer-profile section via initialSection (got ${state.mountOptions && state.mountOptions.initialSection})`);
  ok(!!(state.mountOptions && state.mountOptions.mobileInitialView === 'section'),
    'mobile widths land on the section page, not the list (mobileInitialView=section)');

  // Other deep-links stay legacy; the bare entry stays unified without a pinned section.
  sandbox.openSettings('email');
  await settle();
  ok(state.legacyCalls.length === 1 && state.legacyCalls[0][0] === 'email',
    `openSettings('email') still routes to the legacy editor (got ${JSON.stringify(state.legacyCalls)})`);
  sandbox.openSettings();
  await settle();
  ok(state.mountCalls === 2 && !(state.mountOptions && state.mountOptions.initialSection),
    'bare openSettings() still mounts unified WITHOUT a pinned initial section');

  // Non-seafarer vault: the legacy guard (redirect to General) must keep working.
  const sb2 = makeSandbox({ module: renderingModule, queuedTimers: true });
  if (formFns) vm.runInContext(formFns, sb2.sandbox, { filename: 'dist/index.html#seafarer-form-fns' });
  sb2.sandbox.spLoad = () => {};
  sb2.sandbox.isSeafarerVault = () => false;
  sb2.sandbox.openSettings('seafarer');
  await settle();
  ok(sb2.state.mountCalls === 0 && sb2.state.legacyCalls.length === 1,
    'non-seafarer vault: seafarer deep-link falls through to the legacy guard path');
}

// ---- (i) photo replacement preserves unsaved seafarer fields ----
//
// Both desktop and mobile upload paths used to call spLoad() after writing the
// photo. That re-populated the complete form from saved vault bytes and erased
// any edits the user had not saved yet. Exercise the real upload functions and
// model the destructive spLoad side effect with three unsaved fields.

function extractSeafarerPhotoUploadFns() {
  const fragments = [];
  if (html.indexOf('async function spLoadPhoto()') !== -1) {
    fragments.push(extractFunction('async function spLoadPhoto()'));
  }
  fragments.push(extractFunction('function spUploadPhotoMobile()'));
  fragments.push(extractFunction('async function spUploadPhoto()'));
  return fragments.join('\n');
}

const unsavedPhotoDraft = {
  'sp-surname': 'Draft-Surname-UNSAVED',
  'sp-email': 'draft-unsaved@example.test',
  'sp-nearest_airport': 'Draft Airport UNSAVED',
};

function makeSeafarerPhotoSandbox(mobile) {
  const stored = {
    'sp-surname': 'Stored-Surname',
    'sp-email': 'stored@example.test',
    'sp-nearest_airport': 'Stored Airport',
  };
  const elements = Object.fromEntries(
    Object.entries(unsavedPhotoDraft).map(([id, value]) => [id, { id, value }]),
  );
  elements['sp-photo-box'] = { id: 'sp-photo-box', innerHTML: 'Old photo' };
  const state = { invokes: [], reloads: 0, input: null };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => {
        if (tag !== 'input') throw new Error(`unexpected createElement(${tag})`);
        const input = { files: [], style: {}, parentNode: null, click() {} };
        state.input = input;
        return input;
      },
      body: {
        appendChild: (node) => {
          node.parentNode = { removeChild: () => { node.parentNode = null; } };
        },
      },
    },
    invoke: async (command, args) => {
      state.invokes.push({ command, args });
      if (command === 'get_profile_photo_data_url') {
        return 'data:image/png;base64,NEW_PHOTO_BYTES';
      }
      return {};
    },
    open: async () => '/tmp/new-profile-photo.png',
    isMobileMode: () => mobile,
    hostPlatform: mobile ? 'android' : 'linux',
    mobileReadFileAsBase64: async () => 'TkVXX1BIT1RPX0JZVEVT',
    showToast() {},
    logError() {},
    spLoad: async () => {
      state.reloads++;
      for (const [id, value] of Object.entries(stored)) elements[id].value = value;
      elements['sp-photo-box'].innerHTML = '<img src="data:image/png;base64,NEW_PHOTO_BYTES">';
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractSeafarerPhotoUploadFns(), sandbox, {
    filename: 'dist/index.html#seafarer-photo-upload',
  });
  return { sandbox, state, elements };
}

function assertUnsavedPhotoDraft(elements, platform) {
  for (const [id, value] of Object.entries(unsavedPhotoDraft)) {
    ok(elements[id].value === value,
      `${platform}: unsaved ${id} survives photo replacement (got ${JSON.stringify(elements[id].value)})`);
  }
}

async function assertPhotoUploadPreservesUnsavedFields() {
  section('seafarer photo upload: desktop + mobile preserve three unsaved fields');

  const desktop = makeSeafarerPhotoSandbox(false);
  await desktop.sandbox.spUploadPhoto();
  ok(desktop.state.invokes.some((entry) => entry.command === 'upload_profile_photo'),
    'desktop keeps the existing upload_profile_photo command');
  ok(desktop.state.reloads === 0,
    `desktop does not reload the complete profile after upload (got ${desktop.state.reloads})`);
  ok(desktop.state.invokes.some((entry) => entry.command === 'get_profile_photo_data_url'),
    'desktop refreshes only the photo preview from the vault');
  ok(desktop.elements['sp-photo-box'].innerHTML.indexOf('NEW_PHOTO_BYTES') !== -1,
    'desktop displays the replacement photo');
  assertUnsavedPhotoDraft(desktop.elements, 'desktop');

  const mobile = makeSeafarerPhotoSandbox(true);
  mobile.sandbox.spUploadPhotoMobile();
  mobile.state.input.files = [{ name: 'mobile-photo.png', size: 1024 }];
  await mobile.state.input.onchange();
  ok(mobile.state.invokes.some((entry) => entry.command === 'upload_profile_photo_bytes'),
    'mobile keeps the existing upload_profile_photo_bytes command');
  ok(mobile.state.reloads === 0,
    `mobile does not reload the complete profile after upload (got ${mobile.state.reloads})`);
  ok(mobile.state.invokes.some((entry) => entry.command === 'get_profile_photo_data_url'),
    'mobile refreshes only the photo preview from the vault');
  ok(mobile.elements['sp-photo-box'].innerHTML.indexOf('NEW_PHOTO_BYTES') !== -1,
    'mobile displays the replacement photo');
  assertUnsavedPhotoDraft(mobile.elements, 'mobile');
}

await assertModuleLoadFailFallsBackOnce();
await assertModuleLoadFailWithoutLegacyIsFailClosed();
await assertMountThrowFallsBackOnce();
await assertExportContract();
await assertImportContract();
await assertSystemBackClosesOverlay();
await assertEscapeAndBackdropCloseRemain();
await assertSeafarerSectionEmbedsFullEditor();
await assertSeafarerDeepLinkRoutesUnified();
await assertPhotoUploadPreservesUnsavedFields();

console.log('');
if (fail > 0) {
  console.error(`FAILURES: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, ${fail} failed`);

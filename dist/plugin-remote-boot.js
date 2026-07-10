/* Remote plugin delivery — boot/wiring (Seafarer), behind FEATURE_REMOTE_PLUGIN_DELIVERY.
   ---------------------------------------------------------------------------------------
   KILL SWITCH: if the flag is OFF, this file does NOTHING — no runtime, no
   catalog fetch, no patching. Seafarer is byte-identical to today.

   When ON: creates the isolated remote runtime (SkipiPluginRuntime, sandboxed strict-CSP
   iframe — no host DOM, no network, no host CSP change) and routes the configured remote
   slugs (e.g. bnwas-time-anchor) through it, instead of the bundled mount path. All other
   plugins/screens are untouched. Fail-closed UI on any verification/transport failure.

   Production catalog uses first-party signed packs selected by catalog.keyId. */
(function () {
  'use strict';

  // ---- KILL SWITCH ----
  if (!window.FEATURE_REMOTE_PLUGIN_DELIVERY) return;

  // ---- dependency guard (fail-safe: never break the host if a script is missing) ----
  var CFG = window.SKIPI_REMOTE_CONFIG;
  if (!CFG || !window.SkipiPluginLoader || !window.SkipiPluginRuntime ||
      typeof window.pluginMountInto !== 'function' || typeof window.SkipiPluginHost !== 'object') {
    try { console.warn('[remote-plugins] dependencies missing — staying inert'); } catch (e) {}
    return;
  }

  function getTheme() {
    try {
      var t = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || '';
      return String(t).toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }
  // host-side, slug-namespaced storage (the only storage the plugin can reach, via the bridge)
  var hostStore = {
    get: function (slug, k) { try { return localStorage.getItem('skpd_h.' + slug + '.' + k); } catch (e) { return null; } },
    set: function (slug, k, v) { try { localStorage.setItem('skpd_h.' + slug + '.' + k, String(v)); } catch (e) {} },
    remove: function (slug, k) { try { localStorage.removeItem('skpd_h.' + slug + '.' + k); } catch (e) {} }
  };

  // use the live app version for compatibility checks when available
  if (window.APP_VERSION && CFG.host) CFG.host.version = String(window.APP_VERSION);

  var loader = window.SkipiPluginLoader.create({
    catalogUrl: CFG.catalogUrl, host: CFG.host, policy: CFG.policy,
    pinnedPublicKey: CFG.pinnedPublicKey,
    pinnedPublicKeys: CFG.pinnedPublicKeys
  });
  var REMOTE_REGISTRY_KEY = 'skipi_remote_plugins_state';
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function readRemoteRegistry() {
    try { return JSON.parse(localStorage.getItem(REMOTE_REGISTRY_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeRemoteRegistry(reg) {
    try { localStorage.setItem(REMOTE_REGISTRY_KEY, JSON.stringify(reg || {})); } catch (e) {}
  }
  function remoteRecord(slug) {
    var rec = readRemoteRegistry()[slug];
    return rec && rec.installed ? rec : null;
  }
  function remoteEnabled(slug) {
    var rec = remoteRecord(slug);
    return !!rec && rec.enabled !== false;
  }
  function remoteVersionNewer(nextVersion, currentVersion) {
    if (!nextVersion || !currentVersion) return !!nextVersion && nextVersion !== currentVersion;
    var semverGte = window.SkipiPluginLoader && window.SkipiPluginLoader.semverGte;
    if (typeof semverGte === 'function') {
      return semverGte(nextVersion, currentVersion) && !semverGte(currentVersion, nextVersion);
    }
    return String(nextVersion) > String(currentVersion);
  }
  function findCatalogEntry(catalog, slug) {
    var list = (catalog && catalog.plugins) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].slug === slug) return list[i];
    return null;
  }
  function persistInstalled(entry, pack) {
    if (!entry || !entry.slug) return;
    var reg = readRemoteRegistry();
    var prior = reg[entry.slug] || {};
    var toolCount = entry.toolCount || entry.tool_count || (pack && (pack.toolCount || pack.tool_count)) || prior.toolCount || prior.tool_count;
    reg[entry.slug] = {
      installed: true,
      enabled: prior.enabled === false ? false : true,
      installed_at: prior.installed_at || nowIso(),
      updated_at: nowIso(),
      slug: entry.slug,
      id: entry.id,
      name: entry.name || entry.title || entry.slug,
      title: entry.title || entry.name || entry.slug,
      version: entry.version,
      toolCount: toolCount,
      keyId: (entry.keyId || (CFG && CFG.pinnedPublicKey && CFG.pinnedPublicKey.kid) || null),
      entry: entry
    };
    if (toolCount && reg[entry.slug].entry) reg[entry.slug].entry.toolCount = toolCount;
    writeRemoteRegistry(reg);
  }
  // Read-only helper so the Apps UI can LIST remote catalog entries when
  // ON (display only — opening still goes through the verified runtime). Resolves
  // to [] on any failure so the UI degrades to slug names.
  window.SkipiRemoteList = function () {
    return loader.getCatalog().then(function (c) { return (c && c.catalog && c.catalog.plugins) || []; }, function () { return []; });
  };
  var runtime = window.SkipiPluginRuntime.create({
    enabled: true, loader: loader,
    host: {
      theme: { get: getTheme },
      storage: hostStore,
      navigation: { setTitle: function () {}, closePlugin: function () {} },
      // Non-secret host identity so a plugin can resolve its role. No vault, no token, no
      // public_seafarer_id, no crew/vessel context.
      id: (CFG.host && CFG.host.id) || 'seafarer'
    }
  });
  window.SkipiRemoteRuntime = runtime; // exposed for QA/debug
  window.SkipiRemoteInstalled = function () {
    var reg = readRemoteRegistry(), out = [];
    Object.keys(reg).forEach(function (slug) {
      if (reg[slug] && reg[slug].installed) out.push(reg[slug]);
    });
    return out;
  };
  window.SkipiRemoteStatus = function (slug) {
    var rec = remoteRecord(slug);
    if (!rec) return 'available';
    return rec.enabled === false ? 'disabled' : 'installed';
  };
  window.SkipiRemoteInstall = function (slug, opts) {
    return loader.install(slug, opts).then(function (res) {
      if (res && res.ok) persistInstalled(res.entry, res.pack);
      return res;
    }, function (e) {
      return { ok: false, stage: 'install', reason: '' + (e && e.message || e) };
    });
  };
  window.SkipiRemoteEnsureLatest = function (slug) {
    var rec = remoteRecord(slug);
    if (!rec) return Promise.resolve({ ok: false, reason: 'not_installed' });
    var cache = loader && loader._cache;
    var previousCatalog = cache && typeof cache.get === 'function' ? cache.get('catalog') : null;
    function restorePreviousCatalog() {
      if (previousCatalog && cache && typeof cache.set === 'function') cache.set('catalog', previousCatalog);
    }
    return loader.getCatalog({ allowNetwork: true }).then(function (cat) {
      var entry = findCatalogEntry(cat && cat.catalog, slug);
      if (!entry) return { ok: false, reason: 'not_in_catalog' };
      if (!remoteVersionNewer(entry.version, rec.version || (rec.entry && rec.entry.version))) {
        restorePreviousCatalog();
        return { ok: true, updated: false, entry: rec.entry || entry, version: rec.version || (rec.entry && rec.entry.version) || entry.version };
      }
      return loader.install(slug, { allowNetwork: true }).then(function (res) {
        if (res && res.ok) {
          persistInstalled(res.entry, res.pack);
          return { ok: true, updated: true, entry: res.entry, version: res.entry && res.entry.version, source: res.source };
        }
        restorePreviousCatalog();
        return res || { ok: false, reason: 'install_failed' };
      });
    }, function (e) {
      return { ok: false, stage: 'catalog', reason: '' + (e && e.message || e) };
    });
  };
  window.SkipiRemoteSetEnabled = function (slug, enabled) {
    var reg = readRemoteRegistry();
    if (!reg[slug] || !reg[slug].installed) return { ok: false, reason: 'not_installed' };
    function setEnabled() {
      reg = readRemoteRegistry();
      if (!reg[slug] || !reg[slug].installed) return { ok: false, reason: 'not_installed' };
      reg[slug].enabled = enabled !== false;
      reg[slug].updated_at = nowIso();
      writeRemoteRegistry(reg);
      return { ok: true, status: reg[slug].enabled ? 'installed' : 'disabled' };
    }
    if (enabled !== false && typeof window.SkipiRemoteEnsureLatest === 'function') {
      return window.SkipiRemoteEnsureLatest(slug).then(function (refresh) {
        var res = setEnabled();
        res.refresh = refresh || null;
        res.updated = !!(refresh && refresh.updated);
        return res;
      }, function () { return setEnabled(); });
    }
    return setEnabled();
  };
  window.SkipiRemoteUninstall = function (slug) {
    var reg = readRemoteRegistry();
    if (reg[slug]) delete reg[slug];
    writeRemoteRegistry(reg);
    try { if (currentRemote === slug) runtime.close(); } catch (e) {}
    return loader.uninstall ? loader.uninstall(slug) : { ok: true };
  };

  var REMOTE = CFG.remoteSlugs || [];
  var currentRemote = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
  function msg(title, body) {
    return '<div style="padding:28px 20px;text-align:center;max-width:420px;margin:0 auto;color:inherit">'
      + '<div style="font-size:15px;font-weight:700;margin-bottom:6px">' + esc(title) + '</div>'
      + '<div style="font-size:13px;opacity:.7;line-height:1.4">' + esc(body) + '</div></div>';
  }
  function loadingHtml() { return msg('Loading plugin…', 'Verifying signature and integrity.'); }
  function failHtml(res) {
    var stage = res && res.stage, reason = (res && res.reason) || '';
    switch (stage) {
      case 'signature': return msg('Couldn’t verify this plugin', 'Signature check failed. Not installed.');
      case 'integrity': return msg('Couldn’t verify this plugin', 'Checksum mismatch. Not installed.');
      case 'compat': return msg('Update Skipi to use this plugin', reason || 'This plugin needs a newer app version.');
      case 'policy': return msg('Plugin not allowed', 'It requests permissions Skipi doesn’t allow.');
      case 'catalog':
      case 'install': return msg('Can’t reach the plugin catalog', 'Check your connection and try again. Already-installed plugins still work offline.');
      case 'timeout': return msg('Plugin not responding', 'The plugin runtime did not start. Try again.');
      case 'mount': return msg('Plugin failed to start', reason || 'The plugin could not be opened.');
      default: return msg('Plugin unavailable', reason || 'Could not open this plugin.');
    }
  }

  // ---- route remote plugins through the isolated runtime ----
  var origMountInto = window.pluginMountInto;
  window.pluginMountInto = function (id) {
    // Remote runtime takes over only after a verified remote install exists.
    // Bundled first-party plugins in CFG.remoteSlugs keep their bundled offline
    // baseline until the user explicitly clicks Update.
    if (REMOTE.indexOf(id) < 0 || !remoteRecord(id)) return origMountInto(id); // unchanged path for everything else
    var container = document.getElementById('plugin-host-container');
    if (!container) return;
    if (currentRemote === id) return; // already open
    currentRemote = id;
    if (remoteRecord(id) && !remoteEnabled(id)) {
      container.innerHTML = failHtml({ stage: 'policy', reason: 'disabled' });
      currentRemote = null;
      return;
    }
    container.innerHTML = loadingHtml();
    var rec = remoteRecord(id);
    var ready = rec ? window.SkipiRemoteEnsureLatest(id).then(function () { return true; }, function () { return true; }) : Promise.resolve(true);
    ready.then(function () {
      var openOpts = remoteRecord(id) ? { allowNetwork: false } : undefined;
      return runtime.open(id, container, openOpts);
    }).then(function (res) {
      if (!res || !res.ok) { currentRemote = null; container.innerHTML = failHtml(res); }
    }, function (e) {
      currentRemote = null; container.innerHTML = failHtml({ stage: 'mount', reason: '' + (e && e.message || e) });
    });
  };

  // ---- tear down the isolated frame on the host's single unmount entry ----
  var origUnmount = window.SkipiPluginHost.unmount;
  window.SkipiPluginHost.unmount = function () {
    if (currentRemote) { try { runtime.close(); } catch (e) {} currentRemote = null; }
    return origUnmount ? origUnmount.apply(window.SkipiPluginHost, arguments) : undefined;
  };

  try { console.info('[remote-plugins] ON · production catalog · isolated runtime · remote slugs: ' + REMOTE.join(', ')); } catch (e) {}
})();

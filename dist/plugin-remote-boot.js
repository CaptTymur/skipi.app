/* Remote plugin delivery — boot/wiring (Seafarer), behind FEATURE_REMOTE_PLUGIN_DELIVERY.
   ---------------------------------------------------------------------------------------
   KILL SWITCH: if the flag is OFF (default), this file does NOTHING — no runtime, no
   catalog fetch, no patching. Seafarer is byte-identical to today.

   When ON: creates the isolated remote runtime (SkipiPluginRuntime, sandboxed strict-CSP
   iframe — no host DOM, no network, no host CSP change) and routes the configured remote
   slugs (e.g. bnwas-time-anchor) through it, instead of the bundled mount path. All other
   plugins/screens are untouched. Fail-closed UI on any verification/transport failure.

   STAGING + TEST KEY ONLY. No production catalog. No production key. */
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

  // --- «Моё судно» (my_vessel) host-mediated capability skeleton ---------------
  // Minimal, host-side, grant-gated. NO raw vault data, NO tokens, NO raw files,
  // NO real network for the plugin. media/workflow are honest stubs (no gallery
  // access, no upload). Read the current vault identity + its per-vault My Vessel
  // membership cache; return only what a sender needs.
  function mvReadContext() {
    var inv = (typeof window.invoke === 'function') ? window.invoke : null;
    var prof = inv ? Promise.resolve(inv('get_matchable_profile')).catch(function () { return null; }) : Promise.resolve(null);
    return prof.then(function (p) {
      var uid = p && p.user_id, psid = (p && p.public_seafarer_id) || null, mem = null;
      if (uid) { try { var raw = localStorage.getItem('mv:membership:' + uid); if (raw) mem = JSON.parse(raw); } catch (e) {} }
      if (!mem && window.myVessel && window.myVessel.membership) mem = window.myVessel.membership;
      return { mem: mem, psid: psid };
    });
  }
  function mvLinked(m) { return !!(m && m.crew_member_id && m.vessel_imo && (!m.status || m.status === 'linked')); }
  var mvHost = {
    vessel: {
      getContext: function () {
        return mvReadContext().then(function (c) {
          var m = c.mem;
          if (!mvLinked(m)) return { linked: false, vessel_imo: null, vessel_name: null, status: (m && m.status) || 'not_linked', public_seafarer_id: c.psid || null };
          return { linked: true, vessel_imo: m.vessel_imo, vessel_name: m.vessel_name || null, status: m.status || 'linked', public_seafarer_id: c.psid || null };
        });
      }
    },
    crew: {
      getMembership: function () {
        return mvReadContext().then(function (c) {
          var m = c.mem;
          if (!mvLinked(m)) return { linked: false };
          // minimal — only the ids a sender needs for provenance. No vault_user_id,
          // no tokens, no documents/profile.
          return { linked: true, crew_member_id: m.crew_member_id, public_seafarer_id: c.psid || null, vessel_imo: m.vessel_imo, status: m.status || 'linked', linked_at: m.linked_at || null };
        });
      }
    },
    media: {
      // STUB. Does NOT open the gallery/camera automatically. Default: not implemented.
      // A mock handle is returned ONLY when a test harness sets window.__SKIPI_MEDIA_MOCK__.
      pickPhoto: function () {
        if (window.__SKIPI_MEDIA_MOCK__) return Promise.resolve({ ok: true, handle: { client_media_id: 'mock-photo', content_type: 'image/jpeg', size: 0, sha256: null, mock: true } });
        return Promise.resolve({ ok: false, reason: 'not_implemented', message: 'Photo picker is not wired yet (no gallery/camera access).' });
      }
    },
    workflow: {
      // STUB. Validates vessel context exists, then returns an honest
      // transport-not-connected / pending result. NEVER fakes "sent", NEVER uploads.
      submit: function () {
        return mvHost.vessel.getContext().then(function (v) {
          if (!v || !v.linked || !v.vessel_imo) return { ok: false, stage: 'context', reason: 'not_linked', message: 'Join a vessel crew first.' };
          return { ok: false, stage: 'transport', reason: 'transport_not_connected', pending: true, message: 'Kept as pending — sending to the vessel is not connected yet (capture API not available). Nothing was uploaded.' };
        });
      }
    }
  };

  var loader = window.SkipiPluginLoader.create({
    catalogUrl: CFG.catalogUrl, host: CFG.host, policy: CFG.policy, pinnedPublicKey: CFG.pinnedPublicKey
  });
  var runtime = window.SkipiPluginRuntime.create({
    enabled: true, loader: loader,
    host: {
      theme: { get: getTheme },
      storage: hostStore,
      navigation: { setTitle: function () {}, closePlugin: function () {} },
      vessel: mvHost.vessel,
      crew: mvHost.crew,
      media: mvHost.media,
      workflow: mvHost.workflow
    }
  });
  window.SkipiRemoteRuntime = runtime; // exposed for QA/debug
  window.__SKIPI_MV_HOST__ = mvHost;   // exposed for QA/debug (flag-gated; returns no secrets)

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
    if (REMOTE.indexOf(id) < 0) return origMountInto(id); // unchanged path for everything else
    var container = document.getElementById('plugin-host-container');
    if (!container) return;
    if (currentRemote === id) return; // already open
    currentRemote = id;
    container.innerHTML = loadingHtml();
    runtime.open(id, container).then(function (res) {
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

  try { console.info('[remote-plugins] ON · staging catalog · isolated runtime · remote slugs: ' + REMOTE.join(', ')); } catch (e) {}
})();

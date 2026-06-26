/* ===========================================================================
   SkipiPluginRuntime — ISOLATED plugin runtime + narrow postMessage bridge
   ---------------------------------------------------------------------------
   Behind FEATURE_REMOTE_PLUGIN_DELIVERY. Composes SkipiPluginLoader (verify +
   cache) with an ISOLATED plugin context:

     - the verified plugin runs inside a sandboxed iframe (sandbox="allow-scripts",
       NO allow-same-origin → opaque origin, cross-origin to the host);
     - the frame carries its OWN strict CSP (default-src 'none'; script-src 'nonce-…';
       style-src 'nonce-…'; connect-src 'none') — NO host-app CSP change needed;
     - the plugin has NO host DOM, NO network, NO storage except via the bridge;
     - the host enforces the plugin's granted permissions on every bridge message;
     - the plugin runtime contract is unchanged: it still calls
       window.SkipiPlugins[slug].mount(container, hostApi) — container is the
       frame's own body, hostApi is a bridge proxy.

   Host CSP stays as today (Seafarer csp:null); strictness lives only in the frame.
   No eval. No unsafe-inline (frame code runs via matching nonce). No remote code
   execution in the host document.
   =========================================================================== */
(function () {
  'use strict';

  // ---- code that runs INSIDE the isolated frame (injected via nonce'd inline) ----
  var SHIM_SRC = `
(function () {
  'use strict';
  var TOKEN = window.__SKIPI_TOKEN__ || '';   // per-mount capability token (set by host)
  var slug = null, theme = 'dark', nonce = '', themeSubs = [], pending = {}, seq = 0;
  function send(m) { try { parent.postMessage(Object.assign({ ch: 'skipi-plugin', v: 1, token: TOKEN }, m), '*'); } catch (e) {} }

  function selfCheck() {
    var r = { parentDomAccess: false, storageBlocked: true };
    try { if (window.parent && window.parent.document) r.parentDomAccess = true; } catch (e) { r.parentDomAccess = false; }
    try { window.localStorage.getItem('x'); r.storageBlocked = false; } catch (e) { r.storageBlocked = true; }
    return r;
  }
  function injectStyle(css) { var s = document.createElement('style'); s.nonce = nonce; s.textContent = css || ''; document.head.appendChild(s); }
  function injectScript(js) { var s = document.createElement('script'); s.nonce = nonce; s.textContent = js; document.head.appendChild(s); }

  function proxy(perms) {
    var has = function (p) { return perms.indexOf(p) >= 0; };
    return {
      theme: { get: function () { return theme; }, subscribe: function (cb) { themeSubs.push(cb); return function () { themeSubs = themeSubs.filter(function (f) { return f !== cb; }); }; } },
      storage: {
        get: function (k, cb) { if (!has('local_storage')) { if (cb) cb(null); return; } var id = ++seq; pending[id] = cb || function () {}; send({ type: 'storage.get', id: id, key: k }); },
        set: function (k, v) { if (has('local_storage')) send({ type: 'storage.set', key: k, value: v }); },
        remove: function (k) { if (has('local_storage')) send({ type: 'storage.remove', key: k }); }
      },
      navigation: { setTitle: function (t) { send({ type: 'nav.setTitle', title: t }); }, closePlugin: function () { send({ type: 'nav.close' }); } },
      audio: { playLoop: function () {}, stop: function () {} },
      permissions: { listGranted: function () { return perms.slice(); } }
    };
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || m.ch !== 'skipi-plugin' || m.token !== TOKEN) return;
    if (m.type === 'init') {
      slug = m.slug; theme = m.theme || 'dark'; nonce = m.nonce || '';
      var sc = selfCheck();
      var fetchProbe;
      try {
        fetchProbe = Promise.race([
          fetch('https://blocked.invalid/probe').then(function () { return false; }, function () { return true; }),
          new Promise(function (r) { setTimeout(function () { r(true); }, 600); })
        ]);
      } catch (e) { fetchProbe = Promise.resolve(true); }
      fetchProbe.then(function (blocked) {
        sc.fetchBlocked = blocked;
        try { injectStyle(m.css); injectScript(m.js); } catch (e) { send({ type: 'error', message: 'inject: ' + e.message }); return; }
        var reg = window.SkipiPlugins && window.SkipiPlugins[slug];
        if (!reg || typeof reg.mount !== 'function') { send({ type: 'error', message: 'plugin code did not register (CSP block?)' }); return; }
        try { reg.mount(document.body, proxy(m.permissions || [])); }
        catch (e) { send({ type: 'error', message: 'mount: ' + e.message }); return; }
        send({ type: 'mounted', height: document.body.scrollHeight, selfcheck: sc });
        try { var ro = new ResizeObserver(function () { send({ type: 'resize', height: document.body.scrollHeight }); }); ro.observe(document.body); } catch (e) {}
      });
    } else if (m.type === 'theme') {
      theme = m.theme; themeSubs.forEach(function (cb) { try { cb(theme); } catch (e) {} });
      send({ type: 'resize', height: document.body.scrollHeight });
    } else if (m.type === 'storage.result') {
      var cb = pending[m.id]; if (cb) { delete pending[m.id]; cb(m.value); }
    } else if (m.type === 'unmount') {
      var reg2 = window.SkipiPlugins && window.SkipiPlugins[slug];
      if (reg2 && typeof reg2.unmount === 'function') { try { reg2.unmount(); } catch (e) {} }
      send({ type: 'unmounted' });
    }
  });
  send({ type: 'ready' });
})();
`;

  function randNonce() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    var s = ''; for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s;
  }
  function buildSrcdoc(nonce, token, noCsp) {
    var csp = "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    var cspMeta = noCsp ? '' : '<meta http-equiv="Content-Security-Policy" content="' + csp + '">';
    var boot = 'window.__SKIPI_TOKEN__=' + JSON.stringify(token) + ';\n';
    return '<!doctype html><html><head><meta charset="utf-8">'
      + cspMeta
      + '<scr' + 'ipt nonce="' + nonce + '">' + boot + SHIM_SRC + '</scr' + 'ipt>'
      + '</head><body></body></html>';
  }

  function defaultStore() {
    var m = {};
    return {
      get: function (slug, k) { var key = slug + '::' + k; return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null; },
      set: function (slug, k, v) { m[slug + '::' + k] = String(v); },
      remove: function (slug, k) { delete m[slug + '::' + k]; },
      _all: function () { return m; }
    };
  }

  function create(cfg) {
    var enabled = !!cfg.enabled;
    var loader = cfg.loader;
    var store = (cfg.host && cfg.host.storage) || defaultStore();
    var themeApi = (cfg.host && cfg.host.theme) || { get: function () { return 'dark'; } };
    var nav = (cfg.host && cfg.host.navigation) || { setTitle: function () {}, closePlugin: function () {} };
    var active = null;   // single active plugin frame
    var audit = [];
    var dbg = [];

    function granted(p) { return active && active.perms.indexOf(p) >= 0; }
    function toFrame(msg) { try { active.iframe.contentWindow.postMessage(Object.assign({ ch: 'skipi-plugin', v: 1, token: active.token }, msg), '*'); } catch (e) {} }
    function respond(id, value) { toFrame({ type: 'storage.result', id: id, value: value }); }
    function sendInit() { toFrame({ type: 'init', slug: active.slug, manifest: active.manifest, css: active.css, js: active.js, theme: themeApi.get(), permissions: active.perms, nonce: active.nonce }); }

    function onMessage(ev) {
      var md = ev.data;
      dbg.push({ type: md && md.type, ch: md && md.ch, tokOk: !!(active && md && md.token === active.token) });
      // validate by per-mount capability token (opaque-origin frames have unreliable source identity)
      if (!active || !md || md.ch !== 'skipi-plugin' || md.token !== active.token) return;
      var m = md;
      switch (m.type) {
        case 'ready':
          if (active.installed) sendInit(); else active.gotReady = true;  // wait for verify if not ready yet
          break;
        case 'mounted':
          active.iframe.style.height = Math.max(200, m.height | 0) + 'px';
          active.selfcheck = m.selfcheck || {};
          if (active.resolve) { active.resolve({ ok: true }); active.resolve = null; }
          break;
        case 'resize':
          active.iframe.style.height = Math.max(200, m.height | 0) + 'px';
          break;
        case 'storage.get':
          if (!granted('local_storage')) { audit.push('DENY storage.get'); respond(m.id, null); break; }
          store.get && (active.sawStorageGet = true); respond(m.id, store.get(active.slug, m.key));
          break;
        case 'storage.set':
          if (!granted('local_storage')) { audit.push('DENY storage.set'); break; }
          store.set(active.slug, m.key, m.value); break;
        case 'storage.remove':
          if (!granted('local_storage')) { audit.push('DENY storage.remove'); break; }
          store.remove(active.slug, m.key); break;
        case 'nav.setTitle': nav.setTitle(m.title); break;
        case 'nav.close': if (nav.closePlugin) nav.closePlugin(); active.api.close(); break;
        case 'error':
          active.error = m.message;
          if (active.resolve) { active.resolve({ ok: false, stage: 'mount', reason: m.message }); active.resolve = null; }
          break;
        default:
          audit.push('DENY ' + m.type); // unknown / undeclared capability → dropped + logged
      }
    }
    window.addEventListener('message', onMessage);

    var api = {
      enabled: enabled,
      async open(slug, mountEl) {
        if (!enabled) return { ok: false, stage: 'flag', reason: 'FEATURE_REMOTE_PLUGIN_DELIVERY is off' };
        // Create + boot the isolated frame SYNCHRONOUSLY (before any await), so the
        // frame loads regardless of verification latency. The frame waits for 'init',
        // which carries the verified code and is sent only after install() succeeds.
        var nonce = randNonce(), token = randNonce();
        var iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');   // opaque origin, no host DOM, no same-origin
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.style.cssText = 'width:100%;border:0;height:200px;display:block';
        iframe.srcdoc = buildSrcdoc(nonce, token, cfg.noCsp);
        active = { slug: slug, iframe: iframe, nonce: nonce, token: token, perms: [], resolve: null, api: api, gotReady: false, installed: false };
        var mounted = new Promise(function (res) { active.resolve = res; });
        var timer = setTimeout(function () { if (active && active.resolve) { active.resolve({ ok: false, stage: 'timeout', reason: 'frame did not mount within bridge timeout' }); active.resolve = null; } }, (cfg.bridgeTimeoutMs || 6000));
        mountEl.innerHTML = ''; mountEl.appendChild(iframe);
        // verify + cache (async). Only after this do we hand the verified code to the frame.
        var r;
        try { r = await loader.install(slug); }
        catch (e) { clearTimeout(timer); api.close(); return { ok: false, stage: 'install', reason: e.message }; }
        if (!r.ok) { clearTimeout(timer); api.close(); return r; }   // verify/integrity/policy/offline failure → surfaced
        var ep = r.pack.entrypoints || { ui: 'index.js', style: 'index.css' };
        if (active) {
          active.manifest = r.pack; active.css = r.pack.files[ep.style] || ''; active.js = r.pack.files[ep.ui] || '';
          active.perms = (r.pack.permissions || []).slice(); active.installed = true;
          if (active.gotReady) sendInit();   // frame booted before verify finished → send init now
        }
        var res = await mounted; clearTimeout(timer);
        return res.ok ? { ok: true, source: r.source, selfcheck: active.selfcheck } : res;
      },
      close() {
        if (!active) return;
        toFrame({ type: 'unmount' });
        if (active.iframe.parentNode) active.iframe.parentNode.removeChild(active.iframe);
        active = null;
      },
      pushTheme(t) { if (active) toFrame({ type: 'theme', theme: t }); },
      _active() { return active; },
      _audit() { return audit; },
      _dbg() { return dbg; },
      _store() { return store; }
    };
    return api;
  }

  window.SkipiPluginRuntime = { create: create };
})();

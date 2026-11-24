/* ===========================================================================
   SkipiPluginRuntime — ISOLATED plugin runtime + narrow postMessage bridge
   ---------------------------------------------------------------------------
   Behind FEATURE_REMOTE_PLUGIN_DELIVERY. Composes SkipiPluginLoader (verify +
   cache) with an ISOLATED plugin context:

     - the verified plugin runs inside a sandboxed iframe (sandbox="allow-scripts",
       NO allow-same-origin → opaque origin, cross-origin to the host);
     - the frame carries its OWN strict CSP (default-src 'none'; script-src 'nonce-…';
       style-src 'nonce-…'; connect-src 'none') — NO host-app CSP change needed;
     - the plugin has NO host DOM, NO network, NO storage except via the bridge
       (v1.1: host-mediated net.fetch / files.* — by grant + signed allowlist; the
       frame's own CSP stays connect-src 'none');
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

  // Host-mediated call (v1.1): the frame itself still has NO network and NO files;
  // it asks the host, which enforces the grant + the plugin's signed allowlist.
  function rpc(type, payload) {
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = function (m) { if (m && m.ok) resolve(m.value); else reject(new Error((m && m.error) || 'host call failed')); };
      send(Object.assign({ type: type, id: id }, payload));
    });
  }
  function notGranted(p) { return Promise.reject(new Error('permission not granted: ' + p)); }

  function proxy(perms, hostId) {
    var has = function (p) { return perms.indexOf(p) >= 0; };
    return {
      // Non-secret host identity (so the plugin can resolve its role). No PII.
      host: { id: hostId || null },
      theme: { get: function () { return theme; }, subscribe: function (cb) { themeSubs.push(cb); return function () { themeSubs = themeSubs.filter(function (f) { return f !== cb; }); }; } },
      storage: {
        // Returns a Promise AND honors an optional callback (back-compat): a
        // plugin may 'var v = storage.get(k)' and use v.then(...), or pass a cb.
        get: function (k, cb) {
          if (!has('local_storage')) { if (cb) cb(null); return Promise.resolve(null); }
          var id = ++seq, resolve;
          var p = new Promise(function (r) { resolve = r; });
          pending[id] = function (v) { if (cb) { try { cb(v); } catch (e) {} } resolve(v); };
          send({ type: 'storage.get', id: id, key: k });
          return p;
        },
        set: function (k, v) { if (has('local_storage')) send({ type: 'storage.set', key: k, value: v }); },
        remove: function (k) { if (has('local_storage')) send({ type: 'storage.remove', key: k }); }
      },
      navigation: { setTitle: function (t) { send({ type: 'nav.setTitle', title: t }); }, closePlugin: function () { send({ type: 'nav.close' }); } },
      net: {
        // fetch(url, {method, headers, body | bodyBase64}) -> Promise<{ok, status, headers, text | base64}>
        fetch: function (url, o) {
          if (!has('network')) return notGranted('network');
          o = o || {};
          return rpc('net.fetch', { url: String(url), method: o.method, headers: o.headers, body: o.body, bodyBase64: o.bodyBase64 });
        }
      },
      files: {
        // save({name, mime, text | base64}) -> Promise<{saved}> ; pick({accept, multiple}) -> Promise<[{name, mime, base64}]>
        save: function (f) { if (!has('file_save')) return notGranted('file_save'); f = f || {}; return rpc('files.save', { name: f.name, mime: f.mime, text: f.text, base64: f.base64 }); },
        pick: function (o) { if (!has('file_pick')) return notGranted('file_pick'); o = o || {}; return rpc('files.pick', { accept: o.accept, multiple: !!o.multiple }); }
      },
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
        try { reg.mount(document.body, proxy(m.permissions || [], m.hostId)); }
        catch (e) { send({ type: 'error', message: 'mount: ' + e.message }); return; }
        send({ type: 'mounted', height: document.body.scrollHeight, selfcheck: sc });
        try { var ro = new ResizeObserver(function () { send({ type: 'resize', height: document.body.scrollHeight }); }); ro.observe(document.body); } catch (e) {}
      });
    } else if (m.type === 'theme') {
      theme = m.theme; themeSubs.forEach(function (cb) { try { cb(theme); } catch (e) {} });
      send({ type: 'resize', height: document.body.scrollHeight });
    } else if (m.type === 'storage.result') {
      var cb = pending[m.id]; if (cb) { delete pending[m.id]; cb(m.value); }
    } else if (m.type === 'rpc.result') {
      var cb2 = pending[m.id]; if (cb2) { delete pending[m.id]; cb2(m); }
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

  // ---- host-mediated network + files (v1.1) --------------------------------
  // The frame CSP is NOT weakened: a plugin never opens a socket. It posts
  // net.fetch; the HOST performs the request, and only when ALL hold:
  //   - the plugin was granted 'network';
  //   - the URL is https, without userinfo, and inside pack.network.allow
  //     (origin match + path-prefix match) — the allowlist is part of the verified pack;
  //   - method is one of NET_METHODS.
  // The request carries no cookies/credentials and never follows a redirect
  // (a redirect could leave the allowlist). Host secrets are never added.
  var NET_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  var NET_MAX_BYTES = 16 * 1024 * 1024;      // request body and response body cap
  var NET_TIMEOUT_MS = 60000;
  var NET_DROP_HEADER = /^(cookie|cookie2|set-cookie|host|origin|referer|connection|content-length|proxy-.*|sec-.*)$/i;
  var FILE_MAX_BYTES = 32 * 1024 * 1024;

  function netAllowedUrl(pack, rawUrl) {
    var allow = pack && pack.network && pack.network.allow;
    if (!Array.isArray(allow)) return null;
    var u; try { u = new URL(String(rawUrl)); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    for (var i = 0; i < allow.length; i++) {
      var b; try { b = new URL(String(allow[i])); } catch (e) { continue; }
      if (b.protocol !== 'https:' || b.username || b.password || b.search || b.hash) continue;
      if (u.origin !== b.origin) continue;
      var bp = b.pathname; if (bp.charAt(bp.length - 1) !== '/') bp += '/';
      if ((u.pathname + '/').indexOf(bp) === 0) return u.href;
    }
    return null;
  }
  function netCleanHeaders(h) {
    var out = {}, n = 0;
    if (!h || typeof h !== 'object') return out;
    Object.keys(h).forEach(function (k) {
      if (n >= 32 || !/^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$/.test(k) || NET_DROP_HEADER.test(k)) return;
      var v = h[k]; if (typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v)) return;
      out[k] = v; n++;
    });
    return out;
  }
  function b64ToBytes(b64) {
    var bin = atob(String(b64)), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function bytesToB64(a) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, a.subarray(i, i + CH));
    return btoa(s);
  }
  // Default transport: the host document's own fetch, with the safe options fixed here.
  // A home may replace it (cfg.host.net.fetch) — e.g. a native command — but gets the
  // SAME already-validated request and must honour the same rules.
  function defaultNetFetch(req) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, NET_TIMEOUT_MS);
    var init = { method: req.method, headers: req.headers, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' };
    if (ctl) init.signal = ctl.signal;
    if (req.method !== 'GET') {
      if (typeof req.bodyBase64 === 'string') init.body = b64ToBytes(req.bodyBase64);
      else if (typeof req.body === 'string') init.body = req.body;
    }
    return fetch(req.url, init).then(function (resp) {
      return resp.arrayBuffer().then(function (buf) {
        clearTimeout(timer);
        if (buf.byteLength > NET_MAX_BYTES) throw new Error('response too large');
        var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
        var out = { ok: !!resp.ok, status: resp.status | 0, headers: { 'content-type': ct } };
        if (/^(text\/|application\/(json|xml|.*\+json|.*\+xml))/i.test(ct) || !ct) out.text = new TextDecoder('utf-8').decode(buf);
        else out.base64 = bytesToB64(new Uint8Array(buf));
        return out;
      });
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function safeFileName(n) {
    var s = String(n == null ? '' : n).replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120);
    return s || 'file';
  }

  function create(cfg) {
    var enabled = !!cfg.enabled;
    var loader = cfg.loader;
    var store = (cfg.host && cfg.host.storage) || defaultStore();
    var themeApi = (cfg.host && cfg.host.theme) || { get: function () { return 'dark'; } };
    var nav = (cfg.host && cfg.host.navigation) || { setTitle: function () {}, closePlugin: function () {} };
    var hostId = (cfg.host && cfg.host.id) || null;   // non-secret host app id (e.g. 'seafarer')
    var netApi = (cfg.host && cfg.host.net) || null;      // opt-in: absent → net.fetch is refused
    var filesApi = (cfg.host && cfg.host.files) || null;  // opt-in: absent → files.* are refused
    var active = null;   // single active plugin frame
    var audit = [];
    var dbg = [];

    function granted(p) { return active && active.perms.indexOf(p) >= 0; }
    function toFrame(msg) { try { active.iframe.contentWindow.postMessage(Object.assign({ ch: 'skipi-plugin', v: 1, token: active.token }, msg), '*'); } catch (e) {} }
    function respond(id, value) { toFrame({ type: 'storage.result', id: id, value: value }); }
    // Answer a host-mediated call — only to the SAME mount that asked (a plugin closed or
    // replaced while the host was working must not receive another plugin's result).
    function rpcDone(tok, id, ok, value, error) {
      if (!active || active.token !== tok) return;
      toFrame(ok ? { type: 'rpc.result', id: id, ok: true, value: value } : { type: 'rpc.result', id: id, ok: false, error: String(error || 'failed') });
    }
    function rpcRun(m, fn) {
      var tok = active.token;
      var p; try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      p.then(function (v) { rpcDone(tok, m.id, true, v); }, function (e) { rpcDone(tok, m.id, false, null, (e && e.message) || e); });
    }
    function deny(m, what, why) { audit.push('DENY ' + what + (why ? ' (' + why + ')' : '')); rpcDone(active.token, m.id, false, null, why || 'denied'); }
    function handleNetFetch(m) {
      if (!granted('network')) return deny(m, 'net.fetch', 'permission not granted: network');
      if (!netApi) return deny(m, 'net.fetch', 'network is not available in this host');
      var url = netAllowedUrl(active.manifest, m.url);
      if (!url) return deny(m, 'net.fetch', 'url is not in the plugin allowlist');
      var method = String(m.method || 'GET').toUpperCase();
      if (NET_METHODS.indexOf(method) < 0) return deny(m, 'net.fetch', 'method not allowed');
      var req = { url: url, method: method, headers: netCleanHeaders(m.headers) };
      if (typeof m.bodyBase64 === 'string') req.bodyBase64 = m.bodyBase64; else if (typeof m.body === 'string') req.body = m.body;
      if ((req.body || req.bodyBase64 || '').length > NET_MAX_BYTES * 4 / 3 + 4) return deny(m, 'net.fetch', 'request too large');
      var slug = active.slug;
      rpcRun(m, function () { return typeof netApi.fetch === 'function' ? netApi.fetch(slug, req) : defaultNetFetch(req); });
    }
    function handleFile(m, perm, method, arg) {
      if (!granted(perm)) return deny(m, m.type, 'permission not granted: ' + perm);
      if (!filesApi || typeof filesApi[method] !== 'function') return deny(m, m.type, 'files are not available in this host');
      var slug = active.slug;
      rpcRun(m, function () { return filesApi[method](slug, arg); });
    }

    function sendInit() { toFrame({ type: 'init', slug: active.slug, manifest: active.manifest, css: active.css, js: active.js, theme: themeApi.get(), permissions: active.perms, nonce: active.nonce, hostId: hostId }); }

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
        case 'net.fetch': handleNetFetch(m); break;
        case 'files.save':
          if (((typeof m.base64 === 'string' ? m.base64 : m.text) || '').length > FILE_MAX_BYTES * 4 / 3 + 4) { deny(m, 'files.save', 'file too large'); break; }
          handleFile(m, 'file_save', 'save', typeof m.base64 === 'string'
            ? { name: safeFileName(m.name), mime: String(m.mime || 'application/octet-stream').slice(0, 120), base64: m.base64 }
            : { name: safeFileName(m.name), mime: String(m.mime || 'text/plain').slice(0, 120), text: String(m.text == null ? '' : m.text) });
          break;
        case 'files.pick':
          handleFile(m, 'file_pick', 'pick', { accept: typeof m.accept === 'string' ? m.accept.slice(0, 200) : '', multiple: !!m.multiple });
          break;
        case 'nav.setTitle': nav.setTitle(m.title); break;
        case 'nav.close':
          var closeApi = active && active.api;
          if (nav.closePlugin) nav.closePlugin();
          if (closeApi && closeApi.close) closeApi.close();
          break;
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

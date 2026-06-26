/* ===========================================================================
   SkipiPluginLoader — signed first-party remote plugin delivery (v1 prototype)
   ---------------------------------------------------------------------------
   Loads plugins from a remote catalog WITHOUT a host release, but only after:
     1. signature  — catalog entry signed by the pinned first-party key (ECDSA P-256)
     2. compat     — host id allowed + host version >= minHostVersion
     3. policy     — permissions ⊆ allowlist; capabilities within policy
     4. integrity  — downloaded pack SHA-256 == the signed hash
   Verified packs are cached; after first install the plugin works OFFLINE from
   cache (and is RE-VERIFIED from cache, so cache tampering is also caught).
   Verified code is injected via a blob: URL (no eval / no unsafe-inline), so a
   tight host CSP (script-src 'self' blob'; style-src 'self' blob:) is enough.
   The plugin runtime contract is UNCHANGED: window.SkipiPlugins[slug]={manifest,mount,unmount}.
   First-party only in v1. No third-party marketplace.
   =========================================================================== */
(function () {
  'use strict';

  function canonical(v) { // must match tools/sign.js
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  var enc = new TextEncoder();
  function b64ToBytes(b64) { var bin = atob(b64), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function hex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0'); return s; }
  async function sha256hex(str) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(str))); }
  function semverGte(a, b) {
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
    return true;
  }
  function baseOf(url) { return url.replace(/[^/]*$/, ''); }

  function defaultCache() {
    var NS = 'skpd.';
    return {
      get: function (k) { try { return localStorage.getItem(NS + k); } catch (e) { return null; } },
      set: function (k, v) { try { localStorage.setItem(NS + k, v); } catch (e) {} },
      keys: function () { var out = []; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf(NS) === 0) out.push(k.slice(NS.length)); } } catch (e) {} return out; }
    };
  }

  function createLoader(config) {
    var catalogUrl = config.catalogUrl;
    var host = config.host;                 // { id, version }
    var policy = config.policy;             // { maxPermissions[], requireCapabilities{} }
    var pinnedJwk = config.pinnedPublicKey; // JWK
    var cache = config.cache || defaultCache();
    var doFetch = config.fetch || function (url) {
      return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    };

    var pubKeyPromise = null;
    function pubKey() {
      if (!pubKeyPromise) pubKeyPromise = crypto.subtle.importKey('jwk', pinnedJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return pubKeyPromise;
    }

    async function verifySignature(entry) {
      var noSig = {}; Object.keys(entry).forEach(function (k) { if (k !== 'signature') noSig[k] = entry[k]; });
      try {
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await pubKey(), b64ToBytes(entry.signature || ''), enc.encode(canonical(noSig)));
      } catch (e) { return false; }
    }
    function checkCompat(entry) {
      var c = entry.compat || {};
      if (!c.host || c.host.indexOf(host.id) < 0) return { ok: false, reason: 'host "' + host.id + '" not in compat list' };
      if (c.minHostVersion && !semverGte(host.version, c.minHostVersion)) return { ok: false, reason: 'host ' + host.version + ' < minHostVersion ' + c.minHostVersion };
      return { ok: true };
    }
    function checkPolicy(entry) {
      var perms = entry.permissions || [];
      for (var i = 0; i < perms.length; i++) if (policy.maxPermissions.indexOf(perms[i]) < 0) return { ok: false, reason: 'permission not allowed: ' + perms[i] };
      var caps = entry.capabilities || {}, req = policy.requireCapabilities;
      for (var k in req) if (Object.prototype.hasOwnProperty.call(req, k)) {
        if (caps[k] !== req[k]) return { ok: false, reason: 'capability ' + k + '=' + JSON.stringify(caps[k]) + ' violates policy (' + JSON.stringify(req[k]) + ')' };
      }
      return { ok: true };
    }

    async function verifyEntry(entry) {
      var sig = await verifySignature(entry);
      if (!sig) return { ok: false, stage: 'signature', reason: 'invalid signature' };
      var cm = checkCompat(entry); if (!cm.ok) return { ok: false, stage: 'compat', reason: cm.reason };
      var pl = checkPolicy(entry); if (!pl.ok) return { ok: false, stage: 'policy', reason: pl.reason };
      return { ok: true };
    }

    async function getCatalog(opts) {
      opts = opts || {};
      if (opts.allowNetwork !== false) {
        try {
          var txt = await doFetch(catalogUrl);
          JSON.parse(txt); // validate
          cache.set('catalog', txt);
          return { catalog: JSON.parse(txt), source: 'network' };
        } catch (e) { /* fall through to cache */ }
      }
      var cached = cache.get('catalog');
      if (cached) return { catalog: JSON.parse(cached), source: 'cache' };
      throw new Error('no catalog (network failed and nothing cached)');
    }

    function findEntry(catalog, slug) {
      var list = (catalog && catalog.plugins) || [];
      for (var i = 0; i < list.length; i++) if (list[i].slug === slug) return list[i];
      return null;
    }

    async function getVerifiedPack(entry, opts) {
      opts = opts || {};
      var cacheKey = 'pack:' + entry.slug + '@' + entry.version;
      var packStr = null, source = null;
      if (opts.allowNetwork !== false) {
        try { packStr = await doFetch(baseOf(catalogUrl) + entry.packUrl); source = 'network'; } catch (e) { packStr = null; }
      }
      if (packStr === null) { packStr = cache.get(cacheKey); source = 'cache'; }
      if (packStr === null) return { ok: false, reason: 'pack unavailable (offline and not cached)' };
      // integrity: hash must equal the SIGNED hash (so cache tampering is caught too)
      var h = await sha256hex(packStr);
      if (h !== entry.sha256) return { ok: false, stage: 'integrity', reason: 'sha256 mismatch (expected ' + entry.sha256.slice(0, 12) + '…, got ' + h.slice(0, 12) + '…)' };
      var pack;
      try { pack = JSON.parse(packStr); } catch (e) { return { ok: false, reason: 'pack not valid JSON' }; }
      if (pack.id !== entry.id || pack.slug !== entry.slug || pack.version !== entry.version) return { ok: false, stage: 'integrity', reason: 'pack/entry identity mismatch' };
      cache.set(cacheKey, packStr); // persist verified pack for offline
      return { ok: true, pack: pack, source: source };
    }

    // ---- install: verify entry + fetch/verify pack, cache. No code execution. ----
    async function install(slug, opts) {
      var cat;
      try { cat = await getCatalog(opts); } catch (e) { return { ok: false, stage: 'catalog', reason: e.message }; }
      var entry = findEntry(cat.catalog, slug);
      if (!entry) return { ok: false, reason: 'not in catalog: ' + slug };
      var v = await verifyEntry(entry);
      if (!v.ok) return v;
      var p = await getVerifiedPack(entry, opts);
      if (!p.ok) return p;
      cache.set('entry:' + slug, JSON.stringify(entry));
      return { ok: true, entry: entry, pack: p.pack, source: cat.source + '/' + p.source };
    }

    function injectStyle(css, slug) {
      var blob = new Blob([css], { type: 'text/css' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = url; link.setAttribute('data-skipi-plugin', slug);
      return new Promise(function (res) { link.onload = function () { res(); }; link.onerror = function () { res(); }; document.head.appendChild(link); });
    }
    function injectScript(code, slug) {
      return new Promise(function (res, rej) {
        var blob = new Blob([code], { type: 'text/javascript' });
        var url = URL.createObjectURL(blob);
        var s = document.createElement('script'); s.src = url; s.setAttribute('data-skipi-plugin', slug);
        s.onload = function () { URL.revokeObjectURL(url); res(); };
        s.onerror = function () { URL.revokeObjectURL(url); rej(new Error('blocked or failed to load plugin code (CSP?)')); };
        document.head.appendChild(s);
      });
    }

    var injected = {}; // slug -> true once code is in the page

    // ---- load: install (verify) then inject verified code + mount ----
    async function load(slug, container, hostApi, opts) {
      var r = await install(slug, opts);
      if (!r.ok) return r;
      var pack = r.pack, files = pack.files || {};
      var styleFile = (pack.entrypoints && pack.entrypoints.style) || 'index.css';
      var uiFile = (pack.entrypoints && pack.entrypoints.ui) || 'index.js';
      if (!injected[slug]) {
        if (files[styleFile]) await injectStyle(files[styleFile], slug);
        try { await injectScript(files[uiFile], slug); } catch (e) { return { ok: false, stage: 'inject', reason: e.message }; }
        injected[slug] = true;
      }
      var reg = window.SkipiPlugins && window.SkipiPlugins[slug];
      if (!reg || typeof reg.mount !== 'function') return { ok: false, stage: 'contract', reason: 'plugin did not register window.SkipiPlugins["' + slug + '"]' };
      try { reg.mount(container, hostApi); } catch (e) { return { ok: false, stage: 'mount', reason: e.message }; }
      return { ok: true, source: r.source, manifest: reg.manifest };
    }

    function unload(slug) {
      var reg = window.SkipiPlugins && window.SkipiPlugins[slug];
      if (reg && typeof reg.unmount === 'function') { try { reg.unmount(); } catch (e) {} }
    }

    function isCached(slug) { return !!cache.get('entry:' + slug); }

    return { getCatalog: getCatalog, verifyEntry: verifyEntry, install: install, load: load, unload: unload, isCached: isCached, _cache: cache };
  }

  window.SkipiPluginLoader = { create: createLoader, canonical: canonical, sha256hex: sha256hex, semverGte: semverGte };
})();

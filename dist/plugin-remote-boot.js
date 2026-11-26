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
      typeof window.SkipiPluginHost !== 'object' || !window.SkipiPluginHost ||
      typeof window.SkipiPluginHost.mount !== 'function') {
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

  // A network that does not answer must not hold a launch: the loader falls back to its
  // verified cache when a request fails, so every request is given a time limit.
  var FETCH_TIMEOUT_MS = 5000;
  function timedFetch(url) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, FETCH_TIMEOUT_MS) : null;
    return fetch(url, ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (t) { if (timer) clearTimeout(timer); return t; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  var loader = window.SkipiPluginLoader.create({
    fetch: timedFetch,
    catalogUrl: CFG.catalogUrl, host: CFG.host, policy: CFG.policy,
    pinnedPublicKey: CFG.pinnedPublicKey,
    pinnedPublicKeys: CFG.pinnedPublicKeys,
    bundledVersions: CFG.bundledVersions
  });
  var CENTRAL_KILL_STAGE = 'central_kill_switch';
  var centralDelivery = { checked: false, enabled: true, source: 'default' };
  function catalogObject(res) {
    return res && (res.catalog || res);
  }
  function catalogAllowsDelivery(res) {
    var c = catalogObject(res);
    if (!c) return true;
    if (c.delivery_enabled === false) return false;
    if (c.deliveryEnabled === false) return false;
    if (c.remote_delivery_enabled === false) return false;
    return true;
  }
  function centralDisabledResult() {
    return { ok: false, stage: CENTRAL_KILL_STAGE, reason: 'remote delivery disabled by central catalog flag' };
  }
  function refreshCentralDelivery(opts) {
    return loader.getCatalog(opts || { allowNetwork: true }).then(function (res) {
      var enabled = catalogAllowsDelivery(res);
      centralDelivery = {
        checked: true,
        enabled: enabled,
        source: res && res.source || 'catalog',
        reason: enabled ? '' : 'delivery_enabled=false'
      };
      if (!enabled) {
        try { console.warn('[remote-plugins] disabled by central catalog flag'); } catch (e) {}
      }
      return { enabled: enabled, catalog: catalogObject(res), source: centralDelivery.source };
    }, function (e) {
      // Catalog fetch failure is not a central OFF signal. Keep existing offline
      // behavior for installed/cached plugins and let install/open surface errors.
      centralDelivery = {
        checked: true,
        enabled: true,
        source: 'catalog_unavailable',
        reason: '' + (e && e.message || e)
      };
      return { enabled: true, source: centralDelivery.source, reason: centralDelivery.reason };
    });
  }
  function ensureCentralDelivery(opts) {
    if (centralDelivery.checked && centralDelivery.enabled === false) {
      return Promise.resolve({ enabled: false, source: centralDelivery.source, reason: centralDelivery.reason });
    }
    return refreshCentralDelivery(opts);
  }
  window.SkipiRemoteDeliveryStatus = function () {
    return {
      enabled: centralDelivery.enabled !== false,
      checked: !!centralDelivery.checked,
      source: centralDelivery.source,
      reason: centralDelivery.reason || ''
    };
  };
  refreshCentralDelivery({ allowNetwork: true });
  var REMOTE_REGISTRY_KEY = 'skipi_remote_plugins_state';
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function readRemoteRegistry() {
    try { return JSON.parse(localStorage.getItem(REMOTE_REGISTRY_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeRemoteRegistry(reg) {
    try { localStorage.setItem(REMOTE_REGISTRY_KEY, JSON.stringify(reg || {})); } catch (e) {}
  }
  function forgetRemoteRecord(slug) {
    var reg = readRemoteRegistry();
    if (reg[slug]) delete reg[slug];
    writeRemoteRegistry(reg);
    try { if (currentRemote === slug && runtime) runtime.close(); } catch (e) {}
  }
  function handleInstallResult(slug, res) {
    if (res && res.stage === 'revocation') forgetRemoteRecord(slug);
    return res;
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
    var semverGt = window.SkipiPluginLoader && window.SkipiPluginLoader.semverGt;
    if (typeof semverGt === 'function') {
      return semverGt(nextVersion, currentVersion);
    }
    return String(nextVersion) > String(currentVersion);
  }
  function remoteVersionOlder(nextVersion, currentVersion) {
    if (!nextVersion || !currentVersion) return false;
    var semverGt = window.SkipiPluginLoader && window.SkipiPluginLoader.semverGt;
    if (typeof semverGt === 'function') return semverGt(currentVersion, nextVersion);
    return String(nextVersion) < String(currentVersion);
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
  // A catalog entry may name the platforms it is for (compat.platforms, e.g. ['android','ios']
  // for a plugin that needs the phone's sensors). Elsewhere it is not offered and not installed.
  var HOST_PLATFORM = (function () {
    var ua = '';
    try { ua = String(navigator.userAgent || ''); } catch (e) {}
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'desktop';
  })();
  function platformAllows(entry) {
    var p = entry && entry.compat && entry.compat.platforms;
    return !Array.isArray(p) || !p.length || p.indexOf(HOST_PLATFORM) >= 0;
  }
  window.SkipiRemoteList = function () {
    return ensureCentralDelivery({ allowNetwork: true }).then(function (sw) {
      if (!sw.enabled) return [];
      return ((sw.catalog && sw.catalog.plugins) || []).filter(platformAllows);
    }, function () { return []; });
  };
  // What the runtime may GRANT comes from the SIGNED catalog entry — the same object the
  // policy step judged — never from the pack's own copy: permissions and the network
  // allowlist are taken from the entry, so a pack cannot grant itself more than was checked.
  var runtimeLoader = {
    install: function (slug) {
      // A launch is LOCAL (owner 24.11.2026): the installed pack is taken from the verified
      // cache (signature, policy and checksum are checked again) and is not downloaded on
      // every open. Updates are fetched before this, by SkipiRemoteEnsureLatest. Only an
      // empty or damaged cache goes back to the network.
      return loader.install(slug, { allowNetwork: false }).then(function (r) {
        return (r && r.ok) ? r : loader.install(slug);
      }).then(function (r) {
        if (!r || !r.ok) return r;
        var e = r.entry || {}, caps = e.capabilities || {};
        var pack = {};
        Object.keys(r.pack || {}).forEach(function (k) { if (k !== 'network' && k !== 'permissions') pack[k] = r.pack[k]; });
        pack.permissions = (e.permissions || []).slice();
        if (pack.permissions.indexOf('network') >= 0 && caps.network && Array.isArray(caps.network.allow)) pack.network = { allow: caps.network.allow.slice() };
        return { ok: true, entry: r.entry, pack: pack, source: r.source };
      });
    }
  };
  // ---- motion sensors + keep-awake for plugins (runtime 1.2, grants `motion` / `keep_awake`) ----
  // The plugin frame cannot read sensors. The app reads them natively (commands/motion.rs:
  // Android SensorManager, iOS CoreMotion) and this adapter drains the buffered rows about
  // every 100 ms into the runtime, which forwards them only to the plugin that asked.
  // On desktop there are no sensors: start answers {ok:false, reason:'no-sensors'}.
  function nativeInvoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core || typeof t.core.invoke !== 'function') return Promise.reject(new Error('native bridge unavailable'));
    return t.core.invoke(cmd, args || {});
  }
  var MOTION_DRAIN_MS = 100;
  var motionTimer = null;
  function motionHalt() {
    if (motionTimer) { clearInterval(motionTimer); motionTimer = null; }
    return nativeInvoke('plugin_motion_stop').then(function () {}, function () {});
  }
  var hostMotion = {
    start: function (slug, opts, push) {
      if (motionTimer) { clearInterval(motionTimer); motionTimer = null; }
      return nativeInvoke('plugin_motion_start', { rateHz: opts && opts.rateHz }).then(function (r) {
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'no-sensors' };
        var busy = false;
        motionTimer = setInterval(function () {
          if (busy) return;
          busy = true;
          nativeInvoke('plugin_motion_drain').then(function (rows) {
            busy = false;
            // push() answers false once the plugin that started the sensors is closed
            if (push(Array.isArray(rows) ? rows : []) === false) motionHalt();
          }, function () { busy = false; });
        }, MOTION_DRAIN_MS);
        return { ok: true, rateHz: r.rateHz, source: r.source, platform: r.platform };
      }, function () { return { ok: false, reason: 'no-sensors' }; });
    },
    stop: function () { motionHalt(); }
  };
  var hostScreen = {
    keepAwake: function (slug, on) {
      return nativeInvoke('plugin_keep_awake', { on: !!on }).then(function () { return { ok: true }; }, function () { return { ok: false }; });
    }
  };

  // ---- device capabilities for plugins (runtime 1.3) ----
  // camera / microphone / location are captured HERE, in the host document, and pushed to the
  // runtime; the plugin frame gets no media or geolocation API. Speech and vibration use the
  // WebView where it can, the native command where it cannot (commands/plugin_device.rs).
  function uiLang() { try { return (typeof window.getUiLang === 'function' && window.getUiLang()) || 'en'; } catch (e) { return 'en'; } }
  function pluginTitle(slug) {
    var rec = remoteRecord(slug), n = rec && (rec.name || rec.title);
    if (n && typeof n === 'object') n = n[uiLang()] || n.en || n.ru;
    return String(n || slug);
  }
  // The user is asked once per plugin and capability, before the system's own permission prompt.
  var CONSENT_TEXT = {
    en: { camera: 'use the camera', microphone: 'listen to the microphone', location: 'see your location', q: 'The plugin \u201c{p}\u201d asks to {w}.', note: 'Only while the plugin is open. You can remove the plugin at any time.', yes: 'Allow', no: 'Don\u2019t allow' },
    ru: { camera: '\u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u043a\u0430\u043c\u0435\u0440\u0443', microphone: '\u0441\u043b\u0443\u0448\u0430\u0442\u044c \u043c\u0438\u043a\u0440\u043e\u0444\u043e\u043d', location: '\u0432\u0438\u0434\u0435\u0442\u044c \u0432\u0430\u0448\u0435 \u043c\u0435\u0441\u0442\u043e\u043f\u043e\u043b\u043e\u0436\u0435\u043d\u0438\u0435', q: '\u041f\u043b\u0430\u0433\u0438\u043d \u00ab{p}\u00bb \u043f\u0440\u043e\u0441\u0438\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u044f {w}.', note: '\u0422\u043e\u043b\u044c\u043a\u043e \u043f\u043e\u043a\u0430 \u043f\u043b\u0430\u0433\u0438\u043d \u043e\u0442\u043a\u0440\u044b\u0442. \u041f\u043b\u0430\u0433\u0438\u043d \u043c\u043e\u0436\u043d\u043e \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u0432 \u043b\u044e\u0431\u043e\u0439 \u043c\u043e\u043c\u0435\u043d\u0442.', yes: '\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044c', no: '\u041d\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0442\u044c' }
  };
  function consentKey(slug, cap) { return 'skpd_consent.' + slug + '.' + cap; }
  function askConsent(slug, cap) {
    try { if (localStorage.getItem(consentKey(slug, cap)) === '1') return Promise.resolve(true); } catch (e) {}
    if (typeof window.SkipiPluginConsent === 'function') {          // a home/test override
      return Promise.resolve(window.SkipiPluginConsent(slug, cap)).then(function (yes) {
        if (yes) { try { localStorage.setItem(consentKey(slug, cap), '1'); } catch (e) {} }
        return !!yes;
      });
    }
    return new Promise(function (resolve) {
      var T = CONSENT_TEXT[uiLang()] || CONSENT_TEXT.en;
      var veil = document.createElement('div');
      veil.setAttribute('data-plugin-consent', cap);
      veil.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px');
      var box = document.createElement('div');
      box.setAttribute('style', 'background:#fff;color:#111;border-radius:16px;max-width:420px;width:100%;padding:20px;font:16px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3)');
      var q = document.createElement('div');
      q.setAttribute('style', 'font-weight:700;margin-bottom:8px');
      q.textContent = T.q.replace('{p}', pluginTitle(slug)).replace('{w}', T[cap] || cap);
      var note = document.createElement('div');
      note.setAttribute('style', 'font-size:14px;opacity:.7;margin-bottom:16px');
      note.textContent = T.note;
      var row = document.createElement('div');
      row.setAttribute('style', 'display:flex;gap:10px;justify-content:flex-end');
      function button(text, primary, yes) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = text;
        b.setAttribute('data-plugin-consent-answer', yes ? 'yes' : 'no');
        b.setAttribute('style', 'border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;' + (primary ? 'background:#00455f;color:#fff' : 'background:#e6ebee;color:#111'));
        b.addEventListener('click', function () {
          if (veil.parentNode) veil.parentNode.removeChild(veil);
          if (yes) { try { localStorage.setItem(consentKey(slug, cap), '1'); } catch (e) {} }
          resolve(yes);
        });
        return b;
      }
      row.appendChild(button(T.no, false, false)); row.appendChild(button(T.yes, true, true));
      box.appendChild(q); box.appendChild(note); box.appendChild(row); veil.appendChild(box);
      (document.body || document.documentElement).appendChild(veil);
    });
  }
  function mediaDevices() { try { return (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') ? navigator.mediaDevices : null; } catch (e) { return null; } }
  function refusal(e) {
    var n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || (e && e.code === 1)) return 'denied';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no-device';
    return 'unavailable';
  }
  function stopTracks(stream) { try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {} }
  function bytesToBase64(u8) {
    var out = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  // camera: a hidden <video> on the host document, drawn to a canvas `fps` times a second
  var cam = null;
  function camHalt() {
    var c = cam; cam = null;
    if (!c) return;
    if (c.timer) clearInterval(c.timer);
    if (c.stream) stopTracks(c.stream);
    if (c.video && c.video.parentNode) c.video.parentNode.removeChild(c.video);
  }
  var hostCamera = {
    start: function (slug, o, push) {
      camHalt();
      var md = mediaDevices();
      if (!md) return Promise.resolve({ ok: false, reason: 'unavailable' });
      return askConsent(slug, 'camera').then(function (yes) {
        if (!yes) return { ok: false, reason: 'denied' };
        return md.getUserMedia({ video: { facingMode: o.facing, width: { ideal: o.width } }, audio: false }).then(function (stream) {
          var video = document.createElement('video');
          video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
          video.setAttribute('style', 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none');
          video.srcObject = stream;
          (document.body || document.documentElement).appendChild(video);
          var canvas = document.createElement('canvas');
          var me = cam = { stream: stream, video: video, timer: null };
          try { var pl = video.play(); if (pl && pl.catch) pl.catch(function () {}); } catch (e) {}
          me.timer = setInterval(function () {
            if (cam !== me) return;
            if (document.hidden) return;                       // nothing is captured in the background
            var vw = video.videoWidth, vh = video.videoHeight;
            if (!vw || !vh) return;
            var w = Math.min(o.width, vw), h = Math.round(vh * w / vw);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            var base64 = '';
            try {
              canvas.getContext('2d').drawImage(video, 0, 0, w, h);
              base64 = String(canvas.toDataURL('image/jpeg', o.quality)).split(',')[1] || '';
            } catch (e) { return; }
            if (push({ t: (window.performance && performance.now) ? performance.now() : Date.now(), width: w, height: h, base64: base64 }) === false) camHalt();
          }, Math.max(66, Math.round(1000 / o.fps)));
          return { ok: true, facing: o.facing, width: o.width, fps: o.fps };
        }, function (e) { return { ok: false, reason: refusal(e) }; });
      });
    },
    stop: function () { camHalt(); }
  };

  // microphone: mono 16-bit chunks with their RMS level
  var mic = null;
  function micHalt() {
    var m = mic; mic = null;
    if (!m) return;
    try { m.node.onaudioprocess = null; m.node.disconnect(); m.source.disconnect(); } catch (e) {}
    try { m.ctx.close(); } catch (e) {}
    stopTracks(m.stream);
  }
  var hostMicrophone = {
    start: function (slug, o, push) {
      micHalt();
      var md = mediaDevices(), AC = window.AudioContext || window.webkitAudioContext;
      if (!md || !AC) return Promise.resolve({ ok: false, reason: 'unavailable' });
      return askConsent(slug, 'microphone').then(function (yes) {
        if (!yes) return { ok: false, reason: 'denied' };
        return md.getUserMedia({ audio: true, video: false }).then(function (stream) {
          var ctx = new AC(), source = ctx.createMediaStreamSource(stream), node = ctx.createScriptProcessor(4096, 1, 1);
          var me = mic = { stream: stream, ctx: ctx, source: source, node: node };
          var need = Math.max(1, Math.round(ctx.sampleRate * o.chunkMs / 1000)), buf = new Int16Array(need), fill = 0, sumSq = 0;
          node.onaudioprocess = function (ev) {
            if (mic !== me) return;
            var x = ev.inputBuffer.getChannelData(0);
            for (var i = 0; i < x.length; i++) {
              var v = Math.max(-1, Math.min(1, x[i]));
              buf[fill++] = v < 0 ? v * 0x8000 : v * 0x7fff; sumSq += v * v;
              if (fill === need) {
                var keep = !document.hidden && push({ t: ctx.currentTime * 1000, sampleRate: ctx.sampleRate, level: Math.sqrt(sumSq / need), pcm: bytesToBase64(new Uint8Array(buf.buffer.slice(0))) });
                fill = 0; sumSq = 0;
                if (keep === false && !document.hidden) { micHalt(); return; }
              }
            }
          };
          source.connect(node); node.connect(ctx.destination);      // the node outputs silence
          try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
          return { ok: true, sampleRate: ctx.sampleRate, chunkMs: o.chunkMs };
        }, function (e) { return { ok: false, reason: refusal(e) }; });
      });
    },
    stop: function () { micHalt(); }
  };

  // location: the WebView's geolocation watch
  var geoWatch = null;
  function geoHalt() { if (geoWatch !== null) { try { navigator.geolocation.clearWatch(geoWatch); } catch (e) {} geoWatch = null; } }
  var hostLocation = {
    start: function (slug, o, push) {
      geoHalt();
      var geo = null; try { geo = navigator.geolocation; } catch (e) {}
      if (!geo || typeof geo.watchPosition !== 'function') return Promise.resolve({ ok: false, reason: 'unavailable' });
      return askConsent(slug, 'location').then(function (yes) {
        if (!yes) return { ok: false, reason: 'denied' };
        return new Promise(function (resolve) {
          var answered = false, id = null;
          function answer(v) { if (!answered) { answered = true; resolve(v); } }
          id = geoWatch = geo.watchPosition(function (p) {
            var c = p.coords || {};
            answer({ ok: true });
            if (push({ t: p.timestamp, lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, altitude: c.altitude, speed: c.speed, heading: c.heading }) === false && geoWatch === id) geoHalt();
          }, function (e) {
            if (!answered && geoWatch === id) geoHalt();
            answer({ ok: false, reason: refusal(e) });
          }, { enableHighAccuracy: !!o.highAccuracy, maximumAge: 0, timeout: 30000 });
          // the watch is on; the first fix may take a while outdoors — do not hold the plugin
          setTimeout(function () { answer({ ok: true, pending: true }); }, 1500);
        });
      });
    },
    stop: function () { geoHalt(); }
  };

  // speech: the native engine on Android (its WebView cannot speak), the WebView elsewhere
  function webSpeech() { try { return (window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function') ? window.speechSynthesis : null; } catch (e) { return null; } }
  var hostSpeech = {
    speak: function (slug, r) {
      return nativeInvoke('plugin_speak', { text: r.text, lang: r.lang || null, rate: r.rate, pitch: r.pitch }).then(function (done) { return !!done; }, function () { return false; }).then(function (done) {
        if (done) return { ok: true, engine: 'native' };
        var synth = webSpeech();
        if (!synth) return { ok: false, reason: 'unavailable' };
        try {
          var u = new window.SpeechSynthesisUtterance(r.text);
          if (r.lang) u.lang = r.lang;
          u.rate = r.rate; u.pitch = r.pitch;
          synth.cancel(); synth.speak(u);
          return { ok: true, engine: 'web' };
        } catch (e) { return { ok: false, reason: 'unavailable' }; }
      });
    },
    stop: function () {
      nativeInvoke('plugin_speech_stop').then(function () {}, function () {});
      var synth = webSpeech(); if (synth) { try { synth.cancel(); } catch (e) {} }
    }
  };
  // vibration: the WebView on Android, the system vibration on iOS (one pulse per step)
  var hostHaptics = {
    vibrate: function (slug, pattern) {
      try { if (typeof navigator.vibrate === 'function' && navigator.vibrate(pattern)) return Promise.resolve({ ok: true, engine: 'web' }); } catch (e) {}
      return nativeInvoke('plugin_vibrate', { pattern: pattern }).then(function (done) {
        if (!done) return { ok: false, reason: 'unavailable' };
        var at = 0;
        for (var i = 0; i < pattern.length; i++) {
          if (i > 0 && i % 2 === 0 && pattern[i] > 0) setTimeout(function () { nativeInvoke('plugin_vibrate', { pattern: [1] }).then(function () {}, function () {}); }, at);
          at += pattern[i];
        }
        return { ok: true, engine: 'native' };
      }, function () { return { ok: false, reason: 'unavailable' }; });
    }
  };

  var runtime = window.SkipiPluginRuntime.create({
    enabled: true, loader: runtimeLoader,
    host: {
      // Network for plugins (owner 24.11.2026) — opt-in. The runtime performs the request
      // itself with the host document's fetch, credentials omitted and redirects refused,
      // and only to the plugin's signed allowlist. No host token is ever attached.
      net: {},
      motion: hostMotion,
      screen: hostScreen,
      camera: hostCamera,
      microphone: hostMicrophone,
      location: hostLocation,
      speech: hostSpeech,
      haptics: hostHaptics,
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
    return ensureCentralDelivery({ allowNetwork: opts && opts.allowNetwork }).then(function (sw) {
      if (!sw.enabled) return centralDisabledResult();
      var listed = findCatalogEntry(sw.catalog, slug);
      if (listed && !platformAllows(listed)) return { ok: false, stage: 'platform', reason: 'this plugin works on phones only' };
      return loader.install(slug, opts).then(function (res) {
        if (res && res.ok) persistInstalled(res.entry, res.pack);
        return handleInstallResult(slug, res);
      }, function (e) {
        return { ok: false, stage: 'install', reason: '' + (e && e.message || e) };
      });
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
    return ensureCentralDelivery({ allowNetwork: true }).then(function (sw) {
      if (!sw.enabled) return centralDisabledResult();
      var cat = { catalog: sw.catalog, source: sw.source };
      var entry = findCatalogEntry(cat && cat.catalog, slug);
      if (!entry) return { ok: false, reason: 'not_in_catalog' };
      if (loader.isRevoked && loader.isRevoked(slug, cat.catalog, entry)) {
        var revoked = { ok: false, stage: 'revocation', reason: 'revoked pack: ' + slug + '@' + (entry.version || 'unknown') };
        forgetRemoteRecord(slug);
        if (loader.uninstall) loader.uninstall(slug);
        return revoked;
      }
      var currentVersion = rec.version || (rec.entry && rec.entry.version);
      if (remoteVersionOlder(entry.version, currentVersion)) {
        restorePreviousCatalog();
        return { ok: false, stage: 'downgrade', reason: 'downgrade blocked: ' + entry.version + ' < ' + currentVersion, version: currentVersion };
      }
      if (!remoteVersionNewer(entry.version, currentVersion)) {
        restorePreviousCatalog();
        return { ok: true, updated: false, entry: rec.entry || entry, version: currentVersion || entry.version };
      }
      return loader.install(slug, { allowNetwork: true }).then(function (res) {
        if (res && res.ok) {
          persistInstalled(res.entry, res.pack);
          return { ok: true, updated: true, entry: res.entry, version: res.entry && res.entry.version, source: res.source };
        }
        restorePreviousCatalog();
        return handleInstallResult(slug, res || { ok: false, reason: 'install_failed' });
      });
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

  // ---- no bundled plugins (owner 24.11.2026): every plugin comes from the catalog ----
  // Seafarer used to ship three plugins inside the app. «Старым — как было, новым — пусто»:
  // a user who used them gets them installed from the catalog once (latest version), with
  // the plugin's settings carried over from the old bundled storage; a new user starts with
  // an empty Installed shelf. The decision is taken ONCE and recorded, so a plugin the user
  // removes later never comes back by itself. With no network the plugins stay pending and
  // the run is repeated on the next start / when Apps asks for the catalog.
  var UNBUNDLE_KEY = 'skipi_plugins_unbundled_v1';
  var FORMER_BUNDLED = ['bnwas-time-anchor', 'ecdis-position-reminder', 'navigation-calculators'];
  var LEGACY_STATE_KEY = 'skipi_plugins_state';       // install/enable/last-opened of bundled plugins
  var LEGACY_STORE_PREFIX = 'skipi_plugin_';          // + <slug> + '_' + <key>: the bundled plugin's own data
  function readUnbundle() {
    try { var v = JSON.parse(localStorage.getItem(UNBUNDLE_KEY) || 'null'); return v && Array.isArray(v.pending) ? v : null; } catch (e) { return null; }
  }
  function writeUnbundle(v) { try { localStorage.setItem(UNBUNDLE_KEY, JSON.stringify(v)); } catch (e) {} }
  function legacyKeys() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(LEGACY_STORE_PREFIX) === 0) out.push(k); } } catch (e) {}
    return out;
  }
  function planUnbundle() {
    var st = readUnbundle();
    if (st) return st;
    var legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY) || 'null'); } catch (e) { legacy = null; }
    var keys = legacyKeys();
    // carry the plugins' own data over (never over data the catalog version already holds)
    FORMER_BUNDLED.forEach(function (slug) {
      var pre = LEGACY_STORE_PREFIX + slug + '_';
      keys.forEach(function (k) {
        if (k.indexOf(pre) !== 0) return;
        var name = k.slice(pre.length);
        if (hostStore.get(slug, name) === null) hostStore.set(slug, name, localStorage.getItem(k));
      });
    });
    var used = !!(legacy && typeof legacy === 'object') || keys.length > 0;
    var pending = [];
    if (used) FORMER_BUNDLED.forEach(function (slug) {
      var s = (legacy && legacy[slug]) || {};
      if (s.installed === false) return;              // the user had uninstalled it
      pending.push({ slug: slug, enabled: s.enabled !== false });
    });
    st = { pending: pending, decided_at: nowIso() };
    writeUnbundle(st);
    return st;
  }
  var unbundleRun = null;
  function runUnbundle() {
    if (unbundleRun) return unbundleRun;
    var st = planUnbundle();
    if (!st.pending.length) return Promise.resolve({ ok: true, pending: 0 });
    var queue = st.pending.slice();
    function drop(slug) {
      var cur = readUnbundle() || { pending: [] };
      cur.pending = cur.pending.filter(function (x) { return x.slug !== slug; });
      writeUnbundle(cur);
    }
    function next() {
      var item = queue.shift();
      if (!item) return Promise.resolve();
      if (remoteRecord(item.slug)) { drop(item.slug); return next(); }   // already from the catalog
      return window.SkipiRemoteInstall(item.slug, { allowNetwork: true }).then(function (res) {
        if (res && res.ok) {
          if (item.enabled === false) {
            var reg = readRemoteRegistry();
            if (reg[item.slug]) { reg[item.slug].enabled = false; writeRemoteRegistry(reg); }
          }
          drop(item.slug);
        }
        return next();
      }, function () { return next(); });
    }
    unbundleRun = next().then(function () {
      unbundleRun = null;
      return { ok: true, pending: (readUnbundle() || { pending: [] }).pending.length };
    });
    return unbundleRun;
  }
  window.SkipiRemoteUnbundle = runUnbundle;
  // Apps asks for the catalog when it opens: let a pending move finish first (bounded), so the
  // shelf it renders already has the user's plugins.
  var listBase = window.SkipiRemoteList;
  window.SkipiRemoteList = function () {
    var st = readUnbundle();
    if (st && !st.pending.length) return listBase();
    var bounded = new Promise(function (resolve) {
      var t = setTimeout(resolve, 8000);
      runUnbundle().then(function () { clearTimeout(t); resolve(); }, function () { clearTimeout(t); resolve(); });
    });
    return bounded.then(listBase);
  };
  try { runUnbundle(); } catch (e) {}

  // '*' = catalog-driven: any slug may be remote; whether it IS is decided per mount below
  // (a verified remote install shown by the host). A list keeps the old fixed routing.
  var REMOTE_ALL = CFG.remoteSlugs === '*';
  var REMOTE = REMOTE_ALL ? [] : (CFG.remoteSlugs || []);
  function isRemoteSlug(id) { return REMOTE_ALL || REMOTE.indexOf(id) >= 0; }
  var currentRemote = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
  function msg(title, body) {
    return '<div style="padding:28px 20px;text-align:center;max-width:420px;margin:0 auto;color:inherit">'
      + '<div style="font-size:15px;font-weight:700;margin-bottom:6px">' + esc(title) + '</div>'
      + '<div style="font-size:13px;opacity:.7;line-height:1.4">' + esc(body) + '</div></div>';
  }
  function loadingHtml() { return msg('Loading plugin…', 'Verifying signature and integrity.'); }
  // The host renders the failure surface itself (pluginPlaceholderHtml with our reason),
  // so the remote branch returns {ok:false, reason} instead of silently painting a container.
  // Reasons are whole sentences: the host prints them verbatim to the user.
  function failReason(res) {
    var stage = res && res.stage, reason = (res && res.reason) || '';
    switch (stage) {
      case 'signature': return 'Couldn\u2019t verify this plugin \u2014 signature check failed. Not installed.';
      case 'integrity': return 'Couldn\u2019t verify this plugin \u2014 checksum mismatch. Not installed.';
      case 'revocation': return 'Plugin update blocked \u2014 this package was revoked. Skipi kept it disabled.';
      case 'downgrade': return 'Plugin update blocked \u2014 catalog rollback refused. The latest verified plugin stays cached.';
      case 'platform': return 'This plugin works on a phone only \u2014 it uses the phone\u2019s sensors.';
      case 'compat': return 'Update Skipi to use this plugin \u2014 ' + (reason || 'it needs a newer app version.');
      case 'policy': return reason === 'disabled'
        ? 'This plugin is turned off \u2014 enable it in plugin settings.'
        : 'Plugin not allowed \u2014 it requests permissions Skipi doesn\u2019t allow.';
      case 'catalog':
      case 'install': return 'Can\u2019t reach the plugin catalog \u2014 check your connection and try again. Installed plugins still work offline.';
      case 'timeout': return 'Plugin not responding \u2014 the plugin runtime did not start. Try again.';
      case 'mount': return 'Plugin failed to start \u2014 ' + (reason || 'it could not be opened.');
      default: return 'Plugin unavailable \u2014 ' + (reason || 'could not open this plugin.');
    }
  }

  // ---- route remote plugins through the isolated runtime ----
  // The host mounts through exactly ONE choke point: window.SkipiPluginHost.mount(id, container),
  // called from @skipi/plugin-host-ui's CLOSURE-LOCAL pluginMountInto. Patching the
  // window.pluginMountInto global does not reach that caller: the module copies its closure
  // reference onto window (plugin-host-ui.js globals/attachGlobals) while its own render sites
  // call the closure, so a patch on the global is never invoked and the remote runtime, though
  // constructed, is never driven (SKI No.380, measured 2026-11-05). The interception therefore
  // lives on host.mount - the same seam unmount is patched on below.
  var host = window.SkipiPluginHost;
  var origMount = host.mount;
  function bundledMount(id, container) { return origMount.call(host, id, container); }
  function remoteFailed(res) {
    currentRemote = null;
    host.current = null;
    return { ok: false, reason: failReason(res) };
  }
  function remoteMounted(id) {
    host.current = { id: id };
    // keep the bundled path's bookkeeping: the host records when a plugin was last opened
    try {
      if (typeof window.pluginSetState === 'function' && typeof window.pluginNowIso === 'function') {
        window.pluginSetState(id, { last_opened_at: window.pluginNowIso() });
      }
    } catch (e) {}
    return { ok: true };
  }
  host.mount = function (id, container) {
    // Remote runtime takes over only after a verified remote install exists. Bundled
    // first-party plugins in CFG.remoteSlugs keep their bundled offline baseline until
    // the user explicitly clicks Update.
    // Take over ONLY for what the user is actually looking at. The host decides a plugin's
    // identity with remoteCanOverrideBundled (verified skpd.* cache + semver over the bundled
    // baseline) and exposes the result through pluginById(): an entry with .remote === true.
    // Keying the mount on the raw registry record instead would route an UNVERIFIED remote
    // record to the remote runtime while the tile, metadata and version on screen still say
    // bundled - the same identity split that made No.380 hard to read. One source of truth.
    if (!isRemoteSlug(id)) return bundledMount(id, container);
    var shown = (typeof window.pluginById === 'function') ? window.pluginById(id) : null;
    var takeOver = shown ? shown.remote === true : !!remoteRecord(id);
    if (!takeOver) return bundledMount(id, container);
    if (centralDelivery.checked && centralDelivery.enabled === false) return bundledMount(id, container);
    var el = container || document.getElementById('plugin-host-container');
    if (!el) return Promise.resolve(remoteFailed({ stage: 'mount', reason: 'no container' }));
    if (currentRemote === id && host.current && host.current.id === id) {
      // «Already open» is true only while THIS container still holds the frame. A screen left
      // without host.unmount (top «‹» button) is rendered again with a new, empty container.
      if (typeof el.querySelector === 'function' && el.querySelector('iframe')) return Promise.resolve({ ok: true });
      try { runtime.close(); } catch (e) {}
      host.current = null;
    }
    currentRemote = id;
    if (!remoteEnabled(id)) return Promise.resolve(remoteFailed({ stage: 'policy', reason: 'disabled' }));
    el.innerHTML = loadingHtml();
    return ensureCentralDelivery({ allowNetwork: true }).then(function (sw) {
      if (!sw.enabled) { currentRemote = null; return { bundledFallback: true }; }
      return window.SkipiRemoteEnsureLatest(id).then(function (res) { return res || true; }, function () { return true; });
    }).then(function (refreshRes) {
      if (refreshRes && refreshRes.bundledFallback) return refreshRes;
      if (refreshRes && refreshRes.stage === 'revocation') return refreshRes;
      if (centralDelivery.enabled === false) { currentRemote = null; return { bundledFallback: true }; }
      return runtime.open(id, el, { allowNetwork: false });
    }).then(function (res) {
      if (res && res.bundledFallback) return bundledMount(id, el);
      if (!res || !res.ok) return remoteFailed(res);
      return remoteMounted(id);
    }, function (e) {
      return remoteFailed({ stage: 'mount', reason: '' + (e && e.message || e) });
    });
  };

  // ---- tear down the isolated frame on the host's single unmount entry ----
  var origUnmount = host.unmount;
  host.unmount = function () {
    if (currentRemote) { try { runtime.close(); } catch (e) {} currentRemote = null; host.current = null; }
    return origUnmount ? origUnmount.apply(host, arguments) : undefined;
  };

  try { console.info('[remote-plugins] ON · production catalog · isolated runtime · remote slugs: ' + (REMOTE_ALL ? 'catalog-driven' : REMOTE.join(', '))); } catch (e) {}
})();

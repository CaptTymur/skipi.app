/* ===========================================================================
   BNWAS / Time Anchor — bundled first-party plugin (Seafarer runtime contract)
   ---------------------------------------------------------------------------
   Registers:
     window.SkipiPlugins["bnwas-time-anchor"] = { manifest, mount, unmount }

   mount(container, hostApi):
     - renders the BNWAS UI into `container` (never into document.body)
     - uses hostApi.theme   (get / subscribe)  for light/dark base
     - uses hostApi.storage  (get/set/remove)  for plugin-local settings (namespaced)
     - uses hostApi.navigation.setTitle()      if available
     - generates alarm audio locally via Web Audio (hostApi.audio is no-op in PR #4)

   unmount():
     - stops the countdown ticker
     - stops the alarm loop and closes the audio context
     - removes the keydown listener
     - unsubscribes from host theme
     - empties the container

   Privacy: no network, no documents, no account, no analytics, no server upload.
   Behavior preserved from plugin lab: countdown -> alarm at zero -> alarm
   repeats until Acknowledge -> Acknowledge stops alarm and arms the next cycle.
   =========================================================================== */
(function () {
  'use strict';

  var PLUGIN_KEY = 'bnwas-time-anchor';

  var manifest = {
    id: 'app.skipi.plugins.bnwas-time-anchor',
    slug: 'bnwas-time-anchor',
    name: 'BNWAS / Time Anchor',
    version: '0.1.0',
    developer: 'Tymur Rudov / Skipi',
    kind: 'utility',
    category: 'safety_watchkeeping',
    permissions: ['local_storage', 'audio_alert'],
    capabilities: {
      network: 'none',
      documents: 'none',
      account: 'none',
      analytics: 'none',
      server_upload: false
    },
    safety: {
      certified_equipment: false,
      requires_disclaimer: true
    }
  };

  var PRESETS = [3, 6, 10, 12];   // minutes
  var ESCALATE_AFTER_SEC = 180;   // alarm escalates to level 2 after 3 min unacknowledged
  var STORE_NS = 'bnwas.';        // local-storage namespace fallback

  // --- bilingual copy (EN primary, RU helper) ------------------------------
  var T = {
    sub:        'Personal watchkeeping timer · local only',
    night:      '☾ Night',
    day:        '☀ Day',
    custom:     'Custom · Свой',
    minutesLbl: 'Custom · Свой:',
    minShort:   'мин',
    cycles:     'Cycles · Циклы',
    watchTime:  'Watch time · Вахта',
    start:      'Start watch · Начать вахту',
    ackAlarm:   "I'm here · Я здесь",
    ackAlarm2:  "I'M HERE · Я ЗДЕСЬ",
    ackReset:   "I'm here · reset",
    end:        'End watch · Завершить',
    stReady:    'READY',
    stWatch:    'ON WATCH',
    stAlarm:    'ALARM — ACKNOWLEDGE',
    stAlarm2:   'ALARM — ACKNOWLEDGE NOW',
    capWatch:   'until next check · до следующей отметки',
    capAlarm:   'acknowledge now · подтвердите присутствие',
    safetyEn:   'Personal watchkeeping reminder and training aid only. Not certified bridge equipment. It does not replace the vessel’s BNWAS, alarms, lookout duties, bridge procedures, SMS or master’s standing orders.',
    safetyRu:   'Личное напоминание для несения вахты и учебное пособие. Не является сертифицированным мостиковым оборудованием.'
  };

  var current = null; // the single active instance (mount/unmount are idempotent)

  // ---- normalize host theme into 'light' | 'dark' | null ------------------
  function readHostTheme(hostApi) {
    try {
      if (!hostApi || !hostApi.theme || typeof hostApi.theme.get !== 'function') return null;
      var t = hostApi.theme.get();
      if (!t) return null;
      if (typeof t === 'string') return t.toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
      if (typeof t === 'object') {
        if (typeof t.dark === 'boolean') return t.dark ? 'dark' : 'light';
        if (typeof t.isDark === 'boolean') return t.isDark ? 'dark' : 'light';
        var m = t.mode || t.name || t.scheme;
        if (m) return String(m).toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
      }
    } catch (e) {}
    return null;
  }

  // ---- namespaced storage with localStorage fallback (sync or promise) ----
  function makeStore(hostApi) {
    var hs = hostApi && hostApi.storage;
    var hasHost = hs && typeof hs.get === 'function' && typeof hs.set === 'function';
    return {
      get: function (key, cb) {
        try {
          if (hasHost) {
            var v = hs.get(STORE_NS + key);
            if (v && typeof v.then === 'function') { v.then(function (r) { cb(r); }, function () { cb(null); }); return; }
            cb(v);
            return;
          }
          cb(localStorage.getItem(STORE_NS + key));
        } catch (e) { cb(null); }
      },
      set: function (key, val) {
        try {
          if (hasHost) { hs.set(STORE_NS + key, val); return; }
          localStorage.setItem(STORE_NS + key, val);
        } catch (e) {}
      },
      remove: function (key) {
        try {
          if (hasHost && typeof hs.remove === 'function') { hs.remove(STORE_NS + key); return; }
          localStorage.removeItem(STORE_NS + key);
        } catch (e) {}
      }
    };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // =========================================================================
  // Instance factory — all state, timers, audio and DOM live here so that
  // unmount() can fully tear everything down.
  // =========================================================================
  function createInstance(container, hostApi) {
    var store = makeStore(hostApi);

    var state = {
      stage: 'idle',          // idle | watching | alarming
      intervalMin: 3,
      intervalSecOverride: 0, // test-only fast intervals (seconds)
      remaining: 180,
      cycles: 0,
      totalSec: 0,
      nightMode: true,
      flash: false,
      alarmLevel: 1,
      alarmStartedAt: 0
    };

    var ticker = null;
    var alarmTimer = null;
    var audioCtx = null;
    var startedAt = 0;
    var themeUnsub = null;
    var destroyed = false;

    // DOM refs
    var root, elStatus, elClock, elCaption, elPresets, elCustom, elCustomInput,
        elCycles, elTotal, elControls, elFlash, elNightBtn, elSafety;

    // ----- audio (Web Audio, generated locally; no asset files needed) -----
    function ensureAudio() {
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { audioCtx = null; }
      }
      if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume().catch(function () {}); }
      return audioCtx;
    }
    function playDing(freq, dur, vol) {
      var ctx = ensureAudio();
      if (!ctx) return;
      try {
        var t0 = ctx.currentTime;
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.value = Math.max(0.0001, vol);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + dur + 0.04);
      } catch (e) {}
    }
    function playStandardBurst() {
      var seq = [
        [0.0, 523.25, 0.28], [0.85, 659.25, 0.28], [2.3, 523.25, 0.42],
        [2.7, 659.25, 0.42], [3.1, 784, 0.45], [4.1, 784, 0.62],
        [4.4, 880, 0.68], [4.75, 1046.5, 0.72]
      ];
      seq.forEach(function (x) { schedule(function () { playDing(x[1], 0.42, x[2]); }, x[0] * 1000); });
    }
    function playEscalatedBurst() {
      var seq = [
        [0.0, 380, 0.75], [0.35, 620, 0.80], [0.75, 480, 0.82], [1.1, 850, 0.88],
        [1.5, 620, 0.90], [1.9, 980, 0.92], [2.25, 420, 0.85], [2.6, 1100, 0.95], [3.0, 720, 0.90]
      ];
      seq.forEach(function (x) { schedule(function () { playDing(x[1], 0.38, x[2]); }, x[0] * 1000); });
    }

    // burst timeouts tracked so unmount cancels pending dings too
    var burstTimeouts = [];
    function schedule(fn, ms) {
      var id = setTimeout(function () {
        burstTimeouts = burstTimeouts.filter(function (t) { return t !== id; });
        if (!destroyed) fn();
      }, ms);
      burstTimeouts.push(id);
    }
    function clearBursts() {
      burstTimeouts.forEach(function (id) { clearTimeout(id); });
      burstTimeouts = [];
    }

    function startAlarmLoop(level) {
      stopAlarmLoop();
      if (level === 2) { playEscalatedBurst(); alarmTimer = setInterval(playEscalatedBurst, 3800); }
      else { playStandardBurst(); alarmTimer = setInterval(playStandardBurst, 6200); }
    }
    function stopAlarmLoop() {
      if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
      clearBursts();
    }

    // ----- settings persistence -----
    function saveSettings() {
      store.set('settings', JSON.stringify({ intervalMin: state.intervalMin, nightMode: state.nightMode }));
    }
    function loadSettings(done) {
      store.get('settings', function (raw) {
        if (raw) {
          try {
            var s = JSON.parse(raw);
            if (s && s.intervalMin) { state.intervalMin = s.intervalMin; state.remaining = s.intervalMin * 60; }
            if (s && typeof s.nightMode === 'boolean') state.nightMode = s.nightMode;
          } catch (e) {}
        }
        done();
      });
    }

    // ----- rendering -----
    function build() {
      root = el('div', 'skipi-bnwas');
      root.classList.add(state.nightMode ? 'night' : 'theme-dark');

      var card = el('div', 'bnwas-card');

      var head = el('div', 'bnwas-head');
      var headLeft = el('div', 'bnwas-head-left');
      headLeft.appendChild(el('div', 'bnwas-name', 'BNWAS / Time Anchor'));
      headLeft.appendChild(el('div', 'bnwas-sub', T.sub));
      elNightBtn = el('button', 'bnwas-night-toggle', state.nightMode ? T.night : T.day);
      elNightBtn.type = 'button';
      onClick(elNightBtn, toggleNight);
      head.appendChild(headLeft); head.appendChild(elNightBtn);
      card.appendChild(head);

      elStatus = el('div', 'bnwas-status', T.stReady); card.appendChild(elStatus);
      elClock = el('div', 'bnwas-clock', '00:00'); card.appendChild(elClock);
      elCaption = el('div', 'bnwas-caption', ''); card.appendChild(elCaption);

      elPresets = el('div', 'bnwas-presets'); card.appendChild(elPresets);

      elCustom = el('div', 'bnwas-custom');
      elCustom.appendChild(el('label', null, T.minutesLbl));
      elCustomInput = el('input');
      elCustomInput.type = 'number'; elCustomInput.min = '1'; elCustomInput.max = '300'; elCustomInput.value = '15';
      onEvent(elCustomInput, 'input', onCustomInput);
      onEvent(elCustomInput, 'change', onCustomInput);
      elCustom.appendChild(elCustomInput);
      elCustom.appendChild(el('span', null, T.minShort));
      card.appendChild(elCustom);

      var meta = el('div', 'bnwas-meta');
      var mc = el('span', null, ''); mc.appendChild(document.createTextNode(T.cycles + ' '));
      elCycles = el('b', null, '0'); mc.appendChild(elCycles);
      var mt = el('span', null, ''); mt.appendChild(document.createTextNode(T.watchTime + ' '));
      elTotal = el('b', null, '00:00'); mt.appendChild(elTotal);
      meta.appendChild(mc); meta.appendChild(mt);
      card.appendChild(meta);

      elControls = el('div', 'bnwas-controls'); card.appendChild(elControls);

      elSafety = el('div', 'bnwas-safety');
      var sEn = el('span', null, ''); sEn.appendChild(el('strong', null, 'Safety — '));
      sEn.appendChild(document.createTextNode(T.safetyEn));
      elSafety.appendChild(sEn);
      elSafety.appendChild(el('span', 'ru', T.safetyRu));
      card.appendChild(elSafety);

      elFlash = el('div', 'bnwas-flash'); card.appendChild(elFlash);

      root.appendChild(card);
      container.appendChild(root);
    }

    function renderPresets() {
      elPresets.innerHTML = '';
      var isCustom = PRESETS.indexOf(state.intervalMin) < 0;
      PRESETS.forEach(function (min) {
        var b = el('button', 'bnwas-preset' + (state.intervalMin === min ? ' active' : ''), min + 'm');
        b.type = 'button';
        if (state.stage !== 'idle') b.disabled = true;
        onClick(b, function () {
          if (state.stage !== 'idle') return;
          state.intervalMin = min; state.intervalSecOverride = 0; state.remaining = min * 60;
          saveSettings(); elCustom.style.display = 'none'; updateUI();
        });
        elPresets.appendChild(b);
      });
      var cb = el('button', 'bnwas-preset' + (isCustom ? ' active' : ''), T.custom);
      cb.type = 'button';
      if (state.stage !== 'idle') cb.disabled = true;
      onClick(cb, function () {
        if (state.stage !== 'idle') return;
        elCustom.style.display = 'flex';
        if (!isCustom) elCustomInput.value = '15';
        elCustomInput.focus(); elCustomInput.select();
        onCustomInput();
      });
      elPresets.appendChild(cb);
    }

    function onCustomInput() {
      if (state.stage !== 'idle') return;
      var v = parseInt(elCustomInput.value, 10);
      if (isNaN(v)) v = 15;
      v = Math.max(1, Math.min(300, v));
      state.intervalMin = v; state.intervalSecOverride = 0; state.remaining = v * 60;
      saveSettings(); updateUI();
    }

    function renderControls() {
      elControls.innerHTML = '';
      if (state.stage === 'idle') {
        var start = el('button', 'accent', T.start); start.type = 'button';
        onClick(start, startWatch); elControls.appendChild(start);
      } else {
        var isAlarm = state.stage === 'alarming';
        var ack = el('button', 'accent acknowledge' + (isAlarm ? ' alerting' : ''),
          isAlarm ? (state.alarmLevel === 2 ? T.ackAlarm2 : T.ackAlarm) : T.ackReset);
        ack.type = 'button';
        onClick(ack, acknowledge); elControls.appendChild(ack);

        var end = el('button', 'outline', T.end); end.type = 'button';
        onClick(end, endWatch); elControls.appendChild(end);
      }
    }

    function updateUI() {
      if (destroyed || !root) return;
      var alarming = state.stage === 'alarming';
      root.classList.toggle('night', state.nightMode);
      root.classList.toggle('alarming', alarming);
      root.classList.toggle('alarm-level-2', alarming && state.alarmLevel === 2);

      elStatus.textContent = state.stage === 'idle' ? T.stReady
        : state.stage === 'watching' ? T.stWatch
        : state.alarmLevel === 2 ? T.stAlarm2 : T.stAlarm;

      elClock.textContent = state.stage === 'watching' ? fmt(state.remaining) : '00:00';

      elCaption.textContent = state.stage === 'idle'
        ? 'Interval ' + state.intervalMin + ' min · Интервал ' + state.intervalMin + ' мин'
        : state.stage === 'watching' ? T.capWatch : T.capAlarm;

      elCycles.textContent = String(state.cycles);
      elTotal.textContent = fmt(state.totalSec);

      elFlash.classList.toggle('on', alarming && state.flash);
      elFlash.classList.toggle('hard', alarming && state.alarmLevel === 2);
      if (elNightBtn) elNightBtn.textContent = state.nightMode ? T.night : T.day;

      renderPresets();
      renderControls();
    }

    // ----- state machine -----
    function intervalSeconds() {
      return state.intervalSecOverride > 0 ? state.intervalSecOverride : state.intervalMin * 60;
    }
    function startWatch() {
      if (state.stage !== 'idle') return;
      ensureAudio(); // unlock audio on the user gesture
      startedAt = Date.now();
      state.stage = 'watching';
      state.remaining = intervalSeconds();
      state.flash = false; state.alarmLevel = 1; state.alarmStartedAt = 0;
      stopAlarmLoop(); startTicker(); updateUI();
    }
    function startTicker() {
      if (ticker) clearInterval(ticker);
      ticker = setInterval(tick, 1000);
    }
    function tick() {
      var now = Date.now();
      state.totalSec = Math.floor((now - startedAt) / 1000);
      if (state.stage === 'watching') {
        state.remaining--;
        if (state.remaining <= 0) enterAlarming();
      } else if (state.stage === 'alarming') {
        var inAlarm = Math.floor((now - state.alarmStartedAt) / 1000);
        if (inAlarm >= ESCALATE_AFTER_SEC && state.alarmLevel === 1) {
          state.alarmLevel = 2; startAlarmLoop(2);
        }
      }
      updateUI();
    }
    function enterAlarming() {
      state.stage = 'alarming';
      state.remaining = 0; state.flash = true;
      state.alarmLevel = 1; state.alarmStartedAt = Date.now();
      startAlarmLoop(1); updateUI();
    }
    function acknowledge() {
      if (state.stage === 'idle') return;
      stopAlarmLoop();
      if (state.stage === 'alarming') state.cycles++;
      state.stage = 'watching';
      state.remaining = intervalSeconds();
      state.flash = false; state.alarmLevel = 1; state.alarmStartedAt = 0;
      updateUI();
    }
    function endWatch() {
      stopAlarmLoop();
      if (ticker) { clearInterval(ticker); ticker = null; }
      startedAt = 0;
      state.stage = 'idle';
      state.remaining = intervalSeconds();
      state.flash = false; state.totalSec = 0; state.cycles = 0;
      state.alarmLevel = 1; state.alarmStartedAt = 0;
      updateUI();
    }
    function toggleNight() {
      state.nightMode = !state.nightMode;
      saveSettings(); updateUI();
    }

    // ----- listeners (tracked for clean removal) -----
    var listeners = [];
    function onEvent(node, type, fn) { node.addEventListener(type, fn); listeners.push([node, type, fn]); }
    function onClick(node, fn) { onEvent(node, 'click', fn); }

    function onKeydown(e) {
      var k = (e.key || '').toLowerCase();
      if (k === 'a' && state.stage !== 'idle') acknowledge();
      if (e.key === 'Escape' && state.stage !== 'idle') endWatch();
    }

    // ----- host theme -----
    function applyHostTheme(theme) {
      if (!root || !theme) return;
      root.classList.toggle('theme-light', theme === 'light');
      root.classList.toggle('theme-dark', theme === 'dark');
      // default night watch to follow a dark host theme on first apply
    }

    // ----- lifecycle -----
    function start() {
      loadSettings(function () {
        build();
        var theme = readHostTheme(hostApi);
        if (theme) { applyHostTheme(theme); if (theme === 'light') state.nightMode = false; }
        if (PRESETS.indexOf(state.intervalMin) < 0) {
          elCustom.style.display = 'flex';
          elCustomInput.value = String(state.intervalMin);
        }
        updateUI();

        onEvent(document, 'keydown', onKeydown);

        if (hostApi && hostApi.theme && typeof hostApi.theme.subscribe === 'function') {
          try {
            var unsub = hostApi.theme.subscribe(function (t) {
              var nt = (typeof t === 'string' || (t && typeof t === 'object')) ? normalizeTheme(t) : readHostTheme(hostApi);
              applyHostTheme(nt); updateUI();
            });
            if (typeof unsub === 'function') themeUnsub = unsub;
          } catch (e) {}
        }
        if (hostApi && hostApi.navigation && typeof hostApi.navigation.setTitle === 'function') {
          try { hostApi.navigation.setTitle('BNWAS / Time Anchor'); } catch (e) {}
        }
      });
    }

    function normalizeTheme(t) {
      if (typeof t === 'string') return t.toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
      if (t && typeof t === 'object') {
        if (typeof t.dark === 'boolean') return t.dark ? 'dark' : 'light';
        if (typeof t.isDark === 'boolean') return t.isDark ? 'dark' : 'light';
        var m = t.mode || t.name || t.scheme;
        if (m) return String(m).toLowerCase().indexOf('light') >= 0 ? 'light' : 'dark';
      }
      return null;
    }

    function destroy() {
      destroyed = true;
      stopAlarmLoop();
      if (ticker) { clearInterval(ticker); ticker = null; }
      listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2]); } catch (e) {} });
      listeners = [];
      if (themeUnsub) { try { themeUnsub(); } catch (e) {} themeUnsub = null; }
      if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
      if (root && root.parentNode) { try { root.parentNode.removeChild(root); } catch (e) {} }
      try { container.innerHTML = ''; } catch (e) {}
      root = null;
    }

    // ----- test handle (only exposed when a harness opts in) -----
    var testApi = {
      setIntervalSeconds: function (n) {
        state.intervalSecOverride = Math.max(1, n | 0);
        if (state.stage === 'idle') state.remaining = state.intervalSecOverride;
        updateUI();
      },
      forceExpire: function () { if (state.stage === 'watching') enterAlarming(); },
      forceEscalate: function () {
        if (state.stage === 'alarming' && state.alarmLevel === 1) { state.alarmLevel = 2; startAlarmLoop(2); updateUI(); }
      },
      startWatch: startWatch,
      acknowledge: acknowledge,
      endWatch: endWatch,
      isAlarmAudioActive: function () { return !!alarmTimer; },
      snapshot: function () {
        return {
          stage: state.stage, remaining: state.remaining, cycles: state.cycles,
          alarmLevel: state.alarmLevel, nightMode: state.nightMode,
          themeLight: !!(root && root.classList.contains('theme-light'))
        };
      }
    };

    return { start: start, destroy: destroy, testApi: testApi };
  }

  // =========================================================================
  function mount(container, hostApi) {
    if (!container) throw new Error('[bnwas-time-anchor] mount requires a container element');
    if (current) { try { unmount(); } catch (e) {} }
    var inst = createInstance(container, hostApi || {});
    current = inst;
    inst.start();
    // expose test handle only if a harness explicitly opted in
    if (typeof window !== 'undefined' && window.__SKIPI_PLUGIN_TEST__) {
      window.SkipiPlugins[PLUGIN_KEY].__test = inst.testApi;
    }
  }

  function unmount() {
    if (!current) return;
    try { current.destroy(); } catch (e) {}
    current = null;
    if (window.SkipiPlugins && window.SkipiPlugins[PLUGIN_KEY]) {
      try { delete window.SkipiPlugins[PLUGIN_KEY].__test; } catch (e) {}
    }
  }

  window.SkipiPlugins = window.SkipiPlugins || {};
  window.SkipiPlugins[PLUGIN_KEY] = { manifest: manifest, mount: mount, unmount: unmount };
})();

/* ===========================================================================
   ECDIS Position Reminder - bundled first-party plugin.
   Registers window.SkipiPlugins["ecdis-position-reminder"].
   No network, no document access, no direct host storage.
   =========================================================================== */
(function () {
  'use strict';

  var KEY = 'ecdis-position-reminder';
  var MANIFEST = {"id":"app.skipi.plugins.ecdis-position-reminder","slug":"ecdis-position-reminder","name":"ECDIS Position Reminder","version":"0.1.0","developer":"Tymur Rudov / Skipi","kind":"utility","category":"safety_watchkeeping","distribution":{"mode":"bundled_first_party","bundled":true,"remote_code":false},"hosts":["seafarer","onboard"],"entrypoints":{"ui":"index.js","style":"index.css"},"permissions":["local_storage","audio_alert"],"capabilities":{"network":"none","documents":"none","account":"none","analytics":"none","server_upload":false},"safety":{"certified_equipment":false,"requires_disclaimer":true,"disclaimer":"Personal position-fix reminder and training aid only. Not certified bridge equipment. Does not replace ECDIS, paper chart procedures, bridge log entries, watchkeeping duties, SMS, or master's standing orders."}};
  var STORE_KEY = 'state.v1';
  var LOG_LIMIT = 8;
  var PRESETS = [15, 30, 60];

  var root = null;
  var hostApi = null;
  var tickTimer = null;
  var alarmTimer = null;
  var audioCtx = null;
  var alarmLevel = 0;
  var mountedContainer = null;

  var state = {
    running: false,
    intervalMin: 60,
    alignToClock: true,
    nightMode: false,
    nextDue: null,
    startedAt: null,
    lastAck: null,
    cycles: 0,
    log: []
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function nowMs() {
    return Date.now();
  }

  function pad(n) {
    return String(n < 10 ? '0' + n : n);
  }

  function fmtClock(ms) {
    if (!ms) return '--:--';
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtCountdown(ms) {
    if (!isFinite(ms)) return '--:--';
    if (ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function nextClockBoundary(intervalMin) {
    var d = new Date();
    d.setSeconds(0, 0);
    var interval = Math.max(1, Number(intervalMin) || 60);
    var minute = d.getMinutes();
    var nextMinute = Math.ceil((minute + 0.0001) / interval) * interval;
    if (nextMinute >= 60) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else {
      d.setMinutes(nextMinute, 0, 0);
    }
    if (d.getTime() <= nowMs()) d = new Date(d.getTime() + interval * 60000);
    return d.getTime();
  }

  function nextFromNow(intervalMin) {
    return nowMs() + Math.max(1, Number(intervalMin) || 60) * 60000;
  }

  function scheduleNext() {
    state.nextDue = state.alignToClock ? nextClockBoundary(state.intervalMin) : nextFromNow(state.intervalMin);
  }

  function storageGet(k) {
    try {
      if (!hostApi || !hostApi.storage || !hostApi.storage.get) return Promise.resolve(null);
      var v = hostApi.storage.get(k);
      if (v && typeof v.then === 'function') return v;
      return Promise.resolve(v);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function storageSet(k, v) {
    try {
      if (hostApi && hostApi.storage && hostApi.storage.set) hostApi.storage.set(k, v);
    } catch (e) {}
  }

  function save() {
    storageSet(STORE_KEY, JSON.stringify({
      intervalMin: state.intervalMin,
      alignToClock: state.alignToClock,
      nightMode: state.nightMode,
      nextDue: state.nextDue,
      startedAt: state.startedAt,
      lastAck: state.lastAck,
      running: state.running,
      cycles: state.cycles,
      log: state.log
    }));
  }

  function load() {
    return storageGet(STORE_KEY).then(function (raw) {
      if (!raw) return;
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          Object.keys(state).forEach(function (k) {
            if (Object.prototype.hasOwnProperty.call(parsed, k)) state[k] = parsed[k];
          });
          state.intervalMin = clampInterval(state.intervalMin);
          state.log = Array.isArray(state.log) ? state.log.slice(0, LOG_LIMIT) : [];
        }
      } catch (e) {}
    });
  }

  function clampInterval(v) {
    var n = Math.round(Number(v) || 60);
    if (n < 1) n = 1;
    if (n > 180) n = 180;
    return n;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    var b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function setTitle() {
    try {
      if (hostApi && hostApi.navigation && hostApi.navigation.setTitle) {
        hostApi.navigation.setTitle('ECDIS Position Reminder');
      }
    } catch (e) {}
  }

  function ensureAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function beep(level) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var t = ctx.currentTime;
    var gain = ctx.createGain();
    var osc = ctx.createOscillator();
    var freq = level > 1 ? 1040 : 740;
    var dur = level > 1 ? 0.36 : 0.22;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(level > 1 ? 0.18 : 0.12, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.type = level > 1 ? 'square' : 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function startAlarm() {
    if (alarmTimer) return;
    alarmLevel = 1;
    beep(alarmLevel);
    alarmTimer = setInterval(function () {
      var overdue = state.nextDue ? nowMs() - state.nextDue : 0;
      alarmLevel = overdue > 180000 ? 2 : 1;
      beep(alarmLevel);
      updateDynamic();
    }, 3500);
    render();
  }

  function stopAlarm() {
    if (alarmTimer) clearInterval(alarmTimer);
    alarmTimer = null;
    alarmLevel = 0;
  }

  function addLog(kind, atMs) {
    var item = {
      kind: kind,
      at: new Date(atMs || nowMs()).toISOString(),
      due: state.nextDue ? new Date(state.nextDue).toISOString() : null
    };
    state.log.unshift(item);
    state.log = state.log.slice(0, LOG_LIMIT);
  }

  function startWatch() {
    ensureAudio();
    state.running = true;
    state.startedAt = state.startedAt || new Date().toISOString();
    scheduleNext();
    stopAlarm();
    save();
    render();
  }

  function endWatch() {
    stopAlarm();
    state.running = false;
    state.nextDue = null;
    state.startedAt = null;
    save();
    render();
  }

  function acknowledge() {
    ensureAudio();
    var t = nowMs();
    stopAlarm();
    state.lastAck = new Date(t).toISOString();
    state.cycles += 1;
    addLog('fixed', t);
    scheduleNext();
    save();
    render();
  }

  function snooze() {
    ensureAudio();
    stopAlarm();
    state.nextDue = nowMs() + 5 * 60000;
    addLog('snooze', nowMs());
    save();
    render();
  }

  function setIntervalMin(v) {
    state.intervalMin = clampInterval(v);
    if (state.running) scheduleNext();
    save();
    render();
  }

  function setAlign(v) {
    state.alignToClock = !!v;
    if (state.running) scheduleNext();
    save();
    render();
  }

  function toggleNight() {
    state.nightMode = !state.nightMode;
    save();
    render();
  }

  function isDue() {
    return !!(state.running && state.nextDue && nowMs() >= state.nextDue);
  }

  function statusLabel() {
    if (alarmTimer || isDue()) return 'POSITION FIX DUE';
    if (state.running) return 'WATCH RUNNING';
    return 'STANDBY';
  }

  function makePresets() {
    var wrap = el('div', 'epr-segment');
    PRESETS.forEach(function (min) {
      var b = button('epr-segment-btn' + (state.intervalMin === min ? ' active' : ''), min + 'm', function () {
        setIntervalMin(min);
      });
      wrap.appendChild(b);
    });
    var custom = el('label', 'epr-custom');
    custom.appendChild(el('span', '', 'Custom'));
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '180';
    input.value = String(state.intervalMin);
    input.addEventListener('change', function () { setIntervalMin(input.value); });
    custom.appendChild(input);
    wrap.appendChild(custom);
    return wrap;
  }

  function makeMode() {
    var wrap = el('div', 'epr-segment two');
    wrap.appendChild(button('epr-segment-btn' + (state.alignToClock ? ' active' : ''), 'Clock marks', function () { setAlign(true); }));
    wrap.appendChild(button('epr-segment-btn' + (!state.alignToClock ? ' active' : ''), 'From now', function () { setAlign(false); }));
    return wrap;
  }

  function makeControls() {
    var wrap = el('div', 'epr-controls');
    if (!state.running) {
      wrap.appendChild(button('epr-primary', 'Start watch', startWatch));
      wrap.appendChild(button('epr-secondary', 'Test tone', function () { ensureAudio(); beep(1); }));
      return wrap;
    }
    if (alarmTimer || isDue()) {
      wrap.appendChild(button('epr-primary alert', 'Position fixed', acknowledge));
      wrap.appendChild(button('epr-secondary', 'Snooze 5m', snooze));
      wrap.appendChild(button('epr-secondary', 'End watch', endWatch));
      return wrap;
    }
    wrap.appendChild(button('epr-primary', 'Position fixed', acknowledge));
    wrap.appendChild(button('epr-secondary', 'Test tone', function () { ensureAudio(); beep(1); }));
    wrap.appendChild(button('epr-secondary', 'End watch', endWatch));
    return wrap;
  }

  function makeLog() {
    var wrap = el('div', 'epr-log');
    wrap.appendChild(el('div', 'epr-section-title', 'Recent marks'));
    if (!state.log.length) {
      wrap.appendChild(el('div', 'epr-empty', 'No marks yet'));
      return wrap;
    }
    state.log.forEach(function (item) {
      var row = el('div', 'epr-log-row');
      var at = item.at ? new Date(item.at) : null;
      row.appendChild(el('span', 'epr-log-kind', item.kind === 'snooze' ? 'Snoozed' : 'Fixed'));
      row.appendChild(el('span', 'epr-log-time', at ? fmtClock(at.getTime()) : '--:--'));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function render() {
    if (!mountedContainer) return;
    setTitle();
    mountedContainer.innerHTML = '';
    root = el('div', 'skipi-epr' + (state.nightMode ? ' night' : '') + ((alarmTimer || isDue()) ? ' alarming level-' + alarmLevel : ''));

    var head = el('div', 'epr-head');
    var title = el('div', 'epr-titlebox');
    title.appendChild(el('div', 'epr-name', 'ECDIS Position Reminder'));
    title.appendChild(el('div', 'epr-sub', 'Position fix timer'));
    head.appendChild(title);
    head.appendChild(button('epr-night', state.nightMode ? 'Day' : 'Night', toggleNight));
    root.appendChild(head);

    root.appendChild(el('div', 'epr-status', statusLabel()));
    root.appendChild(el('div', 'epr-clock', state.running ? fmtCountdown((state.nextDue || nowMs()) - nowMs()) : '--:--'));

    var meta = el('div', 'epr-meta');
    meta.appendChild(el('span', '', 'Next ' + (state.nextDue ? fmtClock(state.nextDue) : '--:--')));
    meta.appendChild(el('span', '', 'Interval ' + state.intervalMin + 'm'));
    meta.appendChild(el('span', '', 'Marks ' + state.cycles));
    root.appendChild(meta);

    var settings = el('div', 'epr-settings');
    var intervalBlock = el('div', 'epr-setting-block');
    intervalBlock.appendChild(el('div', 'epr-section-title', 'Interval'));
    intervalBlock.appendChild(makePresets());
    settings.appendChild(intervalBlock);
    var modeBlock = el('div', 'epr-setting-block');
    modeBlock.appendChild(el('div', 'epr-section-title', 'Schedule'));
    modeBlock.appendChild(makeMode());
    settings.appendChild(modeBlock);
    root.appendChild(settings);

    root.appendChild(makeControls());
    root.appendChild(makeLog());
    root.appendChild(el('div', 'epr-safety', 'Personal reminder only. Verify position fixing against approved bridge procedures.'));

    mountedContainer.appendChild(root);
    updateDynamic();
  }

  function updateDynamic() {
    if (!root) return;
    var clock = root.querySelector('.epr-clock');
    var status = root.querySelector('.epr-status');
    if (clock) clock.textContent = state.running ? fmtCountdown((state.nextDue || nowMs()) - nowMs()) : '--:--';
    if (status) status.textContent = statusLabel();
    root.className = 'skipi-epr' + (state.nightMode ? ' night' : '') + ((alarmTimer || isDue()) ? ' alarming level-' + alarmLevel : '');
  }

  function tick() {
    if (state.running && state.nextDue && nowMs() >= state.nextDue && !alarmTimer) {
      startAlarm();
      return;
    }
    updateDynamic();
  }

  function mount(container, api) {
    if (!container) throw new Error('[ecdis-position-reminder] mount requires a container');
    mountedContainer = container;
    hostApi = api || {};
    window.SkipiPlugins[KEY].__test = {
      snapshot: function () { return clone({ state: state, alarming: !!alarmTimer, text: mountedContainer.textContent || '' }); },
      forceDue: function () { state.running = true; state.nextDue = nowMs() - 1000; tick(); },
      acknowledge: acknowledge
    };
    load().then(function () {
      render();
      tickTimer = setInterval(tick, 1000);
    });
  }

  function unmount() {
    stopAlarm();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (audioCtx && audioCtx.close) {
      try { audioCtx.close(); } catch (e) {}
    }
    audioCtx = null;
    if (mountedContainer) mountedContainer.innerHTML = '';
    mountedContainer = null;
    root = null;
    try { delete window.SkipiPlugins[KEY].__test; } catch (e) {}
  }

  window.SkipiPlugins = window.SkipiPlugins || {};
  window.SkipiPlugins[KEY] = { manifest: MANIFEST, mount: mount, unmount: unmount };
})();

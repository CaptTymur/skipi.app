/*!
 * @skipi/assistant — generic, home-agnostic chat Assistant overlay for all
 * Skipi homes (Seafarer / Broker / Crewing / On Board / Ship Management).
 *
 * Framework-free (vanilla, like @skipi/settings). The module owns the chat UI
 * (message list, composer, statuses, history) and NOTHING about transport or
 * business logic: every side-effect goes through the HOST CONTRACT (see
 * CONTRACT.md). The host decides how a message reaches the backend — in a Skipi
 * home that is the existing Tauri `assistant_chat` proxy to the production
 * assistant backend over HTTPS; in the browser harness it can be a mock or a
 * direct HTTPS call. The module never talks to the network itself.
 *
 * Policy №108 (LIVE, owner 2026-08-08): the Assistant UI must NOT disclose
 * Skipi's internal architecture (bot / brain / KB / model / timings) and must
 * NOT offer consultations or training, nor show consult/training CTAs. All
 * user-facing copy in this file is written to that policy; negative tests in
 * tests/policy-108.test.mjs enforce it.
 *
 * Default theme is LIGHT (Skipi canon). Theme is applied by the host via
 * host.applyTheme(theme) → the module toggles a data attribute; CSS variables
 * default to light and only switch to dark when data-skipi-assistant-theme
 * ="dark" is set.
 */
'use strict';

var VERSION = '0.1.0';

(function (global) {
  var NS = 'skipi-assistant';

  // ── i18n fallbacks. The host may override every key via host.getI18n(key);
  // when it returns null/undefined the module falls back to these strings.
  // NONE of these mention internal architecture or consultations (policy №108).
  var I18N = {
    en: {
      'assistant.title': 'Assistant',
      'assistant.subtitle': 'Maritime helper',
      'assistant.empty.title': 'How can I help?',
      'assistant.empty.sub': 'Ask about your certificates, sea service, documents or maritime paperwork.',
      'assistant.placeholder': 'Type your question…',
      'assistant.send': 'Send',
      'assistant.clear': 'Clear',
      'assistant.close': 'Close',
      'assistant.thinking': 'Working on it…',
      'assistant.thinking.long': 'Still working…',
      'assistant.role.you': 'You',
      'assistant.role.assistant': 'Skipi',
      'assistant.error.generic': 'Could not reach the assistant. Check your connection and try again.',
      'assistant.error.limit': 'You have reached today’s free limit. Please come back tomorrow.',
      'assistant.error.setup': 'The assistant is being set up — please try again later.',
      'assistant.suggest.1': 'Which of my certificates expire soon?',
      'assistant.suggest.2': 'What documents do I need for a new contract?',
      'assistant.suggest.3': 'Summarise my sea service.'
    },
    ru: {
      'assistant.title': 'Ассистент',
      'assistant.subtitle': 'Помощник моряка',
      'assistant.empty.title': 'Чем помочь?',
      'assistant.empty.sub': 'Спросите про сертификаты, морской стаж, документы.',
      'assistant.placeholder': 'Ваш вопрос…',
      'assistant.send': 'Отправить',
      'assistant.clear': 'Очистить',
      'assistant.close': 'Закрыть',
      'assistant.thinking': 'Думаю…',
      'assistant.thinking.long': 'Всё ещё думаю…',
      'assistant.role.you': 'Вы',
      'assistant.role.assistant': 'Skipi',
      'assistant.error.generic': 'Не удалось связаться с ассистентом. Проверьте интернет и попробуйте снова.',
      'assistant.error.limit': 'Достигнут дневной лимит бесплатных запросов. Возвращайтесь завтра.',
      'assistant.error.setup': 'Ассистент ещё настраивается — попробуйте позже.',
      'assistant.suggest.1': 'Какие сертификаты скоро истекают?',
      'assistant.suggest.2': 'Какие документы нужны для нового контракта?',
      'assistant.suggest.3': 'Кратко о моём морском стаже.'
    }
  };

  function defaultI18n(key, locale) {
    var loc = (locale || 'en').slice(0, 2).toLowerCase();
    var table = I18N[loc] || I18N.en;
    return table[key] != null ? table[key] : (I18N.en[key] != null ? I18N.en[key] : key);
  }

  // ── tiny DOM helpers (no framework) ──
  function h(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function isPromise(v) { return v && typeof v.then === 'function'; }

  /**
   * Mount the Assistant into `container`. Returns an instance with methods:
   *   focus(), clear(), destroy(), applyTheme(theme), isBusy().
   * `host` implements the host contract (see CONTRACT.md). All host methods are
   * optional except sendMessage; sensible defaults are used when absent.
   */
  function mount(container, host) {
    if (!container) throw new Error('[skipi-assistant] mount: container required');
    host = host || {};
    if (typeof host.sendMessage !== 'function') {
      throw new Error('[skipi-assistant] host.sendMessage(text) is required');
    }

    var ctx = (typeof host.getContext === 'function' && host.getContext()) || {};
    var surface = ctx.surface === 'mobile' ? 'mobile' : 'desktop';
    var locale = ctx.locale || 'en';

    function t(key) {
      if (typeof host.getI18n === 'function') {
        var v = host.getI18n(key);
        if (v != null) return v;
      }
      return defaultI18n(key, locale);
    }

    // history is owned by the host if it provides getHistory/persistHistory,
    // otherwise kept only in memory for this session.
    var messages = [];
    if (typeof host.getHistory === 'function') {
      try {
        var h0 = host.getHistory();
        if (Array.isArray(h0)) messages = h0.slice();
      } catch (e) { messages = []; }
    }
    var busy = false;

    // ── build DOM ──
    var root = h('div', NS + ' ' + NS + '--' + surface);
    root.setAttribute('data-skipi-assistant', VERSION);

    var head = h('div', NS + '__head');
    var titleWrap = h('div', NS + '__title-wrap');
    var title = h('div', NS + '__title'); title.textContent = t('assistant.title');
    var sub = h('div', NS + '__sub'); sub.textContent = t('assistant.subtitle');
    titleWrap.appendChild(title); titleWrap.appendChild(sub);
    var actions = h('div', NS + '__head-actions');
    var clearBtn = h('button', NS + '__btn ' + NS + '__btn--ghost', { type: 'button' });
    clearBtn.textContent = t('assistant.clear');
    actions.appendChild(clearBtn);
    if (typeof host.onClose === 'function') {
      var closeBtn = h('button', NS + '__btn ' + NS + '__btn--ghost ' + NS + '__close', { type: 'button', 'aria-label': t('assistant.close') });
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function () { try { host.onClose(); } catch (e) {} });
      actions.appendChild(closeBtn);
    }
    head.appendChild(titleWrap); head.appendChild(actions);

    var stream = h('div', NS + '__stream', { role: 'log', 'aria-live': 'polite' });

    var composer = h('form', NS + '__composer');
    var textarea = h('textarea', NS + '__input', { rows: '1', placeholder: t('assistant.placeholder'), 'aria-label': t('assistant.placeholder') });
    var sendBtn = h('button', NS + '__send', { type: 'submit', 'aria-label': t('assistant.send') });
    sendBtn.textContent = '➤';
    composer.appendChild(textarea); composer.appendChild(sendBtn);

    root.appendChild(head); root.appendChild(stream); root.appendChild(composer);
    container.appendChild(root);

    // theme: default light; host may set dark.
    applyTheme((ctx.theme) || 'light');

    function applyTheme(theme) {
      root.setAttribute('data-skipi-assistant-theme', theme === 'dark' ? 'dark' : 'light');
    }

    function fmt(text) {
      // plain text only (textContent) — no HTML injection from replies.
      return String(text == null ? '' : text);
    }

    function renderEmpty() {
      var wrap = h('div', NS + '__empty');
      var et = h('div', NS + '__empty-title'); et.textContent = t('assistant.empty.title');
      var es = h('div', NS + '__empty-sub'); es.textContent = t('assistant.empty.sub');
      wrap.appendChild(et); wrap.appendChild(es);
      var sugg = h('div', NS + '__suggest');
      ['assistant.suggest.1', 'assistant.suggest.2', 'assistant.suggest.3'].forEach(function (k) {
        var s = t(k);
        if (!s) return;
        var chip = h('button', NS + '__chip', { type: 'button' });
        chip.textContent = s;
        chip.addEventListener('click', function () {
          textarea.value = s; autogrow(); textarea.focus();
        });
        sugg.appendChild(chip);
      });
      wrap.appendChild(sugg);
      stream.appendChild(wrap);
    }

    function addMsg(role, text) {
      var row = h('div', NS + '__msg ' + NS + '__msg--' + role);
      var label = h('div', NS + '__role');
      label.textContent = role === 'user' ? t('assistant.role.you') : t('assistant.role.assistant');
      var bubble = h('div', NS + '__bubble');
      bubble.textContent = fmt(text);
      row.appendChild(label); row.appendChild(bubble);
      stream.appendChild(row);
      stream.scrollTop = stream.scrollHeight;
      return row;
    }

    function addTyping() {
      var row = h('div', NS + '__msg ' + NS + '__msg--assistant ' + NS + '__typing-row');
      var label = h('div', NS + '__role'); label.textContent = t('assistant.role.assistant');
      var bubble = h('div', NS + '__bubble ' + NS + '__typing');
      for (var i = 0; i < 3; i++) bubble.appendChild(h('span'));
      row.appendChild(label); row.appendChild(bubble);
      stream.appendChild(row);
      stream.scrollTop = stream.scrollHeight;
      return row;
    }

    function render() {
      stream.innerHTML = '';
      if (!messages.length) { renderEmpty(); return; }
      messages.forEach(function (m) {
        addMsg(m.role === 'user' ? 'user' : 'assistant', m.content);
      });
      if (busy) addTyping();
      stream.scrollTop = stream.scrollHeight;
    }

    function persist() {
      if (typeof host.persistHistory === 'function') {
        try { host.persistHistory(messages.slice(-40)); } catch (e) {}
      }
    }

    function friendlyError(err) {
      var msg = String(err == null ? '' : (err.message || err));
      if (msg.indexOf('429') >= 0 || /daily limit/i.test(msg)) return t('assistant.error.limit');
      if (msg.indexOf('503') >= 0 || /not configured|being set up/i.test(msg)) return t('assistant.error.setup');
      return t('assistant.error.generic');
    }

    function setBusy(on) {
      busy = on;
      sendBtn.disabled = on;
      textarea.disabled = on;
    }

    function submit() {
      if (busy) return;
      var text = String(textarea.value || '').trim();
      if (!text) return;
      textarea.value = '';
      autogrow();
      messages.push({ role: 'user', content: text });
      setBusy(true);
      render();
      persist();

      var result;
      try {
        // Host contract: sendMessage(text, historySnapshot) -> string reply OR
        // Promise<string reply> OR Promise<{reply:string, ...}>. History is the
        // full conversation the host may forward to the backend.
        result = host.sendMessage(text, messages.slice());
      } catch (e) {
        result = Promise.reject(e);
      }

      Promise.resolve(result).then(function (res) {
        var reply = (res && typeof res === 'object') ? (res.reply != null ? res.reply : '') : res;
        messages.push({ role: 'assistant', content: fmt(reply) });
        setBusy(false);
        render();
        persist();
      }, function (err) {
        messages.push({ role: 'assistant', content: friendlyError(err), _error: true });
        setBusy(false);
        render();
        persist();
        if (typeof host.onError === 'function') { try { host.onError(err); } catch (e) {} }
      });
    }

    function autogrow() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    }

    textarea.addEventListener('input', autogrow);
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    composer.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    clearBtn.addEventListener('click', function () {
      if (busy) return;
      messages = [];
      render();
      persist();
    });

    render();

    return {
      version: VERSION,
      focus: function () { try { textarea.focus(); } catch (e) {} },
      clear: function () { if (!busy) { messages = []; render(); persist(); } },
      isBusy: function () { return busy; },
      applyTheme: applyTheme,
      destroy: function () {
        try { if (root.parentNode) root.parentNode.removeChild(root); } catch (e) {}
      }
    };
  }

  var SkipiAssistant = {
    version: VERSION,
    mount: mount,
    // exposed for hosts that want the built-in fallbacks / tests
    _defaultI18n: defaultI18n,
    _i18n: I18N
  };

  global.SkipiAssistant = SkipiAssistant;
  if (typeof module !== 'undefined' && module.exports) module.exports = SkipiAssistant;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

// @skipi/vessel — «Моё судно»: check in on a vessel by its IMO number; the vessel is the shared
// space of the people checked in on it — they see each other and a notice board.
//
// Owner, 27.11.2026 (case 265): «моряк может зачекиниться на судне. и судно становится общим
// пространством для тех кто на нем зачекинен … если ты зачекинен на судне то ты виден остальным»;
// «судно будет только одно по имо номеру. и один моряк будет зарегистрирован на одном судне»;
// «базовую функцию можно сделать — доска объявлений».
//
// Classic script: window.SkipiVessel.mount(container, deps). The module never talks to the
// network and never holds a session: every request goes through deps.api (CONTRACT.md), which
// the home implements. All strings from the server are escaped here.
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var TEXT_MAX = 2000;
  var NAME_MAX = 80;

  var root = null;
  var deps = {};
  // view: loading | signin | offline | out | in
  var state = {
    view: 'loading', busy: false,
    imo: '', imoError: '', found: null, name: '',
    space: null, text: '', leaving: false, reported: {}, extra: [], more: false
  };

  function ru() { try { return deps.lang && deps.lang() === 'ru'; } catch (e) { return false; } }
  function t(en, rus) { return ru() ? rus : en; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) { if (typeof deps.toast === 'function') deps.toast(msg, kind || 'info'); }

  // Seven digits; the last one is the check digit: (d1*7 + d2*6 + … + d6*2) mod 10.
  function validImo(imo) {
    if (!/^[0-9]{7}$/.test(String(imo))) return false;
    var sum = 0;
    for (var i = 0; i < 6; i++) sum += Number(imo[i]) * (7 - i);
    return sum % 10 === Number(imo[6]);
  }
  function imoDigits(raw) { return String(raw == null ? '' : raw).replace(/^\s*imo\s*/i, '').replace(/[\s-]/g, ''); }
  // The server stamps UTC without a zone (`2026-11-27T10:00:00`).
  function whenText(iso) {
    var s = String(iso || '');
    if (!s) return '';
    try {
      var d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
      if (isNaN(d.getTime())) return s.slice(0, 10);
      return d.toLocaleString(ru() ? 'ru' : 'en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return s.slice(0, 10); }
  }
  function who(x) { return (x && x.name) ? String(x.name) : t('Skipi seafarer', 'Моряк Skipi'); }

  // ---- requests -----------------------------------------------------------
  function api(method, args) {
    var a = deps.api;
    if (!a || typeof a[method] !== 'function') return Promise.reject('failed');
    return Promise.resolve().then(function () { return a[method].apply(a, args || []); });
  }
  function errCode(err) { return String((err && err.message) || err || 'failed'); }
  function setSpace(res) {
    state.space = res && res.vessel ? res : null;
    state.view = state.space ? 'in' : 'out';
    state.extra = []; state.more = !!(res && res.more); state.leaving = false;
  }
  function load() {
    state.busy = true;
    api('me').then(function (res) {
      state.busy = false; setSpace(res || {}); rerender();
    }, function (err) {
      state.busy = false;
      state.view = errCode(err) === 'sign_in' ? 'signin' : 'offline';
      rerender();
    });
  }
  function fail(err) {
    var code = errCode(err);
    if (code === 'sign_in') toast(t('Sign in to your Skipi account first.', 'Сначала войдите в аккаунт Skipi.'), 'warn');
    else if (code === 'offline') toast(t('No connection. Try again later.', 'Нет связи. Повторите позже.'), 'warn');
    else if (code === 'already_checked_in') { toast(t('You are already checked in on another vessel.', 'Вы уже зачекинены на другом судне.'), 'warn'); load(); }
    else if (code === 'not_checked_in') { toast(t('You are no longer checked in on this vessel.', 'Вы больше не зачекинены на этом судне.'), 'warn'); load(); }
    else if (code === 'bad_imo') toast(t('This IMO number is not valid.', 'Номер ИМО неверный.'), 'warn');
    else if (code === 'name_required') toast(t('Enter the vessel name.', 'Введите название судна.'), 'warn');
    else if (code === 'bad_text') toast(t('Write the notice text first.', 'Сначала напишите текст объявления.'), 'warn');
    else if (code === 'own_notice') toast(t('This is your own notice.', 'Это ваше собственное объявление.'), 'warn');
    else toast(t('Could not complete. Try again.', 'Не получилось. Повторите.'), 'error');
  }
  function call(method, args, done) {
    if (state.busy) return;
    state.busy = true; rerender();
    api(method, args).then(function (res) {
      state.busy = false; done(res || {}); rerender();
    }, function (err) { state.busy = false; fail(err); rerender(); });
  }

  // ---- screens ------------------------------------------------------------
  function btn(label, action, opts) {
    opts = opts || {};
    return '<button type="button" class="svm-btn' + (opts.primary ? ' svm-primary' : '') + '"' + (opts.qa ? ' data-qa="' + opts.qa + '"' : '')
      + (state.busy || opts.disabled ? ' disabled' : '') + ' onclick="SkipiVessel.' + action + '">' + esc(label) + '</button>';
  }
  function introHtml() {
    return '<div class="svm-title">' + esc(t('My Vessel', 'Моё судно')) + '</div>'
      + '<div class="svm-sub">' + esc(t(
        'Check in on the vessel you are on. The vessel is the crew\'s shared space: everyone checked in sees each other and the notice board.',
        'Зачекиньтесь на судне, на котором вы сейчас. Судно — общее пространство экипажа: все, кто зачекинен, видят друг друга и доску объявлений.')) + '</div>';
  }
  function outHtml() {
    var h = '<div class="svm-card" data-qa="vessel-checkin">' + introHtml();
    var f = state.found;
    if (!f) {
      h += '<label class="svm-label" for="svm-imo">' + esc(t('IMO number of the vessel', 'Номер ИМО судна')) + '</label>'
        + '<input id="svm-imo" class="svm-input" data-qa="vessel-imo" type="text" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="'
        + esc(t('7 digits, e.g. 9074729', '7 цифр, например 9074729')) + '" value="' + esc(state.imo) + '" oninput="SkipiVessel.imo(this.value)" onkeydown="if(event.key===\'Enter\'){SkipiVessel.find();}">'
        + (state.imoError ? '<div class="svm-err" data-qa="vessel-imo-error">' + esc(state.imoError) + '</div>' : '')
        + '<div class="svm-actions">' + btn(t('Find the vessel', 'Найти судно'), 'find()', { primary: true, qa: 'vessel-find' }) + '</div>'
        + '<div class="svm-hint">' + esc(t('The IMO number is on the ship\'s certificates and on the superstructure. One vessel — one number.', 'Номер ИМО есть в судовых документах и на надстройке. Одно судно — один номер.')) + '</div>';
      return h + '</div>';
    }
    h += '<div class="svm-vessel" data-qa="vessel-found">';
    if (f.name) {
      h += '<div class="svm-vessel-name">' + esc(f.name) + '</div><div class="svm-vessel-meta">IMO ' + esc(f.imo) + '</div>';
    } else {
      h += '<div class="svm-vessel-meta">IMO ' + esc(f.imo) + '</div>'
        + '<div class="svm-sub">' + esc(t('This vessel is not in Skipi yet. Name it — the whole crew will see the name.', 'Этого судна в Skipi ещё нет. Назовите его — название увидит весь экипаж.')) + '</div>'
        + '<input id="svm-name" class="svm-input" data-qa="vessel-name" type="text" autocomplete="off" maxlength="' + NAME_MAX + '" placeholder="'
        + esc(t('Vessel name', 'Название судна')) + '" value="' + esc(state.name) + '" oninput="SkipiVessel.name(this.value)">';
    }
    h += '<div class="svm-vessel-meta" data-qa="vessel-aboard-count">' + esc(f.crew_count > 0
      ? t('Checked in now: ' + f.crew_count, 'Сейчас зачекинено: ' + f.crew_count)
      : t('Nobody is checked in yet — you will be the first.', 'Пока никто не зачекинен — вы будете первым.')) + '</div></div>'
      + '<div class="svm-hint">' + esc(t('The crew of this vessel will see your name and rank from your profile. Nothing else is shared.', 'Экипаж этого судна увидит ваши имя и должность из профиля. Больше ничего не передаётся.')) + '</div>'
      + '<div class="svm-actions">' + btn(t('Check in', 'Зачекиниться'), 'checkIn()', { primary: true, qa: 'vessel-checkin-go' })
      + btn(t('Another number', 'Другой номер'), 'reset()', { qa: 'vessel-reset' }) + '</div>';
    return h + '</div>';
  }
  function crewHtml(crew) {
    var h = '<div class="svm-card" data-qa="vessel-crew"><div class="svm-block-title">' + esc(t('Crew aboard · ' + crew.length, 'Экипаж на борту · ' + crew.length)) + '</div>';
    crew.forEach(function (c) {
      h += '<div class="svm-person"><div class="svm-person-main"><span class="svm-person-name">' + esc(who(c)) + '</span>'
        + (c.me ? '<span class="svm-you">' + esc(t('you', 'вы')) + '</span>' : '') + '</div>'
        + '<div class="svm-person-sub">' + esc([c.rank, c.since ? t('since ', 'с ') + whenText(c.since) : ''].filter(Boolean).join(' · ')) + '</div></div>';
    });
    return h + '</div>';
  }
  function noticeHtml(n) {
    var h = '<div class="svm-notice" data-qa="vessel-notice-' + esc(n.id) + '"><div class="svm-notice-head"><span class="svm-notice-by">'
      + esc([who(n), n.rank].filter(Boolean).join(' · ')) + '</span><span class="svm-notice-date">' + esc(whenText(n.created_at)) + '</span></div>';
    h += n.hidden
      ? '<div class="svm-hint">' + esc(t('The text was hidden after a report.', 'Текст скрыт по жалобе.')) + '</div>'
      : '<div class="svm-notice-text">' + esc(n.text) + '</div>';
    if (n.mine) h += '<button type="button" class="svm-link" data-qa="vessel-notice-delete"' + (state.busy ? ' disabled' : '') + ' onclick="SkipiVessel.remove(' + Number(n.id) + ')">' + esc(t('Delete', 'Удалить')) + '</button>';
    else if (state.reported[n.id]) h += '<div class="svm-hint">' + esc(t('Reported. Thank you.', 'Жалоба отправлена. Спасибо.')) + '</div>';
    else if (!n.hidden) h += '<button type="button" class="svm-link" data-qa="vessel-notice-report"' + (state.busy ? ' disabled' : '') + ' onclick="SkipiVessel.report(' + Number(n.id) + ')">' + esc(t('Report', 'Пожаловаться')) + '</button>';
    return h + '</div>';
  }
  function boardHtml(sp) {
    var list = (sp.notices || []).concat(state.extra);
    var h = '<div class="svm-card" data-qa="vessel-board"><div class="svm-block-title">' + esc(t('Notice board', 'Доска объявлений')) + '</div>'
      + '<textarea id="svm-text" class="svm-input svm-text" data-qa="vessel-notice-text" rows="3" maxlength="' + TEXT_MAX + '" placeholder="'
      + esc(t('A notice for everyone aboard', 'Объявление для всех на борту')) + '" oninput="SkipiVessel.text(this.value)">' + esc(state.text) + '</textarea>'
      + '<div class="svm-actions">' + btn(t('Post', 'Опубликовать'), 'post()', { primary: true, qa: 'vessel-notice-post' })
      + btn(t('Refresh', 'Обновить'), 'refresh()', { qa: 'vessel-refresh' }) + '</div>'
      + '<div class="svm-hint">' + esc(t('Seen at once by everyone checked in on this vessel, with your name and rank.', 'Сразу видно всем, кто зачекинен на этом судне, с вашими именем и должностью.')) + '</div>';
    if (!list.length) h += '<div class="svm-note" data-qa="vessel-board-empty">' + esc(t('No notices yet.', 'Объявлений пока нет.')) + '</div>';
    list.forEach(function (n) { h += noticeHtml(n); });
    if (state.more) h += '<div class="svm-actions">' + btn(t('Show earlier', 'Показать ранее'), 'more()', { qa: 'vessel-more' }) + '</div>';
    return h + '</div>';
  }
  function inHtml() {
    var sp = state.space, v = sp.vessel;
    var h = '<div class="svm-card" data-qa="vessel-space"><div class="svm-head"><div class="svm-title">' + esc(v.name) + '</div>'
      + '<span class="svm-pill">' + esc(t('Checked in', 'На борту')) + '</span></div>'
      + '<div class="svm-vessel-meta">IMO ' + esc(v.imo) + (sp.since ? ' · ' + esc(t('since ', 'с ') + whenText(sp.since)) : '') + '</div>'
      + '<div class="svm-actions">';
    h += state.leaving
      ? btn(t('Yes, leave', 'Да, сойти'), 'leave()', { primary: true, qa: 'vessel-leave-yes' }) + btn(t('Stay', 'Остаться'), 'askLeave(false)', { qa: 'vessel-leave-no' })
      : btn(t('Leave the vessel', 'Сойти с судна'), 'askLeave(true)', { qa: 'vessel-leave' });
    h += '</div>';
    if (state.leaving) h += '<div class="svm-hint">' + esc(t('After leaving you no longer see the crew and the board. Your notices stay for the crew.', 'Сойдя с судна, вы перестанете видеть экипаж и доску. Ваши объявления останутся экипажу.')) + '</div>';
    return h + '</div>' + crewHtml(sp.crew || []) + boardHtml(sp);
  }
  function html() {
    var body;
    if (state.view === 'loading') body = '<div class="svm-card"><div class="svm-note">' + esc(t('Loading…', 'Загружаю…')) + '</div></div>';
    else if (state.view === 'signin') body = '<div class="svm-card" data-qa="vessel-signin">' + introHtml() + '<div class="svm-note">' + esc(t('Sign in to your Skipi account to check in on a vessel.', 'Войдите в аккаунт Skipi, чтобы зачекиниться на судне.')) + '</div></div>';
    else if (state.view === 'offline') body = '<div class="svm-card" data-qa="vessel-offline">' + introHtml() + '<div class="svm-note">' + esc(t('The vessel space is not available right now. Check the connection.', 'Пространство судна сейчас недоступно. Проверьте связь.')) + '</div>'
      + '<div class="svm-actions">' + btn(t('Try again', 'Повторить'), 'reload()', { qa: 'vessel-retry' }) + '</div></div>';
    else if (state.view === 'in' && state.space) body = inHtml();
    else body = outHtml();
    return '<div class="svm-wrap" data-qa="vessel-module">' + body + '</div>';
  }
  function rerender() { if (root && root.isConnected !== false) root.innerHTML = html(); }

  var moduleApi = {
    version: VERSION,
    validImo: validImo,
    mount: function (container, d) {
      root = container; deps = d || {};
      if (state.view === 'signin' || state.view === 'offline') state.view = 'loading';
      rerender(); load();
    },
    reload: function () { state.view = 'loading'; rerender(); load(); },
    refresh: function () { call('me', [], function (res) { setSpace(res); }); },
    imo: function (v) { state.imo = String(v || '').slice(0, 12); state.imoError = ''; },
    name: function (v) { state.name = String(v || '').slice(0, NAME_MAX); },
    text: function (v) { state.text = String(v || '').slice(0, TEXT_MAX); },
    find: function () {
      var imo = imoDigits(state.imo);
      if (!validImo(imo)) {
        state.imoError = /^[0-9]{7}$/.test(imo)
          ? t('This is not a valid IMO number — check the digits.', 'Такого номера ИМО не бывает — проверьте цифры.')
          : t('An IMO number is seven digits.', 'Номер ИМО — семь цифр.');
        rerender(); return;
      }
      call('lookup', [imo], function (res) { state.found = { imo: imo, name: res.name || '', crew_count: Number(res.crew_count) || 0 }; state.name = ''; });
    },
    reset: function () { state.found = null; state.name = ''; state.imoError = ''; rerender(); },
    checkIn: function () {
      var f = state.found;
      if (!f) return;
      var name = f.name || state.name.replace(/\s+/g, ' ').trim();
      if (!name) { fail('name_required'); return; }
      call('checkIn', [f.imo, name], function (res) {
        setSpace(res); state.found = null; state.imo = ''; state.name = '';
        if (state.space) toast(t('Checked in.', 'Вы зачекинились.'), 'success');
      });
    },
    askLeave: function (on) { state.leaving = !!on; rerender(); },
    leave: function () {
      call('leave', [], function (res) { setSpace(res); state.text = ''; state.reported = {}; toast(t('You left the vessel.', 'Вы сошли с судна.'), 'info'); });
    },
    post: function () {
      var text = state.text.trim();
      if (!text) { fail('bad_text'); return; }
      call('post', [text], function (res) {
        state.text = '';
        if (state.space) { state.space.notices = res.notices || []; state.extra = []; state.more = !!res.more; }
        toast(t('Notice posted.', 'Объявление опубликовано.'), 'success');
      });
    },
    remove: function (id) {
      call('remove', [id], function (res) {
        if (state.space) { state.space.notices = res.notices || []; state.extra = []; state.more = !!res.more; }
      });
    },
    report: function (id) { call('report', [id], function () { state.reported[id] = true; }); },
    more: function () {
      var have = state.space ? (state.space.notices || []).length + state.extra.length : 0;
      call('notices', [have], function (res) { state.extra = state.extra.concat(res.notices || []); state.more = !!res.more; });
    },
    // for tests
    _state: state,
    _html: html
  };
  global.SkipiVessel = moduleApi;
})(typeof window !== 'undefined' ? window : globalThis);

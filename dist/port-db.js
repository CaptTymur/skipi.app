// Skipi Port DB — the «База портов» screen: find a port, read and leave a survey and a review.
//
// Owner, 26.11.2026: «нужно дать пользователям найти порт и оставить по нему отзыв. а с
// наполнением мы разберемся позже»; «сюрвей и отзыв. сход на берег, бюрократия и ограничения
// и так далее, пока эти 2».
//
// The port list is @skipi/ports (dist/skipi-ports.js + dist/skipi-ports.data.js, UN/LOCODE,
// pinned by dist/PORTS_VERSION) — read-only, works without the network. What people say about
// a port lives with the Skipi account on the server; the home passes `deps.invoke`, and the
// native commands (commands/port_reviews.rs) keep the account session to themselves.
//
// Classic script: window.SkipiPortDb.mount(container, deps). All port strings are escaped here
// (the module hands them out raw).
(function (global) {
  'use strict';

  var SURVEY_TOPICS = [
    { key: 'shore_leave', en: 'Shore leave', ru: 'Сход на берег',
      lowEn: 'not possible', highEn: 'unrestricted', lowRu: 'сойти нельзя', highRu: 'свободно' },
    { key: 'bureaucracy', en: 'Bureaucracy and restrictions', ru: 'Бюрократия и ограничения',
      lowEn: 'heavy', highEn: 'easy', lowRu: 'тяжело', highRu: 'легко' }
  ];
  var FUNCTIONS = {
    '1': ['Sea port', 'Морской порт'], '2': ['Rail terminal', 'Ж/д терминал'], '3': ['Road terminal', 'Автотерминал'],
    '4': ['Airport', 'Аэропорт'], '5': ['Postal exchange', 'Почтовый узел'], '6': ['Inland clearance depot', 'Внутренний терминал'],
    '7': ['Fixed transport (pipeline, platform)', 'Стационарный объект (трубопровод, платформа)'], 'B': ['Border crossing', 'Пограничный переход']
  };
  var TEXT_MAX = 2000;
  var LIMIT = 50;
  var RATINGS_TTL_MS = 5 * 60 * 1000;

  var root = null;
  var deps = {};
  var state = { query: '', country: '', code: null, data: 'idle', ratings: {}, ratingsAt: 0, ratingsBusy: false, slots: {} };

  function ru() { try { return deps.lang && deps.lang() === 'ru'; } catch (e) { return false; } }
  function t(en, rus) { return ru() ? rus : en; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ports() { return global.SkipiPorts; }
  function toast(msg, kind) { if (typeof deps.toast === 'function') deps.toast(msg, kind || 'info'); }

  var countryNames = null, countryNamesLang = '';
  function countryName(cc) {
    var lang = ru() ? 'ru' : 'en';
    if (countryNamesLang !== lang) {
      countryNamesLang = lang;
      try { countryNames = new Intl.DisplayNames([lang], { type: 'region' }); } catch (e) { countryNames = null; }
    }
    try { var n = countryNames && countryNames.of(cc); return n && n !== cc ? n : cc; } catch (e) { return cc; }
  }

  function coordText(c) {
    function part(v, pos, neg, width) {
      var a = Math.abs(v), d = Math.floor(a), m = Math.round((a - d) * 60);
      if (m === 60) { d += 1; m = 0; }
      var ds = String(d); while (ds.length < width) ds = '0' + ds;
      return ds + '°' + (m < 10 ? '0' : '') + m + '′' + (v < 0 ? neg : pos);
    }
    return part(c.lat, 'N', 'S', 2) + ' ' + part(c.lon, 'E', 'W', 3);
  }
  function avgLabel(r) { return (Math.round(r.average * 10) / 10).toFixed(1); }
  function starsText(n) { var s = ''; for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆'; return s; }
  function dateText(iso) { return String(iso || '').slice(0, 10); }

  function slot(code) {
    if (!state.slots[code]) state.slots[code] = { data: null, busy: false, error: '', stars: 0, text: '', touched: false, saving: false, reported: {} };
    return state.slots[code];
  }
  function ratingOf(code) {
    var s = state.slots[code];
    var r = (s && s.data && s.data.rating) || state.ratings[code];
    return r && r.count > 0 && typeof r.average === 'number' ? r : null;
  }

  // ---- data loading -------------------------------------------------------
  function ensureData() {
    if (global.SKIPI_PORTS_DATA) { state.data = 'ready'; return; }
    if (state.data === 'loading') return;
    state.data = 'loading';
    var s = global.document.createElement('script');
    s.src = 'skipi-ports.data.js';
    s.onload = function () { state.data = global.SKIPI_PORTS_DATA ? 'ready' : 'failed'; rerender(); };
    s.onerror = function () { state.data = 'failed'; rerender(); };
    global.document.head.appendChild(s);
  }
  function loadRatings() {
    if (typeof deps.invoke !== 'function' || state.ratingsBusy) return;
    if (state.ratingsAt && Date.now() - state.ratingsAt < RATINGS_TTL_MS) return;
    state.ratingsBusy = true;
    Promise.resolve().then(function () { return deps.invoke('port_ratings'); }).then(function (res) {
      state.ratings = (res && res.ratings && typeof res.ratings === 'object') ? res.ratings : {};
      state.ratingsAt = Date.now(); state.ratingsBusy = false;
      if (!state.code) renderResults();
    }, function () { state.ratingsBusy = false; });
  }
  function loadPort(code) {
    var s = slot(code);
    if (typeof deps.invoke !== 'function' || s.busy) return;
    s.busy = true; s.error = '';
    Promise.resolve().then(function () { return deps.invoke('port_reviews_list', { code: code }); }).then(function (res) {
      s.busy = false; s.data = res || {};
      if (!s.touched) { s.stars = (s.data.mine && s.data.mine.stars) || 0; s.text = (s.data.mine && s.data.mine.text) || ''; }
      if (state.code === code) rerender();
    }, function (err) {
      s.busy = false; s.error = String(err || 'failed');
      if (state.code === code) rerender();
    });
  }

  // ---- search list --------------------------------------------------------
  function found() {
    var P = ports();
    var q = state.query.trim();
    if (!q && !state.country) return null;
    var opts = { limit: LIMIT };
    if (state.country) opts.country = state.country;
    return P.search(q, opts);
  }
  function reviewedPorts() {
    var P = ports(), out = [];
    Object.keys(state.ratings).forEach(function (code) {
      var p = null; try { p = P.lookup(code); } catch (e) {}
      if (p && ratingOf(code)) out.push(p);
    });
    out.sort(function (a, b) { return state.ratings[b.code].count - state.ratings[a.code].count || a.name.localeCompare(b.name); });
    return out.slice(0, LIMIT);
  }
  function rowHtml(p) {
    var r = ratingOf(p.code);
    return '<button type="button" class="pdb-row" data-qa="port-row-' + esc(p.code) + '" onclick="SkipiPortDb.open(\'' + esc(p.code) + '\')">'
      + '<span class="pdb-row-main"><span class="pdb-row-name">' + esc(p.name) + '</span>'
      + '<span class="pdb-row-sub">' + esc(countryName(p.country)) + '</span></span>'
      + (r ? '<span class="pdb-rating" title="' + esc(t(r.count + ' rating(s)', 'Оценок: ' + r.count)) + '">★ ' + esc(avgLabel(r)) + '</span>' : '')
      + '<span class="pdb-code">' + esc(ports().formatCode(p.code) || p.code) + '</span></button>';
  }
  function resultsHtml() {
    if (state.data === 'failed') return '<div class="pdb-note pdb-err">' + esc(t('The port list could not be loaded.', 'Не удалось загрузить список портов.')) + '</div>';
    if (state.data !== 'ready' || !ports()) return '<div class="pdb-note">' + esc(t('Loading ports…', 'Загружаю порты…')) + '</div>';
    var list = found();
    if (list === null) {
      var rated = reviewedPorts();
      var h = '<div class="pdb-note">' + esc(t('Type a port name or a UN/LOCODE code, or pick a country.', 'Введите название порта или код UN/LOCODE либо выберите страну.')) + '</div>';
      if (rated.length) h += '<div class="pdb-section-title">' + esc(t('Ports with reviews', 'Порты с отзывами')) + '</div>' + rated.map(rowHtml).join('');
      return h;
    }
    if (!list.length) return '<div class="pdb-note" data-qa="port-none">' + esc(t('No port found. Check the spelling or try the code, e.g. NL RTM.', 'Порт не найден. Проверьте написание или введите код, например NL RTM.')) + '</div>';
    return list.map(rowHtml).join('')
      + (list.length >= LIMIT ? '<div class="pdb-note">' + esc(t('First ' + LIMIT + ' shown — refine the search.', 'Показаны первые ' + LIMIT + ' — уточните запрос.')) + '</div>' : '');
  }
  function countriesHtml() {
    var P = ports();
    if (state.data !== 'ready' || !P) return '';
    var list = P.countries().map(function (c) { return { code: c.code, name: countryName(c.code), ports: c.ports }; });
    list.sort(function (a, b) { return a.name.localeCompare(b.name, ru() ? 'ru' : 'en'); });
    return '<select class="pdb-country" data-qa="port-country" aria-label="' + esc(t('Country', 'Страна')) + '" onchange="SkipiPortDb.country(this.value)">'
      + '<option value="">' + esc(t('All countries', 'Все страны')) + '</option>'
      + list.map(function (c) { return '<option value="' + esc(c.code) + '"' + (c.code === state.country ? ' selected' : '') + '>' + esc(c.name) + ' (' + c.ports + ')</option>'; }).join('')
      + '</select>';
  }
  function listHtml() {
    var release = ''; try { release = ports() && state.data === 'ready' ? ports().dataVersion() : ''; } catch (e) {}
    return '<div class="pdb-wrap" data-qa="port-db">'
      + '<div class="pdb-search"><input type="search" class="pdb-input" id="pdb-q" data-qa="port-search" autocomplete="off" autocapitalize="off" spellcheck="false" '
      + 'placeholder="' + esc(t('Port name or code', 'Название порта или код')) + '" value="' + esc(state.query) + '" oninput="SkipiPortDb.search(this.value)">'
      + countriesHtml() + '</div>'
      + '<div id="pdb-results" class="pdb-results">' + resultsHtml() + '</div>'
      + (release ? '<div class="pdb-foot">' + esc(t('Port list: UN/LOCODE ' + release, 'Список портов: UN/LOCODE ' + release)) + '</div>' : '')
      + '</div>';
  }

  // ---- port page ----------------------------------------------------------
  function pickHtml(handler, arg, value, disabled, label) {
    var h = '<span class="pdb-stars" role="group" aria-label="' + esc(label) + '">';
    for (var i = 1; i <= 5; i++) {
      h += '<button type="button" class="pdb-star' + (i <= value ? ' on' : '') + '"' + (disabled ? ' disabled' : '')
        + ' aria-label="' + i + '" aria-pressed="' + (i === value ? 'true' : 'false') + '" onclick="SkipiPortDb.' + handler + '(' + (arg ? '\'' + arg + '\',' : '') + i + ')">' + (i <= value ? '★' : '☆') + '</button>';
    }
    return h + '</span>';
  }
  function surveyHtml(code, s) {
    var d = s.data || {}, signedIn = !!d.signed_in, mine = d.my_survey || {}, sum = d.survey || {};
    var h = '<div class="pdb-block" data-qa="port-survey"><div class="pdb-block-title">' + esc(t('Survey', 'Опрос')) + '</div>';
    SURVEY_TOPICS.forEach(function (topic) {
      var agg = sum[topic.key], my = mine[topic.key] || 0;
      h += '<div class="pdb-topic" data-qa="port-topic-' + topic.key + '"><div class="pdb-topic-head"><span class="pdb-topic-name">' + esc(t(topic.en, topic.ru)) + '</span>'
        + '<span class="pdb-topic-avg">' + (agg && agg.count > 0 ? '★ ' + esc(avgLabel(agg)) + ' · ' + esc(t('answers: ' + agg.count, 'ответов: ' + agg.count)) : esc(t('no answers yet', 'ответов пока нет'))) + '</span></div>'
        + (signedIn ? pickHtml('answer', topic.key, my, s.saving, t(topic.en, topic.ru)) : '')
        + '<div class="pdb-scale">1 — ' + esc(t(topic.lowEn, topic.lowRu)) + ' · 5 — ' + esc(t(topic.highEn, topic.highRu)) + '</div></div>';
    });
    if (!signedIn) h += '<div class="pdb-note">' + esc(t('Sign in to your Skipi account to answer.', 'Войдите в аккаунт Skipi, чтобы ответить.')) + '</div>';
    else h += '<div class="pdb-hint">' + esc(t('Tap a star to answer; tap your answer again to remove it.', 'Нажмите звезду, чтобы ответить; нажмите свой ответ ещё раз, чтобы снять его.')) + '</div>';
    return h + '</div>';
  }
  function reviewsHtml(code, s) {
    var d = s.data || {}, signedIn = !!d.signed_in, r = ratingOf(code), mine = d.mine;
    var h = '<div class="pdb-block" data-qa="port-reviews"><div class="pdb-block-title">' + esc(t('Ratings and reviews', 'Оценки и отзывы')) + '</div>'
      + '<div class="pdb-summary">' + (r ? '<span class="pdb-avg">★ ' + esc(avgLabel(r)) + '</span> ' + esc(t('ratings: ' + r.count, 'оценок: ' + r.count)) : esc(t('No ratings yet.', 'Оценок пока нет.'))) + '</div>';
    if (!signedIn) {
      h += '<div class="pdb-note">' + esc(t('Sign in to your Skipi account to rate this port.', 'Войдите в аккаунт Skipi, чтобы оценить порт.')) + '</div>';
    } else {
      h += '<div class="pdb-mine"><div class="pdb-mine-title">' + esc(t('Your review', 'Ваш отзыв')) + '</div>'
        + pickHtml('stars', '', s.stars, s.saving, t('Your rating', 'Ваша оценка'))
        + '<textarea class="pdb-text" id="pdb-text" data-qa="port-review-text" maxlength="' + TEXT_MAX + '" rows="4" placeholder="'
        + esc(t('What should others know about this port? (optional)', 'Что стоит знать другим об этом порте? (необязательно)')) + '" oninput="SkipiPortDb.text(this.value)">' + esc(s.text) + '</textarea>'
        + (mine && mine.hidden ? '<div class="pdb-note pdb-err">' + esc(t('Your text was hidden after a report. The rating still counts; a new text will be visible again.', 'Ваш текст скрыт по жалобе. Оценка учитывается; новый текст снова будет виден.')) + '</div>' : '')
        + '<div class="pdb-actions"><button type="button" class="pdb-btn pdb-primary" data-qa="port-review-save"' + (s.saving || !s.stars ? ' disabled' : '') + ' onclick="SkipiPortDb.save()">'
        + esc(mine ? t('Update', 'Обновить') : t('Publish', 'Опубликовать')) + '</button>'
        + (mine ? '<button type="button" class="pdb-btn" data-qa="port-review-delete"' + (s.saving ? ' disabled' : '') + ' onclick="SkipiPortDb.remove()">' + esc(t('Delete my review', 'Удалить мой отзыв')) + '</button>' : '')
        + '</div><div class="pdb-hint">' + esc(t('Published at once, without your name.', 'Публикуется сразу, без вашего имени.')) + '</div></div>';
    }
    var others = (d.reviews || []).filter(function (x) { return !x.mine; });
    others.forEach(function (x) {
      h += '<div class="pdb-review" data-qa="port-review-' + esc(x.id) + '"><div class="pdb-review-head"><span class="pdb-review-stars">' + starsText(x.stars) + '</span><span class="pdb-review-date">' + esc(dateText(x.updated_at)) + '</span></div>'
        + '<div class="pdb-review-text">' + esc(x.text) + '</div>'
        + (signedIn ? (s.reported[x.id]
          ? '<div class="pdb-hint">' + esc(t('Reported. Thank you.', 'Жалоба отправлена. Спасибо.')) + '</div>'
          : '<button type="button" class="pdb-link" onclick="SkipiPortDb.report(' + Number(x.id) + ')">' + esc(t('Report', 'Пожаловаться')) + '</button>') : '')
        + '</div>';
    });
    if (d.more) h += '<div class="pdb-note">' + esc(t('The latest 50 reviews are shown.', 'Показаны 50 последних отзывов.')) + '</div>';
    return h + '</div>';
  }
  function feedbackHtml(code) {
    var s = slot(code);
    if (!s.data) {
      if (s.busy) return '<div class="pdb-block"><div class="pdb-note">' + esc(t('Loading the survey and reviews…', 'Загружаю опрос и отзывы…')) + '</div></div>';
      return '<div class="pdb-block" data-qa="port-feedback-off"><div class="pdb-note">' + esc(t('The survey and reviews are not available right now. Check the connection.', 'Опрос и отзывы сейчас недоступны. Проверьте связь.')) + '</div>'
        + '<button type="button" class="pdb-btn" onclick="SkipiPortDb.reload()">' + esc(t('Try again', 'Повторить')) + '</button></div>';
    }
    return surveyHtml(code, s) + reviewsHtml(code, s);
  }
  function portHtml() {
    var P = ports(), p = null;
    try { p = P.lookup(state.code); } catch (e) {}
    var back = '<button type="button" class="pdb-back" data-qa="port-back" onclick="SkipiPortDb.back()">‹ ' + esc(t('Ports', 'Порты')) + '</button>';
    if (!p) return '<div class="pdb-wrap">' + back + '<div class="pdb-note">' + esc(t('Port not found.', 'Порт не найден.')) + '</div></div>';
    var release = P.dataVersion();
    var fns = (p.functions || []).map(function (f) { var n = FUNCTIONS[f]; return n ? t(n[0], n[1]) : f; }).join(', ');
    function field(label, value, qa) { return '<div class="pdb-field"' + (qa ? ' data-qa="' + qa + '"' : '') + '><span class="pdb-label">' + esc(label) + '</span><span class="pdb-value">' + value + '</span></div>'; }
    return '<div class="pdb-wrap" data-qa="port-page">' + back
      + '<div class="pdb-card"><div class="pdb-title">' + esc(p.name) + '</div>'
      + (p.nameAscii && p.nameAscii !== p.name ? '<div class="pdb-alt">' + esc(p.nameAscii) + '</div>' : '')
      + field('UN/LOCODE', esc(P.formatCode(p.code) || p.code))
      + field(t('Country', 'Страна'), esc(countryName(p.country)))
      + field(t('Position', 'Координаты'), p.coords ? esc(coordText(p.coords)) : '<span class="pdb-muted">' + esc(t('no coordinates in UN/LOCODE ' + release, 'координат нет в UN/LOCODE ' + release)) + '</span>', 'port-coords')
      + (fns ? field(t('Facilities', 'Функции'), esc(fns)) : '')
      + '</div>' + feedbackHtml(p.code) + '</div>';
  }

  // ---- rendering and actions ---------------------------------------------
  function html() { return state.code && state.data === 'ready' && ports() ? portHtml() : listHtml(); }
  function rerender() { if (root && root.isConnected !== false) root.innerHTML = html(); }
  function renderResults() {
    var box = root && global.document.getElementById('pdb-results');
    if (box) box.innerHTML = resultsHtml(); else rerender();
  }
  function fail(err) {
    var code = String(err || 'failed');
    if (code === 'sign_in') toast(t('Sign in to your Skipi account first.', 'Сначала войдите в аккаунт Skipi.'), 'warn');
    else if (code === 'offline') toast(t('No connection. Try again later.', 'Нет связи. Повторите позже.'), 'warn');
    else if (code === 'own_review') toast(t('This is your own review.', 'Это ваш собственный отзыв.'), 'warn');
    else toast(t('Could not save. Try again.', 'Не удалось сохранить. Повторите.'), 'error');
  }
  function call(command, args, done) {
    var code = state.code, s = slot(code);
    if (s.saving || typeof deps.invoke !== 'function') return;
    s.saving = true; rerender();
    Promise.resolve().then(function () { return deps.invoke(command, args); }).then(function (res) {
      s.saving = false; done(res || {}, s); state.ratingsAt = 0;
      if (state.code === code) rerender();
    }, function (err) { s.saving = false; fail(err); if (state.code === code) rerender(); });
  }

  var api = {
    mount: function (container, d) {
      root = container; deps = d || {};
      ensureData(); loadRatings(); rerender();
      if (state.code) loadPort(state.code);
    },
    search: function (q) { state.query = String(q || ''); renderResults(); },
    country: function (cc) { state.country = /^[A-Z]{2}$/.test(cc) ? cc : ''; renderResults(); },
    open: function (code) { state.code = code; rerender(); loadPort(code); if (root && root.scrollIntoView) { try { root.scrollIntoView(); } catch (e) {} } },
    back: function () { state.code = null; loadRatings(); rerender(); },
    reload: function () { if (state.code) { loadPort(state.code); rerender(); } },
    stars: function (n) { var s = slot(state.code); s.stars = n; s.touched = true; rerender(); },
    text: function (v) { var s = slot(state.code); s.text = String(v || '').slice(0, TEXT_MAX); s.touched = true; },
    save: function () {
      var s = slot(state.code);
      if (!s.stars) return;
      call('port_review_save', { code: state.code, stars: s.stars, text: s.text, lang: ru() ? 'ru' : 'en' }, function (res, sl) {
        sl.touched = false; loadPort(state.code);
        toast(t('Review published.', 'Отзыв опубликован.'), 'success');
      });
    },
    remove: function () {
      call('port_review_delete', { code: state.code }, function (res, sl) {
        sl.touched = false; sl.stars = 0; sl.text = ''; loadPort(state.code);
        toast(t('Review deleted.', 'Отзыв удалён.'), 'info');
      });
    },
    report: function (id) {
      call('port_review_report', { code: state.code, reviewId: id, reason: '' }, function (res, sl) { sl.reported[id] = true; });
    },
    answer: function (topic, n) {
      var s = slot(state.code), mine = (s.data && s.data.my_survey) || {};
      var answers = {}; answers[topic] = mine[topic] === n ? null : n;
      call('port_survey_save', { code: state.code, answers: answers }, function (res, sl) {
        if (sl.data) { sl.data.survey = res.survey || sl.data.survey; sl.data.my_survey = res.my_survey || sl.data.my_survey; }
      });
    },
    // for the harness
    _state: state,
    _html: html
  };
  global.SkipiPortDb = api;
})(typeof window !== 'undefined' ? window : globalThis);

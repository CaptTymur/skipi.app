// Port DB («База портов») harness.
//
// Owner, 26.11.2026: «нужно дать пользователям найти порт и оставить по нему отзыв»;
// «сюрвей и отзыв. сход на берег, бюрократия и ограничения и так далее, пока эти 2».
//
// Runs the real screen (dist/port-db.js) over the real vendored port list (@skipi/ports) with a
// stub page and a fake `invoke`, and checks the home's wiring: pin, scripts, tab, tile, commands.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log('  ✓ ' + msg); } else { fail += 1; console.error('  ✗ ' + msg); } }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the vendored module is the pinned one --------------------------------
const pin = Object.fromEntries(read('dist', 'PORTS_VERSION').trim().split('\n').slice(1).map((l) => l.split(': ')));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
ok(sha('skipi-ports.js') === pin.sha256, 'dist/skipi-ports.js matches the PORTS_VERSION pin');
ok(sha('skipi-ports.data.js') === pin['data-sha256'], 'dist/skipi-ports.data.js matches the PORTS_VERSION pin');

// ---- the home loads and shows it ------------------------------------------
const html = read('dist', 'index.html');
ok(html.includes('<script src="skipi-ports.js"></script>') && html.includes('<script src="port-db.js"></script>') && html.includes('href="port-db.css"'), 'index.html loads the port module, the screen and its styles');
ok(!html.includes('src="skipi-ports.data.js"'), 'the 1.2 MB port list is not loaded at startup (the screen loads it when opened)');
ok(/id="mt-ports"[^>]*>|onclick="showView\('ports'\)" id="mt-ports"/.test(html) && html.includes("else if(v==='ports')showPortDb();"), 'desktop: a Port DB tab opens the screen');
ok(html.includes('id="mhb-ports"') && html.includes("if(mobileView==='ports')return renderMobilePorts();"), 'phone: a Port DB tile opens the screen');
ok(html.includes("'nav.ports':'Port DB'") && html.includes("'nav.ports':'База портов'") && html.includes("ports:['База портов'"), 'the tab and the tile are named in English and Russian');
ok(!/mt-ports'\)[^;]*isSeafarer|mtPorts/.test(html), 'the tab is not hidden for non-seafarer account types');

const lib = read('src-tauri', 'src', 'lib.rs');
const COMMANDS = ['port_ratings', 'port_reviews_list', 'port_review_save', 'port_review_delete', 'port_review_report', 'port_survey_save'];
const screen = read('dist', 'port-db.js');
ok(COMMANDS.every((c) => lib.includes('port_reviews::' + c)), 'every port command is registered natively');
// Owner 27.11.2026: the two-topic survey left the screen — its topics became chips of the review. The native command stays.
ok(COMMANDS.filter((c) => c !== 'port_survey_save').every((c) => screen.includes("'" + c + "'")) && !screen.includes('port_survey_save'), 'the screen calls the review commands and no longer the survey');
ok(!/token|Authorization|fetch\(|XMLHttpRequest/.test(screen), 'the screen holds no account token and makes no network calls of its own');

// ---- the screen itself -----------------------------------------------------
function boot(lang, server) {
  const calls = [];
  const rootEl = { innerHTML: '', isConnected: true };
  const results = { innerHTML: '' };
  const sandbox = {
    console, Intl, Promise, Date, setTimeout,
    document: {
      head: { appendChild(s) { vm.runInContext(read('dist', 'skipi-ports.data.js'), ctx); s.onload(); } },
      createElement: () => ({}),
      getElementById: (id) => (id === 'pdb-results' && rootEl.innerHTML.includes('id="pdb-results"') ? results : null),
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('dist', 'skipi-ports.js'), ctx);
  vm.runInContext(screen, ctx);
  const toasts = [];
  sandbox.SkipiPortDb.mount(rootEl, {
    lang: () => lang,
    toast: (m, k) => toasts.push([k, m]),
    invoke: (cmd, args) => { calls.push([cmd, args]); return server(cmd, args || {}); },
  });
  return { api: sandbox.SkipiPortDb, rootEl, results, calls, toasts };
}

function fakeServer(signedIn) {
  const db = { mine: null, my_survey: { shore_leave: null, bureaucracy: null }, others: [{ id: 7, stars: 2, text: '<b>queue</b> at the gate', updated_at: '2026-11-20T10:00:00', mine: false, hidden: false, tags: ['bureaucracy', 'bribes'], author: 'SK-7F3A9C', rank: 'Chief <i>Officer</i>', vessel_type: 'Bulk Carrier' },
      { id: 8, stars: 5, text: '', updated_at: '2026-11-21T10:00:00', mine: false, hidden: false, tags: ['shore_leave'], author: 'SK-0B11D2', rank: null, vessel_type: null }] };
  const view = () => ({
    code: 'UAODS', signed_in: signedIn, mine: db.mine, more: false,
    rating: { average: db.mine ? (db.mine.stars + 2) / 2 : 2, count: db.mine ? 2 : 1 },
    reviews: (db.mine && db.mine.text ? [db.mine] : []).concat(db.others),
    tags: { shore_leave: 1, bureaucracy: 1, bribes: 1 },
    survey: { shore_leave: db.my_survey.shore_leave ? { average: db.my_survey.shore_leave, count: 1 } : { average: null, count: 0 }, bureaucracy: { average: null, count: 0 } },
    my_survey: signedIn ? db.my_survey : null,
  });
  return (cmd, a) => {
    if (cmd === 'port_ratings') return Promise.resolve({ ratings: { UAODS: { average: 2, count: 1 } } });
    if (cmd === 'port_reviews_list') return Promise.resolve(view());
    if (!signedIn) return Promise.reject('sign_in');
    if (cmd === 'port_review_save') { db.mine = { id: 9, stars: a.stars, text: a.text, tags: a.tags || [], author: 'SK-AAAAAA', rank: 'Master', vessel_type: 'Tanker', updated_at: '2026-11-26T09:00:00', mine: true, hidden: false }; return Promise.resolve({}); }
    if (cmd === 'port_review_delete') { db.mine = null; return Promise.resolve({ deleted: true }); }
    if (cmd === 'port_review_report') return Promise.resolve({ reported: true });
    if (cmd === 'port_survey_save') { Object.assign(db.my_survey, a.answers); const v = view(); return Promise.resolve({ survey: v.survey, my_survey: v.my_survey }); }
    return Promise.reject('failed');
  };
}

{
  const s = boot('ru', fakeServer(true));
  await tick();
  ok(s.rootEl.innerHTML.includes('data-qa="port-search"') && s.rootEl.innerHTML.includes('UN/LOCODE 2025-1'), 'the list opens with a search field and names the data release');
  ok(s.results.innerHTML.includes('Порты с отзывами') && s.results.innerHTML.includes('port-row-UAODS') && s.results.innerHTML.includes('★ 2.0'), 'before a search it lists the ports people have rated, with the rating');

  s.api.search('goteborg');
  ok(s.results.innerHTML.includes('port-row-SEGOT') && s.results.innerHTML.includes('Göteborg') && s.results.innerHTML.includes('Швеция'), 'search by name ignores diacritics and names the country in the UI language');
  s.api.search('nl rtm'); const byCodeSpaced = s.results.innerHTML;
  s.api.search('NLRTM');
  ok(s.results.innerHTML.includes('port-row-NLRTM') && s.results.innerHTML.includes('NL RTM'), 'search by code finds the port');
  s.api.search('zzzzqq');
  ok(s.results.innerHTML.includes('data-qa="port-none"'), 'nothing found is said in words');
  s.api.search(''); s.api.country('GE');
  ok(s.results.innerHTML.includes('port-row-GEPTI') && s.results.innerHTML.includes('port-row-GEBUS') && !s.results.innerHTML.includes('port-row-UAODS'), 'a country alone lists that country\'s ports');
  s.api.country('<x>');
  ok(!s.results.innerHTML.includes('port-row-GEPTI'), 'a value that is not a country code clears the country filter');
  void byCodeSpaced;

  s.api.open('UAODS'); await tick();
  const page = s.rootEl.innerHTML;
  ok(page.includes('data-qa="port-page"') && page.includes('Odesa') && page.includes('UA ODS') && page.includes('Украина') && /46°\d\d′N 030°\d\d′E/.test(page), 'the port page shows name, code, country and position');
  ok(!page.includes('data-qa="port-survey"') && !page.includes('Бюрократия и ограничения') && page.indexOf('data-qa="port-reviews"') > 0, 'the port page has no separate survey block: the review comes right after the port card');
  ok(page.includes('&lt;b&gt;queue&lt;/b&gt; at the gate') && !page.includes('<b>queue</b>'), 'another person\'s review is shown as text, never as markup');
  // Owner 27.11.2026: «сделал отзыв — кнопка "опубликовать" не активна»; «нужно сделать как в Bolt taxi»:
  // first the stars, then chips that fit the rating, then an optional comment. No inactive button.
  ok(page.includes('data-qa="port-review-start"') && page.includes('Как вам этот порт?') && !page.includes('data-qa="port-review-save"') && !page.includes('data-qa="port-review-text"'), 'the review starts with one question and the stars; nothing else, no inactive Publish');
  s.api.stars(5); await tick();
  let form = s.rootEl.innerHTML;
  ok(form.includes('Что понравилось?') && form.includes('>Сход на берег<') && form.includes('>Лёгкое оформление<') && ['shore_leave', 'easy_clearance', 'seamans_club', 'shopping', 'shuttle_bus'].every((k) => form.includes('data-qa="port-tag-' + k + '"')) && !form.includes('data-qa="port-tag-bribes"'), 'a good rating offers the good chips: shore leave, easy clearance, seamen\'s club, shopping, shuttle bus');
  ok(form.includes('data-qa="port-review-text"') && form.includes('data-qa="port-review-save"') && !/port-review-save" disabled/.test(form), 'after the stars the comment field and an active Publish appear');
  s.api.tag('shore_leave'); s.api.tag('shuttle_bus'); s.api.tag('shuttle_bus'); await tick();
  ok(/port-tag-shore_leave"[^>]*aria-pressed="true"/.test(s.rootEl.innerHTML) && /port-tag-shuttle_bus"[^>]*aria-pressed="false"/.test(s.rootEl.innerHTML), 'a chip is switched on and off by a tap');
  s.api.text('typed first'); s.api.stars(2); await tick();
  form = s.rootEl.innerHTML;
  ok(form.includes('Что не так?') && form.includes('>Нет схода на берег<') && form.includes('>Сложная бюрократия<') && ['no_shore_leave', 'bureaucracy', 'commercial_pressure', 'not_seafarer_friendly', 'bribes'].every((k) => form.includes('data-qa="port-tag-' + k + '"')) && !form.includes('data-qa="port-tag-shopping"'), 'a low rating offers the problem chips: bureaucracy, commercial pressure, not good for seafarers, bribes');
  ok(!/aria-pressed="true"[^>]*data-qa="port-tag-|port-tag-[a-z_]+"[^>]*aria-pressed="true"/.test(form) && form.includes('typed first'), 'changing the rating to the other side drops the chips of the first side and keeps the typed text');
  // what other people wrote: chips, and a signature without a name
  ok(/port-review-7[\s\S]*?Skipi · SK-7F3A9C · Chief &lt;i&gt;Officer&lt;\/i&gt; · Bulk Carrier/.test(page) && /port-review-7[\s\S]*?Сложная бюрократия[\s\S]*?Взятки/.test(page), 'a review is signed «Skipi · code · rank · vessel type» and shows its chips; the profile text is never markup');
  ok(/port-review-8[\s\S]*?Skipi · SK-0B11D2</.test(page) && page.includes('data-qa="port-review-8"'), 'a review with chips and no text is listed; without a sea profile the signature is the Skipi code alone');
  ok(/data-qa="port-tags-summary"[\s\S]*?Сход на берег · 1[\s\S]*?Сложная бюрократия · 1[\s\S]*?Взятки · 1/.test(page), 'the port page sums up what people named');

  s.api.stars(5); s.api.tag('shopping'); s.api.text('Shore pass in 10 minutes'); s.api.save(); await tick(); await tick();
  const saved = s.calls.find((c) => c[0] === 'port_review_save');
  ok(saved && saved[1].code === 'UAODS' && saved[1].stars === 5 && saved[1].text === 'Shore pass in 10 minutes' && saved[1].lang === 'ru' && JSON.stringify(saved[1].tags) === '["shopping"]', 'publishing sends the rating, the chips, the text and the language');
  ok(s.rootEl.innerHTML.includes('Другие увидят: Skipi · SK-AAAAAA · Master · Tanker'), 'the author is told how the review is signed for others');
  // Owner 27.11.2026: «на страничке порта должно быть видно какие отзывы оставляют» — his own review was shown only inside the form.
  ok(/data-qa="port-review-list"[\s\S]*?Отзывы · 3[\s\S]*?data-qa="port-review-9"[\s\S]*?Skipi · SK-AAAAAA · Master · Tanker · ваш[\s\S]*?Shore pass in 10 minutes/.test(s.rootEl.innerHTML), 'the list shows every review, the author\'s own first-class among them, marked as theirs');
  // Owner 27.11.2026: «видно что оставил такой-то пользователь скипи с таким-то рейтингом доверия. пока мы не доделали рейтинг доверия должна быть заглушка».
  ok((s.rootEl.innerHTML.match(/data-qa="port-review-trust"[^>]*>Рейтинг доверия: пока не рассчитан</g) || []).length === 3, 'every review carries the trust rating line — a placeholder until the rating exists');
  ok(!/data-qa="port-review-9"[\s\S]{0,600}?SkipiPortDb\.report\(9\)/.test(s.rootEl.innerHTML) && s.rootEl.innerHTML.includes('SkipiPortDb.report(7)'), 'one\'s own review has no Report link; other people\'s have it');
  ok(s.rootEl.innerHTML.includes('>Обновить<') && s.rootEl.innerHTML.includes('data-qa="port-review-delete"') && s.rootEl.innerHTML.includes('Shore pass in 10 minutes'), 'after publishing the form offers Update and Delete with the saved text');
  s.api.report(7); await tick();
  ok(s.calls.at(-1)[0] === 'port_review_report' && s.calls.at(-1)[1].reviewId === 7 && s.rootEl.innerHTML.includes('Жалоба отправлена'), 'another person\'s review can be reported');
  s.api.remove(); await tick(); await tick();
  ok(s.calls.some((c) => c[0] === 'port_review_delete') && s.rootEl.innerHTML.includes('data-qa="port-review-start"') && !s.rootEl.innerHTML.includes('data-qa="port-review-save"'), 'deleting the review brings the first question back');
  s.api.back();
  ok(s.rootEl.innerHTML.includes('data-qa="port-search"'), 'Back returns to the search');
}

{
  const s = boot('en', fakeServer(false));
  await tick();
  s.api.open('AEJEA'); await tick();
  const page = s.rootEl.innerHTML;
  ok(page.includes('Jebel Ali') && page.includes('no coordinates in UN/LOCODE 2025-1') && !/0°00′N/.test(page), 'a port without coordinates says so and never shows 0/0');
  ok(page.includes('Sign in to your Skipi account to rate this port.') && !page.includes('data-qa="port-review-save"') && !page.includes('pdb-star'), 'without an account the reviews are read-only, with a sign-in line');
}

{
  const s = boot('en', (cmd) => Promise.reject('offline'));
  await tick();
  s.api.search('rotterdam');
  ok(s.results.innerHTML.includes('port-row-NLRTM'), 'search works without the network');
  s.api.open('NLRTM'); await tick();
  ok(s.rootEl.innerHTML.includes('Rotterdam') && s.rootEl.innerHTML.includes('data-qa="port-feedback-off"'), 'offline the port page still opens and says the reviews are unavailable');
}

console.log('\nport_db_harness: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

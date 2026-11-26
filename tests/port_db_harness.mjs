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
ok(COMMANDS.every((c) => screen.includes("'" + c + "'")), 'the screen calls exactly those commands');
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
  const db = { mine: null, my_survey: { shore_leave: null, bureaucracy: null }, others: [{ id: 7, stars: 2, text: '<b>queue</b> at the gate', updated_at: '2026-11-20T10:00:00', mine: false, hidden: false }] };
  const view = () => ({
    code: 'UAODS', signed_in: signedIn, mine: db.mine, more: false,
    rating: { average: db.mine ? (db.mine.stars + 2) / 2 : 2, count: db.mine ? 2 : 1 },
    reviews: (db.mine && db.mine.text ? [db.mine] : []).concat(db.others),
    survey: { shore_leave: db.my_survey.shore_leave ? { average: db.my_survey.shore_leave, count: 1 } : { average: null, count: 0 }, bureaucracy: { average: null, count: 0 } },
    my_survey: signedIn ? db.my_survey : null,
  });
  return (cmd, a) => {
    if (cmd === 'port_ratings') return Promise.resolve({ ratings: { UAODS: { average: 2, count: 1 } } });
    if (cmd === 'port_reviews_list') return Promise.resolve(view());
    if (!signedIn) return Promise.reject('sign_in');
    if (cmd === 'port_review_save') { db.mine = { id: 9, stars: a.stars, text: a.text, updated_at: '2026-11-26T09:00:00', mine: true, hidden: false }; return Promise.resolve({}); }
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
  ok(page.includes('Сход на берег') && page.includes('Бюрократия и ограничения') && page.includes('data-qa="port-topic-shore_leave"') && page.includes('data-qa="port-topic-bureaucracy"'), 'the survey asks about shore leave and about bureaucracy and restrictions');
  ok(page.includes('&lt;b&gt;queue&lt;/b&gt; at the gate') && !page.includes('<b>queue</b>'), 'another person\'s review is shown as text, never as markup');
  ok(page.includes('data-qa="port-review-save"') && /port-review-save" disabled/.test(page), 'a review cannot be published without a rating');

  s.api.answer('shore_leave', 4); await tick();
  ok(JSON.stringify(s.calls.at(-1)) === JSON.stringify(['port_survey_save', { code: 'UAODS', answers: { shore_leave: 4 } }]), 'tapping a star sends that one survey answer');
  ok(/port-topic-shore_leave[\s\S]*?★ 4\.0 · ответов: 1/.test(s.rootEl.innerHTML), 'the answer shows in the topic average at once');
  s.api.answer('shore_leave', 4); await tick();
  ok(s.calls.at(-1)[1].answers.shore_leave === null, 'tapping the same answer again removes it');

  s.api.stars(5); s.api.text('Shore pass in 10 minutes'); s.api.save(); await tick(); await tick();
  const saved = s.calls.find((c) => c[0] === 'port_review_save');
  ok(saved && saved[1].code === 'UAODS' && saved[1].stars === 5 && saved[1].text === 'Shore pass in 10 minutes' && saved[1].lang === 'ru', 'publishing sends the rating, the text and the language');
  ok(s.rootEl.innerHTML.includes('>Обновить<') && s.rootEl.innerHTML.includes('data-qa="port-review-delete"') && s.rootEl.innerHTML.includes('Shore pass in 10 minutes'), 'after publishing the form offers Update and Delete with the saved text');
  s.api.report(7); await tick();
  ok(s.calls.at(-1)[0] === 'port_review_report' && s.calls.at(-1)[1].reviewId === 7 && s.rootEl.innerHTML.includes('Жалоба отправлена'), 'another person\'s review can be reported');
  s.api.remove(); await tick(); await tick();
  ok(s.calls.some((c) => c[0] === 'port_review_delete') && s.rootEl.innerHTML.includes('>Опубликовать<'), 'deleting the review brings the empty form back');
  s.api.back();
  ok(s.rootEl.innerHTML.includes('data-qa="port-search"'), 'Back returns to the search');
}

{
  const s = boot('en', fakeServer(false));
  await tick();
  s.api.open('AEJEA'); await tick();
  const page = s.rootEl.innerHTML;
  ok(page.includes('Jebel Ali') && page.includes('no coordinates in UN/LOCODE 2025-1') && !/0°00′N/.test(page), 'a port without coordinates says so and never shows 0/0');
  ok(page.includes('Sign in to your Skipi account to answer.') && page.includes('Sign in to your Skipi account to rate this port.') && !page.includes('data-qa="port-review-save"') && !page.includes('pdb-star'), 'without an account the survey and reviews are read-only, with a sign-in line');
}

{
  const s = boot('en', (cmd) => Promise.reject('offline'));
  await tick();
  s.api.search('rotterdam');
  ok(s.results.innerHTML.includes('port-row-NLRTM'), 'search works without the network');
  s.api.open('NLRTM'); await tick();
  ok(s.rootEl.innerHTML.includes('Rotterdam') && s.rootEl.innerHTML.includes('data-qa="port-feedback-off"'), 'offline the port page still opens and says the survey and reviews are unavailable');
}

console.log('\nport_db_harness: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

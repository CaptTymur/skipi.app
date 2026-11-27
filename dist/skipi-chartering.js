// @skipi/chartering — the chartering profile of Skipi: Bazar (board of cargo and open positions with matching)
// and the cargo book with freight requests.
//
// Owner, 27.11.2026 (case 280): «строим А, потом базар». A = one cargo, a freight request sent ship
// by ship, and a log of who was asked and what came back. A cargo and a ship make a pair; the pair
// moves: listed → request sent → quotation received → firm → fixed, or dropped.
//
// Classic script: window.SkipiChartering.mount(container, deps). The module never talks to the
// network and never holds a session: every request goes through deps.api, the letter is opened by
// deps.openMail (CONTRACT.md). All strings from the server are escaped here.
(function (global) {
  'use strict';

  var VERSION = '0.5.0';
  var STEPS = ['new', 'requested', 'quoted', 'firm', 'subs', 'fixed', 'dropped'];
  var EVENT_KINDS = ['quotation', 'counter', 'firm', 'subjects', 'lifted', 'fixed', 'dropped', 'note'];
  var CARGO_FIELDS = ['own_ref', 'account', 'load_port', 'load_details', 'laycan_from', 'laycan_to', 'discharge_port',
    'discharge_details', 'cargo_name', 'qty_min', 'qty_max', 'unit', 'rates', 'terms', 'commission', 'freight_idea', 'enquiry', 'note',
    'load_area', 'discharge_area', 'source', 'contact_email', 'tags',
    'incoterms', 'hs_code', 'req_type', 'req_dwt_min', 'req_dwt_max', 'req_max_age', 'req_geared'];
  // Standard clauses in Skipi's own wording; blanks are filled by the user.
  var CLAUSES = ['Notice of readiness to be tendered by e-mail, whether in berth or not.',
    'Laytime to start at the next working period after notice of readiness is accepted.',
    'Time lost waiting for a berth to count as laytime.',
    'Cargo to be loaded, stowed and discharged free of expense to the ship.',
    'Lashing, securing and dunnage for charterers\' account.',
    'Ship to be suitable for grab discharge.',
    'Owners guarantee the ship\'s gear in good working order throughout the voyage.',
    'Ship not older than __ years; overage insurance, if any, for owners\' account.',
    'Freight payable within __ banking days after signing and releasing bills of lading.',
    'Freight deemed earned on shipment, ship and/or cargo lost or not lost.',
    'Demurrage USD __ per day pro rata; despatch at half the demurrage rate on working time saved.',
    'Taxes and dues on cargo for charterers\' account; on ship and freight for owners\' account.',
    'Shore tally for charterers\' account, ship\'s tally for owners\' account.',
    'Charterers\' agents at both ends.', 'Owners\' agents at both ends.',
    'Ship to comply with the ISM and ISPS codes for the duration of the voyage.',
    'Subject stem, shippers\' and receivers\' approval within __ hours after main terms are agreed.',
    'General average and arbitration in London, English law to apply.',
    'Otherwise as per the GENCON 1994 charter party, logically amended.'];
  var PAIR_FIELDS = ['ship_name', 'imo', 'dwt', 'open_place', 'open_from', 'open_to', 'contact_company', 'contact_email', 'step', 'rate', 'note'];

  var POS_FIELDS = ['ship_name', 'imo', 'ship_type', 'dwt', 'capacity', 'gear', 'built', 'flag', 'open_place', 'open_area', 'open_from', 'open_to',
    'status', 'source', 'company', 'contact_email', 'note', 'tags'];
  var POS_STATUS = ['open', 'on_subs', 'fixed', 'withdrawn'];
  var SOURCES = ['mine', 'received', 'market'];
  // Trading areas: Skipi's own list. NEAR lists the pairs a ship crosses in a few days.
  var AREAS = [['blacksea', 'Black Sea', 'Чёрное море'], ['azov', 'Sea of Azov', 'Азовское море'], ['marmara', 'Sea of Marmara', 'Мраморное море'],
    ['emed', 'East Mediterranean', 'Восточное Средиземноморье'], ['cmed', 'Central Mediterranean', 'Центральное Средиземноморье'],
    ['wmed', 'West Mediterranean', 'Западное Средиземноморье'], ['adriatic', 'Adriatic', 'Адриатика'], ['redsea', 'Red Sea', 'Красное море'],
    ['pg', 'Persian Gulf', 'Персидский залив'], ['arabian', 'Arabian Sea / West India', 'Аравийское море / Западная Индия'],
    ['bengal', 'Bay of Bengal / East India', 'Бенгальский залив / Восточная Индия'], ['seasia', 'South East Asia', 'Юго-Восточная Азия'],
    ['feast', 'Far East', 'Дальний Восток'], ['aus', 'Australia / New Zealand', 'Австралия / Новая Зеландия'], ['iberia', 'Iberia / Biscay', 'Пиренеи / Бискай'],
    ['nwe', 'North West Europe', 'Северо-Западная Европа'], ['uk', 'UK / Ireland', 'Великобритания / Ирландия'], ['baltic', 'Baltic', 'Балтика'],
    ['wafr', 'West Africa', 'Западная Африка'], ['safr', 'South Africa', 'Южная Африка'], ['eafr', 'East Africa', 'Восточная Африка'],
    ['usec', 'US East Coast', 'Восточное побережье США'], ['usg', 'US Gulf', 'Мексиканский залив'], ['carib', 'Caribbean', 'Карибы'],
    ['ecsa', 'East Coast South America', 'Восточное побережье Южной Америки'], ['wcsa', 'West Coast South America', 'Западное побережье Южной Америки'],
    ['wcna', 'West Coast North America', 'Западное побережье Северной Америки'], ['caspian', 'Caspian', 'Каспий']];
  var NEAR = ('blacksea-azov blacksea-marmara marmara-emed emed-cmed cmed-wmed cmed-adriatic emed-redsea redsea-arabian pg-arabian arabian-bengal '
    + 'bengal-seasia seasia-feast seasia-aus wmed-iberia iberia-nwe nwe-uk nwe-baltic iberia-wafr wafr-safr safr-eafr eafr-arabian eafr-redsea '
    + 'usec-usg usg-carib usec-carib carib-ecsa wcsa-wcna').split(' ');

  // Directories kept per account. Field: [key, English label, Russian label, options].
  var KINDS = {
    ships: { en: 'Fleet', ru: 'Флот', icon: '⛴', one: ['Ship', 'Судно'], fields: [
      ['name', 'Ship name', 'Название судна', { required: true }], ['imo', 'IMO number', 'Номер ИМО', {}], ['ship_type', 'Type', 'Тип', {}],
      ['dwt', 'Deadweight, mt', 'Дедвейт, т', {}], ['capacity', 'Capacity, m3', 'Вместимость, м3', {}], ['gear', 'Gear', 'Грузовое устройство', {}],
      ['built', 'Year built', 'Год постройки', {}], ['flag', 'Flag', 'Флаг', {}], ['loa', 'Length overall, m', 'Длина, м', {}], ['beam', 'Beam, m', 'Ширина, м', {}],
      ['draft', 'Draft, m', 'Осадка, м', {}], ['holds', 'Holds / hatches', 'Трюмы / люки', {}], ['owner', 'Owner', 'Владелец', {}], ['manager', 'Manager / disponent owner', 'Менеджер / диспонент', {}],
      ['class_society', 'Class', 'Класс', {}], ['pi_club', 'P&I club', 'P&I клуб', {}], ['contact_email', 'Chartering e-mail', 'Почта фрахтового отдела', { type: 'email' }],
      ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
      cols: [['Ship', 'Судно', 'IMO / type', 'ИМО / тип'], ['DWT', 'Дедвейт', 'Capacity', 'Вместимость'], ['Gear', 'Краны', 'Built', 'Год'], ['Owner', 'Владелец', 'Manager', 'Менеджер']],
      row: function (x) { return [[x.name, [x.imo, x.ship_type].filter(Boolean).join(' / ')], [fmt(x.dwt), fmt(x.capacity)], [x.gear, x.built], [x.owner, x.manager]]; } },
    contacts: { en: 'Contacts', ru: 'Контакты', icon: '☺', one: ['Contact', 'Контакт'], fields: [
      ['name', 'Name', 'Имя', { required: true }], ['company', 'Company', 'Компания', {}],
      ['role', 'Role', 'Роль', { options: [['', '—', '—'], ['owner', 'Ship owner', 'Судовладелец'], ['broker', 'Broker', 'Брокер'], ['charterer', 'Charterer', 'Фрахтователь'],
        ['shipper', 'Shipper / trader', 'Грузовладелец / трейдер'], ['agent', 'Agent', 'Агент'], ['other', 'Other', 'Другое']] }],
      ['position', 'Position', 'Должность', {}], ['email', 'E-mail', 'Почта', { type: 'email' }], ['phone', 'Phone', 'Телефон', {}],
      ['country', 'Country, city', 'Страна, город', {}], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
      cols: [['Name', 'Имя', 'Position', 'Должность'], ['Company', 'Компания', 'Role', 'Роль'], ['E-mail', 'Почта', 'Phone', 'Телефон'], ['Country, city', 'Страна, город', '', '']],
      row: function (x) { return [[x.name, x.position], [x.company, optionName('contacts', 'role', x.role)], [x.email, x.phone], [x.country, '']]; } },
    ports: { en: 'Ports', ru: 'Порты', icon: '⚓', one: ['Port', 'Порт'], fields: [
      ['name', 'Port name', 'Название порта', { required: true }], ['locode', 'UN/LOCODE', 'UN/LOCODE', {}], ['country', 'Country', 'Страна', {}],
      ['area', 'Trading area', 'Район', { areas: true }], ['max_draft', 'Max draft, m', 'Макс. осадка, м', {}], ['max_loa', 'Max length, m', 'Макс. длина, м', {}],
      ['max_beam', 'Max beam, m', 'Макс. ширина, м', {}], ['cranes', 'Shore cranes', 'Береговые краны', {}], ['restrictions', 'Restrictions', 'Ограничения', { wide: true, area: true }],
      ['costs', 'Port costs (your figures)', 'Портовые расходы (ваши цифры)', { wide: true }], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
      cols: [['Port', 'Порт', 'UN/LOCODE', 'UN/LOCODE'], ['Country', 'Страна', 'Area', 'Район'], ['Max draft', 'Макс. осадка', 'Max length', 'Макс. длина'], ['Cranes', 'Краны', '', '']],
      row: function (x) { return [[x.name, x.locode], [x.country, areaName(x.area)], [x.max_draft, x.max_loa], [x.cranes, '']]; } }
  };
  KINDS.orders = { en: 'Orders', ru: 'Ордера', icon: '⏱', one: ['Time-charter order', 'Ордер на тайм-чартер'], fields: [
    ['name', 'Account (whose order)', 'Аккаунт (чей ордер)', { required: true }], ['source', 'Source', 'Источник', { options: [['mine', 'Mine', 'Мои'], ['received', 'Received', 'Полученные'], ['market', 'Market', 'Рынок']] }],
    ['delivery', 'Delivery (place)', 'Сдача в тайм-чартер (место)', {}], ['delivery_area', 'Delivery area', 'Район сдачи', { areas: true }], ['redelivery', 'Redelivery', 'Возврат из тайм-чартера', {}],
    ['period', 'Period / duration', 'Срок', {}], ['dwt_min', 'Deadweight from, mt', 'Дедвейт от, т', {}], ['dwt_max', 'Deadweight to, mt', 'Дедвейт до, т', {}], ['ship_type', 'Ship type', 'Тип судна', {}],
    ['laycan_from', 'Laycan from', 'Лейкан с', { type: 'date' }], ['laycan_to', 'Laycan to', 'Лейкан по', { type: 'date' }], ['cargo', 'Intended cargo', 'Предполагаемый груз', {}],
    ['hire_idea', 'Hire idea', 'Идея ставки найма', {}], ['contact_email', 'E-mail of the charterer side', 'Почта стороны фрахтователя', { type: 'email' }], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
    cols: [['Account', 'Аккаунт', 'Source', 'Источник'], ['Delivery', 'Сдача', 'Redelivery', 'Возврат'], ['DWT', 'Дедвейт', 'Type', 'Тип'], ['Laycan', 'Лейкан', 'Period', 'Срок']],
    row: function (x) { return [[x.name, optionName('orders', 'source', x.source || 'mine')], [x.delivery || areaName(x.delivery_area), x.redelivery], [[fmt(x.dwt_min), fmt(x.dwt_max)].filter(Boolean).join(' – '), x.ship_type], [span(x.laycan_from, x.laycan_to), x.period]]; },
    extra: function (x) { return orderFleetHtml(x); } };
  KINDS.docs = { en: 'Documents', ru: 'Документы', icon: '▣', one: ['Document', 'Документ'], fields: [
    ['name', 'Title / number', 'Название / номер', { required: true }], ['doc_type', 'Type', 'Вид', { options: [['recap', 'Fixture recap', 'Рекап фиксации'], ['booking', 'Booking note', 'Букинг-нота'], ['contract', 'Charter party', 'Чартер-партия']] }],
    ['date', 'Date', 'Дата', { type: 'date' }], ['status', 'Status', 'Статус', { options: [['draft', 'Draft', 'Черновик'], ['sent', 'Sent', 'Отправлен'], ['signed', 'Signed', 'Подписан']] }],
    ['ship', 'Ship', 'Судно', {}], ['owner', 'Owners / carrier', 'Судовладелец / перевозчик', {}], ['charterer', 'Charterers / merchant', 'Фрахтователь / грузовладелец', {}], ['cargo', 'Cargo and quantity', 'Груз и количество', {}],
    ['load_port', 'Loading', 'Погрузка', {}], ['discharge_port', 'Discharging', 'Выгрузка', {}], ['laycan', 'Laycan', 'Лейкан', {}], ['freight', 'Freight', 'Фрахт', {}],
    ['rates', 'Loading / discharging rates', 'Нормы погрузки / выгрузки', { wide: true }], ['demurrage', 'Demurrage / detention', 'Демередж / детеншн', {}], ['commission', 'Commission, %', 'Комиссия, %', {}],
    ['terms', 'Terms', 'Условия', { wide: true, area: true }], ['subjects', 'Subjects', 'Сабжекты', { wide: true }], ['contact_email', 'Send to (e-mail)', 'Кому отправить (почта)', { type: 'email' }],
    ['cargo_ref', 'Cargo reference', 'Номер груза', {}], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
    cols: [['Title', 'Название', 'Type', 'Вид'], ['Ship', 'Судно', 'Date', 'Дата'], ['Loading', 'Погрузка', 'Discharging', 'Выгрузка'], ['Freight', 'Фрахт', 'Status', 'Статус']],
    row: function (x) { return [[x.name, optionName('docs', 'doc_type', x.doc_type || 'recap')], [x.ship, day(x.date)], [x.load_port, x.discharge_port], [x.freight, optionName('docs', 'status', x.status || 'draft')]]; },
    extra: function (x) { return '<div class="scm-block">' + esc(t('Text', 'Текст')) + '</div><div class="scm-enquiry" data-qa="doc-text">' + esc(recapText(x)) + '</div>'; },
    actions: function (x) {
      return (validEmail(clean(x.contact_email)) ? btn(t('Send by mail', 'Отправить письмом'), 'sendDoc()', { primary: true, qa: 'doc-send' }) : '')
        + btn(t('Print', 'Печать'), 'printDoc()', { qa: 'doc-print' }) + btn(t('Create voyage', 'Создать рейс'), 'voyageFromDoc()', { qa: 'doc-voyage' });
    } };
  KINDS.voyages = { en: 'Voyages', ru: 'Рейсы', icon: '➤', one: ['Voyage', 'Рейс'], fields: [
    ['name', 'Voyage', 'Рейс', { required: true }], ['ship', 'Ship', 'Судно', {}], ['contract', 'Contract', 'Контракт', {}],
    ['status', 'Status', 'Статус', { options: [['planned', 'Planned', 'Запланирован'], ['loading', 'Loading', 'Погрузка'], ['sea', 'At sea', 'В море'], ['discharging', 'Discharging', 'Выгрузка'], ['completed', 'Completed', 'Завершён']] }],
    ['load_port', 'Loading port', 'Порт погрузки', {}], ['eta_load', 'ETA loading', 'ETA погрузки', { type: 'date' }], ['ata_load', 'Arrived (loading)', 'Прибыл (погрузка)', { type: 'date' }], ['atd_load', 'Sailed (loading)', 'Вышел (погрузка)', { type: 'date' }],
    ['discharge_port', 'Discharging port', 'Порт выгрузки', {}], ['eta_discharge', 'ETA discharging', 'ETA выгрузки', { type: 'date' }], ['ata_discharge', 'Arrived (discharging)', 'Прибыл (выгрузка)', { type: 'date' }],
    ['completed', 'Completed discharging', 'Выгрузка окончена', { type: 'date' }], ['loaded_qty', 'Loaded quantity', 'Погружено', {}], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
    cols: [['Voyage', 'Рейс', 'Ship', 'Судно'], ['Loading', 'Погрузка', 'ETA / arrived', 'ETA / прибыл'], ['Discharging', 'Выгрузка', 'ETA / arrived', 'ETA / прибыл'], ['Status', 'Статус', 'Contract', 'Контракт']],
    row: function (x) { return [[x.name, x.ship], [x.load_port, [day(x.eta_load), day(x.ata_load)].filter(Boolean).join(' / ')], [x.discharge_port, [day(x.eta_discharge), day(x.ata_discharge)].filter(Boolean).join(' / ')],
      [optionName('voyages', 'status', x.status || 'planned'), x.contract]]; } };
  KINDS.calcs = { en: 'Calculator', ru: 'Калькулятор', icon: '∑', one: ['Voyage estimate', 'Расчёт рейса'], fields: [
    ['name', 'Name of the estimate', 'Название расчёта', { required: true }], ['ship', 'Ship', 'Судно', {}], ['cargo', 'Cargo', 'Груз', {}], ['qty', 'Quantity, mt', 'Количество, т', {}],
    ['freight', 'Freight per mt', 'Фрахт за тонну', {}], ['lumpsum', 'or lump sum', 'или люмпсум', {}], ['commission', 'Commission, %', 'Комиссия, %', {}], ['daily_cost', 'Daily cost of the ship (hire or running)', 'Суточная стоимость судна (найм или содержание)', {}],
    ['dist_ballast', 'Ballast leg, nautical miles', 'Балластный переход, миль', {}], ['speed_ballast', 'Ballast speed, knots', 'Скорость в балласте, уз', {}],
    ['dist_laden', 'Laden leg, nautical miles', 'Переход в грузу, миль', {}], ['speed_laden', 'Laden speed, knots', 'Скорость в грузу, уз', {}],
    ['cons_ballast', 'Fuel at sea in ballast, mt per day', 'Расход в балласте, т/сут', {}], ['cons_laden', 'Fuel at sea laden, mt per day', 'Расход в грузу, т/сут', {}],
    ['cons_port', 'Fuel in port, mt per day', 'Расход в порту, т/сут', {}], ['fuel_price', 'Fuel price per mt', 'Цена топлива за тонну', {}],
    ['days_load', 'Days loading', 'Суток на погрузке', {}], ['days_discharge', 'Days discharging', 'Суток на выгрузке', {}], ['days_extra', 'Other days (waiting, canal)', 'Прочие сутки (ожидание, канал)', {}],
    ['costs_load', 'Port costs, loading', 'Портовые расходы, погрузка', {}], ['costs_discharge', 'Port costs, discharging', 'Портовые расходы, выгрузка', {}], ['costs_other', 'Other costs (canal, insurance)', 'Прочие расходы (канал, страховка)', {}],
    ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
    cols: [['Estimate', 'Расчёт', 'Ship', 'Судно'], ['Cargo', 'Груз', 'Quantity', 'Количество'], ['Net freight', 'Чистый фрахт', 'Result', 'Результат'], ['Days', 'Суток', 'Per day', 'В сутки']],
    row: function (x) { var r = calcResult(x) || {}; return [[x.name, x.ship], [x.cargo, fmt(x.qty)], [money(r.net), money(r.result)], [r.total ? r.total.toFixed(1) : '', money(r.tce)]]; },
    extra: function (x) { return calcHtml(x); }, formExtra: function (f) { return calcHtml(f) + '<div class="scm-actions">' + btn(t('Calculate', 'Рассчитать'), 'recalc()', { qa: 'calc-go' }) + '</div>'; } };
  KINDS.mails = { en: 'Mail', ru: 'Почта', icon: '✉', one: ['Letter', 'Письмо'], fields: [
    ['name', 'Subject', 'Тема', { required: true }], ['to', 'To', 'Кому', {}], ['cc', 'Copy', 'Копия', {}], ['bcc', 'Blind copy', 'Скрытая копия', {}], ['date', 'Date', 'Дата', { type: 'date' }],
    ['about', 'About', 'К чему относится', {}], ['body', 'Message', 'Текст', { wide: true, area: true }]],
    cols: [['Subject', 'Тема', 'To', 'Кому'], ['Date', 'Дата', 'About', 'К чему'], ['Copy', 'Копия', 'Blind copy', 'Скрытая копия'], ['', '', '', '']],
    row: function (x) { return [[x.name, x.to], [day(x.date), x.about], [x.cc, x.bcc], ['', '']]; },
    extra: function (x) { return '<div class="scm-enquiry" data-qa="mail-body">' + esc(x.body) + '</div>'; }, hide: { body: 1 } };
  KINDS.rates = { en: 'Markets', ru: 'Рынки', icon: '◔', one: ['Rate record', 'Запись о ставке'], fields: [
    ['name', 'Cargo', 'Груз', { required: true }], ['load_port', 'Loading', 'Погрузка', {}], ['discharge_port', 'Discharging', 'Выгрузка', {}], ['qty', 'Quantity', 'Количество', {}],
    ['rate', 'Rate', 'Ставка', {}], ['currency', 'Currency', 'Валюта', {}], ['basis', 'Basis', 'База', { options: [['mt', 'per mt', 'за тонну'], ['lumpsum', 'lump sum', 'люмпсум'], ['day', 'per day (hire)', 'в сутки (найм)']] }],
    ['date', 'Date', 'Дата', { type: 'date' }], ['charterer', 'Charterer', 'Фрахтователь', {}], ['ship', 'Ship', 'Судно', {}], ['source', 'Where from', 'Откуда сведения', {}], ['note', 'Your note', 'Ваша заметка', { wide: true, area: true }]],
    cols: [['Cargo', 'Груз', 'Quantity', 'Количество'], ['Loading', 'Погрузка', 'Discharging', 'Выгрузка'], ['Rate', 'Ставка', 'Basis', 'База'], ['Date', 'Дата', 'Ship', 'Судно']],
    row: function (x) { return [[x.name, x.qty], [x.load_port, x.discharge_port], [[clean(x.rate), clean(x.currency)].filter(Boolean).join(' '), optionName('rates', 'basis', x.basis || 'mt')], [day(x.date), x.ship]]; },
    extra: function (x) { return rateStatsHtml(x); } };
  KINDS.ports.fields.splice(4, 0, ['lat', 'Latitude (decimal degrees, south negative)', 'Широта (градусы с десятыми, юг со знаком минус)', {}], ['lon', 'Longitude (decimal degrees, west negative)', 'Долгота (градусы с десятыми, запад со знаком минус)', {}]);
  KINDS.settings = { en: 'Settings', ru: 'Настройки', icon: '⚙', one: ['Settings', 'Настройки'], fields: [['name', 'Company', 'Компания', { required: true }]], cols: [], row: function () { return []; } };
  KINDS.filters = { en: 'Filters', ru: 'Фильтры', icon: '', one: ['Filter', 'Фильтр'], fields: [['name', 'Name', 'Название', { required: true }], ['board', '', '', {}], ['criteria', '', '', {}]], cols: [], row: function () { return []; } };
  var KIND_ORDER = ['orders', 'ships', 'contacts', 'docs', 'voyages', 'calcs', 'ports', 'mails', 'rates'];
  // The rail in the order of the workplace: board, mail, people, own cargo, fleet, papers, voyages, estimates, market, ports, settings.
  var RAIL = ['bazar', 'mails', 'contacts', 'book', 'ships', 'docs', 'voyages', 'calcs', 'rates', 'ports', 'settings'];
  var ALL_KINDS = KIND_ORDER.concat(['filters', 'settings']);
  ALL_KINDS.forEach(function (k) { if (k !== 'filters' && k !== 'settings' && k !== 'mails') KINDS[k].fields.push(['tags', 'Tags (comma separated)', 'Теги (через запятую)', { wide: true }]); });

  var root = null;
  var deps = {};
  var composeThen = null;
  // view: loading | signin | offline | ready
  var state = {
    view: 'loading', busy: false, cargoes: [], q: '', archive: false,
    cargo: null, pairs: [], form: null, pform: null, errors: {}, removing: null,
    section: 'bazar', positions: [], pos: null, posform: null, fq: '', src: { mine: true, received: true, market: true },
    items: { ships: [], contacts: [], ports: [], orders: [], docs: [], voyages: [], calcs: [], filters: [], mails: [], rates: [], settings: [] }, item: null, iform: null, iq: '',
    compose: null, sform: null, btab: 'cargo', ftab: 'fleet', route: ['', ''],
    hist: null, eform: null, flt: { cargo: {}, fleet: {} }, fpanel: null, fltform: null
  };

  function ru() { try { return deps.lang && deps.lang() === 'ru'; } catch (e) { return false; } }
  function t(en, rus) { return ru() ? rus : en; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) { if (typeof deps.toast === 'function') deps.toast(msg, kind || 'info'); }
  function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

  // Seven digits; the last one is the check digit: (d1*7 + d2*6 + … + d6*2) mod 10.
  function validImo(imo) {
    if (!/^[0-9]{7}$/.test(String(imo))) return false;
    var sum = 0;
    for (var i = 0; i < 6; i++) sum += Number(imo[i]) * (7 - i);
    return sum % 10 === Number(imo[6]);
  }
  function validEmail(s) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(s)); }
  function num(v) { var n = Number(String(v == null ? '' : v).replace(/[\s,]/g, '')); return isFinite(n) && n > 0 ? n : 0; }
  function fmt(v) { return num(v) ? thousands(num(v)) : clean(v); }
  function thousands(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function day(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
  }
  function span(a, b) { var x = day(a), y = day(b); return x && y ? x + ' – ' + y : (x || y); }
  function qty(c) {
    var a = num(c.qty_min), b = num(c.qty_max), u = c.unit === 'm3' ? 'm3' : 'mt';
    if (!a && !b) return '';
    return (a && b && a !== b ? thousands(a) + ' – ' + thousands(b) : thousands(a || b)) + ' ' + u;
  }
  function stepName(s) {
    return {
      new: t('Listed', 'В списке'), requested: t('Request sent', 'Запрос отправлен'), quoted: t('Quotation received', 'Котировка получена'),
      firm: t('Firm', 'Фирма'), subs: t('On subjects', 'На сабжектах'), fixed: t('Fixed', 'Зафиксировано'), dropped: t('Dropped', 'Отпало')
    }[s] || s;
  }

  // ---- the letter (always in English: the working language of chartering) ---
  function requestMail(c, p) {
    var q = qty(c), lay = span(c.laycan_from, c.laycan_to);
    var lines = ['Dear Sirs,', '', 'Please propose M/V ' + clean(p.ship_name) + ' for the following cargo:', ''];
    if (clean(c.enquiry)) lines.push(String(c.enquiry).replace(/\s+$/, ''));
    else {
      lines.push('Cargo: ' + [clean(c.cargo_name), q].filter(Boolean).join(', '));
      lines.push('Loading: ' + [clean(c.load_port), clean(c.load_details)].filter(Boolean).join(', '));
      lines.push('Discharging: ' + [clean(c.discharge_port), clean(c.discharge_details)].filter(Boolean).join(', '));
      if (lay) lines.push('Laycan: ' + lay);
      if (clean(c.rates)) lines.push('Load/discharge rates: ' + clean(c.rates));
      if (clean(c.terms)) lines.push('Terms: ' + clean(c.terms));
      if (clean(c.commission)) lines.push('Commission: ' + clean(c.commission) + '%');
    }
    lines.push('', 'Kindly advise the open position and date, and your freight idea.', '');
    lines.push('Ref: ' + [clean(c.ref), clean(c.own_ref)].filter(Boolean).join(' / '));
    return {
      to: clean(p.contact_email),
      subject: 'Freight request: ' + [clean(c.cargo_name), q].filter(Boolean).join(' ') + ', ' + clean(c.load_port) + ' / ' + clean(c.discharge_port)
        + (lay ? ', laycan ' + lay : '') + ' — M/V ' + clean(p.ship_name),
      body: lines.join('\n')
    };
  }

  function offerMail(c, p) {
    var q = qty(c), lay = span(c.laycan_from, c.laycan_to);
    var ship = ['M/V ' + clean(p.ship_name), p.imo ? 'IMO ' + p.imo : '', clean(p.ship_type), num(p.dwt) ? thousands(num(p.dwt)) + ' dwt' : '',
      clean(p.gear), clean(p.built) ? 'built ' + clean(p.built) : '', clean(p.flag) ? clean(p.flag) + ' flag' : ''].filter(Boolean).join(', ');
    var open = [clean(p.open_place) || areaName(p.open_area), span(p.open_from, p.open_to)].filter(Boolean).join(', ');
    return {
      to: clean(c.contact_email),
      subject: 'Ship for your cargo ' + [clean(c.cargo_name), q].filter(Boolean).join(' ') + ', ' + clean(c.load_port) + ' / ' + clean(c.discharge_port) + ' — M/V ' + clean(p.ship_name),
      body: ['Dear Sirs,', '', 'For your cargo ' + [clean(c.cargo_name), q].filter(Boolean).join(', ') + ', ' + clean(c.load_port) + ' / ' + clean(c.discharge_port)
        + (lay ? ', laycan ' + lay : '') + ' we can propose:', '', ship, 'Open: ' + open, '', 'Please advise if of interest and your freight idea.', '',
        'Ref: ' + [clean(c.ref), clean(c.own_ref)].filter(Boolean).join(' / ')].join('\n')
    };
  }

  // ---- requests -----------------------------------------------------------
  function api(method, args) {
    var a = deps.api;
    if (!a || typeof a[method] !== 'function') return Promise.reject('failed');
    return Promise.resolve().then(function () { return a[method].apply(a, args || []); });
  }
  function errCode(err) { return String((err && err.message) || err || 'failed'); }
  function fail(err) {
    var code = errCode(err);
    if (code === 'sign_in') toast(t('Sign in to your Skipi account first.', 'Сначала войдите в аккаунт Skipi.'), 'warn');
    else if (code === 'offline') toast(t('No connection. Try again later.', 'Нет связи. Повторите позже.'), 'warn');
    else if (code === 'not_found') { toast(t('This record no longer exists.', 'Этой записи больше нет.'), 'warn'); state.cargo = null; load(); }
    else if (code === 'bad_imo') toast(t('This IMO number is not valid.', 'Номер ИМО неверный.'), 'warn');
    else if (code === 'bad_email') toast(t('Check the e-mail address.', 'Проверьте адрес почты.'), 'warn');
    else if (code === 'bad_cargo' || code === 'bad_pair') toast(t('Fill in the required fields.', 'Заполните обязательные поля.'), 'warn');
    else if (code === 'no_mail') toast(t('The letter could not be opened in your mail program.', 'Не удалось открыть письмо в почтовой программе.'), 'error');
    else toast(t('Could not complete. Try again.', 'Не получилось. Повторите.'), 'error');
  }
  function call(method, args, done) {
    if (state.busy) return;
    state.busy = true; rerender();
    api(method, args).then(function (res) {
      state.busy = false; done(res || {}); rerender();
    }, function (err) { state.busy = false; fail(err); rerender(); });
  }
  function load() {
    state.busy = true;
    Promise.all([api('list'), api('positions')].concat(ALL_KINDS.map(function (k) { return api('items', [k]); }))).then(function (res) {
      state.busy = false; state.cargoes = (res[0] && res[0].cargoes) || []; state.positions = (res[1] && res[1].positions) || [];
      ALL_KINDS.forEach(function (k, i) { state.items[k] = (res[2 + i] && res[2 + i].items) || []; });
      state.view = 'ready'; rerender();
    }, function (err) {
      state.busy = false; state.view = errCode(err) === 'sign_in' ? 'signin' : 'offline'; rerender();
    });
  }
  // Every answer that carries a cargo carries its ships too; the list row is refreshed from it.
  function take(res) {
    if (!res || !res.cargo) return;
    state.cargo = res.cargo; state.pairs = res.pairs || [];
    var seen = false;
    state.cargoes = state.cargoes.map(function (c) { if (c.id === res.cargo.id) { seen = true; return res.cargo; } return c; });
    if (!seen) state.cargoes.unshift(res.cargo);
  }

  // ---- screens ------------------------------------------------------------
  function btn(label, action, opts) {
    opts = opts || {};
    return '<button type="button" class="scm-btn' + (opts.primary ? ' scm-primary' : '') + (opts.small ? ' scm-small' : '') + '"'
      + (opts.qa ? ' data-qa="' + opts.qa + '"' : '') + (state.busy || opts.disabled ? ' disabled' : '')
      + ' onclick="SkipiChartering.' + action + '">' + esc(label) + '</button>';
  }
  function field(kind, key, label, opts) {
    opts = opts || {};
    var f = state[kind] || {}, id = 'scm-' + kind + '-' + key, err = state.errors[key];
    var on = ' oninput="SkipiChartering.set(\'' + kind + '\',\'' + key + '\',this.value)"';
    var h = '<div class="scm-field' + (opts.wide ? ' scm-wide' : '') + '"><label class="scm-label" for="' + id + '">' + esc(label) + (opts.required ? ' *' : '') + '</label>';
    if (opts.area) h += '<textarea id="' + id + '" class="scm-input scm-area" data-qa="' + id + '" rows="' + (opts.rows || 3) + '"' + on + '>' + esc(f[key]) + '</textarea>';
    else if (opts.options) {
      h += '<select id="' + id + '" class="scm-input" data-qa="' + id + '" onchange="SkipiChartering.set(\'' + kind + '\',\'' + key + '\',this.value)">';
      opts.options.forEach(function (o) { h += '<option value="' + esc(o[0]) + '"' + (String(f[key] || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; });
      h += '</select>';
    } else {
      h += '<input id="' + id + '" class="scm-input" data-qa="' + id + '" type="' + (opts.type || 'text') + '" autocomplete="off"' + (opts.list ? ' list="scm-dl-' + opts.list + '"' : '')
        + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + ' value="' + esc(f[key]) + '"' + on + '>';
    }
    if (err) h += '<div class="scm-err" data-qa="' + id + '-error">' + esc(err) + '</div>';
    return h + '</div>';
  }
  function countsText(c) {
    var k = c.counts || {}, parts = [];
    STEPS.forEach(function (s) { if (k[s] > 0) parts.push(stepName(s) + ' ' + k[s]); });
    return parts.join(' · ') || t('No ships yet', 'Судов пока нет');
  }
  function listHtml() {
    var q = clean(state.q).toLowerCase();
    var rows = state.cargoes.filter(function (c) {
      if (!!c.archived !== state.archive) return false;
      if (!q) return true;
      return [c.ref, c.own_ref, c.account, c.cargo_name, c.load_port, c.discharge_port, c.tags].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var h = '<div class="scm-pane scm-board scm-list" data-qa="chartering-list"><div class="scm-bar"><span class="scm-tabs"><b>' + esc(t('My cargoes', 'Мои грузы')) + '</b> · ' + rows.length + '</span>'
      + '<input class="scm-input scm-search" data-qa="cargo-search" type="search" placeholder="' + esc(t('Search', 'Поиск')) + '" value="' + esc(state.q) + '" oninput="SkipiChartering.search(this.value)">'
      + '<button type="button" class="scm-tab' + (!state.archive ? ' scm-on' : '') + '" data-qa="cargo-active" onclick="SkipiChartering.showArchive(false)">' + esc(t('Active', 'Активные')) + '</button>'
      + '<button type="button" class="scm-tab' + (state.archive ? ' scm-on' : '') + '" data-qa="cargo-archive" onclick="SkipiChartering.showArchive(true)">' + esc(t('Archive', 'Архив')) + '</button>'
      + '<button type="button" class="scm-add" data-qa="cargo-add" title="' + esc(t('Add cargo', 'Добавить груз')) + '" onclick="SkipiChartering.newCargo()">+</button></div>'
      + '<div class="scm-thead scm-tr-cargo">' + th(t('Account', 'Аккаунт'), t('Reference', 'Номер')) + th(t('Loading', 'Погрузка'), t('Discharging', 'Выгрузка')) + th(t('Cargo', 'Груз'), t('Quantity', 'Количество'))
      + th(t('Laycan', 'Лейкан'), t('Area', 'Район')) + th(t('Ships by step', 'Суда по шагам'), '') + '</div>';
    if (!rows.length) {
      h += '<div class="scm-note" data-qa="cargo-empty">' + esc(state.cargoes.length
        ? t('Nothing found.', 'Ничего не найдено.')
        : t('No cargoes yet. Add the first one — then list the ships you want to ask for freight.', 'Грузов пока нет. Добавьте первый — затем перечислите суда, у которых хотите запросить фрахт.')) + '</div>';
    }
    rows.forEach(function (c) {
      h += '<div class="scm-tr scm-tr-cargo' + (state.cargo && state.cargo.id === c.id ? ' scm-on' : '') + '" data-qa="cargo-row-' + esc(c.id) + '" role="button" tabindex="0" title="' + esc(clean(c.load_port) + ' → ' + clean(c.discharge_port))
        + '" onclick="SkipiChartering.open(' + Number(c.id) + ')">' + td(clean(c.account), clean(c.ref)) + td(clean(c.load_port), clean(c.discharge_port), 'scm-strong') + td(clean(c.cargo_name), qty(c), 'scm-qty')
        + td(span(c.laycan_from, c.laycan_to), areaName(c.load_area)) + '<span class="scm-td scm-steps">' + esc(countsText(c)) + '</span></div>';
    });
    return h + '</div>';
  }
  function cargoFormHtml() {
    var isNew = !state.form.id;
    return '<div class="scm-pane scm-card" data-qa="cargo-form"><div class="scm-title">' + esc(isNew ? t('New cargo', 'Новый груз') : t('Edit cargo', 'Изменить груз')) + '</div>'
      + '<div class="scm-block">' + esc(t('Ports and dates', 'Порты и даты')) + '</div><div class="scm-grid">'
      + field('form', 'load_port', t('Port / place of loading', 'Порт / место погрузки'), { required: true, list: 'ports', placeholder: t('e.g. Poti or Batumi', 'например, Поти или Батуми') })
      + field('form', 'load_details', t('Details (terminal, berth)', 'Детали (терминал, причал)'))
      + field('form', 'load_area', t('Loading area', 'Район погрузки'), { options: areaOptions() })
      + field('form', 'discharge_area', t('Discharging area', 'Район выгрузки'), { options: areaOptions() })
      + field('form', 'laycan_from', t('Laycan from', 'Лейкан с'), { type: 'date' })
      + field('form', 'laycan_to', t('Laycan to', 'Лейкан по'), { type: 'date' })
      + field('form', 'discharge_port', t('Port / place of discharging', 'Порт / место выгрузки'), { required: true, list: 'ports' })
      + field('form', 'discharge_details', t('Details (terminal, berth)', 'Детали (терминал, причал)'))
      + '</div><div class="scm-block">' + esc(t('Cargo', 'Груз')) + '</div><div class="scm-grid">'
      + field('form', 'cargo_name', t('Cargo name', 'Название груза'), { required: true })
      + field('form', 'unit', t('Measure', 'Единица'), { options: [['mt', t('metric tons', 'метрические тонны')], ['m3', t('cubic metres', 'кубические метры')]] })
      + field('form', 'qty_min', t('Quantity from', 'Количество от'), { placeholder: '25000' })
      + field('form', 'qty_max', t('Quantity to', 'Количество до'), { placeholder: '50000' })
      + field('form', 'own_ref', t('Your reference', 'Ваш номер'))
      + field('form', 'account', t('Account (whose cargo)', 'Аккаунт (чей груз)'))
      + field('form', 'source', t('Source', 'Источник'), { options: SOURCES.map(function (x) { return [x, sourceName(x)]; }) })
      + field('form', 'contact_email', t('E-mail of the cargo side (if not yours)', 'Почта стороны груза (если груз не ваш)'), { type: 'email' })
      + '</div><div class="scm-block">' + esc(t('Rates and terms', 'Нормы и условия')) + '</div><div class="scm-grid">'
      + field('form', 'rates', t('Loading / discharging rates', 'Нормы погрузки / выгрузки'), { wide: true, placeholder: t('e.g. 5,000 / 8,000 mt per day SSHEX', 'например, 5 000 / 8 000 т в сутки SSHEX') })
      + field('form', 'terms', t('Terms', 'Условия'), { wide: true, area: true, rows: 4 })
      + '<div class="scm-field scm-wide"><label class="scm-label" for="scm-clause">' + esc(t('Add a standard clause to the terms', 'Добавить типовую оговорку в условия')) + '</label>'
      + '<select id="scm-clause" class="scm-input" data-qa="cargo-clause" onchange="SkipiChartering.addClause(this.value)"><option value="">' + esc(t('— choose —', '— выбрать —')) + '</option>'
      + CLAUSES.map(function (x, i) { return '<option value="' + i + '">' + esc(x) + '</option>'; }).join('') + '</select></div>'
      + field('form', 'incoterms', t('Incoterms', 'Инкотермс'), { placeholder: 'FOB, CIF, FIOS…' })
      + field('form', 'hs_code', t('HS code', 'Код ТН ВЭД (HS)'))
      + field('form', 'commission', t('Commission, %', 'Комиссия, %'), { placeholder: '2.5' })
      + field('form', 'freight_idea', t('Your freight idea', 'Ваша идея фрахта'), { placeholder: t('e.g. USD 40 per mt', 'например, 40 USD за тонну') })
      + '</div><div class="scm-block">' + esc(t('Ship requirements', 'Требования к судну')) + '</div><div class="scm-grid">'
      + field('form', 'req_type', t('Ship type', 'Тип судна'), { placeholder: 'BULK, MPP…' })
      + field('form', 'req_geared', t('Own gear', 'Свои краны'), { options: [['', t('does not matter', 'не важно')], ['yes', t('required', 'нужны')]] })
      + field('form', 'req_dwt_min', t('Deadweight from, mt', 'Дедвейт от, т')) + field('form', 'req_dwt_max', t('Deadweight to, mt', 'Дедвейт до, т'))
      + field('form', 'req_max_age', t('Not older than, years', 'Не старше, лет'))
      + '</div><div class="scm-block">' + esc(t('Enquiry text', 'Текст запроса')) + '</div><div class="scm-grid">'
      + field('form', 'enquiry', t('If you paste the enquiry here, it goes into every freight request as written', 'Если вставить сюда текст запроса, он пойдёт в каждый запрос фрахта как есть'), { wide: true, area: true, rows: 6 })
      + field('form', 'note', t('Your note (never sent)', 'Ваша заметка (не отправляется)'), { wide: true, area: true, rows: 2 })
      + field('form', 'tags', t('Tags (comma separated)', 'Теги (через запятую)'), { wide: true })
      + '</div><div class="scm-actions">' + btn(t('Save', 'Сохранить'), 'saveCargo()', { primary: true, qa: 'cargo-save' })
      + btn(t('Cancel', 'Отмена'), 'cancel()', { qa: 'cargo-cancel' }) + '</div></div>';
  }
  function pairFormHtml() {
    var isNew = !state.pform.id, steps = STEPS.map(function (s) { return [s, stepName(s)]; });
    return '<div class="scm-pane scm-card" data-qa="pair-form"><div class="scm-title">' + esc(isNew ? t('Add ship', 'Добавить судно') : t('Ship', 'Судно')) + '</div><div class="scm-grid">'
      + field('pform', 'ship_name', t('Ship name', 'Название судна'), { required: true, list: 'ships' })
      + field('pform', 'imo', t('IMO number', 'Номер ИМО'), { placeholder: t('7 digits', '7 цифр') })
      + field('pform', 'dwt', t('Deadweight, mt', 'Дедвейт, т'))
      + field('pform', 'open_place', t('Open at (port or area)', 'Открыто в (порт или район)'))
      + field('pform', 'open_from', t('Open from', 'Открыто с'), { type: 'date' })
      + field('pform', 'open_to', t('Open to', 'Открыто по'), { type: 'date' })
      + field('pform', 'contact_company', t('Whom to write to (company, person)', 'Кому писать (компания, человек)'))
      + field('pform', 'contact_email', t('E-mail', 'Почта'), { type: 'email', list: 'emails' })
      + (isNew ? '' : field('pform', 'step', t('Step', 'Шаг'), { options: steps })
        + field('pform', 'rate', t('Quoted rate', 'Полученная ставка'), { placeholder: t('e.g. USD 42 per mt', 'например, 42 USD за тонну') }))
      + field('pform', 'note', t('Your note (never sent)', 'Ваша заметка (не отправляется)'), { wide: true, area: true, rows: 2 })
      + '</div><div class="scm-actions">' + btn(t('Save', 'Сохранить'), 'savePair()', { primary: true, qa: 'pair-save' })
      + btn(t('Cancel', 'Отмена'), 'cancel()', { qa: 'pair-cancel' }) + '</div></div>';
  }
  function line(label, value) {
    return value ? '<div class="scm-line"><span class="scm-line-k">' + esc(label) + '</span><span class="scm-line-v">' + esc(value) + '</span></div>' : '';
  }
  function pairHtml(p) {
    var id = Number(p.id), h = '<div class="scm-pair" data-qa="pair-' + id + '"><div class="scm-pair-head"><span class="scm-pair-name">' + esc(clean(p.ship_name)) + '</span>'
      + '<span class="scm-step scm-step-' + esc(p.step) + '" data-qa="pair-step-' + id + '">' + esc(stepName(p.step)) + '</span></div>'
      + '<div class="scm-pair-sub">' + esc([p.imo ? 'IMO ' + p.imo : '', num(p.dwt) ? thousands(num(p.dwt)) + ' dwt' : '',
        clean(p.open_place) ? t('open ', 'открыто ') + clean(p.open_place) : '', span(p.open_from, p.open_to)].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="scm-pair-sub">' + esc([clean(p.contact_company), clean(p.contact_email)].filter(Boolean).join(' · ')) + '</div>';
    if (p.step !== 'new') {
      h += '<div class="scm-pair-sub">' + esc([p.requested_at ? t('request sent ', 'запрос отправлен ') + day(p.requested_at) : '',
        clean(p.rate) ? t('quoted ', 'ставка ') + clean(p.rate) : ''].filter(Boolean).join(' · ')) + '</div>';
    }
    h += deadlineHtml(p);
    if (clean(p.note)) h += '<div class="scm-pair-note">' + esc(p.note) + '</div>';
    h += '<div class="scm-actions">';
    if (state.removing === 'pair-' + id) {
      h += btn(t('Yes, remove', 'Да, убрать'), 'removePair(' + id + ')', { small: true, primary: true, qa: 'pair-remove-yes' })
        + btn(t('Keep', 'Оставить'), 'askRemove(null)', { small: true, qa: 'pair-remove-no' });
    } else {
      h += btn(p.step === 'new' ? t('Freight request', 'Запрос фрахта') : t('Request again', 'Запросить ещё раз'), 'request(' + id + ')', { small: true, primary: p.step === 'new', qa: 'pair-request-' + id });
      if (p.step === 'requested') h += btn(t('Quotation received', 'Котировка получена'), 'step(' + id + ',\'quoted\')', { small: true, qa: 'pair-quoted-' + id });
      if (p.step === 'quoted') h += btn(t('Firm', 'Фирма'), 'step(' + id + ',\'firm\')', { small: true, qa: 'pair-firm-' + id });
      if (p.step === 'firm' || p.step === 'subs') h += btn(t('Fixed', 'Зафиксировано'), 'step(' + id + ',\'fixed\')', { small: true, qa: 'pair-fixed-' + id });
      if (p.step === 'firm' || p.step === 'subs' || p.step === 'fixed') h += btn(t('Recap', 'Рекап'), 'recapFromPair(' + id + ')', { small: true, qa: 'pair-recap-' + id });
      if (p.step !== 'dropped' && p.step !== 'fixed' && p.step !== 'new') h += btn(t('Dropped', 'Отпало'), 'step(' + id + ',\'dropped\')', { small: true, qa: 'pair-dropped-' + id });
      h += btn(t('Edit', 'Изменить'), 'editPair(' + id + ')', { small: true, qa: 'pair-edit-' + id })
        + btn(t('Remove', 'Убрать'), 'askRemove(\'pair-' + id + '\')', { small: true, qa: 'pair-remove-' + id })
        + btn(t('Negotiation · ' + (p.events || []).length, 'Ход торга · ' + (p.events || []).length), 'history(' + id + ')', { small: true, qa: 'pair-history-toggle-' + id });
    }
    h += '</div>';
    if (state.hist === id) h += historyHtml(p);
    return h + '</div>';
  }
  function cargoHtml() {
    var c = state.cargo;
    var h = '<div class="scm-pane scm-card" data-qa="cargo-card"><div class="scm-head"><div class="scm-title">' + esc(clean(c.load_port) + ' → ' + clean(c.discharge_port)) + '</div>'
      + (c.archived ? '<span class="scm-step">' + esc(t('Archive', 'Архив')) + '</span>' : '') + '</div>'
      + line(t('Reference', 'Номер'), [clean(c.ref), clean(c.own_ref)].filter(Boolean).join(' / '))
      + line(t('Account', 'Аккаунт'), clean(c.account))
      + line(t('Loading', 'Погрузка'), [clean(c.load_port), clean(c.load_details)].filter(Boolean).join(', '))
      + line(t('Laycan', 'Лейкан'), span(c.laycan_from, c.laycan_to))
      + line(t('Discharging', 'Выгрузка'), [clean(c.discharge_port), clean(c.discharge_details)].filter(Boolean).join(', '))
      + line(t('Cargo', 'Груз'), [clean(c.cargo_name), qty(c)].filter(Boolean).join(', '))
      + line(t('Rates', 'Нормы'), clean(c.rates)) + line(t('Terms', 'Условия'), clean(c.terms))
      + line(t('Commission', 'Комиссия'), clean(c.commission) ? clean(c.commission) + ' %' : '')
      + line(t('Freight idea', 'Идея фрахта'), clean(c.freight_idea)) + line(t('Incoterms / HS', 'Инкотермс / HS'), [clean(c.incoterms), clean(c.hs_code)].filter(Boolean).join(' / '))
      + line(t('Ship required', 'Требуется судно'), [clean(c.req_type), c.req_geared === 'yes' ? t('geared', 'с кранами') : '',
        num(c.req_dwt_min) || num(c.req_dwt_max) ? [fmt(c.req_dwt_min), fmt(c.req_dwt_max)].filter(Boolean).join(' – ') + ' dwt' : '', num(c.req_max_age) ? t('up to ', 'до ') + num(c.req_max_age) + t(' years', ' лет') : ''].filter(Boolean).join(', '));
    h += tagsHtml(c.tags);
    if (clean(c.enquiry)) h += '<div class="scm-enquiry" data-qa="cargo-enquiry">' + esc(c.enquiry) + '</div>';
    if (clean(c.note)) h += '<div class="scm-pair-note">' + esc(c.note) + '</div>';
    h += '<div class="scm-actions">';
    if (state.removing === 'cargo') {
      h += btn(t('Yes, delete the cargo and its ships', 'Да, удалить груз и его суда'), 'removeCargo()', { primary: true, qa: 'cargo-remove-yes' })
        + btn(t('Keep', 'Оставить'), 'askRemove(null)', { qa: 'cargo-remove-no' });
    } else {
      h += btn(t('Edit', 'Изменить'), 'editCargo()', { qa: 'cargo-edit' })
        + btn(c.archived ? t('Back to active', 'Вернуть в активные') : t('To archive', 'В архив'), 'archive(' + (c.archived ? 'false' : 'true') + ')', { qa: 'cargo-archive-toggle' })
        + btn(t('Delete', 'Удалить'), 'askRemove(\'cargo\')', { qa: 'cargo-remove' })
        + btn(t('Close', 'Закрыть'), 'close()', { qa: 'cargo-close' });
    }
    h += '</div><div class="scm-head scm-ships-head"><div class="scm-block">' + esc(t('Ships · ' + state.pairs.length, 'Суда · ' + state.pairs.length)) + '</div>'
      + btn(t('Add ship', 'Добавить судно'), 'newPair()', { primary: true, small: true, qa: 'pair-add' }) + '</div>';
    if (!state.pairs.length) h += '<div class="scm-note" data-qa="pair-empty">' + esc(t('List the ships you want to ask. One freight request per ship — your mail program opens with the letter ready.', 'Перечислите суда, у которых хотите запросить фрахт. Один запрос на судно — почтовая программа откроется с готовым письмом.')) + '</div>';
    state.pairs.forEach(function (p) { h += pairHtml(p); });
    return h + '</div>';
  }
  // ---- shared: tags, moments, money ------------------------------------------
  function tagsHtml(v) {
    var list = String(v || '').split(',').map(clean).filter(Boolean);
    if (!list.length) return '';
    return '<div class="scm-tags">' + list.map(function (x) { return '<span class="scm-tag">#' + esc(x.replace(/^#/, '')) + '</span>'; }).join('') + '</div>';
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function nowLocal() {
    if (typeof deps.now === 'function') return String(deps.now());
    var d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function moment(v) { var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || '')); return m ? m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + m[5] : day(v); }
  function expired(v) { return !!v && String(v) < nowLocal(); }
  function val(v) { var n = Number(String(v == null ? '' : v).replace(/[\s,]/g, '')); return isFinite(n) ? n : 0; }
  function money(n) { return typeof n === 'number' && isFinite(n) && n !== 0 ? (n < 0 ? '−' : '') + thousands(Math.round(Math.abs(n))) : ''; }

  // ---- negotiation on a pair --------------------------------------------------
  function eventName(k) {
    return { request: t('Request sent', 'Запрос отправлен'), quotation: t('Quotation received', 'Котировка получена'), counter: t('Counter sent', 'Контр-предложение отправлено'),
      firm: t('Firm offer', 'Твёрдая оферта'), subjects: t('Fixed on subjects', 'Зафиксировано на сабжектах'), lifted: t('Subjects lifted', 'Сабжекты сняты'),
      fixed: t('Fixed clean', 'Зафиксировано чисто'), dropped: t('Dropped', 'Отпало'), note: t('Note', 'Заметка') }[k] || k;
  }
  function deadlineHtml(p) {
    var ev = (p.events || []).slice().reverse(), h = '';
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].valid_until || ev[i].subjects_until) {
        if (p.step === 'fixed' || p.step === 'dropped') break;
        if (ev[i].valid_until) h += '<div class="scm-pair-sub' + (expired(ev[i].valid_until) ? ' scm-late' : '') + '" data-qa="pair-valid-' + Number(p.id) + '">' + esc((expired(ev[i].valid_until) ? t('validity expired ', 'срок действия истёк ') : t('valid until ', 'действует до ')) + moment(ev[i].valid_until)) + '</div>';
        if (ev[i].subjects_until) h += '<div class="scm-pair-sub' + (expired(ev[i].subjects_until) ? ' scm-late' : '') + '" data-qa="pair-subs-' + Number(p.id) + '">' + esc((expired(ev[i].subjects_until) ? t('subjects deadline passed ', 'срок снятия сабжектов прошёл ') : t('subjects to be lifted by ', 'сабжекты снять до ')) + moment(ev[i].subjects_until)) + '</div>';
        break;
      }
    }
    return h;
  }
  function historyHtml(p) {
    var id = Number(p.id), h = '<div class="scm-hist" data-qa="pair-history-' + id + '">';
    (p.events || []).forEach(function (e) {
      h += '<div class="scm-hist-line"><span class="scm-hist-when">' + esc(day(e.at)) + '</span><span class="scm-hist-what"><b>' + esc(eventName(e.kind)) + '</b>'
        + esc([clean(e.rate) ? ' · ' + clean(e.rate) : '', e.valid_until ? ' · ' + t('valid until ', 'действует до ') + moment(e.valid_until) : '',
          clean(e.subjects) ? ' · ' + t('subjects: ', 'сабжекты: ') + clean(e.subjects) : '', e.subjects_until ? ' · ' + t('lift by ', 'снять до ') + moment(e.subjects_until) : ''].join(''))
        + (clean(e.note) ? '<br>' + esc(e.note) : '') + '</span></div>';
    });
    if (!(p.events || []).length) h += '<div class="scm-pair-sub">' + esc(t('Nothing recorded yet.', 'Пока ничего не записано.')) + '</div>';
    if (state.eform && state.eform.pair === id) {
      h += '<div class="scm-grid">' + field('eform', 'kind', t('What happened', 'Что произошло'), { options: EVENT_KINDS.map(function (k) { return [k, eventName(k)]; }) })
        + field('eform', 'rate', t('Rate', 'Ставка'), { placeholder: t('e.g. USD 42 per mt', 'например, 42 USD за тонну') })
        + field('eform', 'valid_until', t('Valid until', 'Действует до'), { type: 'datetime-local' })
        + field('eform', 'subjects_until', t('Subjects to be lifted by', 'Сабжекты снять до'), { type: 'datetime-local' })
        + field('eform', 'subjects', t('Subjects', 'Сабжекты'), { wide: true, placeholder: t('e.g. stem, receivers\' approval', 'например, подтверждение груза, одобрение получателей') })
        + field('eform', 'note', t('Terms agreed or countered, your note', 'Согласованные или встречные условия, заметка'), { wide: true, area: true, rows: 2 })
        + '</div><div class="scm-actions">' + btn(t('Record', 'Записать'), 'saveEvent()', { small: true, primary: true, qa: 'event-save' }) + btn(t('Cancel', 'Отмена'), 'cancelEvent()', { small: true, qa: 'event-cancel' }) + '</div>';
    } else h += '<div class="scm-actions">' + btn(t('Record a step', 'Записать шаг'), 'newEvent(' + id + ')', { small: true, primary: true, qa: 'event-add-' + id }) + '</div>';
    return h + '</div>';
  }

  // ---- documents, voyages, estimates, orders --------------------------------
  function recapText(x) {
    var L = [(x.doc_type === 'booking' ? 'BOOKING NOTE' : x.doc_type === 'contract' ? 'CHARTER PARTY — MAIN TERMS' : 'FIXTURE RECAP') + (clean(x.name) ? ' — ' + clean(x.name) : '')];
    function add(k, v) { if (clean(v)) L.push(k + ': ' + clean(v)); }
    add('Date', day(x.date)); add('Ship', x.ship); add('Owners / carrier', x.owner); add('Charterers / merchant', x.charterer); add('Cargo', x.cargo);
    add('Loading', x.load_port); add('Discharging', x.discharge_port); add('Laycan', x.laycan); add('Freight', x.freight); add('Loading / discharging rates', x.rates);
    add('Demurrage / detention', x.demurrage); add('Commission', clean(x.commission) ? clean(x.commission) + '%' : '');
    if (clean(x.terms)) L.push('', 'Terms:', String(x.terms).replace(/\s+$/, ''));
    if (clean(x.subjects)) L.push('', 'Subjects: ' + clean(x.subjects));
    add('Cargo reference', x.cargo_ref);
    L.push('', 'End of recap.');
    return L.join('\n');
  }
  function calcResult(x) {
    var sb = val(x.speed_ballast) > 0 ? val(x.dist_ballast) / (val(x.speed_ballast) * 24) : 0, sl = val(x.speed_laden) > 0 ? val(x.dist_laden) / (val(x.speed_laden) * 24) : 0;
    var port = val(x.days_load) + val(x.days_discharge) + val(x.days_extra), total = sb + sl + port;
    var gross = val(x.lumpsum) || val(x.qty) * val(x.freight);
    if (!gross && !total) return null;
    var comm = gross * val(x.commission) / 100, net = gross - comm;
    var fuel = (sb * val(x.cons_ballast) + sl * val(x.cons_laden) + port * val(x.cons_port)) * val(x.fuel_price);
    var ports = val(x.costs_load) + val(x.costs_discharge) + val(x.costs_other), result = net - fuel - ports;
    return { sea: sb + sl, port: port, total: total, gross: gross, comm: comm, net: net, fuel: fuel, ports: ports, result: result, tce: total > 0 ? result / total : 0,
      profit: val(x.daily_cost) ? result - val(x.daily_cost) * total : null };
  }
  function calcHtml(x) {
    var r = calcResult(x);
    if (!r) return '<div class="scm-note" data-qa="calc-empty">' + esc(t('Enter the freight and the legs to see the result.', 'Введите фрахт и переходы, чтобы увидеть результат.')) + '</div>';
    return '<div class="scm-block">' + esc(t('Result', 'Результат')) + '</div><div class="scm-calc" data-qa="calc-result">'
      + line(t('Days at sea / in port', 'Суток в море / в порту'), r.sea.toFixed(1) + ' / ' + r.port.toFixed(1) + ' = ' + r.total.toFixed(1))
      + line(t('Gross freight', 'Валовый фрахт'), money(r.gross)) + line(t('Commission', 'Комиссия'), money(r.comm)) + line(t('Net freight', 'Чистый фрахт'), money(r.net))
      + line(t('Fuel', 'Топливо'), money(r.fuel)) + line(t('Port and other costs', 'Портовые и прочие расходы'), money(r.ports))
      + line(t('Voyage result', 'Результат рейса'), money(r.result) || '0') + line(t('Per day (time-charter equivalent)', 'В сутки (тайм-чартерный эквивалент)'), money(r.tce) || '0')
      + (r.profit === null ? '' : line(t('After the daily cost of the ship', 'После суточной стоимости судна'), money(r.profit) || '0')) + '</div>';
  }
  function matchOrder(o, p) {
    var score = 0, why = [], fit = true, dwt = num(p.dwt), a = num(o.dwt_min), b = num(o.dwt_max);
    if (!dwt || (!a && !b)) { score += 10; why.push(t('size not compared', 'размер не сравнивался')); }
    else if ((a && dwt < a) || (b && dwt > b)) { fit = false; why.push(t('outside the deadweight range', 'вне диапазона дедвейта')); }
    else { score += 40; why.push(t('within the deadweight range', 'в диапазоне дедвейта')); }
    var lt = o.laycan_to || o.laycan_from, of = p.open_from || p.open_to;
    if (!lt || !of) { score += 10; why.push(t('dates not compared', 'даты не сравнивались')); }
    else if (of > lt) { fit = false; why.push(t('opens after the laycan', 'открывается после лейкана')); }
    else { score += 30; why.push(t('open in time for the laycan', 'открывается к лейкану')); }
    var h = hops(o.delivery_area, p.open_area);
    if (h < 0) { score += 10; why.push(t('area not set', 'район не указан')); }
    else if (h === 0) { score += 30; why.push(t('same area', 'тот же район')); }
    else if (h === 1) { score += 20; why.push(t('neighbouring area', 'соседний район')); }
    else why.push(t('far from the delivery area', 'далеко от района сдачи'));
    return { score: fit ? score : 0, fit: fit, why: why };
  }
  function orderFleetHtml(o) {
    var rows = ranked(state.positions.filter(function (p) { return (p.status || 'open') === 'open'; }), function (p) { return matchOrder(o, p); });
    var h = '<div class="scm-block">' + esc(t('Suitable fleet · ' + rows.filter(function (r) { return r.m.fit; }).length, 'Подходящий флот · ' + rows.filter(function (r) { return r.m.fit; }).length)) + '</div>';
    rows.forEach(function (r) {
      var p = r.x;
      h += '<div class="scm-pair" data-qa="order-pos-' + Number(p.id) + '"><div class="scm-pair-head"><span class="scm-pair-name">' + esc(clean(p.ship_name)) + '</span><span class="scm-step">' + esc(r.m.fit ? r.m.score + ' / 100' : t('does not fit', 'не подходит')) + '</span></div>'
        + '<div class="scm-pair-sub">' + esc([num(p.dwt) ? thousands(num(p.dwt)) + ' dwt' : '', clean(p.open_place) || areaName(p.open_area), span(p.open_from, p.open_to)].filter(Boolean).join(' · ')) + '</div>'
        + '<div class="scm-pair-sub">' + esc(r.m.why.join(' · ')) + '</div>'
        + (r.m.fit && validEmail(clean(o.contact_email)) ? '<div class="scm-actions">' + btn(t('Offer for hire', 'Предложить в тайм-чартер'), 'offerHire(' + Number(p.id) + ')', { small: true, qa: 'order-offer-' + Number(p.id) }) + '</div>' : '') + '</div>';
    });
    return h;
  }
  function hireMail(o, p) {
    var ship = ['M/V ' + clean(p.ship_name), p.imo ? 'IMO ' + p.imo : '', clean(p.ship_type), num(p.dwt) ? thousands(num(p.dwt)) + ' dwt' : '', clean(p.gear), clean(p.built) ? 'built ' + clean(p.built) : ''].filter(Boolean).join(', ');
    return { to: clean(o.contact_email), subject: 'Ship for your time-charter order, delivery ' + (clean(o.delivery) || areaName(o.delivery_area)) + ' — M/V ' + clean(p.ship_name),
      body: ['Dear Sirs,', '', 'For your time-charter order (delivery ' + (clean(o.delivery) || areaName(o.delivery_area)) + (clean(o.redelivery) ? ', redelivery ' + clean(o.redelivery) : '')
        + (clean(o.period) ? ', period ' + clean(o.period) : '') + ') we can propose:', '', ship, 'Open: ' + [clean(p.open_place) || areaName(p.open_area), span(p.open_from, p.open_to)].filter(Boolean).join(', '), '',
        'Please advise if of interest and your hire idea.'].join('\n') };
  }

  // ---- Bazar filters ----------------------------------------------------------
  function passCargo(c, f) {
    var need = num(c.qty_max) || num(c.qty_min), least = num(c.qty_min) || num(c.qty_max);
    if (f.area && c.load_area !== f.area) return false;
    if (num(f.min) && need < num(f.min)) return false;
    if (num(f.max) && least > num(f.max)) return false;
    if (f.from && (c.laycan_to || c.laycan_from || '9999') < f.from) return false;
    if (f.to && (c.laycan_from || c.laycan_to || '') > f.to) return false;
    return true;
  }
  function passPos(p, f) {
    if (f.area && p.open_area !== f.area) return false;
    if (num(f.min) && num(p.dwt) < num(f.min)) return false;
    if (num(f.max) && num(p.dwt) > num(f.max)) return false;
    if (f.from && (p.open_to || p.open_from || '9999') < f.from) return false;
    if (f.to && (p.open_from || p.open_to || '') > f.to) return false;
    if (clean(f.type) && clean(p.ship_type).toLowerCase().indexOf(clean(f.type).toLowerCase()) < 0) return false;
    return true;
  }
  function activeCount(f) { var n = 0; ['area', 'min', 'max', 'from', 'to', 'type'].forEach(function (k) { if (clean(f[k])) n++; }); return n; }
  function filterButton(board) {
    var n = activeCount(state.flt[board]);
    return '<button type="button" class="scm-tab' + (n || state.fpanel === board ? ' scm-on' : '') + '" data-qa="filter-' + board + '" onclick="SkipiChartering.toggleFilter(\'' + board + '\')">' + esc(t('Filter', 'Фильтр') + (n ? ' · ' + n : '')) + '</button>';
  }
  function filterPanel(board) {
    var h = '', saved = state.items.filters.filter(function (x) { return x.board === board; });
    if (saved.length) {
      h += '<div class="scm-saved" data-qa="filters-saved-' + board + '">';
      saved.forEach(function (x) { h += '<button type="button" class="scm-tab' + (state.flt[board].id === x.id ? ' scm-on' : '') + '" data-qa="filter-use-' + Number(x.id) + '" onclick="SkipiChartering.useFilter(' + Number(x.id) + ')">' + esc(clean(x.name)) + '</button>'; });
      h += '</div>';
    }
    if (state.fpanel !== board) return h;
    return h + '<div class="scm-fpanel" data-qa="filter-panel-' + board + '"><div class="scm-grid">'
      + field('fltform', 'area', board === 'cargo' ? t('Loading area', 'Район погрузки') : t('Open area', 'Район'), { options: areaOptions() })
      + (board === 'fleet' ? field('fltform', 'type', t('Ship type', 'Тип судна')) : '')
      + field('fltform', 'min', board === 'cargo' ? t('Quantity from, mt', 'Количество от, т') : t('Deadweight from, mt', 'Дедвейт от, т'))
      + field('fltform', 'max', board === 'cargo' ? t('Quantity to, mt', 'Количество до, т') : t('Deadweight to, mt', 'Дедвейт до, т'))
      + field('fltform', 'from', board === 'cargo' ? t('Laycan not earlier than', 'Лейкан не раньше') : t('Open not earlier than', 'Открыто не раньше'), { type: 'date' })
      + field('fltform', 'to', board === 'cargo' ? t('Laycan not later than', 'Лейкан не позже') : t('Open not later than', 'Открыто не позже'), { type: 'date' })
      + field('fltform', 'name', t('Name, to save the filter', 'Название, чтобы сохранить фильтр'), { wide: true })
      + '</div><div class="scm-actions">' + btn(t('Apply', 'Применить'), 'applyFilter()', { small: true, primary: true, qa: 'filter-apply' })
      + btn(t('Save and apply', 'Сохранить и применить'), 'saveFilter()', { small: true, qa: 'filter-save' }) + btn(t('Clear', 'Сбросить'), 'clearFilter()', { small: true, qa: 'filter-clear' })
      + (state.fltform && state.fltform.id ? btn(t('Delete this filter', 'Удалить этот фильтр'), 'dropFilter()', { small: true, qa: 'filter-drop' }) : '') + '</div></div>';
  }

  // ---- Bazar: areas, matching, board ---------------------------------------
  function areaName(code) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i][0] === code) return ru() ? AREAS[i][2] : AREAS[i][1]; return ''; }
  function areaOptions() { return [['', t('— not set —', '— не указан —')]].concat(AREAS.map(function (a) { return [a[0], ru() ? a[2] : a[1]]; })); }
  function sourceName(x) { return { mine: t('Mine', 'Мои'), received: t('Received', 'Полученные'), market: t('Market', 'Рынок') }[x] || x; }
  function posStatusName(x) { return { open: t('Open', 'Открыто'), on_subs: t('On subjects', 'На сабжектах'), fixed: t('Fixed', 'Зафиксировано'), withdrawn: t('Withdrawn', 'Снято') }[x] || x; }
  function near(a, b) { return NEAR.indexOf(a + '-' + b) >= 0 || NEAR.indexOf(b + '-' + a) >= 0; }
  function hops(a, b) {
    if (!a || !b) return -1;
    if (a === b) return 0;
    if (near(a, b)) return 1;
    for (var i = 0; i < AREAS.length; i++) if (near(a, AREAS[i][0]) && near(AREAS[i][0], b)) return 2;
    return 3;
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // How well an open position suits a cargo: size, dates, distance — each part scored and explained.
  function match(c, p) {
    var score = 0, why = [], fit = true;
    var need = c.unit === 'm3' ? 0 : (num(c.qty_max) || num(c.qty_min)), least = c.unit === 'm3' ? 0 : (num(c.qty_min) || num(c.qty_max)), dwt = num(p.dwt);
    if (!need || !dwt) { score += 10; why.push(t('size not compared', 'размер не сравнивался')); }
    else if (dwt < least * 0.95) { fit = false; why.push(t('deadweight too small', 'мало дедвейта')); }
    else if (dwt < need * 0.95) { score += 20; why.push(t('takes the minimum quantity', 'берёт минимум партии')); }
    else if (need / dwt >= 0.6) { score += 30; why.push(t('right size', 'по размеру подходит')); }
    else if (need / dwt >= 0.3) { score += 15; why.push(t('larger than needed', 'крупнее нужного')); }
    else { score += 5; why.push(t('much larger than needed', 'намного крупнее нужного')); }
    if (clean(c.req_type) && clean(p.ship_type) && clean(p.ship_type).toLowerCase().indexOf(clean(c.req_type).toLowerCase()) < 0) { fit = false; why.push(t('another ship type is required', 'требуется другой тип судна')); }
    if (dwt && num(c.req_dwt_min) && dwt < num(c.req_dwt_min)) { fit = false; why.push(t('below the required deadweight', 'дедвейт ниже требуемого')); }
    if (dwt && num(c.req_dwt_max) && dwt > num(c.req_dwt_max)) { fit = false; why.push(t('above the required deadweight', 'дедвейт выше требуемого')); }
    if (num(c.req_max_age) && num(p.built) && Number((c.laycan_from || nowLocal()).slice(0, 4)) - num(p.built) > num(c.req_max_age)) { fit = false; why.push(t('older than required', 'старше требуемого')); }
    if (c.req_geared === 'yes' && (!clean(p.gear) || /gearless|без/i.test(p.gear))) { fit = false; why.push(t('own gear is required', 'нужны свои краны')); }
    var lf = c.laycan_from || c.laycan_to, lt = c.laycan_to || c.laycan_from, of = p.open_from || p.open_to, ot = p.open_to || p.open_from;
    if (!lf || !of) { score += 10; why.push(t('dates not compared', 'даты не сравнивались')); }
    else if (of > lt) { fit = false; why.push(t('opens after the laycan', 'открывается после лейкана')); }
    else if (ot < addDays(lf, -21)) { score += 10; why.push(t('open long before the laycan', 'открыто задолго до лейкана')); }
    else { score += 30; why.push(t('open in time for the laycan', 'открывается к лейкану')); }
    var h = hops(c.load_area, p.open_area);
    if (h < 0) {
      var a = clean(c.load_port).toLowerCase(), b = clean(p.open_place).toLowerCase();
      if (a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) { score += 40; why.push(t('open at the loading port', 'открыто в порту погрузки')); }
      else { score += 10; why.push(t('area not set', 'район не указан')); }
    } else if (h === 0) { score += 40; why.push(t('same area', 'тот же район')); }
    else if (h === 1) { score += 25; why.push(t('neighbouring area', 'соседний район')); }
    else if (h === 2) { score += 10; why.push(t('two areas away', 'через район')); }
    else why.push(t('far from the loading area', 'далеко от района погрузки'));
    return { score: fit ? score : 0, fit: fit, why: why };
  }
  function ranked(items, fn) {
    return items.map(function (x) { return { x: x, m: fn(x) }; }).sort(function (a, b) { return b.m.score - a.m.score; });
  }
  function hasText(obj, keys, q) { return !q || keys.map(function (k) { return obj[k] || ''; }).join(' ').toLowerCase().indexOf(q) >= 0; }
  function th(a, b) { return '<span class="scm-th">' + esc(a) + (b ? '<br>' + esc(b) : '') + '</span>'; }
  function td(a, b, cls) { return '<span class="scm-td' + (cls ? ' ' + cls : '') + '"><span class="scm-td-a">' + esc(a || '—') + '</span><span class="scm-td-b">' + esc(b || '—') + '</span></span>'; }
  function matchCell(m) {
    return '<span class="scm-td scm-match' + (m.fit ? '' : ' scm-unfit') + '"><span class="scm-td-a">' + (m.fit ? esc(m.score + ' / 100') : esc(t('does not fit', 'не подходит'))) + '</span><span class="scm-td-b">' + esc(m.why.join(' · ')) + '</span></span>';
  }
  function boardCargoRow(c, m) {
    return '<div class="scm-tr scm-tr-cargo' + (m ? ' scm-tr-m' : '') + (state.cargo && state.cargo.id === c.id ? ' scm-on' : '') + '" data-qa="board-cargo-' + esc(c.id) + '" role="button" tabindex="0" onclick="SkipiChartering.open(' + Number(c.id) + ')">'
      + td(clean(c.account), sourceName(c.source || 'mine') + ' · ' + clean(c.ref)) + td(clean(c.load_port), clean(c.discharge_port), 'scm-strong')
      + td(clean(c.cargo_name), qty(c), 'scm-qty') + td(span(c.laycan_from, c.laycan_to), areaName(c.load_area))
      + (m ? matchCell(m) + '<span class="scm-td scm-act">' + (m.fit && validEmail(clean(c.contact_email)) && (c.source || 'mine') !== 'mine'
        ? '<button type="button" class="scm-link" data-qa="board-offer-' + esc(c.id) + '"' + (state.busy ? ' disabled' : '') + ' onclick="event.stopPropagation();SkipiChartering.offerShip(' + Number(c.id) + ')">' + esc(t('Offer the ship', 'Предложить судно')) + '</button>' : '') + '</span>'
        : td(countsText(c), '')) + '</div>';
  }
  function boardPosRow(p, m) {
    return '<div class="scm-tr scm-tr-pos' + (m ? ' scm-tr-m' : '') + (state.pos && state.pos.id === p.id ? ' scm-on' : '') + '" data-qa="board-pos-' + esc(p.id) + '" role="button" tabindex="0" onclick="SkipiChartering.openPos(' + Number(p.id) + ')">'
      + td(clean(p.company), sourceName(p.source || 'mine')) + td(clean(p.ship_name), [p.imo, clean(p.ship_type)].filter(Boolean).join(' / '), 'scm-strong')
      + td(num(p.dwt) ? thousands(num(p.dwt)) : '', num(p.capacity) ? thousands(num(p.capacity)) : '', 'scm-qty') + td(clean(p.gear), clean(p.built))
      + td(clean(p.open_place) || areaName(p.open_area), span(p.open_from, p.open_to))
      + (m ? matchCell(m) + '<span class="scm-td scm-act">' + (m.fit
        ? '<button type="button" class="scm-link" data-qa="board-request-' + esc(p.id) + '"' + (state.busy ? ' disabled' : '') + ' onclick="event.stopPropagation();SkipiChartering.requestPosition(' + Number(p.id) + ')">' + esc(t('Request freight', 'Запросить фрахт')) + '</button>' : '') + '</span>'
        : td(posStatusName(p.status || 'open'), '')) + '</div>';
  }
  function posFormHtml() {
    var isNew = !state.posform.id;
    return '<div class="scm-pane scm-card" data-qa="pos-form"><div class="scm-title">' + esc(isNew ? t('Add position', 'Добавить позицию') : t('Position', 'Позиция')) + '</div><div class="scm-grid">'
      + field('posform', 'ship_name', t('Ship name', 'Название судна'), { required: true, list: 'ships' })
      + field('posform', 'imo', t('IMO number', 'Номер ИМО'), { placeholder: t('7 digits', '7 цифр') })
      + field('posform', 'ship_type', t('Type', 'Тип'), { placeholder: t('e.g. BULK, MPP', 'например, BULK, MPP') })
      + field('posform', 'dwt', t('Deadweight, mt', 'Дедвейт, т'))
      + field('posform', 'capacity', t('Capacity, m3', 'Вместимость, м3'))
      + field('posform', 'gear', t('Gear', 'Грузовое устройство'), { placeholder: t('e.g. 4 x 30 t, or gearless', 'например, 4 x 30 т, или без кранов') })
      + field('posform', 'built', t('Year built', 'Год постройки')) + field('posform', 'flag', t('Flag', 'Флаг'))
      + field('posform', 'open_place', t('Open at (port)', 'Открыто в (порт)'), { list: 'ports' })
      + field('posform', 'open_area', t('Open area', 'Район'), { options: areaOptions() })
      + field('posform', 'open_from', t('Open from', 'Открыто с'), { type: 'date' }) + field('posform', 'open_to', t('Open to', 'Открыто по'), { type: 'date' })
      + field('posform', 'status', t('Status', 'Статус'), { options: POS_STATUS.map(function (x) { return [x, posStatusName(x)]; }) })
      + field('posform', 'source', t('Source', 'Источник'), { options: [['mine', sourceName('mine')], ['market', sourceName('market')]] })
      + field('posform', 'company', t('Published by (company, person)', 'Кто дал позицию (компания, человек)'))
      + field('posform', 'contact_email', t('E-mail', 'Почта'), { type: 'email', list: 'emails' })
      + field('posform', 'note', t('Your note (never sent)', 'Ваша заметка (не отправляется)'), { wide: true, area: true, rows: 2 })
      + field('posform', 'tags', t('Tags (comma separated)', 'Теги (через запятую)'), { wide: true })
      + '</div><div class="scm-actions">' + btn(t('Save', 'Сохранить'), 'savePos()', { primary: true, qa: 'pos-save' }) + btn(t('Cancel', 'Отмена'), 'cancel()', { qa: 'pos-cancel' }) + '</div></div>';
  }
  function posCardHtml() {
    var p = state.pos, h = '<div class="scm-pane scm-card" data-qa="pos-card"><div class="scm-head"><div class="scm-title">' + esc(clean(p.ship_name)) + '</div>'
      + '<span class="scm-step">' + esc(posStatusName(p.status || 'open')) + '</span></div>'
      + line(t('Open', 'Открыто'), [clean(p.open_place), areaName(p.open_area), span(p.open_from, p.open_to)].filter(Boolean).join(' · '))
      + line(t('IMO / type', 'ИМО / тип'), [p.imo, clean(p.ship_type)].filter(Boolean).join(' / '))
      + line(t('Deadweight', 'Дедвейт'), num(p.dwt) ? thousands(num(p.dwt)) + ' mt' : '') + line(t('Capacity', 'Вместимость'), num(p.capacity) ? thousands(num(p.capacity)) + ' m3' : '')
      + line(t('Gear', 'Краны'), clean(p.gear)) + line(t('Built / flag', 'Год / флаг'), [clean(p.built), clean(p.flag)].filter(Boolean).join(' / '))
      + line(t('Published by', 'Кто дал'), [clean(p.company), clean(p.contact_email)].filter(Boolean).join(' · ')) + line(t('Source', 'Источник'), sourceName(p.source || 'mine'));
    h += tagsHtml(p.tags);
    if (clean(p.note)) h += '<div class="scm-pair-note">' + esc(p.note) + '</div>';
    h += '<div class="scm-actions">';
    if (state.removing === 'pos') h += btn(t('Yes, delete the position', 'Да, удалить позицию'), 'removePos()', { primary: true, qa: 'pos-remove-yes' }) + btn(t('Keep', 'Оставить'), 'askRemove(null)', { qa: 'pos-remove-no' });
    else h += btn(t('Edit', 'Изменить'), 'editPos()', { qa: 'pos-edit' }) + btn(t('Delete', 'Удалить'), 'askRemove(\'pos\')', { qa: 'pos-remove' }) + btn(t('Close', 'Закрыть'), 'closePos()', { qa: 'pos-close' });
    return h + '</div></div>';
  }
  function bazarHtml() {
    var q = clean(state.q).toLowerCase(), fq = clean(state.fq).toLowerCase(), left, right;
    var black = blackList();
    var cargoes = state.cargoes.filter(function (c) { return !c.archived && state.src[c.source || 'mine'] && black.indexOf(clean(c.account).toLowerCase()) < 0 && hasText(c, ['ref', 'own_ref', 'account', 'cargo_name', 'load_port', 'discharge_port', 'tags'], q) && passCargo(c, state.flt.cargo); });
    var open = state.positions.filter(function (p) { return (p.status || 'open') === 'open'; });
    var positions = state.positions.filter(function (p) { return black.indexOf(clean(p.company).toLowerCase()) < 0 && hasText(p, ['ship_name', 'imo', 'ship_type', 'company', 'open_place', 'tags'], fq) && passPos(p, state.flt.fleet); });
    var cargoHead = '<div class="scm-thead scm-tr-cargo">' + th(t('Account', 'Аккаунт'), t('Source · ref', 'Источник · номер')) + th(t('Loading', 'Погрузка'), t('Discharging', 'Выгрузка'))
      + th(t('Cargo', 'Груз'), t('Quantity', 'Количество')) + th(t('Laycan', 'Лейкан'), t('Area', 'Район'));
    var posHead = '<div class="scm-thead scm-tr-pos">' + th(t('Published by', 'Кто дал'), t('Source', 'Источник')) + th(t('Ship', 'Судно'), t('IMO / type', 'ИМО / тип'))
      + th(t('DWT', 'Дедвейт'), t('Capacity', 'Вместимость')) + th(t('Gear', 'Краны'), t('Built', 'Год')) + th(t('Open', 'Открыто'), t('Dates', 'Даты'));
    // Left half: the cargo list, an open cargo, a form — or the cargoes that suit the open position.
    if (state.form) left = cargoFormHtml();
    else if (state.cargo) left = cargoHtml();
    else {
      left = '<div class="scm-pane scm-board" data-qa="bazar-cargo"><div class="scm-bar"><span class="scm-tabs">' + (state.pos ? '<b>' + esc(t('Suitable cargo', 'Подходящие грузы')) + '</b>'
        : '<button type="button" class="scm-btab' + (state.btab === 'cargo' ? ' scm-on' : '') + '" data-qa="bazar-tab-cargo" onclick="SkipiChartering.bazarTab(\'left\',\'cargo\')">' + esc(t('Cargo', 'Грузы')) + '</button>'
        + '<button type="button" class="scm-btab' + (state.btab === 'orders' ? ' scm-on' : '') + '" data-qa="bazar-tab-orders" onclick="SkipiChartering.bazarTab(\'left\',\'orders\')">' + esc(t('Orders', 'Ордера')) + '</button>') + '</span>'
        + '<input class="scm-input scm-search" data-qa="bazar-cargo-search" type="search" placeholder="' + esc(t('Search', 'Поиск')) + '" value="' + esc(state.q) + '" oninput="SkipiChartering.search(this.value)">';
      SOURCES.forEach(function (x) { left += '<button type="button" class="scm-tab' + (state.src[x] ? ' scm-on' : '') + '" data-qa="bazar-src-' + x + '" onclick="SkipiChartering.toggleSource(\'' + x + '\')">' + esc(sourceName(x)) + '</button>'; });
      left += filterButton('cargo') + '<button type="button" class="scm-add" data-qa="bazar-cargo-add" title="' + esc(t('Add', 'Добавить')) + '" onclick="SkipiChartering.' + (!state.pos && state.btab === 'orders' ? 'newOrder()' : 'newCargo()') + '">+</button></div>' + filterPanel('cargo');
      var rows = state.pos ? ranked(cargoes, function (c) { return match(c, state.pos); }) : cargoes.map(function (c) { return { x: c, m: null }; });
      if (!state.pos && state.btab === 'orders') { left += ordersBoardHtml(); rows = []; cargoHead = ''; }
      else left += cargoHead + (state.pos ? th(t('Match', 'Совпадение'), t('Why', 'Почему')) + th('', '') : th(t('Ships', 'Суда'), '')) + '</div>';
      if (!rows.length && cargoHead) left += '<div class="scm-note" data-qa="bazar-cargo-empty">' + esc(t('No cargo here yet. Press + to add one.', 'Грузов пока нет. Нажмите +, чтобы добавить.')) + '</div>';
      rows.forEach(function (r) { left += boardCargoRow(r.x, r.m); });
      left += '</div>';
    }
    // Right half (dark): open positions, an open position, a form — or the positions that suit the open cargo.
    if (state.posform) right = posFormHtml();
    else if (state.pform) right = pairFormHtml();
    else if (state.pos) right = posCardHtml();
    else {
      right = '<div class="scm-pane scm-board" data-qa="bazar-fleet"><div class="scm-bar"><span class="scm-tabs">' + (state.cargo ? '<b>' + esc(t('Suitable fleet', 'Подходящий флот')) + '</b>'
        : '<button type="button" class="scm-btab' + (state.ftab === 'fleet' ? ' scm-on' : '') + '" data-qa="bazar-tab-fleet" onclick="SkipiChartering.bazarTab(\'right\',\'fleet\')">' + esc(t('Fleet', 'Флот')) + '</button>'
        + '<button type="button" class="scm-btab' + (state.ftab === 'routes' ? ' scm-on' : '') + '" data-qa="bazar-tab-routes" onclick="SkipiChartering.bazarTab(\'right\',\'routes\')">' + esc(t('Routes', 'Маршруты')) + '</button>') + '</span>'
        + '<input class="scm-input scm-search" data-qa="bazar-fleet-search" type="search" placeholder="' + esc(t('Search', 'Поиск')) + '" value="' + esc(state.fq) + '" oninput="SkipiChartering.fleetSearch(this.value)">'
        + filterButton('fleet') + '<button type="button" class="scm-add" data-qa="bazar-pos-add" title="' + esc(t('Add position', 'Добавить позицию')) + '" onclick="SkipiChartering.newPos()">+</button></div>' + filterPanel('fleet');
      var prow = state.cargo ? ranked(positions.filter(function (p) { return open.indexOf(p) >= 0; }), function (p) { return match(state.cargo, p); }) : positions.map(function (p) { return { x: p, m: null }; });
      if (!state.cargo && state.ftab === 'routes') { right += '</div>'; return '<div class="scm-halves"><div class="scm-half scm-light">' + left + '</div><div class="scm-half scm-dark">' + right.replace(/<\/div>$/, '') + routesHtml() + '</div></div>'; }
      right += posHead + (state.cargo ? th(t('Match', 'Совпадение'), t('Why', 'Почему')) + th('', '') : th(t('Status', 'Статус'), '')) + '</div>';
      if (!prow.length) right += '<div class="scm-note" data-qa="bazar-fleet-empty">' + esc(t('No open positions yet. Press + to add a ship that is open.', 'Открытых позиций пока нет. Нажмите +, чтобы добавить открытое судно.')) + '</div>';
      prow.forEach(function (r) { right += boardPosRow(r.x, r.m); });
      right += '</div>';
    }
    return '<div class="scm-halves"><div class="scm-half scm-light">' + left + '</div><div class="scm-half scm-dark">' + right + '</div></div>';
  }
  // ---- directories: one list / card / form for ships, contacts and ports -----
  function kindOf() { return KIND_ORDER.indexOf(state.section) >= 0 ? KINDS[state.section] : null; }
  function optionName(kind, key, value) {
    var out = '';
    KINDS[kind].fields.forEach(function (f) { if (f[0] === key && f[3].options) f[3].options.forEach(function (o) { if (o[0] === value) out = ru() ? o[2] : o[1]; }); });
    return value ? out : '';
  }
  function fieldValue(kind, f, x) {
    if (f[3].options) return optionName(kind, f[0], x[f[0]]);
    if (f[3].areas) return areaName(x[f[0]]);
    return clean(x[f[0]]);
  }
  function itemsHtml() {
    var kind = state.section, K = kindOf(), q = clean(state.iq).toLowerCase(), keys = K.fields.map(function (f) { return f[0]; });
    var rows = state.items[kind].filter(function (x) { return hasText(x, keys, q); });
    var left = '<div class="scm-pane scm-board" data-qa="items-' + kind + '"><div class="scm-bar"><span class="scm-tabs"><b>' + esc(ru() ? K.ru : K.en) + '</b> · ' + rows.length + '</span>'
      + '<input class="scm-input scm-search" data-qa="items-search" type="search" placeholder="' + esc(t('Search', 'Поиск')) + '" value="' + esc(state.iq) + '" oninput="SkipiChartering.itemSearch(this.value)">'
      + '<button type="button" class="scm-add" data-qa="item-add" title="' + esc(t('Add', 'Добавить')) + '" onclick="SkipiChartering.newItem()">+</button></div><div class="scm-thead scm-tr-4">';
    K.cols.forEach(function (c) { left += th(ru() ? c[1] : c[0], ru() ? c[3] : c[2]); });
    left += '</div>';
    if (!rows.length) left += '<div class="scm-note" data-qa="items-empty">' + esc(t('Nothing here yet. Press + to add.', 'Здесь пока пусто. Нажмите +, чтобы добавить.')) + '</div>';
    rows.forEach(function (x) {
      left += '<div class="scm-tr scm-tr-4' + (state.item && state.item.id === x.id ? ' scm-on' : '') + '" data-qa="item-' + esc(x.id) + '" role="button" tabindex="0" onclick="SkipiChartering.openItem(' + Number(x.id) + ')">';
      K.row(x).forEach(function (c, i) { left += td(clean(c[0]), clean(c[1]), i === 0 ? 'scm-strong' : ''); });
      left += '</div>';
    });
    left += '</div>';
    var right;
    if (state.posform) right = posFormHtml();
    else if (state.iform) {
      right = '<div class="scm-pane scm-card" data-qa="item-form"><div class="scm-title">' + esc(ru() ? K.one[1] : K.one[0]) + '</div><div class="scm-grid">';
      K.fields.forEach(function (f) {
        var o = { required: f[3].required, type: f[3].type, wide: f[3].wide, area: f[3].area, rows: 2 };
        if (f[3].options) o.options = f[3].options.map(function (x) { return [x[0], ru() ? x[2] : x[1]]; });
        if (f[3].areas) o.options = areaOptions();
        right += field('iform', f[0], ru() ? f[2] : f[1], o);
      });
      right += '</div>' + (K.formExtra ? K.formExtra(state.iform) : '') + '<div class="scm-actions">' + btn(t('Save', 'Сохранить'), 'saveItem()', { primary: true, qa: 'item-save' }) + btn(t('Cancel', 'Отмена'), 'cancel()', { qa: 'item-cancel' }) + '</div></div>';
    } else if (state.item) {
      var x = state.item;
      right = '<div class="scm-pane scm-card" data-qa="item-card"><div class="scm-title">' + esc(clean(x.name)) + '</div>';
      K.fields.slice(1).forEach(function (f) { if (f[0] !== 'note' && f[0] !== 'tags' && !(K.hide && K.hide[f[0]])) right += line(ru() ? f[2] : f[1], fieldValue(kind, f, x)); });
      right += tagsHtml(x.tags);
      if (clean(x.note)) right += '<div class="scm-pair-note">' + esc(x.note) + '</div>';
      if (K.extra) right += K.extra(x);
      if (kind === 'ships') {
        var ps = state.positions.filter(function (p) { return (x.imo && p.imo === x.imo) || clean(p.ship_name).toLowerCase() === clean(x.name).toLowerCase(); });
        right += '<div class="scm-block">' + esc(t('Positions · ' + ps.length, 'Позиции · ' + ps.length)) + '</div>';
        ps.forEach(function (p) { right += line(posStatusName(p.status || 'open'), [clean(p.open_place) || areaName(p.open_area), span(p.open_from, p.open_to), clean(p.company)].filter(Boolean).join(' · ')); });
      }
      right += '<div class="scm-actions">';
      if (state.removing === 'item') right += btn(t('Yes, delete', 'Да, удалить'), 'removeItem()', { primary: true, qa: 'item-remove-yes' }) + btn(t('Keep', 'Оставить'), 'askRemove(null)', { qa: 'item-remove-no' });
      else {
        if (kind === 'ships') right += btn(t('Add position', 'Добавить позицию'), 'positionFromShip()', { primary: true, qa: 'ship-position' });
        if (kind === 'contacts' && validEmail(clean(x.email))) right += btn(t('Write', 'Написать'), 'writeTo()', { primary: true, qa: 'contact-write' });
        if (K.actions) right += K.actions(x);
        right += btn(t('Edit', 'Изменить'), 'editItem()', { qa: 'item-edit' }) + btn(t('Delete', 'Удалить'), 'askRemove(\'item\')', { qa: 'item-remove' }) + btn(t('Close', 'Закрыть'), 'closeItem()', { qa: 'item-close' });
      }
      right += '</div></div>';
    } else right = '<div class="scm-pane scm-card"><div class="scm-note">' + esc(t('Open a line to see the details, or press + to add one.', 'Откройте строку, чтобы увидеть детали, или нажмите +, чтобы добавить.')) + '</div></div>';
    return '<div class="scm-halves"><div class="scm-half scm-light">' + left + '</div><div class="scm-half scm-dark">' + right + '</div></div>';
  }
  // Suggestions for place and address fields, taken from the user's own directories.
  function datalistsHtml() {
    var h = '<datalist id="scm-dl-ports">';
    state.items.ports.forEach(function (x) { h += '<option value="' + esc(clean(x.name)) + '"></option>'; });
    h += '</datalist><datalist id="scm-dl-emails">';
    state.items.contacts.forEach(function (x) { if (clean(x.email)) h += '<option value="' + esc(clean(x.email)) + '">' + esc([clean(x.name), clean(x.company)].filter(Boolean).join(', ')) + '</option>'; });
    h += '</datalist><datalist id="scm-dl-ships">';
    state.items.ships.forEach(function (x) { h += '<option value="' + esc(clean(x.name)) + '"></option>'; });
    return h + '</datalist>';
  }
  function railHtml() {
    var h = '<div class="scm-rail" data-qa="chartering-rail">';
    RAIL.forEach(function (k) {
      var label = k === 'bazar' ? t('Bazar', 'Базар') : k === 'book' ? t('Cargo', 'Грузы') : (ru() ? KINDS[k].ru : KINDS[k].en), icon = k === 'bazar' ? '⇄' : k === 'book' ? '▤' : KINDS[k].icon;
      h += '<button type="button" class="scm-rail-item' + (state.section === k ? ' scm-on' : '') + '" data-qa="rail-' + k + '" title="' + esc(label) + '" onclick="SkipiChartering.go(\'' + k + '\')">'
        + '<span class="scm-rail-icon" aria-hidden="true">' + icon + '</span><span class="scm-rail-label">' + esc(label) + '</span></button>';
    });
    return h + '</div>';
  }
  // ---- letter form, settings, routes, rate statistics ---------------------------
  function settings() { return state.items.settings[0] || {}; }
  function blackList() { return String(settings().blacklist || '').split(/[,\n]/).map(function (x) { return clean(x).toLowerCase(); }).filter(Boolean); }
  function compose(mail, about, then) {
    var st = settings();
    state.compose = { to: clean(mail.to), cc: clean(st.cc), bcc: clean(st.bcc), subject: String(mail.subject || ''), about: clean(about),
      body: String(mail.body || '') + (clean(st.signature) ? '\n\n' + String(st.signature).replace(/\s+$/, '') : '') };
    composeThen = then || null; state.errors = {}; rerender();
  }
  function composeHtml() {
    if (!state.compose) return '';
    return '<div class="scm-modal" data-qa="compose"><div class="scm-pane scm-card scm-modal-box"><div class="scm-title">' + esc(t('Letter', 'Письмо')) + '</div><div class="scm-grid">'
      + field('compose', 'to', t('To', 'Кому'), { required: true, wide: true, list: 'emails' }) + field('compose', 'cc', t('Copy', 'Копия'), { list: 'emails' }) + field('compose', 'bcc', t('Blind copy', 'Скрытая копия'), { list: 'emails' })
      + field('compose', 'subject', t('Subject', 'Тема'), { wide: true }) + field('compose', 'body', t('Message', 'Текст'), { wide: true, area: true, rows: 14 })
      + '</div><div class="scm-hint">' + esc(t('The letter opens in your mail program; you send it from there. A copy is kept in «Mail».', 'Письмо откроется в вашей почтовой программе, отправляете вы оттуда. Копия остаётся в разделе «Почта».')) + '</div>'
      + '<div class="scm-actions">' + btn(t('Open in mail', 'Открыть в почте'), 'sendCompose()', { primary: true, qa: 'compose-send' }) + btn(t('Cancel', 'Отмена'), 'cancelCompose()', { qa: 'compose-cancel' }) + '</div></div></div>';
  }
  function settingsHtml() {
    var left = '<div class="scm-pane scm-card" data-qa="settings-form"><div class="scm-title">' + esc(t('Company and letters', 'Компания и письма')) + '</div><div class="scm-grid">'
      + field('sform', 'name', t('Company', 'Компания'), { required: true }) + field('sform', 'email', t('Your e-mail', 'Ваша почта'), { type: 'email' })
      + field('sform', 'phone', t('Phone', 'Телефон')) + field('sform', 'address', t('Address', 'Адрес'))
      + field('sform', 'cc', t('Always copy to', 'Всегда ставить в копию'), {}) + field('sform', 'bcc', t('Always blind copy to', 'Всегда ставить в скрытую копию'), {})
      + field('sform', 'signature', t('Signature under every letter', 'Подпись под каждым письмом'), { wide: true, area: true, rows: 4 })
      + field('sform', 'blacklist', t('Black list: companies hidden from Bazar (comma separated)', 'Чёрный список: компании, скрытые с Базара (через запятую)'), { wide: true, area: true, rows: 2 })
      + '</div><div class="scm-actions">' + btn(t('Save', 'Сохранить'), 'saveSettings()', { primary: true, qa: 'settings-save' }) + '</div></div>';
    var right = '<div class="scm-pane scm-card"><div class="scm-title">' + esc(t('What this changes', 'На что это влияет')) + '</div><div class="scm-note">'
      + esc(t('The signature is added under every freight request, offer and recap. The copy addresses are put into every letter. Cargo and positions of the companies on the black list are not shown on Bazar.',
        'Подпись добавляется под каждым запросом фрахта, предложением и рекапом. Адреса копий подставляются в каждое письмо. Грузы и позиции компаний из чёрного списка на Базаре не показываются.')) + '</div></div>';
    return '<div class="scm-halves"><div class="scm-half scm-light">' + left + '</div><div class="scm-half scm-dark">' + right + '</div></div>';
  }
  function portByName(name) { var out = null; state.items.ports.forEach(function (x) { if (clean(x.name).toLowerCase() === clean(name).toLowerCase()) out = x; }); return out; }
  // Great-circle distance in nautical miles; the sea route is longer.
  function miles(a, b) {
    if (!a || !b || a.lat === '' || a.lon === '' || b.lat === '' || b.lon === '' || isNaN(Number(a.lat)) || isNaN(Number(b.lat)) || isNaN(Number(a.lon)) || isNaN(Number(b.lon))) return null;
    var r = Math.PI / 180, la = Number(a.lat) * r, lb = Number(b.lat) * r, d = (Number(b.lon) - Number(a.lon)) * r;
    var x = Math.sin((lb - la) / 2), y = Math.sin(d / 2), h = x * x + Math.cos(la) * Math.cos(lb) * y * y;
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function routeTotal() {
    var total = 0, ok = true, legs = [];
    for (var i = 1; i < state.route.length; i++) {
      var m = miles(portByName(state.route[i - 1]), portByName(state.route[i]));
      legs.push(m); if (m === null) ok = false; else total += m;
    }
    return { total: total, ok: ok && legs.length > 0, legs: legs };
  }
  function routesHtml() {
    var r = routeTotal(), h = '<div class="scm-pane scm-card" data-qa="bazar-routes"><div class="scm-note">' + esc(t('Pick ports from your directory. Distance is the straight great-circle line between them; the sea route is longer.',
      'Выберите порты из своего справочника. Расстояние считается по прямой (дуге большого круга); морской путь длиннее.')) + '</div>';
    state.route.forEach(function (name, i) {
      h += '<div class="scm-route-line"><select class="scm-input" data-qa="route-port-' + i + '" onchange="SkipiChartering.routeSet(' + i + ',this.value)"><option value="">' + esc(t('— port —', '— порт —')) + '</option>';
      state.items.ports.forEach(function (x) { h += '<option value="' + esc(clean(x.name)) + '"' + (clean(x.name) === name ? ' selected' : '') + '>' + esc(clean(x.name)) + '</option>'; });
      h += '</select><span class="scm-route-leg" data-qa="route-leg-' + i + '">' + esc(i === 0 ? '' : r.legs[i - 1] === null ? (state.route[i] && state.route[i - 1] ? t('no coordinates', 'нет координат') : '') : thousands(Math.round(r.legs[i - 1])) + t(' nm', ' миль')) + '</span>'
        + (state.route.length > 2 ? '<button type="button" class="scm-link" onclick="SkipiChartering.routeRemove(' + i + ')">' + esc(t('remove', 'убрать')) + '</button>' : '') + '</div>';
    });
    h += '<div class="scm-actions">' + btn(t('Add a port', 'Добавить порт'), 'routeAdd()', { small: true, qa: 'route-add' })
      + (r.ok ? btn(t('To the calculator', 'В калькулятор'), 'routeToCalc()', { small: true, primary: true, qa: 'route-calc' }) : '') + '</div>';
    if (r.ok) h += '<div class="scm-title" data-qa="route-total">' + esc(thousands(Math.round(r.total)) + t(' nautical miles', ' морских миль')) + '</div>';
    return h + '</div>';
  }
  function rateStatsHtml(x) {
    var same = state.items.rates.filter(function (y) { return clean(y.load_port).toLowerCase() === clean(x.load_port).toLowerCase() && clean(y.discharge_port).toLowerCase() === clean(x.discharge_port).toLowerCase()
      && (y.basis || 'mt') === (x.basis || 'mt') && val(y.rate) > 0; });
    if (same.length < 2) return '';
    var v = same.map(function (y) { return val(y.rate); }), sum = v.reduce(function (a, b) { return a + b; }, 0);
    return '<div class="scm-block">' + esc(t('Same route, your records · ' + same.length, 'Тот же маршрут, ваши записи · ' + same.length)) + '</div><div data-qa="rate-stats">'
      + line(t('Average', 'Средняя'), (sum / v.length).toFixed(2)) + line(t('Lowest / highest', 'Мин. / макс.'), Math.min.apply(null, v) + ' / ' + Math.max.apply(null, v)) + '</div>';
  }
  function ordersBoardHtml() {
    var h = '<div class="scm-thead scm-tr-4">';
    KINDS.orders.cols.forEach(function (c) { h += th(ru() ? c[1] : c[0], ru() ? c[3] : c[2]); });
    h += '</div>';
    if (!state.items.orders.length) h += '<div class="scm-note" data-qa="bazar-orders-empty">' + esc(t('No time-charter orders yet. Press + to add one.', 'Ордеров на тайм-чартер пока нет. Нажмите +, чтобы добавить.')) + '</div>';
    state.items.orders.forEach(function (x) {
      h += '<div class="scm-tr scm-tr-4" data-qa="board-order-' + Number(x.id) + '" role="button" tabindex="0" onclick="SkipiChartering.openOrder(' + Number(x.id) + ')">';
      KINDS.orders.row(x).forEach(function (c, i) { h += td(clean(c[0]), clean(c[1]), i === 0 ? 'scm-strong' : ''); });
      h += '</div>';
    });
    return h;
  }
  function html() {
    var body, intro = '<div class="scm-title">' + esc(t('My cargoes', 'Мои грузы')) + '</div>';
    if (state.view === 'loading') body = '<div class="scm-pane"><div class="scm-note">' + esc(t('Loading…', 'Загружаю…')) + '</div></div>';
    else if (state.view === 'signin') body = '<div class="scm-pane" data-qa="chartering-signin">' + intro + '<div class="scm-note">' + esc(t('Sign in to your Skipi account to open your cargo book.', 'Войдите в аккаунт Skipi, чтобы открыть книгу грузов.')) + '</div></div>';
    else if (state.view === 'offline') body = '<div class="scm-pane" data-qa="chartering-offline">' + intro + '<div class="scm-note">' + esc(t('The cargo book is not available right now. Check the connection.', 'Книга грузов сейчас недоступна. Проверьте связь.')) + '</div>'
      + '<div class="scm-actions">' + btn(t('Try again', 'Повторить'), 'reload()', { qa: 'chartering-retry' }) + '</div></div>';
    else {
      var right = state.pform ? pairFormHtml() : state.form ? cargoFormHtml() : state.cargo ? cargoHtml()
        : '<div class="scm-pane scm-card scm-idle"><div class="scm-note">' + esc(t('Open a cargo to see its ships and send freight requests.', 'Откройте груз, чтобы увидеть его суда и отправить запросы фрахта.')) + '</div></div>';
      var titles = { bazar: t('Bazar', 'Базар'), book: t('Cargo', 'Грузы'), settings: t('Settings', 'Настройки') };
      KIND_ORDER.forEach(function (k) { titles[k] = ru() ? KINDS[k].ru : KINDS[k].en; });
      body = '<div class="scm-shell">' + railHtml() + '<div class="scm-main"><div class="scm-top" data-qa="chartering-title">' + esc(titles[state.section]) + '</div>' + datalistsHtml()
        + (state.section === 'bazar' ? bazarHtml() : kindOf() ? itemsHtml() : state.section === 'settings' ? settingsHtml() : '<div class="scm-halves' + (state.pform || state.form || state.cargo ? ' scm-opened' : '') + '"><div class="scm-half scm-light">' + listHtml() + '</div><div class="scm-half scm-light scm-right">' + right + '</div></div>')
        + '</div>' + composeHtml() + '</div>';
    }
    return '<div class="scm-wrap" data-qa="chartering-module">' + body + '</div>';
  }
  function rerender() { if (root && root.isConnected !== false) root.innerHTML = html(); }

  function pick(src, keys) { var o = {}; keys.forEach(function (k) { o[k] = src[k] == null ? '' : String(src[k]); }); return o; }
  function cargoErrors(f) {
    var e = {}, need = t('Required.', 'Обязательное поле.');
    if (!clean(f.load_port)) e.load_port = need;
    if (!clean(f.discharge_port)) e.discharge_port = need;
    if (!clean(f.cargo_name)) e.cargo_name = need;
    if (f.laycan_from && f.laycan_to && f.laycan_to < f.laycan_from) e.laycan_to = t('Earlier than the first date.', 'Раньше первой даты.');
    if (num(f.qty_min) && num(f.qty_max) && num(f.qty_max) < num(f.qty_min)) e.qty_max = t('Less than the first figure.', 'Меньше первого числа.');
    if (clean(f.contact_email) && !validEmail(clean(f.contact_email))) e.contact_email = t('Check the address.', 'Проверьте адрес.');
    return e;
  }
  function pairErrors(f) {
    var e = {};
    if (!clean(f.ship_name)) e.ship_name = t('Required.', 'Обязательное поле.');
    if (clean(f.imo) && !validImo(clean(f.imo))) e.imo = t('This is not a valid IMO number — check the digits.', 'Такого номера ИМО не бывает — проверьте цифры.');
    if (clean(f.contact_email) && !validEmail(clean(f.contact_email))) e.contact_email = t('Check the address.', 'Проверьте адрес.');
    if (f.open_from && f.open_to && f.open_to < f.open_from) e.open_to = t('Earlier than the first date.', 'Раньше первой даты.');
    return e;
  }
  function findPair(id) { for (var i = 0; i < state.pairs.length; i++) if (state.pairs[i].id === id) return state.pairs[i]; return null; }

  var moduleApi = {
    version: VERSION,
    validImo: validImo,
    requestMail: requestMail,
    offerMail: offerMail,
    match: match,
    matchOrder: matchOrder,
    calcResult: calcResult,
    recapText: recapText,
    mount: function (container, d) {
      root = container; deps = d || {};
      if (state.view !== 'ready') state.view = 'loading';
      rerender(); load();
    },
    reload: function () { state.view = 'loading'; rerender(); load(); },
    search: function (v) { state.q = String(v || '').slice(0, 80); rerender(); var el = root && root.querySelector && root.querySelector('[data-qa="cargo-search"]'); if (el) { el.focus(); try { el.setSelectionRange(state.q.length, state.q.length); } catch (e) { /* not a text field */ } } },
    showArchive: function (on) { state.archive = !!on; rerender(); },
    set: function (kind, key, v) { if (state[kind]) { state[kind][key] = String(v == null ? '' : v); delete state.errors[key]; } },
    open: function (id) { state.form = null; state.pform = null; state.posform = null; state.pos = null; state.removing = null; call('get', [id], take); },
    close: function () { state.cargo = null; state.pairs = []; state.removing = null; rerender(); },
    cancel: function () { state.form = null; state.pform = null; state.posform = null; state.errors = {}; rerender(); },
    go: function (section) {
      if (section !== 'bazar' && section !== 'book' && section !== 'settings' && KIND_ORDER.indexOf(section) < 0) return;
      state.sform = section === 'settings' ? pick(settings(), ['name', 'email', 'phone', 'address', 'cc', 'bcc', 'signature', 'blacklist']) : null;
      state.compose = null; composeThen = null;
      state.section = section; state.form = null; state.pform = null; state.posform = null; state.pos = null; state.removing = null; state.errors = {};
      state.item = null; state.iform = null; state.iq = ''; state.fpanel = null; state.fltform = null; rerender();
    },
    itemSearch: function (v) { state.iq = String(v || '').slice(0, 80); rerender(); var el = root && root.querySelector && root.querySelector('[data-qa="items-search"]'); if (el) { el.focus(); try { el.setSelectionRange(state.iq.length, state.iq.length); } catch (e) { /* not a text field */ } } },
    openItem: function (id) {
      var K = kindOf(); if (!K) return;
      state.items[state.section].forEach(function (x) { if (x.id === id) state.item = x; });
      state.iform = null; state.posform = null; state.removing = null; rerender();
    },
    closeItem: function () { state.item = null; state.removing = null; rerender(); },
    newItem: function () { var K = kindOf(); if (!K) return; if (state.section === 'mails') { compose({}, ''); return; } state.iform = pick({}, K.fields.map(function (f) { return f[0]; })); state.posform = null; state.errors = {}; rerender(); },
    editItem: function () { var K = kindOf(); if (!K || !state.item) return; state.iform = pick(state.item, K.fields.map(function (f) { return f[0]; })); state.iform.id = state.item.id; state.errors = {}; rerender(); },
    saveItem: function () {
      var K = kindOf(), f = state.iform, kind = state.section; if (!K || !f) return;
      var e = {};
      K.fields.forEach(function (d) {
        var v = clean(f[d[0]]);
        if (d[3].required && !v) e[d[0]] = t('Required.', 'Обязательное поле.');
        else if (d[3].type === 'email' && v && !validEmail(v)) e[d[0]] = t('Check the address.', 'Проверьте адрес.');
        else if (d[0] === 'imo' && v && !validImo(v)) e[d[0]] = t('This is not a valid IMO number — check the digits.', 'Такого номера ИМО не бывает — проверьте цифры.');
      });
      state.errors = e;
      if (Object.keys(e).length) { rerender(); return; }
      var body = pick(f, K.fields.map(function (d) { return d[0]; })); if (f.id) body.id = f.id;
      call('saveItem', [kind, body], function (res) { state.items[kind] = res.items || state.items[kind]; state.item = res.item || null; state.iform = null; });
    },
    removeItem: function () {
      var kind = state.section; if (!KINDS[kind] || !state.item) return;
      call('removeItem', [kind, state.item.id], function (res) { state.items[kind] = res.items || []; state.item = null; state.removing = null; });
    },
    recalc: function () { rerender(); },
    // ---- negotiation
    history: function (id) { state.hist = state.hist === id ? null : id; state.eform = null; state.errors = {}; rerender(); },
    newEvent: function (id) { state.hist = id; state.eform = { pair: id, kind: 'quotation', rate: '', valid_until: '', subjects: '', subjects_until: '', note: '' }; state.errors = {}; rerender(); },
    cancelEvent: function () { state.eform = null; state.errors = {}; rerender(); },
    saveEvent: function () {
      var f = state.eform; if (!f || !state.cargo) return;
      var e = {};
      if ((f.kind === 'quotation' || f.kind === 'counter' || f.kind === 'firm') && !clean(f.rate)) e.rate = t('Enter the rate.', 'Укажите ставку.');
      if (f.kind === 'subjects' && !clean(f.subjects)) e.subjects = t('Say which subjects.', 'Укажите, какие сабжекты.');
      if (f.kind === 'note' && !clean(f.note)) e.note = t('Write the note.', 'Напишите заметку.');
      state.errors = e;
      if (Object.keys(e).length) { rerender(); return; }
      call('addEvent', [state.cargo.id, f.pair, { kind: f.kind, rate: clean(f.rate), valid_until: f.valid_until, subjects: clean(f.subjects), subjects_until: f.subjects_until, note: String(f.note || '').trim() }],
        function (res) { take(res); state.eform = null; });
    },
    // ---- documents, voyages, orders
    recapFromPair: function (id) {
      var p = findPair(id), c = state.cargo; if (!p || !c) return;
      var subs = '';
      (p.events || []).forEach(function (e) { if (e.kind === 'subjects') subs = clean(e.subjects); if (e.kind === 'lifted' || e.kind === 'fixed') subs = ''; });
      var body = pick({ name: [clean(c.ref), clean(p.ship_name)].filter(Boolean).join(' / '), doc_type: 'recap', date: nowLocal().slice(0, 10), status: 'draft', ship: [clean(p.ship_name), p.imo ? 'IMO ' + p.imo : ''].filter(Boolean).join(', '),
        owner: clean(p.contact_company), charterer: clean(c.account), cargo: [clean(c.cargo_name), qty(c)].filter(Boolean).join(', '), load_port: [clean(c.load_port), clean(c.load_details)].filter(Boolean).join(', '),
        discharge_port: [clean(c.discharge_port), clean(c.discharge_details)].filter(Boolean).join(', '), laycan: span(c.laycan_from, c.laycan_to), freight: clean(p.rate), rates: clean(c.rates), terms: c.terms,
        commission: clean(c.commission), subjects: subs, contact_email: clean(p.contact_email), cargo_ref: clean(c.ref) }, KINDS.docs.fields.map(function (f) { return f[0]; }));
      moduleApi.go('docs'); state.iform = body; rerender();
    },
    sendDoc: function () {
      var x = state.item; if (state.section !== 'docs' || !x) return;
      compose({ to: clean(x.contact_email), subject: recapText(x).split('\n')[0], body: recapText(x) }, clean(x.name), function () {
        if ((x.status || 'draft') !== 'draft') return null;
        return api('saveItem', ['docs', { id: x.id, status: 'sent' }]).then(function (res) { state.items.docs = (res && res.items) || state.items.docs; state.item = (res && res.item) || x; });
      });
    },
    printDoc: function () {
      var x = state.item; if (state.section !== 'docs' || !x) return;
      if (typeof deps.print === 'function') deps.print(recapText(x)); else toast(t('Printing is not available here. Send the text by mail instead.', 'Печать здесь недоступна. Отправьте текст письмом.'), 'warn');
    },
    voyageFromDoc: function () {
      var x = state.item; if (state.section !== 'docs' || !x) return;
      var body = pick({ name: [clean(x.ship).split(',')[0], clean(x.load_port).split(',')[0] + ' – ' + clean(x.discharge_port).split(',')[0]].filter(Boolean).join(', '), ship: clean(x.ship).split(',')[0], contract: clean(x.name),
        status: 'planned', load_port: clean(x.load_port).split(',')[0], discharge_port: clean(x.discharge_port).split(',')[0] }, KINDS.voyages.fields.map(function (f) { return f[0]; }));
      moduleApi.go('voyages'); state.iform = body; rerender();
    },
    offerHire: function (posId) {
      var o = state.item, p = null;
      state.positions.forEach(function (x) { if (x.id === posId) p = x; });
      if (state.section !== 'orders' || !o || !p) return;
      compose(hireMail(o, p), clean(o.name));
    },
    // ---- Bazar filters
    toggleFilter: function (board) {
      if (board !== 'cargo' && board !== 'fleet') return;
      if (state.fpanel === board) { state.fpanel = null; state.fltform = null; }
      else { state.fpanel = board; state.fltform = pick(state.flt[board], ['area', 'min', 'max', 'from', 'to', 'type', 'name']); if (state.flt[board].id) state.fltform.id = state.flt[board].id; }
      state.errors = {}; rerender();
    },
    applyFilter: function () {
      var b = state.fpanel, f = state.fltform; if (!b || !f) return;
      state.flt[b] = pick(f, ['area', 'min', 'max', 'from', 'to', 'type', 'name']); if (f.id) state.flt[b].id = f.id;
      state.fpanel = null; state.fltform = null; rerender();
    },
    clearFilter: function () { var b = state.fpanel; if (!b) return; state.flt[b] = {}; state.fpanel = null; state.fltform = null; rerender(); },
    saveFilter: function () {
      var b = state.fpanel, f = state.fltform; if (!b || !f) return;
      if (!clean(f.name)) { state.errors = { name: t('Name the filter to save it.', 'Назовите фильтр, чтобы сохранить.') }; rerender(); return; }
      var crit = pick(f, ['area', 'min', 'max', 'from', 'to', 'type']), body = { name: clean(f.name), board: b, criteria: JSON.stringify(crit) };
      if (f.id) body.id = f.id;
      call('saveItem', ['filters', body], function (res) {
        state.items.filters = res.items || state.items.filters;
        state.flt[b] = crit; state.flt[b].name = body.name; if (res.item) state.flt[b].id = res.item.id;
        state.fpanel = null; state.fltform = null;
      });
    },
    useFilter: function (id) {
      state.items.filters.forEach(function (x) {
        if (x.id !== id) return;
        var crit = {}; try { crit = JSON.parse(x.criteria) || {}; } catch (e) { crit = {}; }
        if (state.flt[x.board].id === id) state.flt[x.board] = {};
        else { state.flt[x.board] = pick(crit, ['area', 'min', 'max', 'from', 'to', 'type']); state.flt[x.board].id = id; state.flt[x.board].name = x.name; }
      });
      state.fpanel = null; state.fltform = null; rerender();
    },
    dropFilter: function () {
      var b = state.fpanel, f = state.fltform; if (!b || !f || !f.id) return;
      call('removeItem', ['filters', f.id], function (res) { state.items.filters = res.items || []; state.flt[b] = {}; state.fpanel = null; state.fltform = null; });
    },
    // A ship from the directory becomes an open position on Bazar: the particulars are carried over.
    positionFromShip: function () {
      var x = state.item; if (state.section !== 'ships' || !x) return;
      state.posform = pick({ ship_name: x.name, imo: x.imo, ship_type: x.ship_type, dwt: x.dwt, capacity: x.capacity, gear: x.gear, built: x.built, flag: x.flag,
        company: x.manager || x.owner, contact_email: x.contact_email, status: 'open', source: 'mine' }, POS_FIELDS);
      state.errors = {}; rerender();
    },
    writeTo: function () { var x = state.item; if (!x) return; compose({ to: clean(x.email) }, clean(x.name)); },
    cancelCompose: function () { state.compose = null; composeThen = null; state.errors = {}; rerender(); },
    sendCompose: function () {
      var f = state.compose; if (!f || state.busy) return;
      var e = {}, bad = function (v) { return String(v || '').split(/[,;]/).map(clean).filter(Boolean).some(function (a) { return !validEmail(a); }); };
      if (!clean(f.to) || bad(f.to)) e.to = t('Check the address.', 'Проверьте адрес.');
      if (bad(f.cc)) e.cc = t('Check the address.', 'Проверьте адрес.');
      if (bad(f.bcc)) e.bcc = t('Check the address.', 'Проверьте адрес.');
      state.errors = e;
      if (Object.keys(e).length) { rerender(); return; }
      if (typeof deps.openMail !== 'function') { fail('no_mail'); return; }
      var then = composeThen, mail = { to: clean(f.to), cc: clean(f.cc), bcc: clean(f.bcc), subject: clean(f.subject), body: String(f.body || '') };
      state.busy = true; rerender();
      Promise.resolve().then(function () { return deps.openMail(mail); }).then(function () {
        return api('saveItem', ['mails', { name: mail.subject || t('(no subject)', '(без темы)'), to: mail.to, cc: mail.cc, bcc: mail.bcc, body: mail.body, date: nowLocal().slice(0, 10), about: f.about }]);
      }, function () { return Promise.reject('no_mail'); }).then(function (res) {
        state.items.mails = (res && res.items) || state.items.mails;
        return then ? then() : null;
      }).then(function () {
        state.busy = false; state.compose = null; composeThen = null;
        toast(t('The letter is open in your mail program. Send it from there.', 'Письмо открыто в почтовой программе. Отправьте его оттуда.'), 'success'); rerender();
      }, function (err) { state.busy = false; fail(err); rerender(); });
    },
    saveSettings: function () {
      var f = state.sform; if (!f) return;
      var e = {};
      if (!clean(f.name)) e.name = t('Required.', 'Обязательное поле.');
      if (clean(f.email) && !validEmail(clean(f.email))) e.email = t('Check the address.', 'Проверьте адрес.');
      state.errors = e;
      if (Object.keys(e).length) { rerender(); return; }
      var body = pick(f, ['name', 'email', 'phone', 'address', 'cc', 'bcc', 'signature', 'blacklist']); if (settings().id) body.id = settings().id;
      call('saveItem', ['settings', body], function (res) { state.items.settings = res.items || state.items.settings; toast(t('Saved.', 'Сохранено.'), 'success'); });
    },
    addClause: function (i) {
      if (!state.form || !CLAUSES[Number(i)] || i === '') return;
      state.form.terms = (clean(state.form.terms) ? String(state.form.terms).replace(/\s+$/, '') + '\n' : '') + CLAUSES[Number(i)]; rerender();
    },
    bazarTab: function (side, tab) {
      if (side === 'left' && (tab === 'cargo' || tab === 'orders')) state.btab = tab;
      if (side === 'right' && (tab === 'fleet' || tab === 'routes')) state.ftab = tab;
      state.fpanel = null; state.fltform = null; rerender();
    },
    openOrder: function (id) { moduleApi.go('orders'); moduleApi.openItem(id); },
    newOrder: function () { moduleApi.go('orders'); moduleApi.newItem(); },
    routeSet: function (i, name) { if (i >= 0 && i < state.route.length) { state.route[i] = String(name || ''); rerender(); } },
    routeAdd: function () { state.route.push(''); rerender(); },
    routeRemove: function (i) { if (state.route.length > 2) { state.route.splice(i, 1); rerender(); } },
    routeToCalc: function () {
      var r = routeTotal(); if (!r.ok) return;
      var name = state.route.filter(Boolean).join(' – ');
      moduleApi.go('calcs'); state.iform = pick({ name: name, dist_laden: String(Math.round(r.total)) }, KINDS.calcs.fields.map(function (f) { return f[0]; })); rerender();
    },
    fleetSearch: function (v) { state.fq = String(v || '').slice(0, 80); rerender(); var el = root && root.querySelector && root.querySelector('[data-qa="bazar-fleet-search"]'); if (el) { el.focus(); try { el.setSelectionRange(state.fq.length, state.fq.length); } catch (e) { /* not a text field */ } } },
    toggleSource: function (x) { if (x in state.src) { state.src[x] = !state.src[x]; rerender(); } },
    openPos: function (id) {
      for (var i = 0; i < state.positions.length; i++) if (state.positions[i].id === id) { state.pos = state.positions[i]; state.posform = null; state.removing = null; state.cargo = null; state.pairs = []; state.form = null; state.pform = null; rerender(); return; }
    },
    closePos: function () { state.pos = null; state.removing = null; rerender(); },
    newPos: function () { state.posform = pick({ status: 'open', source: 'mine' }, POS_FIELDS); state.errors = {}; rerender(); },
    editPos: function () { if (!state.pos) return; state.posform = pick(state.pos, POS_FIELDS); state.posform.id = state.pos.id; state.errors = {}; rerender(); },
    savePos: function () {
      var f = state.posform; if (!f) return;
      state.errors = pairErrors(f);
      if (Object.keys(state.errors).length) { rerender(); return; }
      var body = pick(f, POS_FIELDS); if (f.id) body.id = f.id;
      call('savePosition', [body], function (res) {
        state.positions = res.positions || state.positions; state.posform = null;
        if (state.pos && res.position) state.pos = res.position;
        if (KINDS[state.section]) toast(t('Position added to Bazar.', 'Позиция добавлена на Базар.'), 'success');
      });
    },
    removePos: function () {
      if (!state.pos) return;
      call('removePosition', [state.pos.id], function (res) { state.positions = res.positions || []; state.pos = null; state.removing = null; });
    },
    // From the board: put the position under the open cargo as a ship of the book, then open the letter.
    requestPosition: function (posId) {
      var c = state.cargo, p = null;
      state.positions.forEach(function (x) { if (x.id === posId) p = x; });
      if (!c || !p || state.busy) return;
      var have = null;
      state.pairs.forEach(function (x) { if (x.position_id === posId) have = x; });
      if (have) { moduleApi.request(have.id); return; }
      call('savePair', [c.id, { ship_name: p.ship_name, imo: p.imo, dwt: p.dwt, open_place: p.open_place || areaName(p.open_area), open_from: p.open_from, open_to: p.open_to,
        contact_company: p.company, contact_email: p.contact_email, position_id: posId }], function (res) {
        take(res);
        var made = null;
        state.pairs.forEach(function (x) { if (x.position_id === posId) made = x; });
        if (made) setTimeout(function () { moduleApi.request(made.id); }, 0);
      });
    },
    // From the board: offer the open position to the side that holds the cargo.
    offerShip: function (cargoId) {
      var p = state.pos, c = null;
      state.cargoes.forEach(function (x) { if (x.id === cargoId) c = x; });
      if (!p || !c || state.busy) return;
      compose(offerMail(c, p), clean(c.ref));
    },
    newCargo: function () { state.form = pick({ unit: 'mt', source: 'mine' }, CARGO_FIELDS); state.pform = null; state.errors = {}; rerender(); },
    editCargo: function () { if (!state.cargo) return; state.form = pick(state.cargo, CARGO_FIELDS); state.form.id = state.cargo.id; state.errors = {}; rerender(); },
    saveCargo: function () {
      var f = state.form; if (!f) return;
      state.errors = cargoErrors(f);
      if (Object.keys(state.errors).length) { rerender(); return; }
      var body = pick(f, CARGO_FIELDS); if (f.id) body.id = f.id;
      call('saveCargo', [body], function (res) { take(res); state.form = null; toast(t('Cargo saved.', 'Груз сохранён.'), 'success'); });
    },
    archive: function (on) {
      if (!state.cargo) return;
      call('saveCargo', [{ id: state.cargo.id, archived: !!on }], function (res) { take(res); state.archive = !!on; });
    },
    askRemove: function (what) { state.removing = what || null; rerender(); },
    removeCargo: function () {
      if (!state.cargo) return;
      var id = state.cargo.id;
      call('removeCargo', [id], function () {
        state.cargoes = state.cargoes.filter(function (c) { return c.id !== id; });
        state.cargo = null; state.pairs = []; state.removing = null; toast(t('Cargo deleted.', 'Груз удалён.'), 'info');
      });
    },
    newPair: function () { if (!state.cargo) return; state.pform = pick({ step: 'new' }, PAIR_FIELDS); state.errors = {}; rerender(); },
    editPair: function (id) { var p = findPair(id); if (!p) return; state.pform = pick(p, PAIR_FIELDS); state.pform.id = p.id; state.errors = {}; rerender(); },
    savePair: function () {
      var f = state.pform; if (!f || !state.cargo) return;
      state.errors = pairErrors(f);
      if (Object.keys(state.errors).length) { rerender(); return; }
      var body = pick(f, PAIR_FIELDS); if (f.id) body.id = f.id;
      call('savePair', [state.cargo.id, body], function (res) { take(res); state.pform = null; });
    },
    removePair: function (id) {
      if (!state.cargo) return;
      call('removePair', [state.cargo.id, id], function (res) { take(res); state.removing = null; });
    },
    step: function (id, step) {
      if (!state.cargo || STEPS.indexOf(step) < 0) return;
      call('savePair', [state.cargo.id, { id: id, step: step }], take);
    },
    // Opens the letter in the user's mail program, then marks the pair «request sent» with today's date.
    request: function (id) {
      var p = findPair(id), c = state.cargo;
      if (!p || !c || state.busy) return;
      if (!validEmail(clean(p.contact_email))) {
        toast(t('Add the e-mail of whom to write to first.', 'Сначала укажите почту, кому писать.'), 'warn');
        moduleApi.editPair(id); state.errors = { contact_email: t('Needed for the freight request.', 'Нужна для запроса фрахта.') }; rerender(); return;
      }
      compose(requestMail(c, p), [clean(c.ref), clean(p.ship_name)].filter(Boolean).join(' / '), function () {
        return api('savePair', [c.id, { id: id, step: p.step === 'new' || p.step === 'dropped' ? 'requested' : p.step, requested: true }]).then(function (res) { take(res || {}); });
      });
    },
    // for tests
    _state: state,
    _html: html
  };
  global.SkipiChartering = moduleApi;
})(typeof window !== 'undefined' ? window : globalThis);

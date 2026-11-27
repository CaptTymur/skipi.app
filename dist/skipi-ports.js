/* @skipi/ports — generic-модуль Skipi: справочник морских портов по UN/LOCODE (только чтение).
 * Классический <script>; публикует window.SkipiPorts. Данные — отдельный файл skipi-ports.data.js
 * (window.SKIPI_PORTS_DATA), источник UNECE UN/LOCODE, провенанс — docs/SOURCE.md. Контракт — CONTRACT.md (add-only). */
(function (root) {
  'use strict';
  var VERSION = '0.2.0';
  var SCHEMA_MAX = 1;
  var CODE_RE = /^[A-Z]{2}[A-Z0-9]{3}$/;
  var CODE_PREFIX_RE = /^[A-Z]{2}[A-Z0-9]{0,3}$/;
  var COORD_RE = /^(\d{2})(\d{2})([NS]) (\d{3})(\d{2})([EW])$/;
  var FOLD = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ł': 'l', 'ð': 'd', 'þ': 'th', 'ı': 'i', '’': "'", '‘': "'" };

  function SkipiPortsError(code, message) {
    var e = Error.call(this, message);
    this.name = 'SkipiPortsError';
    this.code = code;
    this.message = message;
    if (e.stack) this.stack = e.stack;
  }
  SkipiPortsError.prototype = Object.create(Error.prototype);
  SkipiPortsError.prototype.constructor = SkipiPortsError;

  function fold(s) {
    var t = String(s).toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t.replace(/[^\x20-\x7e]/g, function (ch) { return FOLD[ch] || ch; });
  }
  function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    var c = input.replace(/\s+/g, '').toUpperCase();
    return CODE_RE.test(c) ? c : null;
  }
  // v1.1 normalize: точные формы кода — 'NLRTM', 'NL RTM', 'nl-rtm' (один дефис ровно между страной и локацией).
  // Поведение lookup/search/formatCode v1 не меняется: хост вызывает lookup(normalize(input)).
  function normalize(input) {
    if (typeof input !== 'string') return null;
    var c = input.replace(/\s+/g, '').toUpperCase();
    if (c.length === 6 && c.charAt(2) === '-') c = c.slice(0, 2) + c.slice(3);
    return CODE_RE.test(c) ? c : null;
  }
  var EARTH_RADIUS_KM = 6371.0088;
  function haversineKm(lat1, lon1, lat2, lon2) {
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }
  function validLimit(v, dflt) {
    return (typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0) ? v : dflt;
  }
  function parseCoords(s) {
    if (typeof s !== 'string') return null;
    var m = COORD_RE.exec(s.trim());
    if (!m) return null;
    var latM = +m[2], lonM = +m[5];
    if (latM >= 60 || lonM >= 60) return null;
    var lat = +m[1] + latM / 60, lon = +m[4] + lonM / 60;
    if (lat > 90 || lon > 180) return null;
    if (m[3] === 'S') lat = -lat;
    if (m[6] === 'W') lon = -lon;
    lat = Math.round(lat * 1e4) / 1e4; lon = Math.round(lon * 1e4) / 1e4;
    if (lat === 0 && lon === 0) return null;
    return Object.freeze({ lat: lat, lon: lon });
  }
  function formatCode(input) {
    var c = normalizeCode(input);
    return c ? c.slice(0, 2) + ' ' + c.slice(2) : null;
  }

  var cache = null;
  function getData() {
    var raw = root.SKIPI_PORTS_DATA;
    if (cache && cache.raw === raw) return cache;
    if (!raw || typeof raw !== 'object') {
      throw new SkipiPortsError('data-missing', 'window.SKIPI_PORTS_DATA is not loaded: include skipi-ports.data.js before calling SkipiPorts');
    }
    if (typeof raw.schema !== 'number' || raw.schema > SCHEMA_MAX) {
      throw new SkipiPortsError('data-missing', 'SKIPI_PORTS_DATA schema ' + raw.schema + ' is newer than supported ' + SCHEMA_MAX);
    }
    if (!Array.isArray(raw.cols) || !Array.isArray(raw.rows) || typeof raw.release !== 'string') {
      throw new SkipiPortsError('data-missing', 'SKIPI_PORTS_DATA is malformed');
    }
    // Глубокая заморозка при первой загрузке: после этого подмена rows/строк/заголовка не влияет на ответы API.
    for (var f = 0; f < raw.rows.length; f++) Object.freeze(raw.rows[f]);
    Object.freeze(raw.rows); Object.freeze(raw.cols); if (raw.source) Object.freeze(raw.source); Object.freeze(raw);
    var col = {};
    for (var i = 0; i < raw.cols.length; i++) col[raw.cols[i]] = i;
    var need = ['code', 'name', 'nameAscii', 'subdiv', 'fn', 'status', 'updated', 'lat', 'lon'];
    for (var n = 0; n < need.length; n++) {
      if (!(need[n] in col)) throw new SkipiPortsError('data-missing', 'SKIPI_PORTS_DATA lacks column ' + need[n]);
    }
    var entries = new Array(raw.rows.length), byCode = {}, perCountry = {}, countryCodes = {};
    for (var r = 0; r < raw.rows.length; r++) {
      var row = raw.rows[r], code = row[col.code], name = row[col.name], ascii = row[col.nameAscii] || name;
      entries[r] = { row: row, code: code, fname: fold(name), fascii: fold(ascii) };
      if (!(code in byCode)) byCode[code] = r;
      var cc = code.slice(0, 2);
      (perCountry[cc] || (perCountry[cc] = [])).push(r);
      (countryCodes[cc] || (countryCodes[cc] = {}))[code] = true;
    }
    var countries = [];
    for (var k in perCountry) countries.push(Object.freeze({ code: k, ports: Object.keys(countryCodes[k]).length }));
    countries.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
    cache = { raw: raw, col: col, entries: entries, byCode: byCode, perCountry: perCountry, countries: Object.freeze(countries) };
    return cache;
  }
  function toPort(d, idx) {
    var row = d.entries[idx].row, col = d.col, code = row[col.code], fn = row[col.fn], functions = [];
    for (var i = 0; i < fn.length; i++) if (fn[i] !== '-') functions.push(fn[i]);
    var lat = row[col.lat], lon = row[col.lon];
    return Object.freeze({
      code: code,
      country: code.slice(0, 2),
      location: code.slice(2),
      name: row[col.name],
      nameAscii: row[col.nameAscii] || row[col.name],
      subdiv: row[col.subdiv],
      functions: Object.freeze(functions),
      status: row[col.status],
      coords: (typeof lat === 'number' && typeof lon === 'number') ? Object.freeze({ lat: lat, lon: lon }) : null,
      updated: row[col.updated]
    });
  }

  function dataVersion() { return getData().raw.release; }
  function lookup(input) {
    var d = getData();
    var c = normalizeCode(input);
    if (c === null || !(c in d.byCode)) return null;
    return toPort(d, d.byCode[c]);
  }
  function countries() { return getData().countries; }
  function search(query, opts) {
    var d = getData();
    var o = opts || {};
    var limit = validLimit(o.limit, 20);
    var country = null;
    if (o.country !== undefined && o.country !== null && o.country !== '') {
      if (typeof o.country !== 'string' || !/^\s*[A-Za-z]{2}\s*$/.test(o.country)) return Object.freeze([]);
      country = o.country.trim().toUpperCase();
    }
    var q = typeof query === 'string' ? query.trim() : '';
    var out = [], i, idx;
    if (q === '') {
      if (country === null || !d.perCountry[country]) return Object.freeze([]);
      var list = d.perCountry[country];
      for (i = 0; i < list.length && out.length < limit; i++) out.push(toPort(d, list[i]));
      return Object.freeze(out);
    }
    var codeQ = q.replace(/\s+/g, '').toUpperCase();
    var codeMode = CODE_PREFIX_RE.test(codeQ);
    var fq = fold(q);
    var pool = country === null ? null : (d.perCountry[country] || []);
    var hits = [];
    var total = pool === null ? d.entries.length : pool.length;
    for (i = 0; i < total; i++) {
      idx = pool === null ? i : pool[i];
      var e = d.entries[idx], rank = -1;
      if (codeMode) {
        if (e.code === codeQ) rank = 0;
        else if (e.code.indexOf(codeQ) === 0) rank = 1;
      }
      if (rank < 0) {
        if (e.fname.indexOf(fq) === 0 || e.fascii.indexOf(fq) === 0) rank = 2;
        else if (e.fname.indexOf(fq) >= 0 || e.fascii.indexOf(fq) >= 0) rank = 3;
      }
      if (rank >= 0) hits.push({ rank: rank, idx: idx, fname: e.fname, code: e.code });
    }
    hits.sort(function (a, b) {
      return a.rank - b.rank || (a.fname < b.fname ? -1 : a.fname > b.fname ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || a.idx - b.idx;
    });
    for (i = 0; i < hits.length && out.length < limit; i++) out.push(toPort(d, hits[i].idx));
    return Object.freeze(out);
  }

  // --- v1.1 (add-only) ---
  function byCountry(cc, opts) {
    var d = getData();
    var o = opts || {};
    if (typeof cc !== 'string' || !/^\s*[A-Za-z]{2}\s*$/.test(cc)) return Object.freeze([]);
    var list = d.perCountry[cc.trim().toUpperCase()] || [];
    var limit = validLimit(o.limit, list.length);
    var out = [];
    for (var i = 0; i < list.length && out.length < limit; i++) out.push(toPort(d, list[i]));
    return Object.freeze(out);
  }
  function nearest(lat, lon, opts) {
    var d = getData();
    var o = opts || {};
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) return Object.freeze([]);
    var limit = validLimit(o.limit, 10);
    var withCoordsOnly = o.withCoordsOnly !== false;
    var col = d.col, ranked = [], without = [], i, row, plat, plon;
    for (i = 0; i < d.entries.length; i++) {
      row = d.entries[i].row; plat = row[col.lat]; plon = row[col.lon];
      if (typeof plat === 'number' && typeof plon === 'number') {
        ranked.push({ idx: i, km: haversineKm(lat, lon, plat, plon) });
      } else if (!withCoordsOnly) {
        without.push(i);
      }
    }
    ranked.sort(function (a, b) { return a.km - b.km || a.idx - b.idx; });
    var out = [];
    for (i = 0; i < ranked.length && out.length < limit; i++) {
      out.push(Object.freeze({ port: toPort(d, ranked[i].idx), distanceKm: Math.round(ranked[i].km * 100) / 100 }));
    }
    for (i = 0; i < without.length && out.length < limit; i++) {
      out.push(Object.freeze({ port: toPort(d, without[i]), distanceKm: null }));
    }
    return Object.freeze(out);
  }

  root.SkipiPorts = Object.freeze({
    version: VERSION,
    SkipiPortsError: SkipiPortsError,
    dataVersion: dataVersion,
    lookup: lookup,
    search: search,
    countries: countries,
    formatCode: formatCode,
    parseCoords: parseCoords,
    // v1.1
    normalize: normalize,
    byCountry: byCountry,
    nearest: nearest
  });
})(typeof window !== 'undefined' ? window : globalThis);

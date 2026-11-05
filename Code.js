/* Scoped, read-only Outlook ICS recurrence diagnostics. */
function runAudit() {
  const config = getInstallationConfig();
  validateConfig(config);
  let response;
  try {
    response = UrlFetchApp.fetch(config.feedUrl, {muteHttpExceptions: true, followRedirects: false});
  } catch (_) {
    throw new Error('Feed fetch failed; private URL omitted.');
  }
  requireProof(response.getResponseCode() === 200, 'Feed HTTP status: ' + response.getResponseCode());
  const report = auditIcs(response.getContentText(), config);
  report.observedAt = new Date().toISOString();
  report.syntheticChecks = runSelfTests();
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function validateConfig(config) {
  requireProof(config && /^https:\/\/[^/@\s]+(?:\/[^\s]*)?$/.test(config.feedUrl || ''),
    'Configuration requires an HTTPS feed URL without embedded credentials.');
  dayNumber(config.fromDate); dayNumber(config.toDate);
  requireProof(config.fromDate < config.toDate &&
    dayNumber(config.toDate) - dayNumber(config.fromDate) <= 366 * 86400000,
    'Audit window must be positive and at most 366 days (exclusive end).');
  requireProof(Array.isArray(config.seriesTitles) && config.seriesTitles.length > 0 &&
    config.seriesTitles.every(t => typeof t === 'string' && t.length > 0), 'Set seriesTitles.');
  requireProof(Number.isInteger(config.minimumMasters) && config.minimumMasters > 0, 'Set minimumMasters.');
  requireProof(Array.isArray(config.allDayChecks) && config.allDayChecks.length > 0, 'Set allDayChecks.');
  requireProof(Array.isArray(config.timedChecks), 'Set timedChecks (may be empty).');
  for (const check of config.allDayChecks) {
    dayNumber(check.date);
    requireProof(check.date >= config.fromDate && check.date < config.toDate &&
      typeof check.title === 'string' && check.title.length > 0 &&
      Number.isInteger(check.count) && check.count >= 0, 'Invalid all-day check.');
  }
  for (const check of config.timedChecks) {
    requireProof(typeof check.title === 'string' && check.title.length > 0 &&
      /^\d{8}T\d{6}$/.test(check.start) && /^\d{8}T\d{6}$/.test(check.end) &&
      typeof check.timeZone === 'string' && check.timeZone.length > 0,
      'Timed checks require an exact local source start, end, and TZID.');
    requireProof(check.start.slice(0, 8) >= config.fromDate &&
      check.start.slice(0, 8) < config.toDate, 'Timed check outside audit window.');
  }
}

function requireProof(condition, message) {
  if (!condition) throw new Error(message);
}

function parseIcs(text) {
  requireProof(text.includes('BEGIN:VCALENDAR') && text.includes('END:VCALENDAR'),
    'Response is not a complete VCALENDAR.');
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let event = null;
  let nested = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      requireProof(event === null, 'Nested VEVENT is unsupported.');
      event = {}; nested = 0; continue;
    }
    if (!event) continue;
    if (line === 'END:VEVENT') { events.push(event); event = null; continue; }
    if (line.startsWith('BEGIN:')) { nested++; continue; }
    if (line.startsWith('END:')) { nested--; continue; }
    if (nested) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    const raw = line.slice(colon + 1);
    const prop = {value: name === 'SUMMARY' ? raw.replace(/\\([nN,;\\])/g,
      (_, escaped) => /[nN]/.test(escaped) ? '\n' : escaped) : raw, params: {}};
    for (const param of params) {
      const eq = param.indexOf('=');
      requireProof(eq > 0, 'Invalid property parameter.');
      prop.params[param.slice(0, eq)] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
    (event[name] || (event[name] = [])).push(prop);
  }
  requireProof(event === null && events.length > 0, 'Incomplete or empty event feed.');
  return events;
}

function one(event, key, optional) {
  const values = event[key] || [];
  requireProof(values.length <= 1 && (optional || values.length === 1),
    'Missing or repeated ' + key + '.');
  return values[0];
}

function val(event, key) { const p = one(event, key, true); return p ? p.value : ''; }
function dayNumber(day) {
  requireProof(/^\d{8}$/.test(day), 'Invalid calendar date.');
  const n = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
  requireProof(dayString(n) === day, 'Impossible calendar date.');
  return n;
}
function dayString(n) { return new Date(n).toISOString().slice(0, 10).replace(/-/g, ''); }

// Only all-day parents are eligible. Preserve nominal calendar date, never UTC-shift it.
function normalizeDate(prop, parent, corrections, field) {
  requireProof(one(parent, 'DTSTART').params.VALUE === 'DATE', 'Parent is not all-day.');
  requireProof(!prop.params.RANGE, 'RANGE exceptions are unsupported.');
  if (prop.params.VALUE === 'DATE') {
    requireProof(!prop.params.TZID, 'DATE must not carry TZID.');
    dayNumber(prop.value); return prop.value;
  }
  requireProof(/^\d{8}T000000$/.test(prop.value) && !!prop.params.TZID,
    'Only timezone-qualified midnight exceptions can be normalized.');
  const day = prop.value.slice(0, 8); dayNumber(day);
  corrections.push({field: field, date: day, fromType: 'DATE-TIME',
    timeZone: prop.params.TZID, toType: 'DATE'});
  return day;
}

function expandAllDay(parent, overrides, fromDay, toDay, corrections) {
  const start = one(parent, 'DTSTART');
  requireProof(start.params.VALUE === 'DATE', 'Expected DATE DTSTART.');
  const end = one(parent, 'DTEND');
  requireProof(end.params.VALUE === 'DATE', 'Expected DATE DTEND.');
  const duration = (dayNumber(end.value) - dayNumber(start.value)) / 86400000;
  requireProof(duration === 1, 'This proof supports single-day all-day events only.');
  requireProof(!parent.RDATE && !parent.EXRULE, 'RDATE/EXRULE are outside proof scope.');
  const rule = val(parent, 'RRULE');
  const slots = new Map();
  const put = (day, e) => {
    if (day >= fromDay && day < toDay && val(e, 'STATUS') !== 'CANCELLED') {
      slots.set(day, {date: day, title: val(e, 'SUMMARY'), allDay: true});
    }
  };
  if (!rule) put(start.value, parent);
  else {
    const r = {};
    for (const part of rule.split(';')) {
      const pair = part.split('=');
      requireProof(pair.length === 2 && !r[pair[0]], 'Invalid recurrence rule.');
      r[pair[0]] = pair[1];
    }
    requireProof(Object.keys(r).every(k => ['FREQ', 'UNTIL', 'INTERVAL', 'BYDAY', 'WKST'].includes(k)),
      'Unsupported recurrence field.');
    requireProof(r.FREQ === 'WEEKLY', 'Only WEEKLY rules supported in this proof.');
    const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const selected = (r.BYDAY || days[new Date(dayNumber(start.value)).getUTCDay()]).split(',');
    requireProof(selected.every(d => days.includes(d)), 'Unsupported BYDAY.');
    const interval = +(r.INTERVAL || '1');
    requireProof(Number.isInteger(interval) && interval > 0, 'Invalid INTERVAL.');
    const weekStart = days.indexOf(r.WKST || 'MO');
    requireProof(weekStart >= 0, 'Invalid WKST.');
    const first = dayNumber(start.value);
    const anchor = first - ((new Date(first).getUTCDay() - weekStart + 7) % 7) * 86400000;
    // UNTIL time on DATE series is malformed; allow only when its boundary cannot affect this window.
    if (r.UNTIL) {
      requireProof(/^\d{8}(T\d{6}Z)?$/.test(r.UNTIL), 'Invalid UNTIL.');
      dayNumber(r.UNTIL.slice(0, 8));
      if (r.UNTIL.length !== 8) requireProof(r.UNTIL.slice(0, 8) > toDay,
        'Mixed-type UNTIL boundary overlaps audit window.');
    }
    for (let n = Math.max(first, dayNumber(fromDay)); n < dayNumber(toDay); n += 86400000) {
      const day = dayString(n);
      if (r.UNTIL && day > r.UNTIL.slice(0, 8)) continue;
      if (Math.floor((n - anchor) / 604800000) % interval === 0 &&
          selected.includes(days[new Date(n).getUTCDay()])) put(day, parent);
    }
  }
  for (const prop of parent.EXDATE || []) {
    for (const value of prop.value.split(',')) {
      const day = normalizeDate({value: value, params: prop.params}, parent, corrections, 'EXDATE');
      slots.delete(day);
    }
  }
  const seenOverrides = new Set();
  for (const override of overrides) {
    const original = normalizeDate(one(override, 'RECURRENCE-ID'), parent, corrections, 'RECURRENCE-ID');
    requireProof(!seenOverrides.has(original), 'Duplicate override date.');
    seenOverrides.add(original); slots.delete(original);
    if (val(override, 'STATUS') === 'CANCELLED') continue;
    requireProof(one(override, 'DTSTART').params.VALUE === 'DATE' &&
      one(override, 'DTEND').params.VALUE === 'DATE', 'Override is not all-day.');
    requireProof(dayNumber(val(override, 'DTEND')) - dayNumber(val(override, 'DTSTART')) === 86400000,
      'Multi-day override outside proof scope.');
    requireProof(!slots.has(val(override, 'DTSTART')), 'Override collides with another occurrence.');
    // Omitted exception fields inherit the parent, including SUMMARY and STATUS.
    put(val(override, 'DTSTART'), Object.assign({}, parent, override));
  }
  return Array.from(slots.values());
}

function auditIcs(text, config) {
  validateConfig(config);
  const events = parseIcs(text);
  const masters = events.filter(e => !e['RECURRENCE-ID'] && config.seriesTitles.includes(val(e, 'SUMMARY')));
  const corrections = [], rows = [], unsupported = [], ids = new Set();
  for (const master of masters) {
    const uid = val(master, 'UID'); requireProof(uid && !ids.has(uid), 'Missing/duplicate master UID.');
    ids.add(uid);
    const overrides = events.filter(e => e['RECURRENCE-ID'] && val(e, 'UID') === uid);
    try { rows.push(...expandAllDay(master, overrides, config.fromDate, config.toDate, corrections)); }
    catch (error) { unsupported.push({title: val(master, 'SUMMARY'), reason: error.message}); }
  }
  const allDayChecks = config.allDayChecks.map(check => {
    const actual = rows.filter(e => e.date === check.date && e.title === check.title).length;
    return {date: check.date, title: check.title, expected: check.count, actual: actual, passed: actual === check.count};
  });
  // Exact source-field assertions; no timezone conversion or timed recurrence expansion.
  const timedChecks = config.timedChecks.map(check => {
    const matches = events.filter(e => val(e, 'SUMMARY') === check.title &&
      val(e, 'DTSTART') === check.start && val(e, 'DTEND') === check.end &&
      !e.RRULE && !e['RECURRENCE-ID'] && val(e, 'STATUS') !== 'CANCELLED' &&
      one(e, 'DTSTART').params.TZID === check.timeZone && one(e, 'DTEND').params.TZID === check.timeZone);
    return {title: check.title, start: check.start, end: check.end, timeZone: check.timeZone,
      actual: matches.length, passed: matches.length === 1};
  });
  const seriesParsed = masters.length >= config.minimumMasters && unsupported.length === 0;
  return {mode: 'READ_ONLY_PROOF', calendarWrites: 0, feedEventCount: events.length,
    scopedMasterCount: masters.length, seriesParsed: seriesParsed,
    passed: seriesParsed && allDayChecks.every(c => c.passed) && timedChecks.every(c => c.passed),
    allDayChecks: allDayChecks, timedChecks: timedChecks, unsupported: unsupported,
    corrections: corrections, correctedAllDayEvents: rows.sort((a, b) => a.date.localeCompare(b.date))};
}

function runSelfTests() {
  const master = {UID:[{value:'test'}], SUMMARY:[{value:'Remote work'}],
    DTSTART:[{value:'20261014',params:{VALUE:'DATE'}}], DTEND:[{value:'20261015',params:{VALUE:'DATE'}}],
    RRULE:[{value:'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;WKST=MO'}]};
  const deleted = JSON.parse(JSON.stringify(master));
  deleted.EXDATE = [{value:'20261111T000000',params:{TZID:'W. Europe Standard Time'}}];
  requireProof(expandAllDay(deleted, [], '20261109','20261114',[]).length === 0, 'Deleted occurrence test failed.');
  const override = {SUMMARY:[{value:'Holiday'}],
    'RECURRENCE-ID':[{value:'20261111T000000',params:{TZID:'W. Europe Standard Time'}}],
    DTSTART:[{value:'20261111',params:{VALUE:'DATE'}}],DTEND:[{value:'20261112',params:{VALUE:'DATE'}}]};
  const rows = expandAllDay(master,[override],'20261109','20261114',[]);
  requireProof(rows.length === 1 && rows[0].title === 'Holiday' && rows[0].date === '20261111', 'Override replacement test failed.');
  const bad = JSON.parse(JSON.stringify(master)); bad.RRULE[0].value = 'FREQ=MONTHLY';
  let rejected = false; try { expandAllDay(bad, [], '20261109','20261114',[]); } catch (_) { rejected = true; }
  requireProof(rejected, 'Unsupported rule must fail closed.');
  const moved = JSON.parse(JSON.stringify(override)); moved.DTSTART[0].value='20261112'; moved.DTEND[0].value='20261113';
  const movedRows=expandAllDay(master,[moved],'20261109','20261114',[]);
  requireProof(movedRows.length===1 && movedRows[0].date==='20261112','Moved override test failed.');
  return {passed: true, cases: ['deleted occurrence', 'renamed override replaces parent without UTC shift',
    'unsupported recurrence rejected', 'moved override replaces original']};
}

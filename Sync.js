/* Calendar synchronization. All entry points use one script lock. */
function syncConfig_() {
  const c = getInstallationConfig();
  validateConfig(c);
  requireProof(c.sync && typeof c.sync.calendarName === 'string' && c.sync.calendarName.length > 0,
    'Set sync.calendarName.');
  for (const k of ['pastDays', 'futureDays', 'maxEvents', 'maxIterations', 'maxChanges']) {
    requireProof(Number.isInteger(c.sync[k]) && c.sync[k] > 0, 'Invalid sync limit.');
  }
  requireProof(c.sync.pastDays + c.sync.futureDays <= 366 && c.sync.maxEvents <= 3000 &&
    c.sync.maxIterations <= 100000 && c.sync.maxChanges <= 500, 'Sync limits exceed safety bounds.');
  requireProof([5, 10, 15, 30].includes(c.sync.intervalMinutes), 'Invalid trigger interval.');
  return c;
}

function fetchSource_(c) {
  let r;
  try { r = UrlFetchApp.fetch(c.feedUrl, {muteHttpExceptions: true, followRedirects: false}); }
  catch (_) { throw new Error('Source fetch failed; URL omitted.'); }
  requireProof(r.getResponseCode() === 200, 'Source fetch did not return HTTP 200.');
  const text = r.getContentText();
  requireProof(text.trim().startsWith('BEGIN:VCALENDAR') && text.trim().endsWith('END:VCALENDAR'),
    'Incomplete source calendar.');
  return text;
}

function syncWindow_(c, now) {
  const today = Utilities.formatDate(now, c.timeZone, 'yyyy-MM-dd');
  const day = Date.parse(today + 'T00:00:00Z');
  return {from: new Date(day - c.sync.pastDays * 86400000).toISOString(),
    to: new Date(day + c.sync.futureDays * 86400000).toISOString()};
}

function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value,
    Utilities.Charset.UTF_8).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function expandFeed_(text, c, window) {
  ICAL.TimezoneService.reset();
  const data = ICAL.parse(text);
  const root = new ICAL.Component(data);
  root.getAllSubcomponents('vtimezone').forEach(component => {
    const zone = new ICAL.Timezone(component);
    ICAL.TimezoneService.register(zone.tzid, zone);
  });
  const zone = name => {
    const z = ICAL.TimezoneService.get(name);
    requireProof(!!z, 'Source timezone is unavailable.'); return z;
  };
  const raw = data[2].filter(x => x[0] === 'vevent');
  requireProof(raw.length > 0, 'Empty source; refusing reconciliation.');
  const prop = (e, name) => e[1].find(p => p[0] === name);
  const masters = new Map();
  raw.filter(e => !prop(e, 'recurrence-id')).forEach(e => {
    const uid = prop(e, 'uid');
    requireProof(uid && !masters.has(uid[3]), 'Missing or duplicate source master.');
    masters.set(uid[3], e);
  });
  // Normalize malformed all-day exception value types before ICAL hydration.
  raw.forEach(e => {
    const uid = prop(e, 'uid');
    requireProof(!!uid && masters.has(uid[3]), 'Orphan source exception.');
    const parent = masters.get(uid[3]);
    if (prop(parent, 'status') && prop(parent, 'status')[3] === 'CANCELLED') return;
    requireProof(!!prop(parent, 'dtstart'), 'Source master lacks DTSTART.');
    if (prop(parent, 'dtstart')[2] !== 'date') return;
    for (const p of e[1]) {
      if (['exdate', 'recurrence-id'].includes(p[0]) && p[2] !== 'date') {
        requireProof(p[2] === 'date-time' && p[1].tzid &&
          p.slice(3).every(v => /^\d{4}-\d\d-\d\dT00:00:00$/.test(v)),
          'Ambiguous all-day exception.');
        p[2] = 'date'; delete p[1].tzid;
        for (let i = 3; i < p.length; i++) p[i] = p[i].slice(0, 10);
      }
      if (p[0] === 'rrule' && p[3].until && p[3].until.includes('T')) {
        const until = ICAL.Time.fromString(p[3].until);
        requireProof(until.zone === ICAL.Timezone.utcTimezone,
          'Mixed all-day UNTIL must be UTC.');
        p[3].until = until.convertToZone(zone(c.sync.allDayBoundaryTimeZone)).toString().slice(0, 10);
      }
    }
  });
  const components = root.getAllSubcomponents('vevent');
  const groups = new Map();
  components.forEach(component => {
    const uid = component.getFirstPropertyValue('uid');
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(component);
  });
  const result = new Map();
  let steps = 0;
  const dateValue = time => {
    requireProof(!!time, 'Missing source date.');
    if (time.isDate) return {date: time.toString()};
    if (time.zone === ICAL.Timezone.localTimezone) time = time.convertToZone(zone(c.sync.floatingTimeZone));
    return {dateTime: time.toJSDate().toISOString()};
  };
  const identity = time => { const value = dateValue(time); return value.date || value.dateTime; };
  const checkZone = component => component.getAllProperties().forEach(p => {
    const tzid = p.getParameter('tzid'); if (tzid) zone(tzid);
    requireProof(!p.getParameter('range'), 'RANGE exceptions are not supported.');
    requireProof(!(p.name === 'rdate' && p.type === 'period'), 'RDATE PERIOD is not supported.');
    requireProof(p.name !== 'exrule', 'EXRULE is not supported.');
    if (p.name === 'rrule') requireProof(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
      .includes(p.getFirstValue().freq), 'Unsupported sync recurrence frequency.');
  });
  groups.forEach((members, uid) => {
    const parent = members.find(e => !e.hasProperty('recurrence-id'));
    if (parent.getFirstPropertyValue('status') === 'CANCELLED') return;
    members.forEach(checkZone);
    const event = new ICAL.Event(parent, {exceptions: []});
    const overrides = new Map();
    members.filter(e => e.hasProperty('recurrence-id')).forEach(e => {
      const key = identity(e.getFirstPropertyValue('recurrence-id'));
      requireProof(!overrides.has(key), 'Duplicate source exception.'); overrides.set(key, e);
    });
    const append = (component, start, end, original) => {
      const field = name => component.getFirstPropertyValue(name) ?? parent.getFirstPropertyValue(name);
      if (field('status') === 'CANCELLED') return;
      requireProof([null, undefined, 'CONFIRMED', 'TENTATIVE'].includes(field('status')), 'Unsupported event status.');
      const a = dateValue(start), b = dateValue(end);
      requireProof(!!a.date === !!b.date, 'Source date types differ.');
      const startValue = a.date || a.dateTime, endValue = b.date || b.dateTime;
      requireProof(endValue >= startValue && (!a.date || endValue > startValue), 'Invalid source duration.');
      const from = a.date ? window.from.slice(0, 10) : window.from;
      const to = a.date ? window.to.slice(0, 10) : window.to;
      if (startValue >= to || endValue < from || (endValue === from && endValue !== startValue)) return;
      const key = 'o' + digest_(uid + '\n' + original);
      requireProof(!result.has(key), 'Duplicate normalized occurrence.');
      const value = {summary: field('summary') || '(untitled)', description: field('description') || '',
        location: field('location') || '', start: a, end: b,
        status: field('status') === 'TENTATIVE' ? 'tentative' : 'confirmed',
        transparency: field('transp') === 'TRANSPARENT' ? 'transparent' : 'opaque',
        visibility: 'private', reminders: {useDefault: false}};
      result.set(key, value);
      requireProof(result.size <= c.sync.maxEvents, 'Source event limit exceeded.');
    };
    const iterator = event.iterator();
    let occurrence;
    while ((occurrence = iterator.next())) {
      requireProof(++steps <= c.sync.maxIterations, 'Source iteration limit exceeded.');
      const instant = dateValue(occurrence);
      if ((instant.date || instant.dateTime) >= (instant.date ? window.to.slice(0, 10) : window.to)) break;
      if (overrides.has(identity(occurrence))) continue;
      const end = occurrence.clone(); end.addDuration(event.duration);
      append(parent, occurrence, end, identity(occurrence));
    }
    overrides.forEach((component, original) => {
      if ((component.getFirstPropertyValue('status') ?? parent.getFirstPropertyValue('status')) === 'CANCELLED') return;
      const start = component.getFirstPropertyValue('dtstart');
      requireProof(!!start, 'Active exception lacks DTSTART.');
      let end = component.getFirstPropertyValue('dtend');
      if (!end) { end = start.clone(); end.addDuration(component.getFirstPropertyValue('duration') || event.duration); }
      append(component, start, end, original);
    });
  });
  return result;
}

function withSyncLock_(action) {
  const lock = LockService.getScriptLock();
  requireProof(lock.tryLock(1000), 'Another synchronization is running.');
  try { return action(); } finally { lock.releaseLock(); }
}

function destination_(c, create) {
  const properties = PropertiesService.getScriptProperties();
  let instance = properties.getProperty('SYNC_INSTANCE');
  if (!instance) { instance = Utilities.getUuid(); properties.setProperty('SYNC_INSTANCE', instance); }
  const marker = 'Managed by Outlook ICS Normalizer. Instance: ' + instance;
  let id = properties.getProperty('SYNC_CALENDAR_ID');
  if (!id && create) {
    requireProof(!properties.getProperty('SYNC_CREATION_PENDING'),
      'Previous calendar creation is uncertain; reconcile it before retrying.');
    properties.setProperty('SYNC_CREATION_PENDING', 'true');
    const calendar = Calendar.Calendars.insert({summary: c.sync.calendarName,
      timeZone: c.timeZone, description: marker});
    requireProof(calendar.id && calendar.id !== 'primary', 'Invalid new calendar identity.');
    id = calendar.id; properties.setProperty('SYNC_CALENDAR_ID', id);
    properties.deleteProperty('SYNC_CREATION_PENDING');
  }
  requireProof(!!id && id !== 'primary', 'Run installSync first.');
  const calendar = Calendar.Calendars.get(id);
  requireProof(calendar.id === id && calendar.description === marker, 'Destination ownership mismatch.');
  return {id: id, instance: instance};
}

function reconcile_(desired, destination, c, window, dryRun) {
  const existing = new Map();
  let page;
  do {
    const response = Calendar.Events.list(destination.id, {maxResults: 2500, pageToken: page,
      privateExtendedProperty: ['normalizer=' + destination.instance], showDeleted: false});
    requireProof(Array.isArray(response.items || []), 'Invalid destination response.');
    (response.items || []).forEach(e => {
      requireProof(e.extendedProperties && e.extendedProperties.private.normalizer === destination.instance,
        'Destination event ownership mismatch.');
      existing.set(e.id, e);
    });
    page = response.nextPageToken;
  } while (page);
  const writes = [], removals = [];
  desired.forEach((value, id) => {
    const hash = digest_(JSON.stringify(value));
    const old = existing.get(id);
    // Calendar omits default-valued fields in readback (opaque / false).
    const defaultValue = k => k === 'status' ? 'confirmed' : k === 'transparency' ? 'opaque' : '';
    const matches = old && ['summary', 'description', 'location', 'status', 'transparency', 'visibility']
      .every(k => (old[k] || defaultValue(k)) === (value[k] || defaultValue(k))) &&
      ['start', 'end'].every(k => value[k].date ? old[k].date === value[k].date :
        Date.parse(old[k].dateTime) === Date.parse(value[k].dateTime)) &&
      (!old.reminders || (old.reminders.useDefault !== true && !(old.reminders.overrides || []).length));
    if (!old || old.extendedProperties.private.fingerprint !== hash || !matches) {
      writes.push({id: id, old: !!old, body: Object.assign({}, value, {id: id,
        extendedProperties: {private: {normalizer: destination.instance, fingerprint: hash}}})});
    }
  });
  // Remove only owned copies; outside-window copies are pruned as the window rolls.
  existing.forEach((value, id) => { if (!desired.has(id)) removals.push(id); });
  requireProof(writes.length + removals.length <= c.sync.maxChanges, 'Change limit exceeded; no writes applied.');
  if (!dryRun) {
    writes.forEach(change => {
      if (change.old) Calendar.Events.update(change.body, destination.id, change.id, {sendUpdates: 'none'});
      else {
        // A previous insert may have succeeded before its response was lost.
        // Do not replay failures here: the next run lists and reconciles state.
        try { Calendar.Events.insert(change.body, destination.id, {sendUpdates: 'none'}); }
        catch (error) {
          if (!/\b409\b|identifier already exists/i.test(error.message)) throw error;
          const previous = Calendar.Events.get(destination.id, change.id);
          requireProof(previous.id === change.id && previous.status === 'cancelled',
            'Conflicting destination identity; no overwrite.');
          Calendar.Events.update(change.body, destination.id, change.id, {sendUpdates: 'none'});
        }
      }
    });
    removals.forEach(id => Calendar.Events.remove(destination.id, id, {sendUpdates: 'none'}));
  }
  return {mode: dryRun ? 'DRY_RUN' : 'SYNC', desired: desired.size,
    writes: writes.length, removals: removals.length, unchanged: desired.size - writes.length,
    window: window};
}

function runSync_(install, dryRun) {
  return withSyncLock_(() => {
    const c = syncConfig_(), text = fetchSource_(c), window = syncWindow_(c, new Date());
    const desired = expandFeed_(text, c, window);
    if (install) requireProof(auditIcs(text, c).passed, 'Configured acceptance audit failed; installation stopped.');
    const destination = destination_(c, install);
    const report = reconcile_(desired, destination, c, window, dryRun);
    if (!dryRun) PropertiesService.getScriptProperties().setProperty('SYNC_LAST_SUCCESS', new Date().toISOString());
    console.log(JSON.stringify(report)); return report;
  });
}

function previewSync() { return runSync_(false, true); }
function syncCalendar() { return runSync_(false, false); }

function previewSource() {
  const c = syncConfig_(), text = fetchSource_(c), window = syncWindow_(c, new Date());
  const desired = expandFeed_(text, c, window), audit = auditIcs(text, c);
  const report = {mode: 'SOURCE_PREVIEW', occurrences: desired.size, window: window,
    auditPassed: audit.passed, writes: 0};
  console.log(JSON.stringify(report)); return report;
}

function installSync() {
  const report = runSync_(true, false);
  withSyncLock_(() => {
    const c = syncConfig_();
    const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncCalendar');
    requireProof(triggers.length <= 1, 'Multiple sync triggers found; remove duplicates.');
    const p = PropertiesService.getScriptProperties();
    if (triggers.length === 0 || p.getProperty('SYNC_INTERVAL') !== String(c.sync.intervalMinutes)) {
      triggers.forEach(t => ScriptApp.deleteTrigger(t));
      ScriptApp.newTrigger('syncCalendar').timeBased().everyMinutes(c.sync.intervalMinutes).create();
      p.setProperty('SYNC_INTERVAL', String(c.sync.intervalMinutes));
    }
  });
  return report;
}

function stopSync() {
  withSyncLock_(() => ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncCalendar')
    .forEach(t => ScriptApp.deleteTrigger(t)));
}

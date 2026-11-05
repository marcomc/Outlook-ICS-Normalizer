const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const c = {ICAL: require('../vendor/ical.js'), Utilities: {
  computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
  DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'}
}};
vm.createContext(c);
['Code.js', 'Sync.js'].forEach(f => vm.runInContext(fs.readFileSync(f, 'utf8'), c));
const config = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
const window = {from: '2026-11-09T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z'};
const wrap = text => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + text.replace(/\n/g, '\r\n') + 'END:VCALENDAR\r\n';
const source = `BEGIN:VEVENT
UID:remote
DTSTART;VALUE=DATE:20261104
DTEND;VALUE=DATE:20261105
RRULE:FREQ=WEEKLY;BYDAY=WE
EXDATE;TZID=Europe/London:20261111T000000
SUMMARY:Remote
END:VEVENT
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261111
DTEND;VALUE=DATE:20261112
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:meeting
DTSTART:20261109T090000Z
DTEND:20261109T100000Z
RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=3
SUMMARY:Release
END:VEVENT
`;
assert.equal(c.expandFeed_(wrap('BEGIN:VEVENT\nUID:cancelled\nSTATUS:CANCELLED\nEND:VEVENT\n'), config, window).size, 0);
assert.equal([...c.expandFeed_(wrap(source.replace('SUMMARY:Holiday', 'STATUS:TENTATIVE\nSUMMARY:Holiday')), config, window).values()].find(e => e.summary === 'Holiday').status, 'tentative');
const desired = c.expandFeed_(wrap(source), config, window);
assert.equal(desired.size, 2);
assert.equal([...desired.values()].filter(x => x.summary === 'Remote').length, 0);
assert.equal([...desired.values()].find(x => x.summary === 'Release').start.dateTime, '2026-11-09T09:00:00.000Z');
const renamed = source.replace('EXDATE;TZID=Europe/London:20261111T000000\n', '') + `BEGIN:VEVENT
UID:remote
RECURRENCE-ID;TZID=Europe/London:20261111T000000
DTSTART;VALUE=DATE:20261112
DTEND;VALUE=DATE:20261113
SUMMARY:Moved holiday
END:VEVENT
`;
assert.equal([...c.expandFeed_(wrap(renamed), config, window).values()]
  .filter(x => x.summary === 'Remote').length, 0);
assert.equal([...c.expandFeed_(wrap(renamed), config, window).values()]
  .find(x => x.summary === 'Moved holiday').start.date, '2026-11-12');
assert.throws(() => c.expandFeed_(wrap(source.replace('T000000', 'T010000')), config, window), /Ambiguous/);
assert.throws(() => c.expandFeed_('BEGIN:VCALENDAR\nEND:VCALENDAR', config, window), /Empty/);

const stored = new Map(), calls = [];
const serverCopy = body => {
  const value = structuredClone(body);
  if (value.transparency === 'opaque') delete value.transparency;
  if (value.reminders.useDefault === false && !value.reminders.overrides) value.reminders = {};
  return value;
};
let paginated = false;
c.Calendar = {Events: {
  list: (_, args) => {
    const items = [...stored.values()].filter(e => e.status !== 'cancelled');
    if (paginated && !args.pageToken) return {items: items.slice(0, 1), nextPageToken: 'next'};
    return {items: paginated ? items.slice(1) : items};
  },
  insert: (body, _, options) => {
    assert.equal(options.sendUpdates, 'none');
    if (stored.has(body.id)) throw new Error('409 identifier already exists');
    calls.push('insert'); stored.set(body.id, serverCopy(body)); return body;
  },
  update: (body, _, id) => { calls.push('update'); stored.set(id, serverCopy(body)); },
  remove: (_, id) => { calls.push('remove'); stored.set(id, {id, status: 'cancelled'}); },
  get: (_, id) => stored.get(id)
}};
const dest = {id: 'dedicated', instance: 'test-instance'};
assert.equal(c.reconcile_(desired, dest, config, window, true).writes, 2);
assert.equal(calls.length, 0);
c.reconcile_(desired, dest, config, window, false);
assert.equal(calls.length, 2);
paginated = true;
assert.equal(c.reconcile_(desired, dest, config, window, false).writes, 0);
paginated = false;
stored.values().next().value.reminders = {useDefault: true};
assert.equal(c.reconcile_(desired, dest, config, window, false).writes, 1);
stored.values().next().value.summary = 'User edit';
assert.equal(c.reconcile_(desired, dest, config, window, false).writes, 1);
const less = new Map(desired); less.delete([...desired.keys()][0]);
assert.equal(c.reconcile_(less, dest, config, window, false).removals, 1);
assert.equal(c.reconcile_(desired, dest, config, window, false).writes, 1); // Restore tombstone.
assert.throws(() => c.reconcile_(desired, dest, {...config, sync: {...config.sync, maxChanges: -1}}, window, false), /limit/);

const props = new Map();
c.PropertiesService = {getScriptProperties: () => ({getProperty: k => props.get(k),
  setProperty: (k, v) => props.set(k, v), deleteProperty: k => props.delete(k)})};
c.Utilities.getUuid = () => 'instance';
let creates = 0;
c.Calendar.Calendars = {insert: () => { creates++; throw new Error('Lost response'); }};
assert.throws(() => c.destination_(config, true), /Lost response/);
assert.throws(() => c.destination_(config, true), /uncertain/);
assert.equal(creates, 1);
props.set('SYNC_CALENDAR_ID', 'dedicated');
c.Calendar.Calendars.get = () => ({id: 'dedicated', description: 'wrong owner'});
assert.throws(() => c.destination_(config, false), /ownership/);
console.log('Sync expansion, idempotency, update, delete, restore, pagination and ownership checks passed.');

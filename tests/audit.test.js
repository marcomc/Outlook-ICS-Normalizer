const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'Code.js'), 'utf8'), context);
assert.equal(context.runSelfTests().passed, true);

const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const event = (uid, title, start, end, extra = '') =>
  `BEGIN:VEVENT\nUID:${uid}\nSUMMARY:${title}\nDTSTART;VALUE=DATE:${start}\nDTEND;VALUE=DATE:${end}\n${extra}END:VEVENT\n`;
const feed = 'BEGIN:VCALENDAR\n' +
  event('unavailable', 'Unavailable', '20261102', '20261103',
    'RRULE:FREQ=WEEKLY;BYDAY=MO\nEXDATE;TZID=Europe/London:20261109T000000\n') +
  event('remote', 'Remote work', '20261104', '20261105',
    'RRULE:FREQ=WEEKLY;BYDAY=WE\nEXDATE;TZID=Europe/London:20261111T000000\n') +
  event('holiday', 'Holiday', '20261111', '20261112') + 'END:VCALENDAR\n';
const report = context.auditIcs(feed, config);
assert.equal(report.passed, true);
assert.equal(report.calendarWrites, 0);
assert.equal(report.correctedAllDayEvents.length, 1);
assert.equal(context.auditIcs(feed.replace('20261109T000000', '20261102T000000'), config).passed, false);
assert.throws(() => context.auditIcs(feed, {...config, fromDate: '20261114'}));
assert.throws(() => context.auditIcs(feed, {...config, feedUrl: 'http://example.com/feed'}));
assert.throws(() => context.auditIcs(feed, {...config, feedUrl: 'https://user:pass@example.com/feed'}));

const weekly = context.parseIcs('BEGIN:VCALENDAR\n' +
  event('weekly', 'Remote work', '20261104', '20261105',
    'RRULE:FREQ=WEEKLY;BYDAY=WE\n') + 'END:VCALENDAR\n')[0];
const copy = value => JSON.parse(JSON.stringify(value));
for (const until of ['20261131', '20261131T000000Z']) {
  const bad = copy(weekly);
  bad.RRULE[0].value += ';UNTIL=' + until;
  assert.throws(() => context.expandAllDay(bad, [], '20261109', '20261114', []), /Impossible/);
}
for (const [until, expected] of [['20261110', 0], ['20261111', 1], ['20261201T000000Z', 1]]) {
  const valid = copy(weekly);
  valid.RRULE[0].value += ';UNTIL=' + until;
  assert.equal(context.expandAllDay(valid, [], '20261109', '20261114', []).length, expected);
}
const escapedTitle = 'Holiday, team; travel\\notes\nDay off';
const escapedFeed = feed.replace('SUMMARY:Holiday', 'SUMMARY:Holiday\\, team\\; travel\\\\notes\\nDay off');
const escapedConfig = {...config,
  seriesTitles: config.seriesTitles.map(t => t === 'Holiday' ? escapedTitle : t),
  allDayChecks: config.allDayChecks.map(c => c.title === 'Holiday' ? {...c, title: escapedTitle} : c)};
assert.equal(context.auditIcs(escapedFeed, escapedConfig).passed, true);

const moved = {'RECURRENCE-ID': [{value: '20261111', params: {VALUE: 'DATE'}}],
  DTSTART: [{value: '20261112', params: {VALUE: 'DATE'}}],
  DTEND: [{value: '20261113', params: {VALUE: 'DATE'}}]};
assert.equal(context.expandAllDay(weekly, [moved], '20261109', '20261114', [])[0].title, 'Remote work');
const cancelled = copy(weekly);
cancelled.STATUS = [{value: 'CANCELLED'}];
assert.equal(context.expandAllDay(cancelled, [moved], '20261109', '20261114', []).length, 0);
assert.equal(context.expandAllDay(weekly, [{...moved, STATUS: [{value: 'CANCELLED'}]}],
  '20261109', '20261114', []).length, 0);

// Execute the public entry point with only fetch/config stubs: calendar access
// or any other Google service would fail because none is provided.
context.getInstallationConfig = () => config;
context.UrlFetchApp = {fetch: (url, options) => {
  assert.equal(url, config.feedUrl);
  assert.equal(options.followRedirects, false);
  return {getResponseCode: () => 200, getContentText: () => feed};
}};
context.console = {log: () => {}};
assert.equal(context.runAudit().passed, true);
context.UrlFetchApp.fetch = () => {throw new Error(config.feedUrl);};
assert.throws(() => context.runAudit(), error => !error.message.includes(config.feedUrl));
console.log('Audit regression checks passed (including four recurrence self-tests).');

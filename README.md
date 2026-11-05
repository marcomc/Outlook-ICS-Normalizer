# Outlook ICS Normalizer

Google Apps Script that reads an Outlook ICS feed, corrects all-day recurrence
exceptions and maintains copies in its own dedicated Google calendar. It runs
on Google servers, independently of the local computer.

## Table of contents

- [Install](#install)
- [Configuration](#configuration)
- [Synchronization](#synchronization)
- [Operations](#operations)
- [Deployment](#deployment)
- [Limits](#limits)
- [Development and license](#development-and-license)

## Install

Requires Python 3.9+ with timezone data. Automated upload also requires an
installed, authenticated `gws` CLI with Apps Script project access. Each user
installs their own private standalone Apps Script project.

1. Copy `config.example.json` to `config.local.json` and customize it. Keep this
   file private: it contains the access-bearing feed URL and account identity.
2. Run `make prepare` to generate the private Apps Script files in `build/`.
3. Run `make upload` to create or update your project with the verified `gws`
   identity. It reads back all uploaded files and verifies exact source equality.
   Installation identity is saved in ignored `.installation.json`.
4. Open your project in [Apps Script](https://script.google.com/) and run
   `previewSource`. Authorize the requested permissions and verify
   `auditPassed: true`, zero writes, and a plausible occurrence count.
5. Run `installSync`. It requires the configured acceptance audit to pass, creates
   one dedicated calendar, imports the corrected events, then installs one timer.
6. Run `syncCalendar` again: an unchanged source must produce zero writes/removals.
   Enable the new Google calendar in your calendar clients; hide the old
   subscription to avoid displaying both copies.

Manual upload is also possible: copy the four generated `.gs` files into matching
Apps Script files and replace the manifest with `build/appsscript.json`.

`config.local.json`, `build/`, `.installation.json`, `.clasp.json`, and `reports/`
are excluded from Git. Cloud `Config.gs` remains private to your installation;
restrict project editors. Generated files use atomic replacement and restrictive
permissions; linked build directories or targets are rejected. Upload transfers
credentials and private source in memory, never as command-line arguments.

The manifest requests external HTTP access, trigger management, and
`calendar.app.created` (secondary calendars created by this app). It does not
request access to Gmail, Drive, or all existing calendars. The Calendar advanced
service is included in the manifest. The initial consent belongs to the user.

## Configuration

| Field | Meaning |
| --- | --- |
| `feedUrl` | Private HTTPS ICS URL; no embedded authority credentials |
| `installationAccount` | Expected authenticated `gws` account for upload |
| `timeZone` | IANA timezone for the project and calendar |
| `fromDate`, `toDate` | Fixed acceptance-audit dates, `YYYYMMDD`, end exclusive |
| `seriesTitles`, `minimumMasters` | All-day masters selected by the acceptance audit |
| `allDayChecks` | Exact title/date occurrence counts; zero asserts absence |
| `timedChecks` | Exact standalone source title/start/end/TZID assertions |
| `sync.calendarName` | Name of the new dedicated calendar |
| `sync.pastDays`, `sync.futureDays` | Rolling coverage, default 30 days back / 180 ahead; total at most 366 |
| `sync.intervalMinutes` | Timer interval: 5, 10, 15 or 30 minutes; default 15 |
| `sync.maxEvents`, `sync.maxIterations`, `sync.maxChanges` | Expansion and mutation bounds; exceeding a bound stops the run |
| `sync.allDayBoundaryTimeZone` | Feed VTIMEZONE identifier, or UTC, for malformed UTC UNTIL on all-day series |
| `sync.floatingTimeZone` | Feed VTIMEZONE identifier, or UTC, for floating timed events |

Timed audit assertions use `YYYYMMDDTHHMMSS` and compare exact source fields.
They do not perform timezone conversion. The example contains dummy data and
must be customized before a live run. After editing configuration, regenerate,
upload, preview and rerun `installSync` to reconcile the timer interval.

## Synchronization

The full feed is parsed using vendored ICAL.js. All-day exception dates retain
their nominal date. Malformed UTC UNTIL values on all-day parents are converted
through the configured source boundary timezone before becoming DATE values.
Timed occurrences use the feed's VTIMEZONE definitions and are stored in UTC.

Recurring events are expanded into independent copies within the rolling window.
Stable IDs derive from the source UID and original occurrence date/instant, so
renaming or moving an occurrence updates its copy. Omitted exception fields
inherit the parent. Cancelled occurrences and stale owned copies are removed;
copies outside the rolling window are pruned. Unowned events are preserved.

Every destination and event is checked for its ownership marker. All entry points
that mutate state share a script lock. Source expansion and a complete paginated
destination read finish before any event mutation. Each run has a change limit.
An uncertain mutation is reconciled on the next run rather than blindly retried.
An uncertain calendar/project creation stops setup pending manual reconciliation.

Copies include title, description, location, dates and free/busy state. They are
private, have no reminders, and carry no attendees or invitations. Editing copies
is temporary: the next sync restores source fields. Source Outlook events remain
unchanged. Client refresh delays are additional to the server timer interval.

## Operations

| Function | Behavior |
| --- | --- |
| `runAudit` | Fixed-window read-only proof; logs selected event details |
| `previewSource` | Reads and expands source; no calendar creation or writes |
| `previewSync` | Compares against an already installed calendar; no writes |
| `installSync` | Explicit audited setup/resume: dedicated calendar, initial sync, timer |
| `syncCalendar` | Scheduled one-way reconciliation; never creates a calendar |
| `stopSync` | Removes only this project's `syncCalendar` triggers; retains calendar/events |

Check Apps Script Executions for failures. Script Properties retain
`SYNC_CALENDAR_ID`, `SYNC_INSTANCE`, `SYNC_LAST_SUCCESS` and timer settings. Keep
these properties when replacing code/config. Do not remove a pending-creation
marker until reconciling whether the remote object was created. Keep the dedicated
calendar description marker intact. Local upload state is also private and should
be retained for future updates.

## Deployment

Two GitHub Actions implement the release flow:

```text
branch -> pull request -> Validation / check -> merge main -> Deploy Apps Script
```

PR validation runs `make check` without Google credentials. A push to `main`
repeats the same checks before uploading the exact current `main` commit to the
existing production Apps Script project. No staging project is required.
GitHub tags and releases document a completed deployment; they do not deploy.
The existing timer uses the updated project HEAD on its next execution.

Configure a GitHub environment named `production`, restricted to `main`, with:

| Environment secret | Contents |
| --- | --- |
| `DEPLOY_AUTH_JSON` | Dedicated OAuth JSON with `client_id`, `client_secret`, `refresh_token`; scopes limited to `script.projects`, `userinfo.email` and optional identity scopes `openid`/`userinfo.profile` |
| `DEPLOY_TARGET_JSON` | JSON with `scriptId` and `account`, matching the existing private installation |

Use a dedicated Google Cloud project and Desktop OAuth client for deployment;
enable the Apps Script API and configure its app identity and production audience.
The repository includes minimal [homepage](docs/index.html),
[privacy](docs/privacy.html) and [license](docs/terms.html) pages for OAuth branding.
Host them on a domain you control before publishing the OAuth app; Testing mode
can expire the deployment authorization after seven days.

For a dedicated CLI authorization, use an isolated `gws` configuration directory
and request only these scopes with `gws auth login --scopes`. Verify the granted
scopes before exporting the credential. Keep a private backup in your password
manager. Do not reuse the broad personal CLI credential or commit credential files.
A changed OAuth scope or advanced service requires an owner-controlled install
and consent before the automatic deployment can continue.

Deployment verifies the authenticated account and project creator, requires the
exact expected file set, preserves the installed `Config.gs` and manifest timezone,
and rejects permission/service changes. It rechecks remote `main` and installed
content immediately before upload, verifies exact cloud readback, then records a
numbered Apps Script version labeled with the Git commit. Existing Script
Properties, calendars and timers are retained. The numbered version is an audit
snapshot; triggers still execute HEAD. Secrets and cloud source are never printed
or uploaded as workflow artifacts. The runner temporarily reads private cloud
configuration in memory to preserve it during the complete source update.

Use a protected `main` requiring PRs and the `Validation / check` status.
Deployment runs are serialized and never cancelled midway by a newer run; stale
queued revisions fail before upload. After deployment, check the first scheduled
sync in Apps Script Executions. A successful source upload is not proof that an
external Calendar call succeeded.

For rollback, revert the relevant code through a PR and merge it to `main`; the
same workflow redeploys the previous behavior while retaining current private
configuration. No new calendar or timer is created. Deployment failures do not
retry mutations automatically. Inspect the installation before rerunning a failed
job: source upload can succeed even if later readback/version recording fails.

## Limits

Sync supports DAILY, WEEKLY, MONTHLY and YEARLY recurrence through ICAL.js,
including ordinary RDATE/EXDATE and single-occurrence overrides. RANGE, EXRULE,
RDATE PERIOD, unknown timezones and ambiguous all-day exceptions stop the run.
Very long/large recurrence histories can exceed configured iteration/runtime
limits; a failed expansion applies no event changes. Later API failures can leave
a partial reconciliation, which the next run repairs. Apps Script quotas apply.

The fixed-window `runAudit` deliberately remains narrower: single-day all-day
weekly series and exact standalone timed assertions. Unsupported selected audit
series fail acceptance. Use it for explicit regression dates, not as a complete
ICS validator. Reports and execution logs may contain private event details.

## Development and license

Node.js 18+ and markdownlint-cli are used for checks:

```bash
make check
```

Override `NODE`, `PYTHON`, `MARKDOWNLINT`, or `MARKDOWNLINT_CONFIG` for local tools.
Tests use synthetic data and mocked Calendar services. Real cloud activation and
readback are separate checks. See [TODO.md](TODO.md) for optional future work.

Project code is [MIT licensed](LICENSE), matching the reference Cataloger projects.
Vendored ICAL.js 2.2.1 retains its [MPL-2.0 license](vendor/ICAL-LICENSE); see
[vendor provenance](vendor/README.md).

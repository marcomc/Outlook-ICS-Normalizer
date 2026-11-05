# Outlook ICS Normalizer

A small, read-only Google Apps Script proof for malformed Outlook all-day
recurrence exceptions. Each installation supplies its own feed and assertions.
This version audits selected events; calendar synchronization is not implemented.

## Table of contents

- [Setup](#setup)
- [Configuration](#configuration)
- [Behavior and limits](#behavior-and-limits)
- [Development](#development)

## Setup

Requires Python 3.9+ with timezone data. Node.js 18+ and markdownlint-cli are used
only for development checks. No runtime dependencies are installed.

1. Copy `config.example.json` to `config.local.json` and customize it.
2. Run `make prepare` to generate the three files under `build/`.
3. Create a standalone project at [Google Apps Script](https://script.google.com/).
4. Copy `build/Code.gs` and `build/Config.gs` into matching script files. Remove
   the default empty code if necessary. Enable the manifest in project settings
   and replace its content with `build/appsscript.json`.
5. Run `runAudit` and authorize external HTTP requests. Inspect the execution log:
   `passed` must be `true` and `unsupported` must be empty.

The script needs only `script.external_request`; it has no Calendar or Drive
permission and creates no events, calendars, triggers, or deployments. It runs
on Google servers, without depending on the local computer after installation.
Run it manually for this proof; it is not an automatic synchronization service.

`config.local.json`, generated `build/`, installation IDs, and local reports are
excluded from Git. `Config.gs` contains private settings in the installed Apps
Script project: keep that project private and restrict its editors. To update
settings, edit the local JSON, repeat `make prepare`, and replace the cloud files.
The installer preparation does not upload anything or read existing cloud settings.
Generated files are replaced atomically with private permissions. Symlinked build
directories or output files are rejected; remove the link before preparing again.
Do not put real data in the example configuration, fixtures, or documentation.

## Configuration

| Field | Meaning |
| --- | --- |
| `feedUrl` | Private HTTPS ICS URL; credentials embedded in the authority are rejected |
| `timeZone` | IANA timezone written into the Apps Script manifest |
| `fromDate`, `toDate` | Audit window as `YYYYMMDD`; start inclusive, end exclusive, maximum 366 days |
| `seriesTitles` | Exact titles of all-day masters to expand; overrides are matched by UID |
| `minimumMasters` | Minimum number of selected masters expected in the feed |
| `allDayChecks` | Expected occurrence counts by `date` and exact `title`; zero asserts absence |
| `timedChecks` | Optional standalone event assertions: exact `title`, `start`, `end`, and source `timeZone` (TZID) |

Timed starts and ends use `YYYYMMDDTHHMMSS`. These checks compare the source
fields and do not convert timezones. The example intentionally uses dummy event
titles and a documentation URL; it must be customized before a live run.

## Behavior and limits

For single-day all-day parents, timezone-qualified midnight `EXDATE` and
`RECURRENCE-ID` values are normalized to their nominal calendar date without a
UTC shift. Deleted occurrences are excluded; renamed and moved exceptions
replace the original occurrence.
Escaped summary text is decoded before title matching. Exceptions inherit omitted
title and status fields from their parent; cancelled occurrences remain excluded.

Supported recurrence: weekly frequency, interval, weekdays, week start, DATE
exclusions and single-day all-day overrides. RDATE, EXRULE, RANGE, COUNT,
multi-day events, and other frequencies are rejected for selected series.
Mixed-type UNTIL is tolerated only when its boundary is beyond the audit window.
This is a deliberately scoped parser, not a complete RFC 5545 implementation.
Moving an override onto another occurrence of the same series is not supported.
Unselected events are counted but not expanded or validated. Titles select
masters, so renamed masters require configuration updates.

Reports contain selected event titles and dates; keep execution logs private.
HTTP redirects are disabled. Fetch failures omit the private URL from errors.
The output describes corrected occurrences in memory and does not republish ICS.

## Development

```bash
make check
```

Use `NODE`, `PYTHON`, `MARKDOWNLINT`, or `MARKDOWNLINT_CONFIG` to override local
tools. Tests use synthetic fixtures with no personal calendar records and cover
deletions, renamed and moved exceptions, unsupported rules, configured acceptance
checks, and the read-only entry point. Test the live feed separately in Apps
Script after installing your private configuration.

See [TODO.md](TODO.md) for work outside this proof. No license or publication
destination has been selected yet.

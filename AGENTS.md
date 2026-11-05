# AGENTS.md Instructions

<!-- generated-by: agents-file-templates-and-skills/init-agents-file -->
<!-- generated-date: 2026-11-05 -->

Follow `${HOME}/AGENTS.md` for canonical user-wide policy.

## Project Context

- Project: `Outlook-ICS-Normalizer`
- Description: Google Apps Script audit and dedicated-calendar synchronization for Outlook ICS.

## Project-Type Overlays

<!-- BEGIN TEMPLATE: generic-development -->
### Generic Development

## Project Work

- Read the nearest `README.md`, package metadata, and relevant task or release
  notes before editing. Use the project's documented commands and wrappers.
- Keep changes within the requested module boundary; preserve unrelated work and
  edit sources rather than generated outputs.
- Verify changed behavior with the narrowest relevant checks, treat lint output
  as actionable, and report checks that could not run.
- Update the affected operational documentation when behavior changes. Keep one
  canonical document per topic instead of duplicating detailed guidance.
- Do not create commits, tags, pushes, pull requests, or releases unless asked.

## Public-Safe Content

- Keep tracked content portable. Replace personal, network, credential, and
  environment-specific values with stable placeholders.

<!-- END TEMPLATE: generic-development -->

## Project Local Rules

<!-- BEGIN PROJECT LOCAL -->
- Run `make check` after changing source, tests, or documentation.
- Keep configuration in ignored `config.local.json`; generate private cloud files
  with `make prepare`. Never publish `build/`, reports, real feed URLs, or Script IDs.
- Keep `runAudit` read-only. Sync may write only its owned dedicated calendar;
  calendar creation and trigger installation are explicit setup actions.
- Modify `Code.js`, not generated `build/Code.gs`. Keep examples and tests synthetic.
- Use English for authored project artifacts.
<!-- END PROJECT LOCAL -->

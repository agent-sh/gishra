# Changelog fragments

Add one `changelog.d/<task-or-pr>.md` file per change, for example `T86.md` or `123.md`. Use Markdown bullets. Leave existing fragments and `CHANGELOG.md` unchanged; CI rejects edits to them and requires a new fragment in each change.

`CHANGELOG.md` is the historical archive. At release, `node scripts/changelog.js` assembles the fragments in filename order followed by that archive on stdout. Save that output as the release changelog artifact outside the checkout. Assembly keeps the source fragments, so the complete changelog can be regenerated for every release.

The CLI command rows in `docs/cli.md` come from `COMMANDS` in `bin/tower-crane.js`. Keep that table sorted by command name, with one entry per line and a blank line between entries. Change a command's usage and summary there, then run `npm run docs:generate`. Keep contract details outside the generated blocks. `npm run check:shared` checks the generated rows and table layout; pass `-- --base SHA` to also check the changelog changes against a base commit.

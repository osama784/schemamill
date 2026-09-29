---
name: changelog-flow
description: Keep `CHANGELOG.md` current — an entry under `[Unreleased]` per change, version sections cut at release. Use when finishing a change, preparing a PR, or cutting a release.
---

# Changelog flow

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Write entries for strangers: past tense, detailed, public-safe — no client or personal names.

## Format

- Sections: `## [Unreleased]`, `## [X.Y.Z] - YYYY-MM-DD` (space-hyphen-space, ISO date).
- Categories: `### Added`, `### Changed`, `### Deprecated`, `### Fixed`, `### Removed`, `### Security`, `### Documentation`.
- Entries: `- **Bold title** — prose description in past tense`, identifiers, paths, and commands backticked.
- Released sections are never rewritten; the file grows forward only.

## Per feature or fix

Add the entry under `[Unreleased]` in the right category, on the feature branch, and commit it separately as `docs: update unreleased changelog`.

## Release

With the `dev` → `main` release PR:

1. Rename `[Unreleased]` → `[<version>] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` above it.
2. Commit `chore(release): add CHANGELOG.md for v<version>` and push `dev`.
3. The release PR body carries that version's section; after merge, tag `v<version>` and create the GitHub release with the same notes.

## Semver

`fix:` → patch · `feat:` → minor · breaking → major.

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

1. Bump the release/package version in all seven fields together in a single commit using the exact message form `chore(release): bump the version to <X.Y.Z>`; the seven fields, in the order defined by `.github/scripts/release-check.mjs:23-56`, are:
   1. root `package.json`
   2. `packages/core/package.json`
   3. `packages/postgres/package.json`
   4. `packages/cli/package.json`
   5. `packages/server/package.json`
   6. `packages/core/src/index.ts` version literal
   7. `packages/postgres/src/index.ts` version literal
   Both this bump and the `CHANGELOG.md` cut below must land on `dev` before any tag: `.github/scripts/release-check.mjs:138-150` requires all seven fields and the newest dated `CHANGELOG.md` header to agree simultaneously, so a bump-only commit leaves the gate red.
2. Rename `[Unreleased]` → `[<version>] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` above it.
3. Commit `chore(release): add CHANGELOG.md for v<version>` and push `dev`.
4. The release PR body carries that version's section; after merge, pull `main` and run `pnpm release:check` immediately before `git tag`, then tag `v<version>` and create the GitHub release with the same notes.

## Semver

`fix:` → patch · `feat:` → minor · breaking → major.

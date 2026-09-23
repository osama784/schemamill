# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- **Branch/PR and changelog workflows** — adopted a feature-branch → `dev` → `main` flow with `gh` PRs and a Keep a Changelog–based `CHANGELOG.md`, captured as repo skills.
- **First-slice plan** — [`docs/plans/first-slice.md`](docs/plans/first-slice.md) scopes the first end-to-end path: read two PostgreSQL DDL dumps, compare, and render the migration plan as migration SQL.

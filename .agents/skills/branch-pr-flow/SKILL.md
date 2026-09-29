---
name: branch-pr-flow
description: Feature branches into `dev`, PRs via `gh`, releases `dev` → `main`. Use whenever committing, pushing, opening a PR, or cutting a release.
---

# Branch & PR flow

`main` is release-only; all work lands on `dev` through a feature branch and a PR. Forward-only: never amend, rebase, reset, or force-push. Stage explicit paths only — never `git add -A`. Merge with merge commits, never squash.

## Day-to-day (feature → dev)

1. Create the branch — the prefix mirrors the commit type (`feat/`, `fix/`, `docs/`, `chore/`): `git checkout -b feat/my-thing`
2. Code and commit with a conventional commit message. Semver mapping: `fix:` → patch, `feat:` → minor, breaking → major.
3. Add the changelog entry under `[Unreleased]` (see the `changelog-flow` skill) and commit it separately as `docs: update unreleased changelog`.
4. Push: `git push origin feat/my-thing`
5. Write the PR body to a temp file (e.g. `/tmp/opencode/pr-body.md`), then:
   `gh pr create --base dev --head feat/my-thing --title "feat(x): desc" --body-file /tmp/opencode/pr-body.md`
6. Merge with auto-delete:
   `gh pr merge <N> --merge --delete-branch --subject "feat(x): desc" --body-file /tmp/opencode/pr-body.md`
7. Clean up: `git checkout dev && git pull origin dev && git branch -D feat/my-thing`, then remove the temp file.

## Release (dev → main)

1. `git checkout dev && git pull origin dev`
2. Cut the version in `CHANGELOG.md` (see `changelog-flow`), commit `chore(release): add CHANGELOG.md for v<version>`, push `dev`.
3. Write the release PR body (that version's changelog section) to a temp file, then:
   `gh pr create --base main --head dev --title "chore(release): merge dev for v<version>" --body-file /tmp/opencode/pr-body.md`
4. Merge:
   `gh pr merge <N> --merge --subject "chore(release): merge dev for v<version>" --body-file /tmp/opencode/pr-body.md`
5. Tag and publish:
   `git checkout main && git pull origin main`
   `git tag v<version> && git push origin v<version>`
   Write that version's changelog section to `/tmp/opencode/release-notes.md`, then:
   `gh release create v<version> --title "v<version>" --notes-file /tmp/opencode/release-notes.md`
6. Sync back: `git checkout dev && git merge main && git push origin dev`

CI verifies every PR; `dev` pushes are verified too.

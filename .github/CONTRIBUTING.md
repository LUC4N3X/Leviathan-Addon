# Contributing

## Local setup

1. Use Node.js 18+.
2. Install dependencies with `npm ci`.
3. Run `npm run check` before opening a pull request.

## Commit style

Use Conventional Commits. The release workflow reads commit history to update `CHANGELOG.md`, open release PRs and bump the version automatically.

Recommended types:

- `feat:` new functionality
- `fix:` bug fix
- `perf:` performance improvement
- `refactor:` internal refactor
- `docs:` documentation only
- `test:` tests only
- `build:` packaging or dependency changes
- `ci:` workflow/automation changes
- `chore:` maintenance with no user-facing impact

Breaking changes:

- use `feat!:` or `fix!:` for breaking work
- or add a `BREAKING CHANGE:` footer in the commit body

Examples:

- `feat: add stricter origin validation for playback routes`
- `fix: block private network targets in VIX proxy`
- `perf: reduce cache cleanup contention`

## Quality gates

- keep golden fixtures updated for language, anime, and pack edge cases
- avoid duplicating canonical title/language/anime logic outside `core/canonical`
- prefer small, reviewable pull requests

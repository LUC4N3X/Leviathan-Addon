# Contributing

## Local setup

1. Use Node.js 18+.
2. Install dependencies with `npm ci`.
3. Run `npm run check` before opening a pull request.

## Commit style

Use Conventional Commits where possible:

- `feat:` new functionality
- `fix:` bug fix
- `refactor:` internal refactor
- `test:` tests only
- `chore:` maintenance

## Quality gates

- keep golden fixtures updated for language, anime, and pack edge cases
- avoid duplicating canonical title/language/anime logic outside `core/canonical`
- prefer small, reviewable pull requests

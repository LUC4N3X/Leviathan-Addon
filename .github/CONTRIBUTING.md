# Contributing

## Local setup

1. Use Node.js 20.19 or newer.
2. Install dependencies with `npm ci`.
3. Run `npm run check` before opening a pull request.
4. For Docker changes, verify the image locally with `docker build -t leviathan:local .`.

## Commit style

Use short Conventional Commit style messages where it makes sense:

- `feat:` new functionality
- `fix:` bug fix
- `perf:` performance improvement
- `refactor:` internal cleanup
- `docs:` documentation only
- `test:` test changes
- `ci:` workflow or automation changes
- `chore:` maintenance

## Quality gates

Keep changes small, keep provider-specific logic isolated, and add tests for title parsing, language detection, debrid matching, provider routing and extractor regressions whenever you touch those areas.

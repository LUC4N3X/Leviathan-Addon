# Contributing to Leviathan

Thanks for helping improve Leviathan.

## Local setup

Use Node.js 20.19 or newer.

```bash
npm ci
npm test
```

For quick validation before opening a pull request:

```bash
npm run lint
npm run format:check
node --test tests/config_schema.test.js tests/source_mode.test.js tests/title_parser.test.js tests/language_guard.test.js tests/stream_quality_filters.test.js
```

## Pull requests

Keep pull requests focused. Mention the provider, extractor, cache layer or UI area touched by the change. Include logs only after removing tokens, cookies, IPs and API keys.

## Provider work

Provider fixes should prefer deterministic parsing, conservative fallbacks and clear failure classification. Avoid hardcoding private proxy endpoints or secrets.

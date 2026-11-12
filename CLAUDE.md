# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**unofficial-magister-mcp** is an MCP (Model Context Protocol) server that provides access to Dutch school schedules from Magister.net. It uses Playwright for browser automation to authenticate and fetch schedule data via both API calls and DOM scraping as fallback.

## Commands

```bash
npm run dev          # Run from source with tsx
npm run build        # Build with tsup (ESM + types)
npm start            # Run compiled server
node dist/index.js login   # Interactive login (visible Chromium), stores the session
node dist/index.js logout  # Remove the local session

npm test             # All tests (unit, synthetic Chromium, protocol); needs `npm run build` first
npm run test:unit    # Unit tests only (no browser)
npm run smoke        # Protocol smoke test against dist/ (no credentials, no network)
npm run lint         # ESLint (src, tests, scripts)
npm run format:check # Prettier
npm run type-check   # tsc for src and tests
```

Browser tests need Chromium: `npx playwright install chromium`.

## Architecture

- `src/index.ts` – entry: loads `.env` from the cwd, calls `run()` in `cli.ts`
- `src/cli.ts` – commands (`login`, `logout`, `--help`, `--version`, none = stdio server) and shutdown on SIGINT/SIGTERM/stdin close
- `src/server.ts` – MCP server (lowlevel `Server`), the 6 tools, output formatting
- `src/tools.ts` / `src/dates.ts` – tool definitions, argument validation, Europe/Amsterdam dates and inclusive ranges (default 14, max 31 days)
- `src/assignments.ts` – homework (InfoType 1) and tests (InfoType 2–5) from agenda appointments; HTML to plain text with htmlparser2 (no DOM, nothing executed or loaded)
- `src/config.ts` – env validation; canonical school origin; state dir
- `src/security.ts` / `src/browser-policy.ts` – exact-origin allowlist; context-wide navigation, redirect and popup guard
- `src/browser-session.ts` – one browser/context/page with the policy applied
- `src/auth.ts` – interactive and password login, silent refresh, token capture from the school callback only, child selection
- `src/magister-api.ts` – API boundary: exact origin, no redirects, zod schemas
- `src/magister.ts` – `MagisterClient`: restore, refresh, logout detection, schedule mapping
- `src/storage.ts` – private per-account `session.json` (0700/0600, O_NOFOLLOW, atomic writes)
- `src/cache.ts` – in-memory cache of validated appointments per client (TTL, max stale, LRU, generation); schedule, homework and tests are projections of it
- `src/logger.ts` / `src/errors.ts` – fixed log events on stderr; public errors with fixed codes and texts

### Rules that must hold

- stdout carries only JSON-RPC; everything else goes through `logEvent` to stderr. Never log free text, URLs, error messages, tokens or names.
- Errors reaching the client are `PublicError` codes; anything else becomes `INTERNAL`.
- Credentials are only filled on `https://accounts.magister.net`; tokens only come from the callback on the school origin; never use an `id_token`.
- API errors are errors, never an empty schedule.
- Tests never touch real Magister, real credentials or the real state dir; the fixture in `tests/fixtures/magister-routes.ts` aborts everything else.

### Key Implementation Details
- Schedule API endpoint: `/api/personen/{id}/afspraken?status=1&van={date}&tot={date}`; a week or homework/test range is one call, with no detail fetches
- API calls run as `fetch()` inside the page (Playwright's `context.request` bypasses `context.route`)

## Environment Variables

See `.env.example` and the README. Only `MAGISTER_SCHOOL` is required; `MAGISTER_USER`/`MAGISTER_PASS` only in `MAGISTER_AUTH_MODE=password`.

## Build System

- **tsup** for bundling (ESM output with types)
- **ESLint 9** with TypeScript support
- **Prettier** for formatting
- **Husky + lint-staged** for pre-commit hooks

## Release Process

1. Follow [Conventional Commits](https://conventionalcommits.org/) for commit messages
2. release-please manages versioning and changelog
3. Manual npm publish by maintainer

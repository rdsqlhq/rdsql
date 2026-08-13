# Contributing to rdSQL Desktop

Thanks for your interest in improving rdSQL Desktop! This document covers
everything you need to set up the project, make a change, and get it merged.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Rust & Cargo](https://www.rust-lang.org/) v1.75+
- Platform build dependencies for [Tauri v2](https://v2.tauri.app/start/prerequisites/)
  (Xcode CLT on macOS, `libwebkit2gtk` etc. on Linux, WebView2 on Windows)

## Getting Set Up

```bash
git clone https://github.com/rdsqlhq/rdsql.git
cd rdsql
make install       # or: npm install
make dev           # full desktop app (Tauri window + Vite)
make dev-web       # frontend only, in a browser, no Rust toolchain needed
```

Run `make help` to see every available target.

## Project Layout

- `src/` — React 19 + TypeScript frontend (Vite)
  - `src/components/` — UI components, grouped by feature area
  - `src/core/` — domain logic (SQL, backup, storage, compare, etc.)
  - `src/store/` — Zustand state stores
- `src-tauri/` — Rust backend (Tauri v2 commands, drivers, native services)

## Making a Change

1. Fork the repo and create a branch off `main`:
   `git checkout -b feat/short-description` (or `fix/…`, `docs/…`, `chore/…`).
2. Make your change. Keep it focused — unrelated fixes/refactors belong in a
   separate PR.
3. Add or update tests for behavior you touch (see [Testing](#testing)).
4. Run the checks below before opening a PR.
5. Commit with a clear message (see [Commit Messages](#commit-messages)).
6. Push and open a pull request against `main`.

## Quality Checks

```bash
make typecheck      # tsc --noEmit
make lint           # currently an alias for typecheck
npm test            # vitest run (unit tests)
```

For Rust changes in `src-tauri/`:

```bash
cd src-tauri
cargo check
cargo test
```

CI runs these same checks on every pull request — please make sure they pass
locally first.

## Testing

Frontend unit tests live next to the code they cover, under `__tests__/`
directories, and run with [Vitest](https://vitest.dev/):

```bash
npm test         # run once
npm run test:watch
```

New logic in `src/core/` (SQL generation, backup/restore, storage, diffing,
etc.) should come with test coverage. UI-only changes don't need it, but if
you touch behavior that's already tested, keep the tests green.

## Commit Messages

Use short, imperative, present-tense messages. [Conventional Commits](https://www.conventionalcommits.org/)
prefixes are encouraged but not required:

```
fix: correct null handling in relation cell input
feat: add CSV export for query results
docs: clarify release process
```

## Pull Requests

- Describe **what** changed and **why**, not just what files were touched.
- Link any related issue (`Closes #123`).
- Keep PRs scoped to one concern — smaller PRs review and merge faster.
- Screenshots or a short clip are appreciated for UI changes.
- A maintainer will review, request changes if needed, and merge once CI is
  green and the PR is approved.

## Reporting Bugs / Requesting Features

Please use the issue templates in the
**[rdSQL Community repository](https://github.com/rdsqlhq/rdsql-community/issues/new/choose)**.
Include reproduction steps, expected vs. actual behavior, and your OS/app
version for bugs.

## Releasing

Releasing is maintainer-driven and tag-based; see [RELEASE.md](RELEASE.md)
for the full process. Contributors don't need to worry about this — just
open PRs against `main`.

## License

By contributing, you agree that your contributions will be licensed under
the project's [MIT License](LICENSE).

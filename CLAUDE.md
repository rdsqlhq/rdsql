# rdSQL Desktop — Agent Context

Native database workspace: **Tauri v2 + Rust** backend, **React 19 + TypeScript + Vite** frontend.
Open source under the MIT License (see `LICENSE`).

## Repo layout

- `src/` — frontend. `components/` (by feature), `core/` (SQL/backup/storage/compare domain
  logic), `store/` (Zustand).
- `src-tauri/` — Rust backend: Tauri commands, DB drivers, native services (keyring, S3, backup).
- `docs/tutorials/`, `docs/screenshots/`, `screenshots/` — public-facing docs, kept accurate
  against the real app (don't add tutorials for features that don't exist).

## Optional cloud backend

`src-tauri/src/commands/backend.rs` talks to an optional rdSQL backend (accounts, device
pairing, encrypted sync, entitlement) via two compile-time env vars, `RDSQL_API_BASE` /
`RDSQL_WEB_BASE` (see `.env.example`). A plain `git clone && make build` leaves both unset, which
disables cloud sign-in/sync/entitlement entirely (`backend_is_cloud_configured` returns `false`) —
every database/editor/ERD/backup feature works fully without them. There is no bundled backend
implementation in this repo.

## Related project

Community hub (issues, discussions, sample databases): `rdsqlhq/rdsql-community`
(https://github.com/rdsqlhq/rdsql-community).

## Build / release

Everything's driven from the `Makefile` (`make help`). Releasing is tag-driven via
`.github/workflows/release.yml` — see `RELEASE.md` for the full process. Signing (Tauri updater
key, Apple code signing/notarization) needs credentials that don't exist yet; see `RELEASE.md`
and the `NEEDS REVIEW` note there for current status. Builds and tests do not require any signing
credentials.

## Known gotchas

- `RunEvent::Opened` (in `src-tauri/src/lib.rs`) only exists on macOS/iOS in Tauri 2.x — must
  stay behind `#[cfg(any(target_os = "macos", target_os = "ios"))]` or Linux CI and Windows
  release builds fail to compile.
- CI (`.github/workflows/ci.yml`) runs `cargo check --all-targets && cargo test` on
  `ubuntu-22.04` — cold builds (no `Swatinem/rust-cache` hit yet) can take 30+ minutes due to
  `duckdb-rs` compiling DuckDB's C++ source from scratch. Not a sign it's hung.

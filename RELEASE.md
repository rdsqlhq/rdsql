# Releasing rdSQL Desktop

How a version gets built, published, and delivered to users already running the app.

Everything is driven from the `Makefile`. Run `make help` for the full target list.

---

## The short version

```bash
make bump V=1.0.1                          # set the version everywhere
git commit -am "chore: release v1.0.1"
make publish                               # tag + push → CI builds 4 platforms
make release-watch                         # ~20 min
make release-publish                       # un-draft; this is what users see
```

---

## How it works

Releases are **tag-driven**. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds four targets in parallel:

| Platform | Runner | Target |
|---|---|---|
| macOS Apple Silicon | `macos-latest` | `aarch64-apple-darwin` |
| macOS Intel | `macos-13` | `x86_64-apple-darwin` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |

`tauri-action` uploads the installers to a GitHub Release and — because
`createUpdaterArtifacts` is on — also generates `latest.json`, the manifest the
in-app updater reads.

The Release is created as a **draft**. It stays invisible to users, and to the
updater, until `make release-publish`.

---

## Version: Cargo.toml is the single source of truth

`src-tauri/Cargo.toml` is the only place a release version is actually
declared. `src-tauri/tauri.conf.json` has no `version` field at all — Tauri
reads it from `Cargo.toml` automatically when it's absent (this is documented
Tauri CLI behavior, not a hack), and the frontend never hardcodes it either:
`useAppVersion()` (`src/core/hooks/useAppVersion.ts`) fetches it at runtime
via `@tauri-apps/api/app`'s `getVersion()`, so the UI always shows whatever's
actually running — no separate constant to go stale. (This is exactly what
happened before: `src/core/config/version.ts` sat hardcoded at `1.0.0` for
several releases because `make bump` never touched it — deleted now that
nothing needs it.)

`package.json` still carries its own version field, since npm requires one —
but nothing in the app reads it. `make bump V=x.y.z` sets `Cargo.toml` (the
source of truth) and `package.json` + its lockfile (so `npm` tooling doesn't
show a stale number); `make version` shows the current state.

**Why it matters:** the workflow triggers on the tag you push, but
`tauri-action` uploads to a release named `v__VERSION__` resolved from that
same `Cargo.toml` version. Push `v1.0.1` while `Cargo.toml` still says `1.0.0`
and you get a `v1.0.0` release with your `v1.0.1` tag pointing at nothing.
`make publish` refuses to run unless `package.json` and `Cargo.toml` agree, so
this can't happen by accident.

---

## The updater

### What the user sees

- **On startup** — a silent check 4 seconds after launch. If the app is current,
  or the machine is offline, nothing appears.
- **When an update exists** — a toast: *"Update available — v1.0.1"* with an
  **Install now** button that downloads, installs, and restarts the app.
- **Help ▸ Check for Updates...** — a manual check that always reports back,
  including "You are up to date".

### The moving parts

| Piece | Where |
|---|---|
| Check / download / relaunch logic | `src/core/updater.ts` |
| Startup check + menu wiring | `src/components/layout/MainLayout.tsx` |
| Plugin registration, menu item | `src-tauri/src/lib.rs` |
| Endpoint + public key | `src-tauri/tauri.conf.json` → `plugins.updater` |
| Permissions | `src-tauri/capabilities/default.json` |
| Signing key injection | `.github/workflows/release.yml` |

The endpoint is:

```
https://github.com/rdsqlhq/rdsql/releases/latest/download/latest.json
```

> ### NEEDS REVIEW — endpoint points at this (now public) repo
>
> This used to point at a private repo (`robiokidenis/rdsql-desktop`, then
> `rdsqlhq/rdsql-desktop`), and GitHub doesn't serve release *assets*
> anonymously on private repos — anonymous requests 404'd regardless of the
> repo owner, so the in-app updater couldn't actually reach it. Now that this
> code lives in the public `rdsqlhq/rdsql`, that specific problem goes away
> **once releases actually exist here** — but nobody has verified it in
> practice yet, and the `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` GitHub
> Secrets below still need to be set on *this* repo (they don't carry over
> from the private one). Treat auto-update as unverified until a real tagged
> release has been published and tested end-to-end.

### Signing

Update packages are signed with a **minisign** keypair. The public half is
embedded in `tauri.conf.json`; the private half must be in GitHub Secrets:

```bash
make updater-secrets      # uploads ~/.tauri/rdsql-desktop.key
```

Generating a fresh key, if ever needed:

```bash
npx tauri signer generate -w ~/.tauri/rdsql-desktop.key
# then paste the .pub contents into tauri.conf.json → plugins.updater.pubkey
```

> ### ⚠️ Back up the private key
>
> It lives at `~/.tauri/rdsql-desktop.key` and was generated **without a
> password**. The matching public key is compiled into every copy of the app
> already installed on users' machines, and there is no way to change it
> remotely.
>
> **Lose this key and every existing install is permanently cut off from
> updates.** Users would have to download a new build by hand. Store it in a
> password manager.

### Connecting official releases to rdsql.com

`API_BASE`/`WEB_BASE` in `src-tauri/src/commands/backend.rs` are hardcoded to
`https://rdsql.com/...` — they're plain URLs, extractable from any network
trace or `strings` on the binary regardless of how they get in, so there's no
point injecting them. What's compile-time-gated is `RDSQL_CLIENT_KEY` (read
via `option_env!`): unset (the default for any clone-and-build, including
forks and PR/branch CI in `ci.yml`), `backend_is_cloud_configured()` returns
`false` and the build ships fully functional with cloud features simply off
— nothing else in the app depends on it.

Local maintainer builds pick it up automatically from `OFFICIAL_ENV`
(`~/.tauri/rdsql-desktop.official.env`, outside the repo — one `KEY=VALUE`
per line, e.g. `RDSQL_CLIENT_KEY=<value>`). **CI-built releases need the same
value as a GitHub Secret**, or `release.yml` builds it unset and every
downloadable release ships cloud-disabled even though your local
`make release` doesn't:

```bash
make backend-secrets      # uploads RDSQL_CLIENT_KEY from ~/.tauri/rdsql-desktop.official.env
```

**`RDSQL_CLIENT_KEY` is not a real secret.** Once compiled into a public,
downloadable binary it's just as extractable as the URL above — keeping it
out of the committed source and out of fork/PR builds isn't about hiding it,
it's so a self-compiled build from a random fork doesn't silently start
talking to the production backend as if it were official. That's a soft
anti-abuse signal, not access control: it stops *casual* impersonation, not
a determined one. The actual security boundary is server-side:
`backend_open_login`'s OAuth/device-pairing flow authenticates the signed-in
*user* (tokens in the OS keyring), and billing/entitlement/abuse checks
should key off that authenticated user, not off which binary is calling. If
the key ever leaks, rotate it (`make backend-secrets` again with a new
value) and treat it as hygiene, not an incident.

---

## Gotchas

### The updater ignores draft releases

`releases/latest/download/` resolves to the latest *published* release, so a
draft is invisible to it. CI can go fully green and the app will still report
"up to date" — because from its point of view, nothing has shipped yet.

**Fix:** `make release-publish`.

### Only builds that ship the updater can update themselves

The update mechanism has to already be inside the running app. Any install
predating the updater work has no way to learn about new versions and must be
replaced manually. The first published release containing the updater is the
baseline for everything after it.

### macOS and Windows builds are unsigned

There is no `APPLE_CERTIFICATE` or Windows signing certificate in CI, so:

- macOS shows *"app is damaged"* or *"unidentified developer"*. Workaround:
  `xattr -cr /Applications/rdSQL.app`
- Windows shows a SmartScreen warning.
- **Auto-install on macOS can fail** even though the update itself is valid.

Minisign signing (which the updater uses to verify the update package) and OS
code signing (which convinces Gatekeeper the app is safe to launch) are separate
problems. Having the first does not solve the second.

### `make release` is not a release

`make release` builds an optimized local installer for *your machine only*.
`make publish` is what produces cross-platform installers and a real release.

---

## Troubleshooting

**Push rejected: "refusing to allow an OAuth App to ... workflow ... without `workflow` scope"**

The HTTPS remote authenticates with a `gh` OAuth token that lacks the `workflow`
scope, which is required to modify files under `.github/workflows/`. Either use
the SSH remote (`git@github.com:rdsqlhq/rdsql.git`) or run
`gh auth refresh -h github.com -s workflow`.

**CI is green but no `latest.json` in the release**

`TAURI_SIGNING_PRIVATE_KEY` is missing from GitHub Secrets. The build succeeds
without it — it just silently skips signing and the manifest. Run
`make updater-secrets`, then re-run the workflow.

**App never finds an update**

Check in order:
1. Is the Release published, or still a draft? → `make release-publish`
2. Does the release contain `latest.json`? → see above
3. Is the installed version actually older than the release?
4. Does the app include the updater at all? (see baseline note above)

**`make publish` refuses to run**

It enforces four preconditions: versions in sync across the three files, clean
working tree, tag not already taken, and a readable version in `tauri.conf.json`.
The error message names which one failed.

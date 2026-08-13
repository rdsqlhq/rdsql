# rdSQL Desktop — Makefile
#
# Common workflows:
#   make install     — install JS dependencies (and check Rust toolchain)
#   make dev         — run the full desktop app (Tauri window + Vite)
#   make dev-web     — run only the frontend in a browser (no Rust needed)
#   make typecheck   — TypeScript typecheck (no emit)
#   make build       — production desktop build (debug binary)
#   make release     — production desktop build (optimized binary + installers)
#   make setup       — same as `release`: build the .dmg/.msi/.AppImage setup
#   make run-release — launch the optimized binary without bundling
#   make clean       — remove build artifacts
#   make help        — this list
#
# Shipping a version (builds all 4 platforms on GitHub Actions):
#   make version           — show the current version in every file
#   make bump V=1.0.1      — set that version in Cargo.toml (the single source
#                            of truth — tauri.conf.json reads it automatically,
#                            see below) and package.json (+ lockfiles), then
#                            commit it yourself
#   make publish           — tag v<version> and push; this fires release.yml
#   make release-watch     — list recent release runs
#   make release-publish   — flip the resulting draft Release to public
#   make updater-secrets   — one-time: push the signing key to GitHub Secrets
#   make backend-secrets   — one-time: push RDSQL_CLIENT_KEY to GitHub Secrets
#
# Note: `release` builds locally for THIS machine only. `publish` is what
# produces the cross-platform installers via CI.
#
# The in-app updater reads latest.json from the LATEST PUBLISHED release, so it
# stays blind to a version until `make release-publish` un-drafts it.
#
# Installer output lands in src-tauri/target/release/bundle/  e.g.
#   macOS:   src-tauri/target/release/bundle/dmg/*.dmg
#            src-tauri/target/release/bundle/macos/*.app
#   Windows: src-tauri/target/release/bundle/msi/*.msi
#            src-tauri/target/release/bundle/nsis/*-setup.exe
#   Linux:   src-tauri/target/release/bundle/appimage/*.AppImage
#            src-tauri/target/release/bundle/deb/*.deb

# Prefer pnpm only when a pnpm-lock.yaml is present AND pnpm actually works.
# This project ships a package-lock.json, so npm is the default. We avoid
# auto-picking a broken pnpm (e.g. one that crashes on the current Node).
PKG_MANAGER := $(shell \
	if [ -f pnpm-lock.yaml ] && pnpm -v >/dev/null 2>&1; then \
		echo pnpm; \
	else \
		echo npm; \
	fi)
# Detect the OS so installer targets can name the right artifact.
UNAME_S := $(shell uname -s)

# Updater signing key. The public half lives in tauri.conf.json, which makes
# `tauri build` require a matching private key to sign the update bundle —
# otherwise it fails with "public key found, but no private key". Load it
# from disk automatically for local builds; CI gets it from the
# TAURI_SIGNING_PRIVATE_KEY GitHub secret instead (see `updater-secrets`).
UPDATER_KEY ?= $(HOME)/.tauri/rdsql-desktop.key
SIGN_ENV = $(if $(wildcard $(UPDATER_KEY)),TAURI_SIGNING_PRIVATE_KEY="$$(cat $(UPDATER_KEY))" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}",)

# Official backend config (RDSQL_CLIENT_KEY). Same pattern as the signing
# key above: a plain `git clone && make build` produces a community binary
# with cloud sign-in/sync disabled (see backend.rs's `require_cloud_configured`)
# because this file doesn't exist for anyone but the maintainer. The backend
# URLs themselves are hardcoded in backend.rs — not sensitive, not
# configurable here. Format: one KEY=VALUE per line, e.g.
#   RDSQL_CLIENT_KEY=<value>
OFFICIAL_ENV ?= $(HOME)/.tauri/rdsql-desktop.official.env
API_ENV = $(if $(wildcard $(OFFICIAL_ENV)),$(shell grep -E '^[A-Z_]+=' $(OFFICIAL_ENV) | awk -F= '{printf "%s=\"%s\" ", $$1, $$2}'),)

# Cargo.toml is the single source of truth for the release version.
# tauri.conf.json has no "version" field at all — Tauri reads it from
# Cargo.toml automatically when it's absent (confirmed in the Tauri CLI's own
# config schema: "If removed the version number from Cargo.toml is used").
# tauri-action then substitutes that resolved version into `tagName:
# v__VERSION__`, so the git tag must match it.
# Assigned with `=` (not `:=`) so `make bump ... publish` sees the new value.
APP_VERSION = $(shell sed -n '1,/^version = /s/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml)

# Default goal: show help instead of silently running the first target.
.DEFAULT_GOAL := help

.PHONY: help check-rust check-node check-gh install dev dev-web typecheck lint build release setup run-release bundle installer clean clean-dist clean-target show-artifacts version check-versions bump publish release-watch release-publish updater-secrets backend-secrets build-artifacts build-macos-arm64 build-macos-x64

help: ## Show this help
	@echo "rdSQL Desktop — available targets:"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf ""} \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Package manager detected: $(PKG_MANAGER)"
	@echo "Bundle target dir: src-tauri/target/release/bundle/"

# --- Prerequisite checks ----------------------------------------------------

check-node: ## Verify Node.js + npm are installed
	@command -v node >/dev/null 2>&1 || { \
		echo "Node.js not found. Install it (e.g. via nvm or from https://nodejs.org) and retry."; \
		exit 1; \
	}
	@command -v $(PKG_MANAGER) >/dev/null 2>&1 || { \
		echo "$(PKG_MANAGER) not found. Install Node.js or run 'npm install -g pnpm'."; \
		exit 1; \
	}

check-rust: ## Verify the Rust toolchain (cargo) is installed
	@command -v cargo >/dev/null 2>&1 || { \
		echo "Cargo/Rust not found. Install it with:"; \
		echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; \
		echo "then restart your terminal and try again."; \
		echo "(Or run 'make dev-web' to skip Tauri and use the browser build.)"; \
		exit 1; \
	}

check-gh: ## Verify the GitHub CLI (gh) is installed and authenticated
	@command -v gh >/dev/null 2>&1 || { \
		echo "GitHub CLI not found. Install it: https://cli.github.com"; \
		exit 1; \
	}
	@gh auth status >/dev/null 2>&1 || { \
		echo "GitHub CLI is not authenticated. Run: gh auth login"; \
		exit 1; \
	}

# --- Setup / install --------------------------------------------------------

install: check-node ## Install JavaScript dependencies
	$(PKG_MANAGER) install

# --- Development ------------------------------------------------------------

dev: check-rust ## Run the desktop app in dev mode (Tauri + Vite)
	$(PKG_MANAGER) run tauri dev

dev-web: ## Run only the frontend in a browser (no Rust toolchain required)
	$(PKG_MANAGER) run dev

# --- Quality checks ---------------------------------------------------------

# The `--` matters: without it npm swallows `--noEmit` as its own config
# ("Unknown cli config") and tsc runs without it, emitting JS and hiding errors.
typecheck: ## TypeScript typecheck (no emit)
	$(PKG_MANAGER) exec -- tsc --noEmit

lint: typecheck ## Typecheck (placeholder for a future eslint step)

# --- Builds -----------------------------------------------------------------

build: check-rust ## Production desktop build (debug binary, fast)
	@$(SIGN_ENV) $(API_ENV) $(PKG_MANAGER) run tauri build --debug

release: check-rust ## Production desktop build (optimized binary + installers)
	@$(SIGN_ENV) $(API_ENV) $(PKG_MANAGER) run tauri build

# `setup` is an alias for `release` — produces the platform installer
# (.dmg on macOS, .msi/.exe on Windows, .AppImage/.deb on Linux).
setup: release

# Build optimized binary only, skipping bundling (faster than `release`).
run-release: check-rust ## Build + launch the optimized binary (no installer)
	$(PKG_MANAGER) run tauri build --no-bundle
	@echo "Launching optimized binary…"
	@./src-tauri/target/release/rdsql-desktop || \
		./src-tauri/target/release/rdsql-desktop.app/Contents/MacOS/rdsql-desktop || \
		echo "Binary not found at the expected path."

# Aliases that read naturally for "build the setup/installer".
bundle: release
installer: release

# --- Versioning & release ---------------------------------------------------

version: ## Show the current version in every file that carries one
	@echo "Declared versions:"
	@$(MAKE) --no-print-directory check-versions
	@echo ""
	@echo "Latest tag: $$(git describe --tags --abbrev=0 2>/dev/null || echo '(none yet)')"

# Cargo.toml is the single source of truth (tauri.conf.json has no "version"
# field — Tauri reads it from Cargo.toml automatically). package.json is the
# only other file that still needs to agree, since npm requires its own
# version field even though nothing in the app reads it at runtime.
check-versions: ## Verify package.json / Cargo.toml agree
	@pkg=$$(node -p "require('./package.json').version"); \
	crate=$$(sed -n '1,/^version = /s/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml); \
	printf "  %-20s %s\n" "package.json" "$$pkg"; \
	printf "  %-20s %s\n" "Cargo.toml (source of truth)" "$$crate"; \
	if [ "$$pkg" != "$$crate" ]; then \
		echo ""; \
		echo "Versions disagree. Sync them with: make bump V=x.y.z"; \
		exit 1; \
	fi

bump: check-node ## Set the version everywhere (usage: make bump V=1.2.3)
	@test -n "$(V)" || { echo "Usage: make bump V=1.2.3"; exit 1; }
	@echo "$(V)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$$' || { \
		echo "Version must look like 1.2.3 (got '$(V)')."; exit 1; \
	}
	@node -e ' \
		const fs = require("fs"), v = process.argv[1]; \
		const patch = (f, fn) => { \
			if (!fs.existsSync(f)) return; \
			const j = JSON.parse(fs.readFileSync(f, "utf8")); \
			fn(j); \
			fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); \
		}; \
		patch("package.json", j => { j.version = v; }); \
		patch("package-lock.json", j => { \
			j.version = v; \
			if (j.packages && j.packages[""]) j.packages[""].version = v; \
		}); \
	' $(V)
	@sed -i.bak '1,/^version = /s/^version = .*/version = "$(V)"/' src-tauri/Cargo.toml
	@rm -f src-tauri/Cargo.toml.bak
	@# Cargo.lock is tracked, so refresh it. `cargo metadata` resolves without
	@# compiling; skip silently if Rust isn't installed on this machine.
	@if command -v cargo >/dev/null 2>&1; then \
		cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 >/dev/null; \
	else \
		echo "Note: cargo not found — Cargo.lock not refreshed."; \
	fi
	@echo "Bumped to $(V). Next:"
	@echo "  git commit -am 'chore: release v$(V)' && make publish"

publish: check-versions ## Tag v<version> and push — fires the CI release build
	@test -z "$$(git status --porcelain)" || { \
		echo ""; \
		echo "Working tree is dirty — commit or stash before publishing:"; \
		git status --short; \
		exit 1; \
	}
	@test -n "$(APP_VERSION)" || { echo "Could not read version from tauri.conf.json."; exit 1; }
	@if git rev-parse -q --verify "refs/tags/v$(APP_VERSION)" >/dev/null; then \
		echo "Tag v$(APP_VERSION) already exists — bump first: make bump V=x.y.z"; \
		exit 1; \
	fi
	@echo ""
	@echo "Publishing v$(APP_VERSION) from $$(git rev-parse --abbrev-ref HEAD)…"
	git tag -a "v$(APP_VERSION)" -m "rdSQL Desktop v$(APP_VERSION)"
	git push origin HEAD
	git push origin "v$(APP_VERSION)"
	@echo ""
	@echo "CI is building macOS (arm64 + x64), Windows and Linux installers."
	@echo "  make release-watch     — see run status"
	@echo "  make release-publish   — publish the draft Release when it's green"

# The private half of UPDATER_KEY (defined near the top) must also reach CI
# as a secret, or tauri-action emits no latest.json and the in-app updater
# has nothing to read.
updater-secrets: check-gh ## Upload the updater signing key to GitHub Secrets
	@test -f "$(UPDATER_KEY)" || { \
		echo "Signing key not found at $(UPDATER_KEY)."; \
		echo "Generate one with:"; \
		echo "  npx tauri signer generate -w $(UPDATER_KEY)"; \
		exit 1; \
	}
	gh secret set TAURI_SIGNING_PRIVATE_KEY < "$(UPDATER_KEY)"
	@printf '' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
	@echo "Uploaded. Verify with: gh secret list"

# Pushes every KEY=VALUE line in OFFICIAL_ENV (defined near the top) as a
# same-named GitHub Secret, so release.yml's build step can inject them into
# the CI build the same way it already does for the updater signing key.
# Without this, GitHub Actions-built releases ship with cloud features
# disabled even though your local `make release` (which reads OFFICIAL_ENV
# directly) has them on.
backend-secrets: check-gh ## Upload RDSQL_CLIENT_KEY (from OFFICIAL_ENV) to GitHub Secrets
	@test -f "$(OFFICIAL_ENV)" || { \
		echo "Official backend config not found at $(OFFICIAL_ENV)."; \
		echo "Create it with one KEY=VALUE per line, e.g.:"; \
		echo "  RDSQL_CLIENT_KEY=<value>"; \
		exit 1; \
	}
	@grep -E '^[A-Z_]+=' "$(OFFICIAL_ENV)" | while IFS='=' read -r key val; do \
		echo "Setting $$key…"; \
		printf '%s' "$$val" | gh secret set "$$key"; \
	done
	@echo "Uploaded. Verify with: gh secret list"

release-watch: check-gh ## List recent GitHub release-workflow runs
	@gh run list --workflow=release.yml --limit 5
	@echo ""
	@echo "Follow one live with: gh run watch <run-id>"

# release.yml sets releaseDraft: true, so the Release stays private until this.
release-publish: check-gh ## Flip the draft Release for the current version to public
	@gh release view "v$(APP_VERSION)" >/dev/null 2>&1 || { \
		echo "No Release found for v$(APP_VERSION) — has CI finished? (make release-watch)"; \
		exit 1; \
	}
	gh release edit "v$(APP_VERSION)" --draft=false
	@echo "Published: $$(gh release view 'v$(APP_VERSION)' --json url -q .url)"

# --- Introspection ---------------------------------------------------------

show-artifacts: ## List installer artifacts produced by the last release build
	@echo "Installer artifacts:"
	@find src-tauri/target -type f \( \
		-name '*.dmg' -o -name '*.app' -o -name '*.msi' -o -name '*.exe' \
		-o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
		-print 2>/dev/null || echo "  (none — run 'make setup' first)"

# --- Local artifact builds --------------------------------------------------
# Build installers for this machine's platform without going through CI.
# Cross-compile targets (e.g. arm64 ↔ x64 on macOS) require the matching Rust
# target to be installed: `rustup target add <triple>`.
#
# Bundle output for --target builds lands in:
#   src-tauri/target/<triple>/release/bundle/{dmg,macos,msi,deb,...}/

# macOS target triples (auto-detected from uname -m).
MACOS_ARM64_TARGET := aarch64-apple-darwin
MACOS_X64_TARGET   := x86_64-apple-darwin

# Ad-hoc sign with hardened runtime + entitlements. Without hardened runtime,
# macOS Sonoma+ shows "rdSQL is damaged" (not the friendlier "unidentified
# developer" dialog) for any downloaded (quarantined) app. The entitlements
# are required by the WebKit/JIT engine that Tauri uses at runtime.
#
# For public distribution you still need a real Apple Developer ID +
# notarization ($99/year) — without it users see the Gatekeeper warning and
# must right-click → Open. But at least it's a warning, not "damaged."
ENTITLEMENTS := src-tauri/entitlements.plist

define codesign-app
	@echo "  Signing $$(basename $(1)) with hardened runtime…"; \
	app=$$(find $(1)/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit 2>/dev/null); \
	if [ -n "$$app" ]; then \
		codesign --deep --force \
			--options runtime \
			--entitlements $(ENTITLEMENTS) \
			--sign - "$$app" \
			&& echo "    ✓ signed (adhoc + hardened runtime)" \
			|| { echo "    ⚠ codesign failed (non-fatal)"; exit 0; }; \
		\
		# Re-package DMG with the signed .app so the installer inside the \
		# DMG matches the signing (Tauri builds DMG before we sign). \
		dmg_dir="$(1)/release/bundle/dmg"; \
		dmg=$$(ls "$$dmg_dir"/*.dmg 2>/dev/null | head -1); \
		if [ -n "$$dmg" ]; then \
			dmg_name=$$(basename "$$dmg"); \
			staging="/tmp/dmg-staging-$$$$"; \
			rm -rf "$$staging"; mkdir -p "$$staging"; \
			cp -R "$$app" "$$staging/"; \
			ln -sf /Applications "$$staging/Applications"; \
			rm -f "$$dmg"; \
			hdiutil create -volname "rdSQL" -srcfolder "$$staging" \
				-ov -format UDZO "$$dmg" >/dev/null 2>&1 \
				&& echo "    ✓ DMG re-packaged ($$dmg_name)" \
				|| echo "    ⚠ DMG re-package failed"; \
			rm -rf "$$staging"; \
		fi; \
	else \
		echo "    ⚠ no .app found to sign"; \
	fi
endef

build-macos-arm64: check-rust ## Build macOS Apple Silicon .dmg (native on M-series)
	@rustup target list --installed 2>/dev/null | grep -q "$(MACOS_ARM64_TARGET)" \
		|| rustup target add "$(MACOS_ARM64_TARGET)"
	$(SIGN_ENV) $(API_ENV) npm run tauri build -- --target "$(MACOS_ARM64_TARGET)"
	$(call codesign-app,"src-tauri/target/$(MACOS_ARM64_TARGET)")
	@echo ""
	@echo "✓ macOS ARM64 build complete:"
	@find "src-tauri/target/$(MACOS_ARM64_TARGET)/release/bundle" -name '*.dmg' -print 2>/dev/null

build-macos-x64: check-rust ## Build macOS Intel .dmg (cross-compile on M-series)
	@rustup target list --installed 2>/dev/null | grep -q "$(MACOS_X64_TARGET)" \
		|| rustup target add "$(MACOS_X64_TARGET)"
	$(SIGN_ENV) $(API_ENV) npm run tauri build -- --target "$(MACOS_X64_TARGET)"
	$(call codesign-app,"src-tauri/target/$(MACOS_X64_TARGET)")
	@echo ""
	@echo "✓ macOS x86_64 build complete:"
	@find "src-tauri/target/$(MACOS_X64_TARGET)/release/bundle" -name '*.dmg' -print 2>/dev/null

# Build all macOS targets (both arches). On an M-series Mac this produces
# universal coverage: native arm64 + cross-compiled x86_64.
build-artifacts: check-rust ## Build all macOS installers (arm64 + x86_64)
	@$(MAKE) build-macos-arm64
	@$(MAKE) build-macos-x64
	@echo ""
	@echo "✓ All macOS builds complete. Artifacts:"
	@find src-tauri/target -path '*/release/bundle/*' \( -name '*.dmg' -o -name '*.app' \) -print 2>/dev/null

# --- Cleanup ---------------------------------------------------------------

clean-dist: ## Remove the frontend dist/ output
	rm -rf dist

clean-target: ## Remove the Rust target/ (full rebuild next time)
	rm -rf src-tauri/target

clean: clean-dist ## Remove all build artifacts (dist + Rust target)
	@echo "Cleaning build artifacts…"

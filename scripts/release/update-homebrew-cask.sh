#!/usr/bin/env bash
# Regenerates Casks/rdsql.rb in a checked-out rdsqlhq/homebrew-rdsql working
# copy (at $1) from a release manifest.json (at $2), then commits and pushes
# if anything changed. Split out of release.yml because a heredoc's closing
# delimiter can't be indented to match surrounding YAML while also being
# unindented enough for bash to recognize it — a real script sidesteps that
# entirely.
set -euo pipefail

TAP_DIR="$1"
MANIFEST="$2"

VERSION=$(jq -r '.version' "$MANIFEST")
ARM_SHA=$(jq -r '.files[] | select(.file | test("_aarch64\\.dmg$")) | .sha256' "$MANIFEST")
INTEL_SHA=$(jq -r '.files[] | select(.file | test("_x64\\.dmg$")) | .sha256' "$MANIFEST")

if [ -z "$VERSION" ] || [ -z "$ARM_SHA" ] || [ -z "$INTEL_SHA" ]; then
  echo "⚠ Missing version or checksums in $MANIFEST — skipping Homebrew cask bump"
  exit 0
fi

cat > "$TAP_DIR/Casks/rdsql.rb" <<EOF
cask "rdsql" do
  arch arm: "aarch64", intel: "x64"

  version "$VERSION"
  sha256 arm:   "$ARM_SHA",
         intel: "$INTEL_SHA"

  url "https://rdsql.com/download/rdSQL_#{version}_#{arch}.dmg"
  name "rdSQL Desktop"
  desc "Native database workspace for PostgreSQL, MySQL, SQLite, DuckDB, MongoDB, Redis, and S3-compatible object storage"
  homepage "https://rdsql.com"

  livecheck do
    url "https://rdsql.com/download"
    regex(/Current version:\s*v?(\d+(?:\.\d+)+)/i)
  end

  app "rdSQL.app"

  postflight do
    # macOS builds aren't code-signed yet (see rdsql-desktop RELEASE.md), so
    # Gatekeeper quarantines the app and refuses to launch it after a plain
    # DMG install. Homebrew installs bypass the manual "xattr -cr" workaround
    # by clearing the quarantine flag here automatically.
    system_command "/usr/bin/xattr",
                    args: ["-cr", "#{appdir}/rdSQL.app"],
                    sudo: false
  end

  zap trash: [
    "~/Library/Application Support/com.rdsql.desktop",
    "~/Library/Caches/com.rdsql.desktop",
    "~/Library/Preferences/com.rdsql.desktop.plist",
    "~/Library/Saved Application State/com.rdsql.desktop.savedState",
  ]
end
EOF

cd "$TAP_DIR"
git add Casks/rdsql.rb
if git diff --cached --quiet; then
  echo "Cask already up to date at v$VERSION"
  exit 0
fi

git config user.name "rdSQL Release Bot"
git config user.email "noreply@rdsql.com"
git commit -m "rdsql: update to v$VERSION"
git push origin main

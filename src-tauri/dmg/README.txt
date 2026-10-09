rdSQL — READ ME FIRST (one-time step on first launch)
=====================================================

rdSQL is not code-signed with an Apple Developer certificate yet, so macOS
Gatekeeper blocks the app on first launch. You may see:

    "rdSQL can't be opened because it is from an unidentified developer"
    "rdSQL is damaged and can't be opened"     (macOS Sonoma and later)

The app is fine — the download was just quarantined. Fix it once:

  1. Drag rdSQL.app to your Applications folder (if you haven't already).

  2. Open Terminal: press Cmd+Space, type "Terminal", press Enter.

  3. Paste these two lines and press Enter:

        xattr -cr "/Applications/rdSQL.app"
        open "/Applications/rdSQL.app"

The first command clears the quarantine flag macOS added during the
download. The second one launches the app. You only need to do this once —
after that, open rdSQL normally from Applications or Spotlight.

Don't want to use Terminal? Install with Homebrew instead — the cask clears
the quarantine flag for you automatically:

    brew install --cask rdsqlhq/rdsql/rdsql

Download page and SHA-256 checksums: https://rdsql.com/download

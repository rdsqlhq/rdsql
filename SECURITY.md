# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or
pull requests.** Publicly disclosing a vulnerability before a fix is available puts every user
running the app at risk.

<!-- TODO: no dedicated security contact exists yet. Replace this line with a real
     reporting channel (e.g. a security@ mailbox, or GitHub's private
     "Report a vulnerability" flow via Security Advisories) before this policy is
     treated as final. Until then, use GitHub Security Advisories on this repo
     (Security tab → "Report a vulnerability") if enabled, or open a draft/private
     channel with a maintainer directly rather than a public issue. -->

When reporting, please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (proof-of-concept code or a minimal repro is ideal).
- The affected version (`rdSQL Desktop` version, OS, and platform).
- Any suggested mitigation, if you have one.

We aim to acknowledge reports promptly and will work with you on a coordinated disclosure
timeline once a fix is available.

## Supported Versions

rdSQL Desktop is under active development and does not yet maintain parallel long-term-support
branches. Security fixes target the **latest released version**; users should stay current via
the in-app updater or by downloading the newest release. This section will be updated with a
formal support matrix once the project has multiple maintained release lines.

## Scope

This policy covers the rdSQL Desktop application in this repository: the Tauri/Rust backend and
the React/TypeScript frontend, including database drivers, credential storage, backup/restore,
and the encrypted sync client. It does not cover the hosted rdSQL backend/cloud services, which
live in a separate, private repository — please do not include hosted-service findings in
reports against this repo unless they involve how the desktop client itself talks to that
service (e.g. a client-side flaw in how tokens or encrypted data are handled).

## Responsible Disclosure

We ask that you:

- Give us a reasonable amount of time to investigate and address a report before any public
  disclosure.
- Make a good-faith effort to avoid privacy violations, data destruction, and service
  disruption while researching or reporting an issue.
- Only interact with accounts, data, or environments you own or have explicit permission to
  test.

Security researchers acting in good faith and in accordance with this policy will not be
pursued or reported for their research.

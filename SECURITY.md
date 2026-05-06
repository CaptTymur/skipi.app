# Security Policy

Skipi handles seafarers' identity documents, certificates, and career
records. Security is treated as a primary concern, not an afterthought.

For the internal cross-project threat model covering the desktop app,
`skipi-server`, Skipi Crewing, updater trust, fraud, abuse, and incident
readiness, see `SECURITY_THREAT_MODEL.md`.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, email **<tymur.rudov@icloud.com>** with:

- A clear description of the vulnerability.
- Steps to reproduce, including platform (Windows / macOS / Linux) and
  Skipi version.
- Impact assessment (what an attacker could do).
- Optional: a suggested fix.

You should expect an acknowledgement within 5 business days. Confirmed
vulnerabilities are typically addressed in the next release; severe issues
get an out-of-band patch release.

We do not run a paid bug bounty programme. Reporters of valid issues will
be credited in the release notes if they wish.

## Supported versions

Only the latest released version receives security fixes. Auto-update is
enabled by default in Skipi; users on older versions should let the
updater install the latest build.

## Scope — what we consider a vulnerability

In scope:

- Bugs that cause Skipi to send the user's documents, personal data, or
  certificate fields to any network destination without explicit user
  action.
- Bugs that allow another user on the same machine to read the Skipi
  vault outside the OS-level file permissions of the chosen vault folder.
- Tauri / Rust / WebView vulnerabilities that allow code execution or
  filesystem escape from the WebView context.
- Bugs in the auto-updater that allow installation of an unsigned or
  attacker-signed binary.
- Bugs in the optional AI-scan feature that leak document contents to
  unintended endpoints.

Out of scope:

- The user manually choosing to share documents with a third-party
  service (e.g. attaching a file to an email or uploading via a browser
  outside Skipi).
- Issues in the optional online services (skipi.app jobs board, Package
  Link transactional email) — these are tracked separately and are not
  part of the open-source signed client.
- Theoretical attacks requiring root / administrator access on the
  user's own machine.

## Cryptographic boundaries

- **Auto-updater:** Tauri minisign signature on `latest.json` and on every
  installer asset. Public key is pinned in `tauri.conf.json`. The
  updater refuses any binary that fails signature verification.
- **Windows Authenticode:** signed via SignPath Foundation (in progress
  as of 2026-04). See `.github/SIGNING_SETUP.md` for the build pipeline.
- **macOS:** Developer ID Application certificate, notarized via Apple
  notarytool, stapled.

## Disclosure timeline

1. Report received → acknowledgement within 5 business days.
2. Triaged and validated → typically within 14 days.
3. Fix prepared, tested, released.
4. Public disclosure via release notes once the fix is shipped to users
   (auto-update typically distributes within 24 hours of release).

If a vulnerability is being actively exploited and we cannot prepare a
fix in time, we will publish mitigations and advise users to disable the
affected feature.

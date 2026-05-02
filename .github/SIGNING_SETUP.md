# Windows signing setup

Skipi should not publish new unsigned Windows installers. The release workflow
now validates Azure Trusted Signing secrets before the Windows build and Tauri
uses `src-tauri/tauri.windows.conf.json` to sign every Windows binary/installer
with `trusted-signing-cli`.

macOS builds are intentionally paused. This document covers Windows only.

## Current status

As of 2026-05-02, the GitHub repositories have the Tauri updater signing key,
but the Azure Trusted Signing secrets are not configured yet. Until they are
added, the next tagged release will fail in the Windows job before publishing
an unsigned installer.

Required repositories:

- `CaptTymur/skipi.app`
- `CaptTymur/skipi-crewing`

## Azure setup

1. Create an Azure Trusted Signing Account.
2. Complete Microsoft identity validation.
3. Create a Public Trust certificate profile.
4. Create a Microsoft Entra app registration for GitHub Actions.
5. Grant that service principal the `Trusted Signing Certificate Profile Signer`
   role on the Trusted Signing Account.
6. Copy the Trusted Signing account endpoint URL.

## GitHub Actions secrets

Add these six secrets to both repositories:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | Microsoft Entra directory tenant ID |
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | App registration client secret value |
| `AZURE_ENDPOINT` | Trusted Signing account endpoint URL |
| `AZURE_CODE_SIGNING_NAME` | Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | Public Trust certificate profile name |

Existing updater signing secrets still remain required:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signature |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater key password, if set |

## How CI signs Windows releases

1. A tag such as `v0.4.92` triggers `.github/workflows/release.yml`.
2. The Windows job checks that all six Azure secrets are present.
3. The Windows job installs `trusted-signing-cli`.
4. Tauri merges `src-tauri/tauri.windows.conf.json` for the Windows build.
5. Tauri replaces `%1` in `signCommand` with the file being signed and calls:

```text
trusted-signing-cli -e %AZURE_ENDPOINT% -a %AZURE_CODE_SIGNING_NAME% -c %AZURE_CERT_PROFILE_NAME% %1
```

6. The GitHub Release is created only after the signed Windows build succeeds.

## Important distinction

This is Windows Authenticode signing. It is separate from Tauri updater
signatures. Both are needed:

- Authenticode helps Windows, browsers, Defender, SmartScreen, and company
  security policy understand who published the installer.
- Tauri updater signatures let an already-installed Skipi verify app updates.

## First signed release checklist

1. Add the six Azure secrets to both repositories.
2. Confirm `TAURI_SIGNING_PRIVATE_KEY` still exists in both repositories.
3. Bump the app version normally.
4. Push a tag.
5. Download the Windows `.exe` and `.msi`.
6. On a Windows machine, verify the Digital Signatures tab shows the expected
   publisher and timestamp.

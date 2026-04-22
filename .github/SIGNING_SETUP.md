# Signing setup — Windows (Azure Trusted Signing) + macOS (Apple Developer)

Skipi ships signed binaries on both Windows and macOS. The GitHub Actions
workflow is already wired; this doc covers the one-time account setup and
the GitHub Secrets you need to provide.

---

## Part 1 — Windows (Azure Trusted Signing)

**Cost:** $1/month (Basic tier) or $10/month (Standard tier).
Basic allows up to 10 signing operations per month — plenty for our release
cadence. Switch to Standard only if we start releasing more than ~10× per
month.

### Step 1. Create Azure account

- Go to <https://azure.microsoft.com/free/>
- Sign up with your Microsoft account (the one you used for FP submissions
  is fine). Requires a credit card but the free tier covers setup.

### Step 2. Provision Trusted Signing Account

- In the Azure Portal → search for **"Trusted Signing Accounts"**
- **+ Create** a new Trusted Signing Account
  - Subscription: your default subscription
  - Resource group: create `skipi-rg` (or any name)
  - Region: `West US` (closest Trusted Signing region — lowest latency
    for the signing HTTP calls during CI). `North Europe` is the EU option
    if you prefer EU data residency.
  - Name: `skipi-signing` (this is your `AZURE_CODE_SIGNING_NAME`)
  - Pricing tier: **Basic**
  - Review + Create

### Step 3. Identity Validation

This is the slow step — Microsoft verifies you're allowed to sign things.

- In your new Trusted Signing Account → **Identity validations** → **+ New identity validation**
- Pick **Individual** (you as author) or **Organization** (if Skipi is under
  a legal entity).
- Fill in the form — real name, ID document, etc.
- Submit. **Takes 1–3 business days** for MS to approve.

Until approved you can't create a Certificate Profile, so wait for the
green "Completed" mark before proceeding.

### Step 4. Create Certificate Profile

Once Identity Validation is Completed:

- Trusted Signing Account → **Certificate profiles** → **+ Create**
- Type: **Public Trust** (this is the one Defender / SmartScreen trusts)
- Identity validation: pick the one you just completed
- Certificate profile name: `skipi-public-trust` (this is your `AZURE_CERT_PROFILE_NAME`)
- Create

### Step 5. Create Service Principal (for CI auth)

Azure Trusted Signing doesn't accept personal logins from GitHub Actions.
You need an **App Registration** with a client secret that CI can use.

- Azure Portal → **Azure Active Directory** (now called **Microsoft Entra ID**) → **App registrations**
- **+ New registration**
  - Name: `skipi-github-signer`
  - Supported account types: **Single tenant**
  - No redirect URI needed. Register.
- After creation, note these values:
  - **Application (client) ID** → this is `AZURE_CLIENT_ID`
  - **Directory (tenant) ID** → this is `AZURE_TENANT_ID`
- Left panel → **Certificates & secrets** → **+ New client secret**
  - Description: `github-actions-2026`
  - Expires: 24 months
  - Copy the **Value** (only shown once) → this is `AZURE_CLIENT_SECRET`

### Step 6. Grant the Service Principal access to your Trusted Signing Account

- Go back to your **Trusted Signing Account** (`skipi-signing`) → **Access control (IAM)**
- **+ Add** → **Add role assignment**
- Role: **Trusted Signing Certificate Profile Signer**
- Assign access to: User, group, or service principal
- Members → select `skipi-github-signer`
- Review + assign

### Step 7. Find your Trusted Signing Endpoint

- Trusted Signing Account → **Overview** → copy the **Account URI**
  (something like `https://wus.codesigning.azure.net/`) → this is
  `AZURE_ENDPOINT`.

### Step 8. Add GitHub Secrets for Windows signing

Go to <https://github.com/CaptTymur/skipi.app/settings/secrets/actions>
and add these six secrets:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | from Step 5 (Directory tenant ID) |
| `AZURE_CLIENT_ID` | from Step 5 (Application client ID) |
| `AZURE_CLIENT_SECRET` | from Step 5 (client secret value) |
| `AZURE_ENDPOINT` | from Step 7 (full URL with https:// and trailing slash) |
| `AZURE_CODE_SIGNING_NAME` | from Step 2 (e.g. `skipi-signing`) |
| `AZURE_CERT_PROFILE_NAME` | from Step 4 (e.g. `skipi-public-trust`) |

---

## Part 2 — macOS (Apple Developer ID + notarization)

**Prerequisite:** active Apple Developer account ($99/yr). You already have
this.

The workflow uses tauri-action's built-in Apple signing; the step set in
`release.yml` picks up the secrets below and runs `codesign` + `xcrun notarytool`
automatically.

### Step 1. Make sure you have a Developer ID Application certificate

- Open **Xcode** → Preferences (⌘,) → Accounts → your Apple ID → Manage Certificates
- If you don't already see **"Developer ID Application"**, click `+` → create one.
- (Not "Developer ID Installer" — that's for `.pkg`. We need Application for `.dmg` notarization.)

### Step 2. Export the cert as `.p12`

- **Keychain Access.app** → Category `My Certificates` → find
  `Developer ID Application: Tymur Rudov (TEAMID)` → right-click → Export
- Format: **Personal Information Exchange (.p12)**
- Save with a strong password — remember it, it becomes `APPLE_CERTIFICATE_PASSWORD`

### Step 3. Base64-encode the `.p12` (GitHub Secrets can't hold raw bytes)

On your Mac:

```bash
base64 -i /path/to/DeveloperIDApplication.p12 | pbcopy
```

The base64 blob is now in your clipboard → paste it into the `APPLE_CERTIFICATE` secret.

### Step 4. Get your Team ID

- Visit <https://developer.apple.com/account> → Membership → **Team ID** (10 characters, e.g. `9ABC12DEF3`).
- Or from Keychain: look at the cert's common name — it's in parentheses:
  `Developer ID Application: Tymur Rudov (9ABC12DEF3)`.
- This is `APPLE_TEAM_ID`.

### Step 5. Get your Signing Identity string

This is the full common-name text from the cert, e.g.:

```
Developer ID Application: Tymur Rudov (9ABC12DEF3)
```

- `APPLE_SIGNING_IDENTITY`

### Step 6. Generate an app-specific password for notarytool

- <https://appleid.apple.com/> → Sign In → **App-Specific Passwords** → Generate
- Label: `github-actions-notarize`
- Copy the 16-char password (format `abcd-efgh-ijkl-mnop`) → this is `APPLE_PASSWORD`
- Your Apple ID email goes into `APPLE_ID`.

### Step 7. Add GitHub Secrets for macOS signing

On <https://github.com/CaptTymur/skipi.app/settings/secrets/actions>:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` (Step 3) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password (Step 2) |
| `APPLE_SIGNING_IDENTITY` | full cert common name (Step 5) |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | app-specific password (Step 6) |
| `APPLE_TEAM_ID` | 10-char team ID (Step 4) |

---

## Part 3 — First signed release

Once all 12 secrets (6 Azure + 6 Apple) are provisioned:

1. Bump version in the three places (per `CLAUDE.md`):
   `dist/index.html` (APP_VERSION + welcome-version) / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`
2. `cd src-tauri && cargo update -p skipi && cd ..`
3. Commit, tag `v0.4.53`, push tag.
4. CI will:
   - Build Linux `.deb` / `.AppImage` / `.rpm` (no signing needed).
   - Build Windows `.msi` / `.exe` and sign each via `trusted-signing-cli`.
   - Build macOS `.dmg` (Universal: arm64 + x64), sign via codesign, notarize via notarytool, staple.
   - Upload all artifacts to the GitHub Release.

First installations from a signed Windows build should no longer trigger
`Program:Win32/Wacapew.A!ml`. SmartScreen reputation builds up
automatically over the first ~100–1000 downloads — until then you may
occasionally still see a "Windows protected your PC" warning with a
"Run anyway" button. That's expected for non-EV certs.

macOS users won't see any Gatekeeper warning at all — notarization gives
full clearance out of the gate.

---

## Cost summary

| Item | Cost |
|---|---|
| Azure Trusted Signing (Basic) | $1/month |
| Apple Developer Program | $99/year (already paid) |
| GitHub Actions | $0 (public repo, unlimited minutes) |
| **Total new ongoing cost** | **≈$1/month** |

---

## Troubleshooting

### Windows build fails: `trusted-signing-cli: command not found`

The install step uses `cargo install trusted-signing-cli --locked`.
If the crate name has changed, check <https://crates.io/crates/trusted-signing-cli>
and update both `release.yml` and this doc.

### Windows build fails: `SignFileFailed: auth failed`

Check `AZURE_CLIENT_SECRET` hasn't expired (24-month life). Regenerate in
Azure AD → App registrations → skipi-github-signer → Certificates &
secrets.

### macOS build fails: `notarytool submission rejected`

Common causes:
- `APPLE_ID` wrong or not using app-specific password (`APPLE_PASSWORD` must
  be the 16-char app-specific one, not your account password).
- `APPLE_TEAM_ID` doesn't match the team the cert was issued under.
- Cert expired — Developer ID Application certs are valid 5 years, but
  you may have revoked and forgotten to regenerate.

### Identity validation still pending after 3 days

Open a support case at <https://azure.microsoft.com/support/> — Microsoft
sometimes holds submissions for manual review if your identity docs look
non-standard.

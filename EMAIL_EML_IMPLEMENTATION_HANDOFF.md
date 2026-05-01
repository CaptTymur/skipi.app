# EML Email Implementation Handoff

Status: ready for implementation
Date: 2026-04-27
Related decision: `EMAIL_DELIVERY_DECISION.md`

## Goal

Replace fragile per-platform "open installed mail client with attachments"
logic with one shared `.eml` generation path used by:

- Jobs Apply flow (`Apply via email` in Jobs tab)
- Dispatch flow
- future Crewing-side document send flows

SMTP remains the direct-send production path. `.eml` is the reliable
cross-platform fallback when SMTP is not configured or when the user chooses
manual sending.

## Current State

Repo: `/home/linux/Developer/skipi-public`

Important files:

- `dist/index.html`
  - Jobs Apply flow: `jobsApply(...)`
  - Dispatch flow: `showDispatch(...)`, `doDispatchUnified(...)`
- `src-tauri/src/commands/jobs.rs`
  - currently has `open_mail_with_attachment(...)`
  - Linux Thunderbird path works better than macOS/Windows mailto fallback
- `src-tauri/src/commands/packages.rs`
  - `dispatch_package(...)` already has richer legacy native composer logic
  - `open_email_with_attachment(...)` is older package-only path
- `src-tauri/src/commands/email.rs`
  - SMTP config and send path already exist through `lettre` + `keyring`
- `src-tauri/src/lib.rs`
  - command registration

Known issue: `jobs.rs` duplicates mail-composer behavior instead of reusing
Dispatch. Do not extend that duplication.

## Architecture To Implement

Create one shared Rust module for mail intent handling, preferably:

- `src-tauri/src/mail_intent.rs`

Suggested types:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MailIntent {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub attachments: Vec<String>,
    pub tracking_context: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MailIntentResult {
    pub status: String,
    pub eml_path: Option<String>,
    pub folder_path: Option<String>,
    pub message: String,
}
```

Suggested Tauri command:

```rust
#[tauri::command]
pub fn create_email_file(intent: MailIntent) -> Result<MailIntentResult, String>
```

Output folder:

```text
~/Downloads/Skipi/Outbox/
```

File naming:

```text
Skipi_<purpose>_<YYYY-MM-DD_HHMMSS>.eml
```

Keep names filesystem-safe.

## EML Format Requirements

Generate a valid RFC 5322 / MIME message:

- CRLF line endings (`\r\n`)
- `From:` optional or omitted if unknown
- `To:`
- `Subject:`
- `Date:`
- `MIME-Version: 1.0`
- `Content-Type: multipart/mixed; boundary="..."`
- first part: `text/plain; charset=utf-8`
- each attachment:
  - `Content-Type: <mime>; name="<filename>"`
  - `Content-Transfer-Encoding: base64`
  - `Content-Disposition: attachment; filename="<filename>"`

Body must always append footer once:

```text
Sent via Skipi (https://skipi.app)
```

If body already contains this footer, do not duplicate it.

For non-ASCII subject or filenames, implement RFC 2047 encoded-word or keep
the first implementation conservative by generating ASCII-safe filenames and
documenting subject limitations. Prefer implementing encoded-word now because
Skipi users may have Cyrillic names / vessel names.

## Implementation Details

Use existing dependencies if possible. `base64 = "0.22"` is already present in
the current local branch because messaging uses it.

Mime type detection can start with extension mapping:

- `.pdf` -> `application/pdf`
- `.zip` -> `application/zip`
- `.jpg` / `.jpeg` -> `image/jpeg`
- `.png` -> `image/png`
- fallback -> `application/octet-stream`

Do not delete generated `.eml` files automatically. Users may need to reopen
or resend them.

After creating the file:

- try to open the `.eml` itself with OS default opener
- also expose/open the containing folder as fallback
- return `eml_path` and `folder_path` so frontend can show manual actions

Cross-platform open helpers already exist in different modules. Consolidate if
that stays small; otherwise keep a local helper in `mail_intent.rs`.

## Frontend Changes

Jobs Apply:

- Keep existing generation of redacted CV PDF.
- Replace `open_mail_with_attachment(...)` call with `create_email_file(...)`.
- Show clear toast/message:
  - success: `Email file created. Open it in your mail app and send.`
  - include path or add actions if there is an existing result panel pattern.

Dispatch:

- Either route `dispatch_package(...)` through the new mail intent internally,
  or add a new frontend path that prepares attachments then calls
  `create_email_file(...)`.
- Avoid keeping two independent implementations of subject/body/footer.

SMTP:

- Do not remove SMTP.
- If SMTP is configured, current direct send remains the preferred production
  path.
- `.eml` is fallback/manual path.

## Tests / Verification

Minimum local checks:

```bash
cd /home/linux/Developer/skipi-public
node -e '
const fs=require("fs");
const html=fs.readFileSync("dist/index.html","utf8");
const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
new Function(blocks.reduce((a,b)=>a.length>b.length?a:b,""));
console.log("JS syntax OK");
'

cd /home/linux/Developer/skipi-public/src-tauri
cargo check
cargo test
```

Manual smoke test:

1. Open Skipi dev app.
2. Open a seafarer vault.
3. Go to Jobs.
4. Click `Apply via email` on a vacancy with `reply_to`.
5. Verify `.eml` exists under `~/Downloads/Skipi/Outbox/`.
6. Open `.eml` and inspect:
   - To is correct
   - Subject is correct
   - Body includes footer once
   - Redacted CV PDF is attached

Also test Dispatch with a package if time allows.

## Risks / Gotchas

- `.eml` may open as a message viewer instead of an editable draft in some
  clients. This is accepted by the decision. UI must set expectations.
- `mailto:` attachment support should not be treated as reliable.
- AppleScript / Outlook COM / Thunderbird compose can remain optional
  convenience adapters later, but do not make them the core guarantee.
- Keep all user-generated strings escaped/encoded for EML headers.
- Use CRLF line endings. Some clients are strict.
- Do not include full PII in tracking context or filenames.

## Done Criteria

- Shared `.eml` generation command exists.
- Jobs Apply uses it instead of `open_mail_with_attachment`.
- Dispatch has a clear path to use it or is refactored to use it now.
- Footer is centralized.
- Generated `.eml` contains attachments.
- JS syntax and Rust checks pass.

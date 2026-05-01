# Email Delivery Decision

Status: accepted
Date: 2026-04-27

## Decision

Skipi will use a generated `.eml` file as the common cross-platform email
fallback for application and dispatch flows.

The product-level contract is not "open the installed mail client". The
contract is:

1. Build a complete email intent inside Skipi.
2. Save it as a portable MIME `.eml` artifact with subject, body, footer,
   and attachments.
3. Open the file and/or its containing folder for the user.
4. Let the user's email client handle the final send.

## Rationale

There is no reliable single API for opening a compose window with attachments
across Linux, Windows, and macOS.

- `mailto:` is standard, but attachments are not.
- macOS Mail can be automated with AppleScript, but that does not generalize
  to Outlook or third-party clients.
- Windows classic Outlook can be automated through COM, but new Outlook,
  webmail, and non-Outlook clients are different surfaces.
- Linux depends on Thunderbird, `xdg-email`, Flatpak/Snap packaging, and
  desktop environment behavior.

`.eml` is the rational common denominator: it captures the full email in a
standard file format and avoids platform-specific attachment handling.

## Intended Flow

Primary production path:

1. If SMTP is configured, Skipi sends directly.
2. If SMTP is not configured, Skipi generates a `.eml` file.
3. Native compose integrations may exist later as convenience adapters, but
   they are not the core delivery guarantee.

The UI should be explicit:

- "Email file created. Open it in your mail app and send."
- Provide actions for opening the `.eml`, opening its folder, and copying the
  body text.

## Implementation Notes

The shared Rust abstraction should be a mail intent, for example:

```text
MailIntent {
  to[]
  subject
  body
  attachments[]
  tracking_context
}
```

Both Dispatch and Apply should use this shared path. The existing
platform-specific composer code can be kept as optional enhancement or removed
once `.eml` is implemented.

Generated emails must include:

- `text/plain; charset=utf-8`
- `multipart/mixed` when attachments are present
- attachments encoded as base64
- `Content-Disposition: attachment`
- CRLF line endings
- a Skipi footer, e.g. `Sent via Skipi (https://skipi.app)`

## Consequences

This is not a perfect one-click send experience. Some clients open `.eml` as a
message view rather than an editable draft. That tradeoff is acceptable for
MVP because the behavior is predictable and cross-platform.

SMTP remains the path to a fully in-app send experience.

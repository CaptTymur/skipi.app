//! Carried over from the pilot client (skipi-crewing `src-tauri/src/contact.rs` at
//! 4b82cd8, plus `open_with_default_app` from its `lib.rs`), tasks/018.
//!
//! Handing a prepared draft to the operator's own mail client (K2.1).
//!
//! OWNER (739) п.3–4: Crewing never sends mail itself. The draft written on the
//! candidate card is opened in the mail client the operator already uses, and
//! nothing is attached — `mailto:` cannot carry files, and the saved copies of
//! the letter and its attachments already live under `Downloads/Skipi/Crewing`.
//!
//! The platform branches are copied from the Seafarer home
//! (`skipi-public src-tauri/src/commands/jobs.rs:284-365`, checkout
//! `fix/seafarer-step8-contact-fields-20260905`): Linux prefers Thunderbird's
//! native `-compose` CLI (it honours subject and body even under snap, which
//! `xdg-email` does not) and falls back to `xdg-email`; macOS and Windows open a
//! `mailto:` URL.
//!
//! The copy is deliberately NOT literal in one place. In `jobs.rs` the recipient
//! is interpolated into the compose URI with no escaping at all, because there it
//! comes from a Skipi profile. Here it comes from a fact parsed out of a
//! stranger's CV, so the recipient must pass a strict ASCII addr-spec first:
//! `a@b.test%2Cattachment='/etc/passwd'` would otherwise become a SECOND compose
//! field and attach a local file to the operator's draft.

/// RFC 5321 caps a path at 256 octets including the angle brackets.
const RECIPIENT_MAX_LEN: usize = 254;

/// The one accepted recipient shape: a trimmed ASCII addr-spec `local@domain`
/// with a dotted domain. Every character that carries meaning to a compose URI
/// or to a header (`% , ' " < >`, whitespace, CR, LF) is refused outright rather
/// than escaped — a refusal the operator sees beats a draft they cannot audit.
pub(crate) fn checked_recipient(to: &str) -> Result<String, String> {
    let value = to.trim();
    if value.is_empty() || value.len() > RECIPIENT_MAX_LEN {
        return Err("recipient_shape".to_string());
    }
    // A leading `-` is not a cosmetic issue: `xdg-email` reads such an argument
    // as a flag and fails, and the screen would then write "draft opened" for a
    // draft that never opened. `Ok` here means "the client was started", which is
    // already a weaker claim than "the operator saw the draft" — it must at least
    // not be false (Супервайзор, e05a3c4c).
    if value.starts_with('-') {
        return Err("recipient_shape".to_string());
    }
    if value.chars().any(|c| {
        matches!(c, '%' | ',' | '\'' | '"' | '<' | '>' | '\r' | '\n' | '\0')
            || c.is_whitespace()
            || c.is_control()
            || !c.is_ascii()
    }) {
        return Err("recipient_shape".to_string());
    }
    let mut parts = value.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    if parts.next().is_some() || local.is_empty() || domain.is_empty() {
        return Err("recipient_shape".to_string());
    }
    if !local
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err("recipient_shape".to_string());
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return Err("recipient_shape".to_string());
    }
    for label in labels {
        if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("recipient_shape".to_string());
        }
    }
    Ok(value.to_string())
}

/// Thunderbird's compose URI is a comma-separated `key=value` list whose values
/// are wrapped in single quotes, so `'`, `"` and `,` have to be percent-escaped.
/// `%` is escaped FIRST: doing it last would re-escape the `%` of `%27`/`%22`/
/// `%2C` and the client would display the escape sequence instead of the text.
pub(crate) fn compose_escape(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\'', "%27")
        .replace('"', "%22")
        .replace(',', "%2C")
}

/// `to=` is never escaped here — it is already known to be a strict addr-spec
/// (`checked_recipient`), which is exactly why that check is not optional.
pub(crate) fn compose_uri(to: &str, subject: &str, body: &str) -> String {
    format!(
        "to={},subject='{}',body='{}'",
        to,
        compose_escape(subject),
        compose_escape(body)
    )
}

/// Percent-encoding for a `mailto:` URL (copied from `jobs.rs:413 urlencoding`).
pub(crate) fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

pub(crate) fn mailto_url(to: &str, subject: &str, body: &str) -> String {
    format!(
        "mailto:{}?subject={}&body={}",
        percent_encode(to),
        percent_encode(subject),
        percent_encode(body)
    )
}

/// Opens the operator's mail client on a prepared draft. No attachment, no send:
/// the message leaves the machine only when the operator presses send in their
/// own client.
#[tauri::command]
pub fn open_mailto(to: String, subject: String, body: String) -> Result<(), String> {
    let recipient = checked_recipient(&to)?;

    #[cfg(target_os = "linux")]
    {
        let uri = compose_uri(&recipient, &subject, &body);
        if std::process::Command::new("thunderbird")
            .arg("-compose")
            .arg(&uri)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        std::process::Command::new("xdg-email")
            .arg("--utf8")
            .arg("--subject")
            .arg(&subject)
            .arg("--body")
            .arg(&body)
            .arg(&recipient)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(mailto_url(&recipient, &subject, &body))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", "", &mailto_url(&recipient, &subject, &body)])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (&recipient, &subject, &body);
        Err("no_mail_client".to_string())
    }
}

/// Open a saved file in the operator's default application.
pub(crate) fn open_with_default_app(path: &str) -> Result<(), String> {
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let _ = path;

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/C", "start", "", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipient_refuses_everything_that_could_become_a_second_compose_field() {
        // The four negatives named in card D1 (R4): a smuggled `attachment=`
        // field, a quoted local part carrying a comma, a trailing quote, and a
        // CRLF header injection.
        assert!(checked_recipient("a@b.test%2Cattachment=%27/etc/passwd%27").is_err());
        assert!(checked_recipient("\"a,b\"@c.test").is_err());
        assert!(checked_recipient("a@b.test'").is_err());
        assert!(checked_recipient("x@y.test\r\nBcc: z@w.test").is_err());
        // and the shapes that are simply not an address
        assert!(checked_recipient("").is_err());
        assert!(checked_recipient("no-at-sign.test").is_err());
        assert!(checked_recipient("a@b").is_err());
        assert!(checked_recipient("a@b..test").is_err());
        assert!(checked_recipient("a b@c.test").is_err());
        assert!(checked_recipient("два@example.test").is_err());
        assert!(
            checked_recipient("-x@y.test").is_err(),
            "a leading dash reaches xdg-email as a flag"
        );
        assert!(checked_recipient("--attach=/etc/passwd@y.test").is_err());
        assert!(checked_recipient(&format!("{}@example.test", "a".repeat(250))).is_err());
        // the one accepted shape, trimmed
        assert_eq!(
            checked_recipient("  oleh.v+cv@example.co.uk \n").unwrap(),
            "oleh.v+cv@example.co.uk"
        );
    }

    #[test]
    fn compose_escapes_the_percent_first() {
        assert_eq!(compose_escape("total %2C already"), "total %252C already");
        assert_eq!(compose_escape("it's \"x\", y"), "it%27s %22x%22%2C y");
        let uri = compose_uri("a@b.test", "Offer", "body with %2C and 'quote'");
        assert!(uri.starts_with("to=a@b.test,subject='Offer',body='"), "{uri}");
        assert!(uri.contains("body with %252C and %27quote%27"), "{uri}");
        assert!(!uri.contains("attachment="), "{uri}");
    }

    #[test]
    fn mailto_url_percent_encodes_all_three_parts() {
        let url = mailto_url("a@b.test", "Offer, now", "line one\nline two & more");
        assert_eq!(
            url,
            "mailto:a%40b.test?subject=Offer%2C%20now&body=line%20one%0Aline%20two%20%26%20more"
        );
        assert!(!url.contains('\n'));
    }
}

//! `.eml` mail-intent generation — cross-platform deterministic Apply fallback.
//!
//! Per `EMAIL_DELIVERY_DECISION.md` and PM audit (2026-04-28): when SMTP is
//! not configured and E2E is unavailable, write a fully-formed `.eml` file
//! into `~/Downloads/Skipi/Outbox/` and hand it to the OS opener. Users
//! land in their mail client with a draft they can review and send.
//!
//! `mailto:` is intentionally NOT used — attachments don't survive across
//! mail clients on Linux/macOS/Windows.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct MailIntent {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailIntentResult {
    pub status: String,
    pub eml_path: String,
    pub folder_path: String,
    pub message: String,
}

const FOOTER: &str = "Sent via Skipi (https://skipi.app)";

fn outbox_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Downloads").join("Skipi").join("Outbox")
}

/// Map common file extensions to MIME types. Falls back to
/// `application/octet-stream` for unknown extensions — receivers will still
/// open the attachment, just without a preview hint.
fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("txt") => "text/plain",
        Some("csv") => "text/csv",
        Some("eml") => "message/rfc822",
        _ => "application/octet-stream",
    }
}

/// RFC 2047 encoded-word for headers containing non-ASCII — Cyrillic vessel
/// names and seafarer surnames are common.
fn encode_header(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    format!("=?UTF-8?B?{}?=", b64)
}

/// Filesystem-safe filename slug.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn rfc2822_date_now() -> String {
    // Use chrono via tauri's existing transitive dep if available; otherwise
    // hand-format from SystemTime. The SMTP module already pulls chrono.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0)
        .map(|dt| dt.format("%a, %d %b %Y %H:%M:%S +0000").to_string())
        .unwrap_or_else(|| "Mon, 01 Jan 2026 00:00:00 +0000".to_string())
}

fn build_eml(intent: &MailIntent) -> Result<String, String> {
    let boundary = format!(
        "=_skipi_{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let mut body_with_footer = intent.body.clone();
    if !body_with_footer.contains(FOOTER) {
        if !body_with_footer.is_empty() && !body_with_footer.ends_with('\n') {
            body_with_footer.push('\n');
        }
        body_with_footer.push('\n');
        body_with_footer.push_str(FOOTER);
        body_with_footer.push('\n');
    }
    // Normalize to CRLF for MIME compliance.
    let body_crlf = body_with_footer.replace("\r\n", "\n").replace('\n', "\r\n");

    let to_header = intent.to.join(", ");
    let mut out = String::new();
    out.push_str(&format!("To: {}\r\n", to_header));
    out.push_str(&format!("Subject: {}\r\n", encode_header(&intent.subject)));
    out.push_str(&format!("Date: {}\r\n", rfc2822_date_now()));
    out.push_str("MIME-Version: 1.0\r\n");
    out.push_str(&format!(
        "Content-Type: multipart/mixed; boundary=\"{}\"\r\n",
        boundary
    ));
    out.push_str("\r\n");
    out.push_str("This is a multi-part message in MIME format.\r\n");

    // Text/plain part.
    out.push_str(&format!("--{}\r\n", boundary));
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n");
    out.push_str("\r\n");
    out.push_str(&body_crlf);
    out.push_str("\r\n");

    // Attachment parts.
    for path_str in &intent.attachments {
        let path = Path::new(path_str);
        if !path.exists() {
            return Err(format!("attachment not found: {}", path_str));
        }
        let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path_str, e))?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment.bin");
        let mime = guess_mime(path);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        out.push_str(&format!("--{}\r\n", boundary));
        out.push_str(&format!(
            "Content-Type: {}; name=\"{}\"\r\n",
            mime,
            encode_header(filename)
        ));
        out.push_str("Content-Transfer-Encoding: base64\r\n");
        out.push_str(&format!(
            "Content-Disposition: attachment; filename=\"{}\"\r\n",
            encode_header(filename)
        ));
        out.push_str("\r\n");
        // Wrap base64 to 76-char lines per RFC 2045.
        for chunk in b64.as_bytes().chunks(76) {
            out.push_str(std::str::from_utf8(chunk).unwrap());
            out.push_str("\r\n");
        }
    }

    out.push_str(&format!("--{}--\r\n", boundary));
    Ok(out)
}

fn open_path(path: &Path) {
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}

#[tauri::command]
pub fn create_email_file(intent: MailIntent) -> Result<MailIntentResult, String> {
    if intent.to.is_empty() {
        return Err("at least one recipient required".into());
    }
    let dir = outbox_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create outbox: {}", e))?;

    let eml = build_eml(&intent)?;

    let purpose = intent
        .purpose
        .as_deref()
        .map(slugify)
        .unwrap_or_else(|| "apply".to_string());
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let fname = format!("Skipi_{}_{}.eml", purpose, stamp);
    let eml_path = dir.join(&fname);

    fs::write(&eml_path, eml).map_err(|e| format!("write {}: {}", eml_path.display(), e))?;

    // Try to open the .eml itself; if the OS has no handler the user can find
    // it via the folder path. Fire and forget — we never want this to block.
    open_path(&eml_path);

    Ok(MailIntentResult {
        status: "ok".into(),
        eml_path: eml_path.to_string_lossy().to_string(),
        folder_path: dir.to_string_lossy().to_string(),
        message: format!("Email file created: {}", fname),
    })
}

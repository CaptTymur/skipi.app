//! SMTP-based outgoing mail for Skipi.
//!
//! This module replaces the fragile "open the user's mail client with
//! attachments" dance — see packages::dispatch_package for the legacy
//! Thunderbird/AppleScript/xdg-email path — with direct SMTP sending.
//!
//! ## Storage
//! - Non-secret fields (email, display name, SMTP host, port, encryption
//!   mode) live in a plain JSON file at `~/.config/skipi/smtp.json`.
//! - The password is stored in the OS credential store via the `keyring`
//!   crate: gnome-keyring / kwallet on Linux, Keychain on macOS,
//!   Credential Manager on Windows. Service id: `skipi.app`. Account: the
//!   configured email address.
//!
//! ## Provider autodetect
//! `suggest_smtp_from_email` returns sensible defaults for common
//! providers (gmail, icloud, yahoo, outlook, yandex, mail.ru) so most
//! seafarers only need to fill in email + App Password.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};

const KEYRING_SERVICE: &str = "skipi.app";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfig {
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub host: String,
    pub port: u16,
    /// "tls" (SMTPS, implicit TLS on connect, typically port 465)
    /// "starttls" (plain, upgrade via STARTTLS, typically port 587)
    /// "none" (plain — test only, we never recommend this)
    pub encryption: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfigPublic {
    pub email: String,
    pub display_name: Option<String>,
    pub host: String,
    pub port: u16,
    pub encryption: String,
    /// True when a password was found in the OS credential store for this
    /// account. Lets the frontend show a "password saved" indicator
    /// without ever reading the secret.
    pub has_password: bool,
}

fn config_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "Cannot locate user config directory".to_string())?
        .join("skipi");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("smtp.json"))
}

fn load_config_file() -> Option<SmtpConfig> {
    let path = config_path().ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_config_file(cfg: &SmtpConfig) -> Result<(), String> {
    let path = config_path()?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(())
}

fn keyring_entry(email: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, email).map_err(|e| format!("keyring: {}", e))
}

fn load_password(email: &str) -> Option<String> {
    let entry = keyring_entry(email).ok()?;
    entry.get_password().ok()
}

// ========== Tauri commands =================================================

/// Best-effort guess of SMTP settings for common email providers. The
/// frontend uses this to prefill host/port/encryption when the user types
/// their email so most setups require no manual config.
#[tauri::command]
pub fn suggest_smtp_from_email(email: String) -> serde_json::Value {
    let domain = email
        .rsplit_once('@')
        .map(|(_, d)| d.to_ascii_lowercase())
        .unwrap_or_default();

    let (host, port, encryption, provider) = match domain.as_str() {
        "gmail.com" | "googlemail.com" => (
            "smtp.gmail.com",
            465u16,
            "tls",
            "Gmail — requires an App Password (not your main password). Create one at myaccount.google.com/apppasswords.",
        ),
        "icloud.com" | "me.com" | "mac.com" => (
            "smtp.mail.me.com",
            587u16,
            "starttls",
            "iCloud Mail — requires an App-Specific Password from appleid.apple.com.",
        ),
        "yahoo.com" | "ymail.com" => (
            "smtp.mail.yahoo.com",
            465u16,
            "tls",
            "Yahoo Mail — requires an App Password.",
        ),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => (
            "smtp.office365.com",
            587u16,
            "starttls",
            "Outlook / Hotmail — your normal account password usually works, unless 2FA is on (then App Password).",
        ),
        "yandex.ru" | "yandex.com" => (
            "smtp.yandex.ru",
            465u16,
            "tls",
            "Yandex Mail — enable IMAP access and use an App Password.",
        ),
        "mail.ru" | "bk.ru" | "inbox.ru" | "list.ru" => (
            "smtp.mail.ru",
            465u16,
            "tls",
            "Mail.ru — requires an External App Password from account.mail.ru/user/2-step-auth/passwords.",
        ),
        "ukr.net" => ("smtp.ukr.net", 465, "tls", "Ukr.net"),
        _ => {
            // Generic fallback: guess mail.<domain> on 587 STARTTLS. User can edit.
            let guessed = if !domain.is_empty() {
                format!("mail.{}", domain)
            } else {
                String::new()
            };
            return serde_json::json!({
                "host": guessed,
                "port": 587,
                "encryption": "starttls",
                "provider": "",
            });
        }
    };

    serde_json::json!({
        "host": host,
        "port": port,
        "encryption": encryption,
        "provider": provider,
    })
}

#[tauri::command]
pub fn get_smtp_config() -> Option<SmtpConfigPublic> {
    let cfg = load_config_file()?;
    let has_pw = load_password(&cfg.email).is_some();
    Some(SmtpConfigPublic {
        email: cfg.email,
        display_name: cfg.display_name,
        host: cfg.host,
        port: cfg.port,
        encryption: cfg.encryption,
        has_password: has_pw,
    })
}

#[tauri::command]
pub fn save_smtp_config(
    email: String,
    display_name: Option<String>,
    host: String,
    port: u16,
    encryption: String,
    password: Option<String>,
) -> Result<(), String> {
    if email.trim().is_empty() {
        return Err("Email is required".to_string());
    }
    if host.trim().is_empty() {
        return Err("SMTP host is required".to_string());
    }

    // If the email changed, drop the old password from the keyring to
    // avoid leaving orphan entries.
    if let Some(prev) = load_config_file() {
        if prev.email != email {
            if let Ok(entry) = keyring_entry(&prev.email) {
                let _ = entry.delete_credential();
            }
        }
    }

    let cfg = SmtpConfig {
        email: email.clone(),
        display_name: display_name.filter(|s| !s.trim().is_empty()),
        host,
        port,
        encryption,
    };
    save_config_file(&cfg)?;

    // Only touch the keyring when the user actually supplied a password
    // (empty/None means "keep the existing one"). Lets the user edit
    // host/port without re-typing the password every time.
    if let Some(pw) = password {
        if !pw.is_empty() {
            let entry = keyring_entry(&email)?;
            entry
                .set_password(&pw)
                .map_err(|e| format!("Could not store password in OS keychain: {}", e))?;
        }
    }

    Ok(())
}

/// Wipe both the config file and the keyring entry. Useful if the user
/// wants to log out or change accounts cleanly.
#[tauri::command]
pub fn clear_smtp_config() -> Result<(), String> {
    if let Some(prev) = load_config_file() {
        if let Ok(entry) = keyring_entry(&prev.email) {
            let _ = entry.delete_credential();
        }
    }
    let path = config_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_transport(cfg: &SmtpConfig, password: &str) -> Result<SmtpTransport, String> {
    let creds = Credentials::new(cfg.email.clone(), password.to_string());
    let builder = match cfg.encryption.as_str() {
        "tls" => SmtpTransport::relay(&cfg.host)
            .map_err(|e| format!("relay: {}", e))?
            .port(cfg.port),
        "starttls" => {
            let tls = TlsParameters::new(cfg.host.clone()).map_err(|e| format!("tls: {}", e))?;
            SmtpTransport::builder_dangerous(&cfg.host)
                .port(cfg.port)
                .tls(Tls::Required(tls))
        }
        _ => SmtpTransport::builder_dangerous(&cfg.host).port(cfg.port),
    };
    Ok(builder
        .timeout(Some(Duration::from_secs(20)))
        .credentials(creds)
        .build())
}

/// Attempt to connect + authenticate against the configured SMTP server
/// without actually sending a message. Called from the "Test" button in
/// Settings → Email sending. Gives the user precise feedback on whether
/// credentials / host / encryption are correct.
#[tauri::command]
pub fn test_smtp_connection(
    email: String,
    host: String,
    port: u16,
    encryption: String,
    password: Option<String>,
) -> Result<String, String> {
    // Allow testing the stored password without re-typing it — empty /
    // missing `password` falls back to the keyring entry.
    let pw = match password {
        Some(p) if !p.is_empty() => p,
        _ => load_password(&email).ok_or_else(|| {
            "No password provided and nothing stored in keychain — type one first.".to_string()
        })?,
    };
    let cfg = SmtpConfig {
        email,
        display_name: None,
        host,
        port,
        encryption,
    };
    let transport = build_transport(&cfg, &pw)?;
    transport
        .test_connection()
        .map_err(|e| format!("SMTP test failed: {}", e))?;
    Ok("SMTP connection OK — credentials accepted.".to_string())
}

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub recipients: Vec<String>,
    pub subject: String,
    pub body: String,
    /// Absolute paths to files that should be attached. Empty list is OK.
    #[serde(default)]
    pub attachments: Vec<String>,
}

fn parse_mailbox(addr: &str, display_name: Option<&str>) -> Result<Mailbox, String> {
    let parsed: lettre::Address = addr
        .trim()
        .parse()
        .map_err(|e| format!("Invalid address '{}': {}", addr, e))?;
    Ok(match display_name {
        Some(n) if !n.trim().is_empty() => Mailbox::new(Some(n.to_string()), parsed),
        _ => Mailbox::new(None, parsed),
    })
}

fn attach_file(path: &Path) -> Result<SinglePart, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let mime_str = match ext.as_str() {
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "txt" => "text/plain",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    };
    let ct: ContentType = mime_str
        .parse()
        .map_err(|e| format!("mime {}: {}", mime_str, e))?;
    let body = Body::new(bytes);
    Ok(Attachment::new(file_name).body(body, ct))
}

/// Send an email via the configured SMTP account. Errors are surfaced
/// verbatim so the frontend can show them in a toast.
#[tauri::command]
pub fn send_email_smtp(req: SendEmailRequest) -> Result<String, String> {
    if req.recipients.is_empty() {
        return Err("At least one recipient is required".to_string());
    }
    let cfg = load_config_file().ok_or_else(|| {
        "SMTP is not configured. Open Settings → Email sending first.".to_string()
    })?;
    let password = load_password(&cfg.email).ok_or_else(|| {
        "SMTP password not found in the OS keychain. Re-save it in Settings → Email sending."
            .to_string()
    })?;

    let from = parse_mailbox(&cfg.email, cfg.display_name.as_deref())?;
    let mut builder = Message::builder().from(from).subject(&req.subject);
    for to in &req.recipients {
        builder = builder.to(parse_mailbox(to, None)?);
    }

    // Build multipart/mixed body so text and attachments coexist cleanly.
    let mut multipart = MultiPart::mixed().singlepart(
        SinglePart::builder()
            .header(ContentType::TEXT_PLAIN)
            .body(req.body.clone()),
    );
    for att_path in &req.attachments {
        let path = Path::new(att_path);
        if !path.exists() {
            return Err(format!("Attachment missing on disk: {}", att_path));
        }
        let part = attach_file(path)?;
        multipart = multipart.singlepart(part);
    }

    let email = builder
        .multipart(multipart)
        .map_err(|e| format!("Build email: {}", e))?;

    let transport = build_transport(&cfg, &password)?;
    transport
        .send(&email)
        .map_err(|e| format!("SMTP send failed: {}", e))?;

    Ok(format!(
        "Email sent to {} recipient(s) with {} attachment(s).",
        req.recipients.len(),
        req.attachments.len()
    ))
}

//! The «Фрахтование» profile: the home's side of the module `@skipi/chartering`.
//!
//! Owner, 27.11.2026 (case 280, tasks/031): an account of the chartering type signs in to
//! Skipi and works in the chartering module; its records live with the Skipi account on
//! assistant.skipi.app (`webapp/chartering.py`, paths `/api/app/chartering/…`), per the
//! module's `CONTRACT.md` v0.5. The module never goes to the network and never holds the
//! account token: these commands take it from the app's own session.
//!
//! A record's number travels inside `body.id`, as the module sends it: no `id` → `POST`
//! (a new record), an `id` → `PATCH` of that record.

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::commands::plugin_reviews::{run, session_token, Call};
use crate::AppState;

/// The kinds of the generic store (`items/<kind>`); anything else never reaches a URL.
const KINDS: [&str; 11] = [
    "ships", "contacts", "ports", "orders", "docs", "voyages", "calcs", "filters", "mails",
    "rates", "settings",
];

const BASE: &str = "/api/app/chartering";

fn token_or_err(state: &State<'_, AppState>) -> Result<String, String> {
    session_token(state).ok_or_else(|| "sign_in".to_string())
}

fn kind_or_err(kind: &str) -> Result<&str, String> {
    if KINDS.contains(&kind) {
        Ok(kind)
    } else {
        Err("bad_item".to_string())
    }
}

/// Splits what the module sent into the record's number (if any) and the fields.
/// A body that is not an object, or an `id` that is not a positive number, is refused.
fn split_id(body: Value) -> Result<(Option<u64>, Value), String> {
    let Value::Object(mut fields) = body else {
        return Err("failed".to_string());
    };
    let id = match fields.remove("id") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(n.as_u64().filter(|n| *n > 0).ok_or("not_found")?),
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s.parse::<u64>().ok().filter(|n| *n > 0).ok_or("not_found")?),
        Some(_) => return Err("not_found".to_string()),
    };
    Ok((id, Value::Object(fields)))
}

/// `POST <collection>` for a new record, `PATCH <collection>/<id>` for an existing one.
async fn save(state: State<'_, AppState>, collection: String, body: Value) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    let (id, fields) = split_id(body)?;
    match id {
        None => run(collection, Call::Post(fields), Some(token)).await,
        Some(id) => run(format!("{}/{}", collection, id), Call::Patch(fields), Some(token)).await,
    }
}

/// `{cargoes: [cargo]}` — newest first, archived ones included.
#[tauri::command]
pub async fn chartering_cargoes(state: State<'_, AppState>) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(format!("{}/cargoes", BASE), Call::Get, Some(token)).await
}

/// `{cargo, pairs}`.
#[tauri::command]
pub async fn chartering_cargo(state: State<'_, AppState>, cargo_id: u64) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(format!("{}/cargoes/{}", BASE, cargo_id), Call::Get, Some(token)).await
}

#[tauri::command]
pub async fn chartering_cargo_save(state: State<'_, AppState>, body: Value) -> Result<Value, String> {
    save(state, format!("{}/cargoes", BASE), body).await
}

/// Removes the cargo together with its ships.
#[tauri::command]
pub async fn chartering_cargo_remove(state: State<'_, AppState>, cargo_id: u64) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(format!("{}/cargoes/{}", BASE, cargo_id), Call::Delete, Some(token)).await
}

/// A ship under a cargo; `requested: true` makes the server stamp the request date.
#[tauri::command]
pub async fn chartering_pair_save(
    state: State<'_, AppState>,
    cargo_id: u64,
    body: Value,
) -> Result<Value, String> {
    save(state, format!("{}/cargoes/{}/pairs", BASE, cargo_id), body).await
}

#[tauri::command]
pub async fn chartering_pair_remove(
    state: State<'_, AppState>,
    cargo_id: u64,
    pair_id: u64,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        format!("{}/cargoes/{}/pairs/{}", BASE, cargo_id, pair_id),
        Call::Delete,
        Some(token),
    )
    .await
}

/// A step of the negotiation on a pair (quotation, counter, firm, subjects, …).
#[tauri::command]
pub async fn chartering_event_add(
    state: State<'_, AppState>,
    cargo_id: u64,
    pair_id: u64,
    event: Value,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(
        format!("{}/cargoes/{}/pairs/{}/events", BASE, cargo_id, pair_id),
        Call::Post(event),
        Some(token),
    )
    .await
}

/// `{positions: [position]}` — newest first.
#[tauri::command]
pub async fn chartering_positions(state: State<'_, AppState>) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(format!("{}/positions", BASE), Call::Get, Some(token)).await
}

#[tauri::command]
pub async fn chartering_position_save(state: State<'_, AppState>, body: Value) -> Result<Value, String> {
    save(state, format!("{}/positions", BASE), body).await
}

#[tauri::command]
pub async fn chartering_position_remove(
    state: State<'_, AppState>,
    position_id: u64,
) -> Result<Value, String> {
    let token = token_or_err(&state)?;
    run(format!("{}/positions/{}", BASE, position_id), Call::Delete, Some(token)).await
}

/// `{items: [record]}` of one kind of the account's store — newest first.
#[tauri::command]
pub async fn chartering_items(state: State<'_, AppState>, kind: String) -> Result<Value, String> {
    let kind = kind_or_err(&kind)?.to_string();
    let token = token_or_err(&state)?;
    run(format!("{}/items/{}", BASE, kind), Call::Get, Some(token)).await
}

#[tauri::command]
pub async fn chartering_item_save(
    state: State<'_, AppState>,
    kind: String,
    body: Value,
) -> Result<Value, String> {
    let kind = kind_or_err(&kind)?.to_string();
    save(state, format!("{}/items/{}", BASE, kind), body).await
}

#[tauri::command]
pub async fn chartering_item_remove(
    state: State<'_, AppState>,
    kind: String,
    item_id: u64,
) -> Result<Value, String> {
    let kind = kind_or_err(&kind)?.to_string();
    let token = token_or_err(&state)?;
    run(format!("{}/items/{}/{}", BASE, kind, item_id), Call::Delete, Some(token)).await
}

// ---- the letter: a draft in the user's mail program --------------------------------

/// What the module hands to `deps.openMail`. Addresses are one line each, separated by
/// commas or semicolons, as the user typed them.
#[derive(Debug, Clone, Deserialize)]
pub struct MailDraft {
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
}

/// The addresses of one header: split on `,` / `;`, nothing that could start a new header.
fn addresses(line: &str) -> Vec<String> {
    line.split([',', ';'])
        .map(|a| a.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// RFC 2047 encoded-word for a subject with non-ASCII text; never more than one line.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
fn header_text(text: &str) -> String {
    use base64::Engine;
    let line: String = text.chars().filter(|c| !c.is_control()).collect();
    if line.is_ascii() {
        line
    } else {
        format!(
            "=?UTF-8?B?{}?=",
            base64::engine::general_purpose::STANDARD.encode(line.as_bytes())
        )
    }
}

/// The letter as an unsent `.eml`: the text exactly as the module composed it, with
/// To / Cc / Bcc. `X-Unsent: 1` makes mail programs that know it open it for editing.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
fn draft_eml(mail: &MailDraft) -> Result<String, String> {
    let to = addresses(&mail.to);
    if to.is_empty() {
        return Err("no_mail".to_string());
    }
    let mut out = String::from("X-Unsent: 1\r\n");
    out.push_str(&format!("To: {}\r\n", to.join(", ")));
    for (name, line) in [("Cc", &mail.cc), ("Bcc", &mail.bcc)] {
        let list = addresses(line);
        if !list.is_empty() {
            out.push_str(&format!("{}: {}\r\n", name, list.join(", ")));
        }
    }
    out.push_str(&format!("Subject: {}\r\n", header_text(&mail.subject)));
    out.push_str("MIME-Version: 1.0\r\n");
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
    out.push_str(&mail.body.replace("\r\n", "\n").replace('\n', "\r\n"));
    out.push_str("\r\n");
    Ok(out)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_draft(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let started = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let started = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", ""])
            .arg(path)
            .spawn()
    };
    #[cfg(target_os = "linux")]
    let started = std::process::Command::new("xdg-open").arg(path).spawn();
    started.map(|_| ()).map_err(|_| "no_mail".to_string())
}

/// Writes the letter as a draft file into `Downloads/Skipi/Outbox` and opens it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_and_open_draft(mail: &MailDraft) -> Result<(), String> {
    let eml = draft_eml(mail)?;
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "no_mail".to_string())?;
    let dir = home.join("Downloads").join("Skipi").join("Outbox");
    std::fs::create_dir_all(&dir).map_err(|_| "no_mail".to_string())?;
    let name = format!(
        "Skipi_chartering_{}.eml",
        chrono::Local::now().format("%Y-%m-%d_%H%M%S")
    );
    let path = dir.join(name);
    std::fs::write(&path, eml).map_err(|_| "no_mail".to_string())?;
    open_draft(&path)
}

/// Percent-encoding for a `mailto:` link: everything but RFC 3986 unreserved characters.
fn encoded(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// The letter as a `mailto:` link with to, copy, blind copy, subject and text.
fn mailto_link(mail: &MailDraft) -> Result<String, String> {
    let list = |line: &str| addresses(line).iter().map(|a| encoded(a)).collect::<Vec<_>>().join(",");
    let to = list(&mail.to);
    if to.is_empty() {
        return Err("no_mail".to_string());
    }
    let mut query = Vec::new();
    for (name, line) in [("cc", &mail.cc), ("bcc", &mail.bcc)] {
        let addresses = list(line);
        if !addresses.is_empty() {
            query.push(format!("{}={}", name, addresses));
        }
    }
    let subject: String = mail.subject.chars().filter(|c| !c.is_control()).collect();
    query.push(format!("subject={}", encoded(&subject)));
    query.push(format!(
        "body={}",
        encoded(&mail.body.replace("\r\n", "\n").replace('\n', "\r\n"))
    ));
    Ok(format!("mailto:{}?{}", to, query.join("&")))
}

/// A link longer than this is not reliably handed over to a mail program on a computer
/// (Windows cuts a command line near 2000 characters); such a letter goes as a draft file.
const MAILTO_MAX: usize = 1800;

/// `deps.openMail` of the module: opens the letter as a draft in the user's own mail
/// program — a `mailto:` link, or, on a computer, an `.eml` file when the letter is too
/// long for a link. Skipi sends nothing itself. Refusal: `no_mail`.
#[tauri::command]
pub fn chartering_open_mail(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    mail: MailDraft,
) -> Result<(), String> {
    let link = mailto_link(&mail)?;
    #[cfg(target_os = "android")]
    {
        let _ = app;
        crate::commands::vault::open_external_url(window, link).map_err(|_| "no_mail".to_string())
    }
    #[cfg(target_os = "ios")]
    {
        let _ = window;
        crate::commands::vault::open_external_url(app, link).map_err(|_| "no_mail".to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (window, app);
        if link.len() > MAILTO_MAX {
            return write_and_open_draft(&mail);
        }
        crate::commands::vault::open_external_url(link).map_err(|_| "no_mail".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_link_carries_every_addressee_and_the_text() {
        let link = mailto_link(&MailDraft {
            to: "ops@owner.test; desk@owner.test".into(),
            cc: "boss@montline.test".into(),
            bcc: String::new(),
            subject: "MV TRADER & wheat".into(),
            body: "Dear Sirs,\nPls quote 100% + terms.".into(),
        })
        .unwrap();
        assert_eq!(link, "mailto:ops%40owner.test,desk%40owner.test?cc=boss%40montline.test&subject=MV%20TRADER%20%26%20wheat&body=Dear%20Sirs%2C%0D%0APls%20quote%20100%25%20%2B%20terms.");
        assert!(link.starts_with("mailto:"));
        let blind = mailto_link(&MailDraft { to: "a@b.test".into(), cc: String::new(), bcc: "x@y.test, z@y.test".into(), subject: "Привет".into(), body: String::new() }).unwrap();
        assert_eq!(blind, "mailto:a%40b.test?bcc=x%40y.test,z%40y.test&subject=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&body=");
        let nobody = MailDraft { to: " , ".into(), cc: String::new(), bcc: String::new(), subject: String::new(), body: String::new() };
        assert_eq!(mailto_link(&nobody), Err("no_mail".to_string()));
    }

    #[test]
    fn only_a_known_kind_reaches_a_url() {
        for ok in KINDS {
            assert_eq!(kind_or_err(ok), Ok(ok));
        }
        for bad in ["", "passwords", "ships/1", "../cargoes", "Ships", "ships?x=1"] {
            assert_eq!(kind_or_err(bad), Err("bad_item".to_string()), "{bad}");
        }
    }

    #[test]
    fn a_body_without_a_number_is_new_and_with_one_is_a_change() {
        let (id, fields) = split_id(json!({ "cargo_name": "Wheat" })).unwrap();
        assert_eq!((id, fields), (None, json!({ "cargo_name": "Wheat" })));
        let (id, fields) = split_id(json!({ "id": 7, "note": "x" })).unwrap();
        assert_eq!((id, fields), (Some(7), json!({ "note": "x" })));
        assert_eq!(split_id(json!({ "id": "12" })).unwrap().0, Some(12));
        assert_eq!(split_id(json!({ "id": null, "name": "a" })).unwrap().0, None);
        for bad in [json!({ "id": 0 }), json!({ "id": -3 }), json!({ "id": "7/../8" }), json!({ "id": [7] }), json!({ "id": 1.5 })] {
            assert_eq!(split_id(bad.clone()), Err("not_found".to_string()), "{bad}");
        }
        assert_eq!(split_id(json!(["Wheat"])), Err("failed".to_string()));
    }

    #[test]
    fn the_draft_keeps_the_letter_and_carries_copy_and_blind_copy() {
        let eml = draft_eml(&MailDraft {
            to: "ops@owner.test; desk@owner.test".into(),
            cc: "boss@montline.test".into(),
            bcc: " archive@montline.test ,".into(),
            subject: "MV TRADER / 6,800 mt wheat Constanta–Alexandria".into(),
            body: "Dear Sirs,\n\nPls quote.\n".into(),
        })
        .unwrap();
        assert!(eml.starts_with("X-Unsent: 1\r\nTo: ops@owner.test, desk@owner.test\r\nCc: boss@montline.test\r\nBcc: archive@montline.test\r\nSubject: =?UTF-8?B?"));
        assert!(eml.ends_with("\r\n\r\nDear Sirs,\r\n\r\nPls quote.\r\n\r\n"));
        assert!(!eml.contains("Sent via Skipi"), "the letter is the user's own, nothing is appended");
    }

    #[test]
    fn a_header_cannot_be_smuggled_in_and_a_letter_needs_an_addressee() {
        let eml = draft_eml(&MailDraft {
            to: "ops@owner.test\r\nBcc: thief@evil.test".into(),
            cc: String::new(),
            bcc: String::new(),
            subject: "Hello\r\nBcc: thief@evil.test".into(),
            body: "text".into(),
        })
        .unwrap();
        assert_eq!(eml.matches("\r\nBcc:").count(), 0);
        assert!(!eml.contains("\r\nCc:"));
        let empty = MailDraft { to: " ; ".into(), cc: String::new(), bcc: String::new(), subject: String::new(), body: String::new() };
        assert_eq!(draft_eml(&empty), Err("no_mail".to_string()));
    }
}

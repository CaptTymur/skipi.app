use crate::cv;
use crate::db;
use crate::AppState;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

fn normalize_mail_body(body: &str) -> String {
    // Some mail-client bridges treat `\n` as literal text if the body has
    // passed through an escaping layer. Repair only obvious escaped multiline
    // drafts; otherwise preserve user text verbatim.
    let escaped_lines = body.matches("\\n").count() + body.matches("\\r\\n").count();
    let repaired = if !body.contains('\n') && escaped_lines >= 2 {
        body.replace("\\r\\n", "\n").replace("\\n", "\n")
    } else {
        body.to_string()
    };
    repaired.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(target_os = "windows")]
fn ps_utf8_string_expr(s: &str) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    format!(
        "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{}'))",
        b64
    )
}

#[cfg(target_os = "macos")]
fn applescript_string_expr(s: &str) -> String {
    let normalized = normalize_mail_body(s);
    let mut parts: Vec<String> = Vec::new();
    for (idx, line) in normalized.split('\n').enumerate() {
        if idx > 0 {
            parts.push("linefeed".to_string());
        }
        parts.push(format!(
            "\"{}\"",
            line.replace('\\', "\\\\").replace('"', "\\\"")
        ));
    }
    if parts.is_empty() {
        "\"\"".to_string()
    } else {
        parts.join(" & ")
    }
}

/// Copies a source file into `~/Downloads/Skipi/` under a sanitised,
/// timestamp-prefixed name. We do this before invoking `xdg-email` on Linux
/// because:
///   1. Thunderbird (especially the snap build) can fail to attach paths
///      that contain spaces / non-ASCII / characters that collide with the
///      `xdg-email` `--attach` multiplexing format.
///   2. Vault folders often live under `~/Documents/My Vault/…` with spaces
///      in the path — attachments silently vanish, leaving the user with a
///      subject + body but no files.
/// Returns the absolute path of the staged copy (always safe ASCII).
/// Escape a value for Thunderbird's `-compose` single-argument syntax.
/// Thunderbird parses `key=value,key=value,...` so any literal comma in the
/// value must be wrapped in single quotes. Single quotes are doubled to
/// escape them inside the quoted region.
#[cfg(target_os = "linux")]
fn tb_compose_escape(v: &str) -> String {
    let needs_quote = v.contains(',') || v.contains('\'');
    if needs_quote {
        format!("'{}'", v.replace('\'', "''"))
    } else {
        v.to_string()
    }
}

/// Launch Thunderbird with a pre-filled compose window. Returns Err if
/// Thunderbird isn't on PATH or the spawn fails, so the caller can fall
/// back to `xdg-email`.
/// Spawn Thunderbird's compose window on Windows with attachments. Tries
/// `thunderbird` on PATH first (the installer usually registers it), then
/// the two default install locations. Returns `Err` if none of them launch.
#[cfg(target_os = "windows")]
fn spawn_thunderbird_compose_win(
    to: &str,
    subject: &str,
    body: &str,
    attachments: &[String],
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    fn escape(v: &str) -> String {
        let needs_quote = v.contains(',') || v.contains('\'') || v.contains(' ');
        if needs_quote {
            format!("'{}'", v.replace('\'', "''"))
        } else {
            v.to_string()
        }
    }

    let uri_list: String = attachments
        .iter()
        .map(|p| format!("file:///{}", p.replace('\\', "/")))
        .collect::<Vec<_>>()
        .join(",");

    let compose = format!(
        "to={},subject={},body={}{}",
        escape(to),
        escape(subject),
        escape(body),
        if uri_list.is_empty() {
            String::new()
        } else {
            format!(",attachment={}", escape(&uri_list))
        },
    );

    // Try PATH first, then common install locations. `thunderbird` may be
    // registered as an App Path alias, in which case the bare name works.
    let candidates: [&str; 3] = [
        "thunderbird",
        r"C:\Program Files\Mozilla Thunderbird\thunderbird.exe",
        r"C:\Program Files (x86)\Mozilla Thunderbird\thunderbird.exe",
    ];

    for exe in candidates.iter() {
        if let Ok(_child) = std::process::Command::new(exe)
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-osint", "-compose"])
            .arg(&compose)
            .spawn()
        {
            return Ok(());
        }
    }
    Err("Thunderbird not found on PATH or in default install locations".to_string())
}

/// Classify a mail-client display name into one of the known integration
/// buckets. `outlook` and `thunderbird` have first-class support (COM / CLI
/// with attachments); everything else falls back to a `mailto:` URI.
#[cfg(target_os = "windows")]
fn classify_mail_client_id(name: &str) -> &'static str {
    let lc = name.to_lowercase();
    if lc.contains("outlook") {
        "outlook"
    } else if lc.contains("thunderbird") {
        "thunderbird"
    } else {
        "mailto"
    }
}

#[cfg(target_os = "windows")]
fn list_mail_clients_win() -> Vec<serde_json::Value> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Each subkey under HKLM\Software\Clients\Mail is one registered client.
    // Installers (Outlook, Thunderbird, eM Client, Mailspring, etc.) add
    // themselves here; Windows itself registers "Windows Mail" on older
    // builds.
    let ps_script =
        "Get-ChildItem 'HKLM:\\Software\\Clients\\Mail' -ErrorAction SilentlyContinue | \
                     ForEach-Object { $_.PSChildName }";

    let output = std::process::Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .output();

    let mut clients: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(out) = output {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                let name = line.trim();
                if name.is_empty() {
                    continue;
                }
                if !seen.insert(name.to_lowercase()) {
                    continue;
                }
                let id = classify_mail_client_id(name);
                clients.push(serde_json::json!({
                    "id": id,
                    "name": name,
                }));
            }
        }
    }
    clients
}

/// List mail clients the user can route Dispatch through. Windows returns
/// what's registered in `HKLM\Software\Clients\Mail`; other platforms return
/// an empty list (Linux uses Thunderbird/xdg-email directly, macOS uses the
/// default Mail app), so the UI only surfaces this on Windows.
#[tauri::command]
pub fn list_mail_clients() -> Vec<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
        list_mail_clients_win()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn spawn_thunderbird_compose(
    to: &str,
    subject: &str,
    body: &str,
    attachments: &[PathBuf],
) -> Result<(), String> {
    let which = std::process::Command::new("which")
        .arg("thunderbird")
        .output()
        .map_err(|e| e.to_string())?;
    if !which.status.success() {
        return Err("thunderbird not on PATH".to_string());
    }

    // Thunderbird expects file:// URIs for attachments; multiple URIs are
    // comma-separated *inside* a single-quoted value.
    let uri_list: String = attachments
        .iter()
        .map(|p| format!("file://{}", p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(",");

    let compose = format!(
        "to={},subject={},body={},attachment={}",
        tb_compose_escape(to),
        tb_compose_escape(subject),
        tb_compose_escape(body),
        tb_compose_escape(&uri_list),
    );

    std::process::Command::new("thunderbird")
        .arg("-compose")
        .arg(&compose)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn stage_attachment_for_mail(src: &Path, stem_hint: &str) -> Result<PathBuf, String> {
    let downloads = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Skipi");
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let stem_safe: String = stem_hint
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let name = format!("{}_{}.{}", ts, stem_safe.trim_matches('_'), ext);
    let dest = downloads.join(name);
    fs::copy(src, &dest).map_err(|e| format!("stage attach: {}", e))?;
    Ok(dest)
}

#[tauri::command]
pub fn create_package(
    state: State<AppState>,
    title: String,
    doc_ids: Vec<String>,
    expiry_days: i32,
    download_limit: i32,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let all_docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    if doc_ids.is_empty() {
        return Err("Select at least one document".to_string());
    }
    let mut missing: Vec<String> = Vec::new();
    for doc_id in &doc_ids {
        match all_docs.iter().find(|d| &d.id == doc_id) {
            None => missing.push(format!("Unknown doc id {}", doc_id)),
            Some(doc) => match &doc.file_name {
                None => missing.push(doc.title.clone()),
                Some(fname) => {
                    let src = vault_path.join(&doc.category).join(fname);
                    if !src.exists() {
                        missing.push(format!("{} (file missing on disk)", doc.title));
                    }
                }
            },
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "Cannot create package — {} document(s) have no file:\n• {}",
            missing.len(),
            missing.join("\n• ")
        ));
    }

    let pkg_id = uuid::Uuid::new_v4().to_string();
    let expires = chrono::Utc::now() + chrono::Duration::days(expiry_days as i64);
    let expires_str = expires.format("%Y-%m-%dT%H:%M:%S").to_string();

    db::create_package(conn, &pkg_id, &title, &expires_str, download_limit, None)
        .map_err(|e| e.to_string())?;

    let pkg_dir = vault_path.join("_packages");
    fs::create_dir_all(&pkg_dir).map_err(|e| e.to_string())?;
    let zip_path = pkg_dir.join(format!("{}.zip", pkg_id));

    let file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for doc_id in &doc_ids {
        let doc = all_docs.iter().find(|d| &d.id == doc_id);
        if let Some(doc) = doc {
            if let Some(ref fname) = doc.file_name {
                let src = vault_path.join(&doc.category).join(fname);
                if src.exists() {
                    let data = fs::read(&src).map_err(|e| e.to_string())?;
                    zip.start_file(fname.clone(), options)
                        .map_err(|e| e.to_string())?;
                    use std::io::Write;
                    zip.write_all(&data).map_err(|e| e.to_string())?;

                    let pf_id = uuid::Uuid::new_v4().to_string();
                    db::add_package_file(conn, &pf_id, &pkg_id, doc_id, fname)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;

    Ok(pkg_id)
}

#[tauri::command]
pub fn get_packages(state: State<AppState>) -> Result<Vec<db::PackageRecord>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_all_packages(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_package(
    state: State<AppState>,
    package_id: String,
    dest_path: String,
) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let zip_src = vault_path
        .join("_packages")
        .join(format!("{}.zip", package_id));
    if !zip_src.exists() {
        return Err("Package ZIP not found".to_string());
    }
    fs::copy(&zip_src, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_package(state: State<AppState>, package_id: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let zip_path = vault_path
        .join("_packages")
        .join(format!("{}.zip", package_id));
    if zip_path.exists() {
        let _ = fs::remove_file(zip_path);
    }
    db::delete_package(conn, &package_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file_in_default(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File not found: {}", path));
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn open_email_with_attachment(
    _state: State<AppState>,
    _package_id: String,
    _to: String,
    _subject: String,
    _body: Option<String>,
) -> Result<String, String> {
    Err("Package email composition is not wired for mobile yet.".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn open_email_with_attachment(
    state: State<AppState>,
    package_id: String,
    to: String,
    subject: String,
    body: Option<String>,
) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let zip_path = vault_path
        .join("_packages")
        .join(format!("{}.zip", package_id));
    if !zip_path.exists() {
        return Err("Package ZIP not found".to_string());
    }

    let body_str = normalize_mail_body(&body.unwrap_or_default());

    #[cfg(target_os = "linux")]
    {
        // See stage_attachment_for_mail — vault paths with spaces break
        // mail client attach parsing, so we stage into ~/Downloads/Skipi.
        let staged =
            stage_attachment_for_mail(&zip_path, "documents").unwrap_or_else(|_| zip_path.clone());
        let attach = staged.to_string_lossy().to_string();
        let staged_vec = vec![staged.clone()];

        // Thunderbird `-compose` first (reliably attaches under snap),
        // xdg-email as fallback for KMail/Evolution/Geary users.
        let tb_ok = spawn_thunderbird_compose(&to, &subject, &body_str, &staged_vec).is_ok();
        if !tb_ok {
            let mut cmd = std::process::Command::new("xdg-email");
            cmd.arg("--attach")
                .arg(&attach)
                .arg("--subject")
                .arg(&subject);
            if !body_str.is_empty() {
                cmd.arg("--body").arg(&body_str);
            }
            cmd.arg(&to);
            let _ = cmd.spawn();
        }
        // Always reveal the stage folder so the user can drag-drop if the
        // mail client silently dropped the attachment.
        if let Some(stage_dir) = staged.parent() {
            let _ = std::process::Command::new("xdg-open")
                .arg(stage_dir.to_string_lossy().as_ref())
                .spawn();
        }
        return Ok(attach);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let zip_str = zip_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Mail"
                set newMsg to make new outgoing message with properties {{subject:{subject}, content:{body}, visible:true}}
                tell newMsg
                    make new to recipient with properties {{address:{to}}}
                    make new attachment with properties {{file name:POSIX file {zip}}}
                end tell
                activate
            end tell"#,
            subject = applescript_string_expr(&subject),
            body = applescript_string_expr(&body_str),
            to = applescript_string_expr(&to),
            zip = applescript_string_expr(&zip_str),
        );
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // Primary: PowerShell + Outlook COM — body + attachment included
        let ps_script = format!(
            "$o = New-Object -ComObject Outlook.Application; \
             $m = $o.CreateItem(0); \
             $m.To = {}; \
             $m.Subject = {}; \
             $m.Body = {}; \
             $m.Attachments.Add({}); \
             $m.Display()",
            ps_utf8_string_expr(&to),
            ps_utf8_string_expr(&subject),
            ps_utf8_string_expr(&body_str),
            ps_utf8_string_expr(&zip_str),
        );
        let outlook_ok = std::process::Command::new("powershell")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
            .spawn()
            .and_then(|mut c| c.wait())
            .map(|s| s.success())
            .unwrap_or(false);

        // Fallback: mailto + open folder for drag-drop
        if !outlook_ok {
            fn pct(s: &str) -> String {
                s.bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                            (b as char).to_string()
                        } else {
                            format!("%{:02X}", b)
                        }
                    })
                    .collect()
            }
            let url = format!(
                "mailto:{}?subject={}&body={}",
                to,
                pct(&subject),
                pct(&body_str),
            );
            let _ = std::process::Command::new("cmd")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["/C", "start", "", &url])
                .spawn();
        }
        let _ = std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&zip_str)
            .spawn();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Ok(zip_str)
}

#[tauri::command]
pub fn dispatch_package(
    state: State<AppState>,
    package_id: Option<String>,
    recipients: Vec<String>,
    subject: String,
    body: String,
    include_cv: Option<bool>,
    redacted_cv: Option<bool>,
    // v0.4.51: frontend passes the user's preferred mail client id so the
    // Windows branch can route straight to the right integration instead of
    // always trying Outlook COM first. `None` keeps the legacy behaviour.
    #[cfg_attr(not(target_os = "windows"), allow(unused_variables))] mail_client: Option<String>,
) -> Result<serde_json::Value, String> {
    if recipients.is_empty() {
        return Err("At least one recipient is required".to_string());
    }
    let body = normalize_mail_body(&body);
    // Default to true so older callers (e.g. /api or any pre-v0.4.21 clients)
    // keep the "CV + package" behaviour they used to see.
    let include_cv = include_cv.unwrap_or(true);
    let redacted_cv = redacted_cv.unwrap_or(false);
    let pkg_id_opt: Option<String> =
        package_id.and_then(|s| if s.is_empty() { None } else { Some(s) });

    if pkg_id_opt.is_none() && !include_cv {
        return Err("Nothing to send — tick CV or pick a package".to_string());
    }

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    // Validate ZIP only when a package was actually selected.
    let zip_path_opt: Option<PathBuf> = match &pkg_id_opt {
        Some(pid) => {
            let p = vault_path.join("_packages").join(format!("{}.zip", pid));
            if !p.exists() {
                return Err("Package ZIP not found — export the package first".to_string());
            }
            Some(p)
        }
        None => None,
    };

    let dispatch_dir = vault_path.join("_dispatch");
    fs::create_dir_all(&dispatch_dir).map_err(|e| e.to_string())?;
    let cv_data = {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        cv::build_cv_data(conn)?
    };
    let name_safe: String = cv_data
        .personal
        .surname
        .clone()
        .or_else(|| cv_data.personal.first_name.clone())
        .unwrap_or_else(|| cv_data.personal.name.clone())
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let cv_pdf_path = dispatch_dir.join(format!(
        "{}_{}.pdf",
        name_safe,
        if redacted_cv { "Privacy_CV" } else { "CV" }
    ));
    if include_cv {
        if redacted_cv {
            let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            let conn = conn_lock.as_ref().ok_or("No vault open")?;
            let extras = cv::build_redacted_extras(conn);
            cv::render_redacted_cv_pdf(&cv_data, &extras, &cv_pdf_path)?;
        } else {
            let photo_abs = cv_data
                .personal
                .photo_path
                .as_ref()
                .map(|rel| vault_path.join(rel))
                .filter(|p| p.exists());
            cv::render_cv_pdf(&cv_data, &cv_pdf_path, photo_abs.as_deref())?;
        }
    }

    let zip_str = zip_path_opt
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let cv_str = cv_pdf_path.to_string_lossy().to_string();
    let to_joined = recipients.join(",");

    #[cfg(target_os = "linux")]
    {
        // Stage attachments into ~/Downloads/Skipi with safe ASCII names so
        // mail clients reliably pick them up (vault paths often contain
        // spaces / non-ASCII that break attach parsing).
        let mut staged_paths: Vec<std::path::PathBuf> = Vec::new();
        if let Some(zip_path) = &zip_path_opt {
            let staged_zip =
                stage_attachment_for_mail(zip_path, &format!("{}_documents", name_safe))
                    .unwrap_or_else(|_| zip_path.clone());
            staged_paths.push(staged_zip);
        }
        if include_cv {
            let staged_cv = stage_attachment_for_mail(&cv_pdf_path, &format!("{}_CV", name_safe))
                .unwrap_or_else(|_| cv_pdf_path.clone());
            staged_paths.push(staged_cv);
        }

        // Primary path: Thunderbird `-compose` reliably attaches multiple
        // files even under snap confinement, unlike `xdg-email --attach`
        // which Thunderbird snap often silently ignores.
        let tb_ok = spawn_thunderbird_compose(&to_joined, &subject, &body, &staged_paths).is_ok();

        // Fallback: xdg-email (for users on KMail, Evolution, Geary, etc.).
        if !tb_ok {
            let mut cmd = std::process::Command::new("xdg-email");
            for p in &staged_paths {
                cmd.arg("--attach").arg(p.to_string_lossy().as_ref());
            }
            cmd.arg("--subject")
                .arg(&subject)
                .arg("--body")
                .arg(&body)
                .arg(&to_joined);
            cmd.spawn().map_err(|e| e.to_string())?;
        }

        // Always reveal the staged folder so the user can drag-drop as a
        // last resort if the mail client silently dropped the attachments.
        if let Some(stage_dir) = staged_paths.first().and_then(|p| p.parent()) {
            let _ = std::process::Command::new("xdg-open")
                .arg(stage_dir.to_string_lossy().as_ref())
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let rec_script: String = recipients
            .iter()
            .map(|r| format!("                    make new to recipient with properties {{address:\"{}\"}}\n", r))
            .collect();
        let zip_attach = if !zip_str.is_empty() {
            format!("                    make new attachment with properties {{file name:POSIX file \"{}\"}}\n", zip_str)
        } else {
            String::new()
        };
        let cv_attach = if include_cv {
            format!("                    make new attachment with properties {{file name:POSIX file \"{}\"}}\n", cv_str)
        } else {
            String::new()
        };
        let script = format!(
            r#"tell application "Mail"
                set newMsg to make new outgoing message with properties {{subject:{subject}, content:{body}, visible:true}}
                tell newMsg
{rec_script}{zip_attach}{cv_attach}                end tell
                activate
            end tell"#,
            subject = applescript_string_expr(&subject),
            body = applescript_string_expr(&body),
            rec_script = rec_script,
            zip_attach = zip_attach,
            cv_attach = cv_attach,
        );
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // Collect attachment paths
        let mut attachments: Vec<String> = Vec::new();
        if !zip_str.is_empty() {
            attachments.push(zip_str.clone());
        }
        if include_cv {
            attachments.push(cv_str.clone());
        }

        // v0.4.51: route by user's preferred client.
        // `None` or unknown → fall through to Outlook COM → mailto fallback
        // (the old behaviour); `thunderbird` → CLI; `mailto` → skip Outlook.
        let prefer = mail_client.as_deref().unwrap_or("").to_lowercase();

        let try_outlook = prefer.is_empty() || prefer == "outlook";
        let try_thunderbird = prefer == "thunderbird";
        let force_mailto = prefer == "mailto";

        let mut handled = false;

        if try_thunderbird {
            handled =
                spawn_thunderbird_compose_win(&to_joined, &subject, &body, &attachments).is_ok();
        }

        if !handled && try_outlook {
            let attach_ps: String = attachments
                .iter()
                .map(|a| format!("$m.Attachments.Add({})", ps_utf8_string_expr(a)))
                .collect::<Vec<_>>()
                .join("; ");
            let ps_script = format!(
                "$o = New-Object -ComObject Outlook.Application; \
                 $m = $o.CreateItem(0); \
                 $m.To = {}; \
                 $m.Subject = {}; \
                 $m.Body = {}; \
                 {}; \
                 $m.Display()",
                ps_utf8_string_expr(&to_joined),
                ps_utf8_string_expr(&subject),
                ps_utf8_string_expr(&body),
                attach_ps,
            );
            handled = std::process::Command::new("powershell")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .spawn()
                .and_then(|mut c| c.wait())
                .map(|s| s.success())
                .unwrap_or(false);
        }

        // Fallback: mailto (no attachments possible, but body is included).
        // Used when (a) user explicitly picked mailto, (b) selected client
        // failed to launch, or (c) unknown preference fell through.
        if !handled || force_mailto {
            fn pct(s: &str) -> String {
                s.bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                            (b as char).to_string()
                        } else {
                            format!("%{:02X}", b)
                        }
                    })
                    .collect()
            }
            let url = format!(
                "mailto:{}?subject={}&body={}",
                to_joined,
                pct(&subject),
                pct(&body),
            );
            let _ = std::process::Command::new("cmd")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["/C", "start", "", &url])
                .spawn();
        }

        // Always open the dispatch folder so user can drag-drop attachments
        let _ = std::process::Command::new("explorer")
            .arg(dispatch_dir.to_string_lossy().as_ref())
            .spawn();
    }

    // Record the dispatch in DB
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        let disp_id = uuid::Uuid::new_v4().to_string();
        // "cv_only" is a sentinel for dispatches that carry no package —
        // history view treats it as a CV-only send.
        let pkg_ref = pkg_id_opt.as_deref().unwrap_or("cv_only");
        db::add_dispatch(conn, &disp_id, pkg_ref, &to_joined, &subject, &cv_str)
            .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "cv_path": cv_str,
        "zip_path": zip_str,
        "recipients": recipients,
    }))
}

/// Return the path to the dispatch staging folder (~/Downloads/Skipi),
/// creating it if needed. Used by `doDispatchPrepare` in the frontend.
#[tauri::command]
pub fn get_dispatch_dir() -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("Skipi");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Return all dispatch history entries, newest first.
#[tauri::command]
pub fn get_dispatches(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_dispatches(conn).map_err(|e| e.to_string())
}

/// Build the attachment list for a dispatch: generate CV PDF if requested,
/// locate the package ZIP if a package id is given. Returns absolute paths.
/// Used by the SMTP send path in the frontend — the mail-client fallback
/// does its own staging via `dispatch_package`.
#[tauri::command]
pub fn prepare_dispatch_attachments(
    state: State<AppState>,
    package_id: Option<String>,
    include_cv: Option<bool>,
    redacted_cv: Option<bool>,
) -> Result<Vec<String>, String> {
    let include_cv = include_cv.unwrap_or(false);
    let redacted_cv = redacted_cv.unwrap_or(false);
    let pkg_id_opt: Option<String> =
        package_id.and_then(|s| if s.is_empty() { None } else { Some(s) });
    if pkg_id_opt.is_none() && !include_cv {
        return Err("Nothing to attach — tick CV or pick a package".to_string());
    }

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let mut out: Vec<String> = Vec::new();

    if let Some(pid) = &pkg_id_opt {
        let zip_path = vault_path.join("_packages").join(format!("{}.zip", pid));
        if !zip_path.exists() {
            return Err("Package ZIP not found — export the package first".to_string());
        }
        out.push(zip_path.to_string_lossy().to_string());
    }

    if include_cv {
        let dispatch_dir = vault_path.join("_dispatch");
        fs::create_dir_all(&dispatch_dir).map_err(|e| e.to_string())?;
        let cv_data = {
            let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            let conn = conn_lock.as_ref().ok_or("No vault open")?;
            cv::build_cv_data(conn)?
        };
        let name_safe: String = cv_data
            .personal
            .surname
            .clone()
            .or_else(|| cv_data.personal.first_name.clone())
            .unwrap_or_else(|| cv_data.personal.name.clone())
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        let cv_pdf_path = dispatch_dir.join(format!(
            "{}_{}.pdf",
            name_safe,
            if redacted_cv { "Privacy_CV" } else { "CV" }
        ));
        if redacted_cv {
            let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            let conn = conn_lock.as_ref().ok_or("No vault open")?;
            let extras = cv::build_redacted_extras(conn);
            cv::render_redacted_cv_pdf(&cv_data, &extras, &cv_pdf_path)?;
        } else {
            let photo_abs = cv_data
                .personal
                .photo_path
                .as_ref()
                .map(|rel| vault_path.join(rel))
                .filter(|p| p.exists());
            cv::render_cv_pdf(&cv_data, &cv_pdf_path, photo_abs.as_deref())?;
        }
        out.push(cv_pdf_path.to_string_lossy().to_string());
    }

    Ok(out)
}

/// Log an SMTP-sent dispatch in the vault history table so it shows up in
/// the "Recent dispatches" list exactly like mail-client dispatches do.
#[tauri::command]
pub fn record_dispatch_history(
    state: State<AppState>,
    package_id: Option<String>,
    recipients: Vec<String>,
    subject: String,
    cv_path: Option<String>,
) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let disp_id = uuid::Uuid::new_v4().to_string();
    let pkg_ref = package_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("cv_only");
    let to_joined = recipients.join(",");
    let cv = cv_path.unwrap_or_default();
    db::add_dispatch(conn, &disp_id, pkg_ref, &to_joined, &subject, &cv)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_mail_body;

    #[test]
    fn normalize_mail_body_preserves_real_newlines() {
        let body = "Dear Sirs,\n\nPlease find attached my CV.\n\nKind regards";
        assert_eq!(normalize_mail_body(body), body);
    }

    #[test]
    fn normalize_mail_body_repairs_escaped_multiline_draft() {
        let body = "Dear Sirs,\\n\\nPlease find attached my CV.\\n\\nKind regards";
        assert_eq!(
            normalize_mail_body(body),
            "Dear Sirs,\n\nPlease find attached my CV.\n\nKind regards"
        );
    }

    #[test]
    fn normalize_mail_body_does_not_rewrite_single_backslash_n() {
        let body = "Use the literal token \\n in documentation";
        assert_eq!(normalize_mail_body(body), body);
    }
}

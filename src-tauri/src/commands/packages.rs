use crate::db;
use crate::cv;
use crate::AppState;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

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
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for doc_id in &doc_ids {
        let doc = all_docs.iter().find(|d| &d.id == doc_id);
        if let Some(doc) = doc {
            if let Some(ref fname) = doc.file_name {
                let src = vault_path.join(&doc.category).join(fname);
                if src.exists() {
                    let data = fs::read(&src).map_err(|e| e.to_string())?;
                    zip.start_file(fname.clone(), options).map_err(|e| e.to_string())?;
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
pub fn export_package(state: State<AppState>, package_id: String, dest_path: String) -> Result<(), String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let zip_src = vault_path.join("_packages").join(format!("{}.zip", package_id));
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

    let zip_path = vault_path.join("_packages").join(format!("{}.zip", package_id));
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
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_email_with_attachment(state: State<AppState>, package_id: String, to: String, subject: String, body: Option<String>) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let zip_path = vault_path.join("_packages").join(format!("{}.zip", package_id));
    if !zip_path.exists() {
        return Err("Package ZIP not found".to_string());
    }

    let zip_str = zip_path.to_string_lossy().to_string();
    let body_str = body.unwrap_or_default();

    #[cfg(target_os = "linux")]
    {
        // See stage_attachment_for_mail — vault paths with spaces break
        // Thunderbird's attach parsing, so we stage into ~/Downloads/Skipi.
        let staged = stage_attachment_for_mail(&zip_path, "documents")
            .unwrap_or_else(|_| zip_path.clone());
        let attach = staged.to_string_lossy().to_string();
        let mut cmd = std::process::Command::new("xdg-email");
        cmd.arg("--attach").arg(&attach)
           .arg("--subject").arg(&subject);
        if !body_str.is_empty() {
            cmd.arg("--body").arg(&body_str);
        }
        cmd.arg(&to);
        let result = cmd.spawn();
        if result.is_ok() {
            return Ok(attach);
        }
        // Fallback: open mailto + open package folder
        let _ = std::process::Command::new("xdg-open")
            .arg(vault_path.join("_packages").to_string_lossy().to_string())
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Mail"
                set newMsg to make new outgoing message with properties {{subject:"{}", visible:true}}
                tell newMsg
                    make new to recipient with properties {{address:"{}"}}
                    make new attachment with properties {{file name:POSIX file "{}"}}
                end tell
                activate
            end tell"#,
            subject, to, zip_str
        );
        let _ = std::process::Command::new("osascript").arg("-e").arg(&script).spawn();
    }
    #[cfg(target_os = "windows")]
    {
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
        let body = format!(
            "Прикрепите файл вручную: {}\n\n\
             (Windows не позволяет почтовым клиентам автоматически прикреплять \
             файлы через mailto:. Skipi открыл папку с пакетом — перетащите ZIP в \
             черновик письма.)",
            zip_str
        );
        let url = format!(
            "mailto:{}?subject={}&body={}",
            to,
            pct(&subject),
            pct(&body),
        );
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
        let _ = std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&zip_str)
            .spawn();
    }

    Ok(zip_str)
}

#[tauri::command]
pub fn dispatch_package(
    state: State<AppState>,
    package_id: String,
    recipients: Vec<String>,
    subject: String,
    body: String,
    include_cv: Option<bool>,
) -> Result<serde_json::Value, String> {
    if recipients.is_empty() {
        return Err("At least one recipient is required".to_string());
    }
    // Default to true so older callers (e.g. /api or any pre-v0.4.21 clients)
    // keep the "CV + package" behaviour they used to see.
    let include_cv = include_cv.unwrap_or(true);
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let zip_path = vault_path.join("_packages").join(format!("{}.zip", package_id));
    if !zip_path.exists() {
        return Err("Package ZIP not found — export the package first".to_string());
    }

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
    let cv_pdf_path = dispatch_dir.join(format!("{}_CV.pdf", name_safe));
    if include_cv {
        let photo_abs = cv_data
            .personal
            .photo_path
            .as_ref()
            .map(|rel| vault_path.join(rel))
            .filter(|p| p.exists());
        cv::render_cv_pdf(&cv_data, &cv_pdf_path, photo_abs.as_deref())?;
    }

    let zip_str = zip_path.to_string_lossy().to_string();
    let cv_str = cv_pdf_path.to_string_lossy().to_string();
    let to_joined = recipients.join(",");

    #[cfg(target_os = "linux")]
    {
        // Stage attachments into ~/Downloads/Skipi with safe ASCII names so
        // mail clients (Thunderbird in particular) reliably pick them up
        // via `xdg-email --attach`. See stage_attachment_for_mail.
        let staged_zip = stage_attachment_for_mail(&zip_path, &format!("{}_documents", name_safe))
            .unwrap_or_else(|_| zip_path.clone());
        let zip_attach = staged_zip.to_string_lossy().to_string();
        let mut cmd = std::process::Command::new("xdg-email");
        cmd.arg("--attach").arg(&zip_attach);
        if include_cv {
            let staged_cv = stage_attachment_for_mail(&cv_pdf_path, &format!("{}_CV", name_safe))
                .unwrap_or_else(|_| cv_pdf_path.clone());
            cmd.arg("--attach").arg(staged_cv.to_string_lossy().to_string());
        }
        cmd.arg("--subject").arg(&subject)
           .arg("--body").arg(&body)
           .arg(&to_joined);
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let rec_script: String = recipients
            .iter()
            .map(|r| format!("                    make new to recipient with properties {{address:\"{}\"}}\n", r))
            .collect();
        let cv_attach = if include_cv {
            format!("                    make new attachment with properties {{file name:POSIX file \"{}\"}}\n", cv_str)
        } else {
            String::new()
        };
        let script = format!(
            r#"tell application "Mail"
                set newMsg to make new outgoing message with properties {{subject:"{subject}", content:"{body}", visible:true}}
                tell newMsg
{rec_script}                    make new attachment with properties {{file name:POSIX file "{zip}"}}
{cv_attach}                end tell
                activate
            end tell"#,
            subject = subject.replace('"', "\\\""),
            body = body.replace('"', "\\\"").replace('\n', "\\n"),
            rec_script = rec_script,
            cv_attach = cv_attach,
            zip = zip_str,
        );
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
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
        let cv_hint = if include_cv { format!("\n{}", cv_str) } else { String::new() };
        let hint = format!(
            "{}\n\n--- Please attach manually ---\n{}{}\n",
            body, zip_str, cv_hint
        );
        let url = format!(
            "mailto:{}?subject={}&body={}",
            to_joined,
            pct(&subject),
            pct(&hint),
        );
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
        let _ = std::process::Command::new("explorer")
            .arg(dispatch_dir.to_string_lossy().as_ref())
            .spawn();
    }

    // Record the dispatch in DB
    {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        let disp_id = uuid::Uuid::new_v4().to_string();
        db::add_dispatch(
            conn,
            &disp_id,
            &package_id,
            &to_joined,
            &subject,
            &cv_str,
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "cv_path": cv_str,
        "zip_path": zip_str,
        "recipients": recipients,
    }))
}

/// Return all dispatch history entries, newest first.
#[tauri::command]
pub fn get_dispatches(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_dispatches(conn).map_err(|e| e.to_string())
}

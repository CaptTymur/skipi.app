use crate::db;
use crate::cv;
use crate::AppState;
use std::fs;

use tauri::State;

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
        let mut cmd = std::process::Command::new("xdg-email");
        cmd.arg("--attach").arg(&zip_str)
           .arg("--subject").arg(&subject);
        if !body_str.is_empty() {
            cmd.arg("--body").arg(&body_str);
        }
        cmd.arg(&to);
        let result = cmd.spawn();
        if result.is_ok() {
            return Ok(zip_str);
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
) -> Result<serde_json::Value, String> {
    if recipients.is_empty() {
        return Err("At least one recipient is required".to_string());
    }
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
    let photo_abs = cv_data
        .personal
        .photo_path
        .as_ref()
        .map(|rel| vault_path.join(rel))
        .filter(|p| p.exists());
    cv::render_cv_pdf(&cv_data, &cv_pdf_path, photo_abs.as_deref())?;

    let zip_str = zip_path.to_string_lossy().to_string();
    let cv_str = cv_pdf_path.to_string_lossy().to_string();
    let to_joined = recipients.join(",");

    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-email")
            .arg("--attach").arg(&zip_str)
            .arg("--attach").arg(&cv_str)
            .arg("--subject").arg(&subject)
            .arg("--body").arg(&body)
            .arg(&to_joined)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let rec_script: String = recipients
            .iter()
            .map(|r| format!("                    make new to recipient with properties {{address:\"{}\"}}\n", r))
            .collect();
        let script = format!(
            r#"tell application "Mail"
                set newMsg to make new outgoing message with properties {{subject:"{subject}", content:"{body}", visible:true}}
                tell newMsg
{rec_script}                    make new attachment with properties {{file name:POSIX file "{zip}"}}
                    make new attachment with properties {{file name:POSIX file "{cv}"}}
                end tell
                activate
            end tell"#,
            subject = subject.replace('"', "\\\""),
            body = body.replace('"', "\\\"").replace('\n', "\\n"),
            rec_script = rec_script,
            zip = zip_str,
            cv = cv_str,
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
        let hint = format!(
            "{}\n\n--- Please attach manually ---\n{}\n{}\n",
            body, zip_str, cv_str
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

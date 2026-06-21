use crate::db::{self, VaultInfo};
use crate::{frameworks, identity, AppState};
use rusqlite::DatabaseName;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub fn get_last_vault() -> Option<String> {
    crate::load_last_vault()
}

/// Returns the app version baked in at build time from Cargo.toml.
/// Used by the About tab and feedback email so we never drift between UI and binary.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returns a short identifier for the host OS (mac/windows/linux/other).
/// Used by the feedback template so beta reports always include the platform.
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

/// Default parent folder for new vaults. Used by the frontend to pre-fill
/// "where this vault will be saved" before any native picker opens.
#[tauri::command]
pub fn get_default_vault_parent() -> Result<String, String> {
    let p = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve user Documents / home folder".to_string())?
        .join("Skipi");
    fs::create_dir_all(&p).map_err(|e| format!("Could not create default Skipi folder: {}", e))?;
    Ok(p.to_string_lossy().to_string())
}

/// Detects how Skipi is installed on Linux so the frontend can choose
/// the right update path. Tauri's built-in updater only works for AppImage
/// builds — on `.deb` installs it fails with "invalid binary format".
///
/// Returns one of:
///   - "appimage"   — running from an AppImage (env APPIMAGE is set)
///   - "deb"        — binary lives under /usr/bin, /usr/local/bin or /opt (apt/dpkg install)
///   - "other"      — Linux, unknown packaging (dev build, manual copy, etc.)
///   - "non-linux"  — macOS/Windows, updater works normally
#[tauri::command]
pub fn get_linux_install_type() -> String {
    if !cfg!(target_os = "linux") {
        return "non-linux".to_string();
    }
    if std::env::var("APPIMAGE").is_ok() {
        return "appimage".to_string();
    }
    if let Ok(exe) = std::env::current_exe() {
        let p = exe.to_string_lossy().to_string();
        if p.starts_with("/usr/bin/") || p.starts_with("/usr/local/bin/") || p.starts_with("/opt/")
        {
            return "deb".to_string();
        }
    }
    "other".to_string()
}

/// Sets the OS window title. Called from the frontend whenever the vault
/// context changes so the titlebar shows `Skipi — <AccountType> — <VaultName>`.
/// Receives the current `WebviewWindow` directly (Tauri injects it) — that
/// way we don't depend on a specific label or on extra window-plugin
/// capabilities on the JS side.
#[tauri::command]
pub fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    // Desktop only — mobile platforms have no OS window titlebar.
    #[cfg(desktop)]
    {
        window.set_title(&title).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, title);
        Ok(())
    }
}

/// Opens a URL in the user's default browser. Implemented via `xdg-open` /
/// `open` / `start` so we don't need the tauri_plugin_shell dep. Used to
/// redirect Linux `.deb` users to the release page when auto-update isn't
/// applicable to their install type.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    // Sanity check — limit to scheme://-style URLs so this command can't be
    // abused to run arbitrary programs. We allow http(s)/mailto/tel which
    // are the schemes Skipi routes through default applications.
    let allowed = ["https://", "http://", "mailto:", "tel:"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err("Only http(s)/mailto/tel URLs are allowed".to_string());
    }
    #[cfg(target_os = "macos")]
    let cmd = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/C", "start", "", &url])
            .spawn()
    };
    #[cfg(target_os = "linux")]
    let cmd = std::process::Command::new("xdg-open").arg(&url).spawn();
    // Mobile (iOS/Android) has no spawnable `open`/`start`/`xdg-open`; external
    // URL opening on mobile is handled by the webview / OS link handling.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let cmd: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "open_external_url is not supported on mobile",
    ));
    cmd.map(|_| ()).map_err(|e| e.to_string())
}

/// Download a .deb from GitHub releases to /tmp and install via pkexec dpkg -i.
/// Shows a native password prompt. On success, exits the app so the user
/// restarts into the new version.
#[tauri::command]
pub async fn install_deb_update(version: String) -> Result<String, String> {
    if !cfg!(target_os = "linux") {
        return Err("Only available on Linux".to_string());
    }
    let filename = format!("Skipi_{}_amd64.deb", version);
    let url = format!(
        "https://github.com/CaptTymur/skipi.app/releases/download/v{}/{}",
        version, filename
    );
    let dest = std::path::PathBuf::from("/tmp").join(&filename);

    // Download
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("Cannot save .deb: {}", e))?;

    // Install via pkexec (shows native password dialog)
    let status = std::process::Command::new("pkexec")
        .args(["dpkg", "-i", &dest.to_string_lossy()])
        .status()
        .map_err(|e| format!("Cannot run pkexec: {}", e))?;

    if !status.success() {
        return Err("Installation failed (wrong password or cancelled)".to_string());
    }

    Ok("Installed. Please restart Skipi.".to_string())
}

#[tauri::command]
pub fn get_vault_types() -> serde_json::Value {
    serde_json::json!({
        "vessel_types": frameworks::vessel_types(),
        "ranks": frameworks::seafarer_ranks(),
    })
}

#[tauri::command]
pub fn create_vault(
    state: State<AppState>,
    path: String,
    account_type: String,
    name: String,
    rank: Option<String>,
    vessel_type: Option<String>,
) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    if vault_path.join("skipi.db").exists() {
        return Err("A Skipi vault already exists in that folder. Use Open Existing Vault, or choose a different parent folder/name.".to_string());
    }
    fs::create_dir_all(&vault_path).map_err(|e| e.to_string())?;

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    crate::reset_vault_content(&conn);
    identity::ensure_vault_identity(&conn, &vault_path)?;

    db::set_vault_info(&conn, "account_type", &account_type).map_err(|e| e.to_string())?;
    db::set_vault_info(&conn, "name", &name).map_err(|e| e.to_string())?;
    if let Some(ref r) = rank {
        db::set_vault_info(&conn, "rank", r).map_err(|e| e.to_string())?;
    }
    if let Some(ref v) = vessel_type {
        db::set_vault_info(&conn, "vessel_type", v).map_err(|e| e.to_string())?;
    }

    // Generate framework documents
    let docs = match account_type.as_str() {
        "seafarer" => frameworks::get_seafarer_framework(rank.as_deref()),
        _ => frameworks::get_vessel_framework(vessel_type.as_deref()),
    };

    // Create category folders
    let mut categories_seen = std::collections::HashSet::new();
    for doc in &docs {
        if categories_seen.insert(doc.category.clone()) {
            let cat_dir = vault_path.join(&doc.category);
            fs::create_dir_all(&cat_dir).map_err(|e| e.to_string())?;
        }
        db::insert_doc(&conn, doc).map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "category": doc.category.clone(),
            "kind": "framework",
            "template_id": doc.template_id.clone(),
            "account_type": account_type.clone(),
        })
        .to_string();
        let _ = db::log_event(
            &conn,
            "doc_added",
            "document",
            Some(&doc.id),
            Some(&payload),
        );
    }

    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;

    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);

    Ok(info)
}

#[tauri::command]
pub fn open_vault(state: State<AppState>, path: String) -> Result<VaultInfo, String> {
    let vault_path = PathBuf::from(&path);
    let db_file = vault_path.join("skipi.db");
    if !db_file.exists() {
        return Err("Not a Skipi vault (no skipi.db found)".to_string());
    }

    let conn = db::open_db(&vault_path).map_err(|e| e.to_string())?;
    let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
    // Pick up templates added after this vault was created (e.g. Visas
    // category introduced in v0.4.21). Best-effort: log but don't fail
    // the whole open if seeding a single template errors out.
    let _ = crate::commands::profile::ensure_profile_templates(&conn, &vault_path);

    crate::save_last_vault(&path);
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(vault_path);
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);

    Ok(info)
}

#[tauri::command]
pub fn close_vault(state: State<AppState>, forget: Option<bool>) -> Result<(), String> {
    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if forget.unwrap_or(false) {
        let cfg = crate::config_path();
        let _ = fs::write(cfg, serde_json::json!({}).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_current_vault_path(state: State<AppState>) -> Option<String> {
    state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_vault_path(state: State<AppState>) -> Result<String, String> {
    let lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    lock.as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or("No vault open".to_string())
}

#[tauri::command]
pub fn get_vault_identity_key(state: State<AppState>) -> Result<serde_json::Value, String> {
    let vault_path = state
        .vault_path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .ok_or("No vault open")?
        .clone();
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    identity::get_vault_identity_key(conn, &vault_path)
}

fn zip_path_name(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn add_file_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    src: &Path,
    in_zip: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let mut f = fs::File::open(src).map_err(|e| format!("open {}: {}", src.display(), e))?;
    zip.start_file(in_zip, options)
        .map_err(|e| format!("zip {}: {}", in_zip, e))?;
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("read {}: {}", src.display(), e))?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n])
            .map_err(|e| format!("write {}: {}", in_zip, e))?;
    }
    Ok(())
}

fn add_vault_tree_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    vault_path: &Path,
    dir: &Path,
    skip_paths: &[PathBuf],
    options: zip::write::SimpleFileOptions,
) -> Result<usize, String> {
    let mut count = 0_usize;
    for entry in fs::read_dir(dir).map_err(|e| format!("read {}: {}", dir.display(), e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("metadata {}: {}", path.display(), e))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            count += add_vault_tree_to_zip(zip, vault_path, &path, skip_paths, options)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name == "skipi.db" || name == "skipi.db-wal" || name == "skipi.db-shm" {
            continue;
        }
        let mut skip_file = false;
        if let Ok(a) = path.canonicalize() {
            for skip in skip_paths {
                if let Ok(b) = skip.canonicalize() {
                    if a == b {
                        skip_file = true;
                        break;
                    }
                } else if path == skip.as_path() {
                    skip_file = true;
                    break;
                }
            }
        }
        if skip_file {
            continue;
        }
        let rel = path.strip_prefix(vault_path).map_err(|e| e.to_string())?;
        add_file_to_zip(zip, &path, &zip_path_name(rel), options)?;
        count += 1;
    }
    Ok(count)
}

#[tauri::command]
pub fn export_vault_backup(
    state: State<AppState>,
    output_path: String,
) -> Result<serde_json::Value, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?.clone();
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let info = db::get_vault_info(conn).map_err(|e| e.to_string())?;

    let out = PathBuf::from(&output_path);
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_out = out.with_extension("zip.part");
    if tmp_out.exists() {
        let _ = fs::remove_file(&tmp_out);
    }

    let db_snapshot =
        std::env::temp_dir().join(format!("skipi-db-snapshot-{}.db", uuid::Uuid::new_v4()));
    if db_snapshot.exists() {
        let _ = fs::remove_file(&db_snapshot);
    }
    conn.backup(DatabaseName::Main, &db_snapshot, None)
        .map_err(|e| format!("database backup failed: {}", e))?;

    let file =
        fs::File::create(&tmp_out).map_err(|e| format!("create {}: {}", tmp_out.display(), e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);

    add_file_to_zip(&mut zip, &db_snapshot, "skipi.db", options)?;
    let skip_paths = vec![out.clone(), tmp_out.clone()];
    let mut file_count =
        1 + add_vault_tree_to_zip(&mut zip, &vault_path, &vault_path, &skip_paths, options)?;

    let manifest = serde_json::json!({
        "schema_version": 1,
        "kind": "skipi_vault_backup",
        "exported_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "vault": {
            "name": info.name,
            "account_type": info.account_type,
            "rank": info.rank,
            "vessel_type": info.vessel_type,
            "position": info.position,
            "vessel_category": info.vessel_category,
        }
    });
    zip.start_file("_skipi_export.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    file_count += 1;
    zip.finish().map_err(|e| e.to_string())?;

    let _ = fs::remove_file(&db_snapshot);
    if out.exists() {
        fs::remove_file(&out).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_out, &out).map_err(|e| format!("finalize export: {}", e))?;
    let size = fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "path": out.to_string_lossy().to_string(),
        "bytes": size,
        "files": file_count
    }))
}

fn target_dir_is_empty_or_missing(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if !path.is_dir() {
        return Err("Target path exists and is not a folder".to_string());
    }
    let mut entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    if entries.next().is_some() {
        return Err("Target folder is not empty. Choose a new empty folder.".to_string());
    }
    Ok(())
}

fn extract_backup_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open backup: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("invalid backup zip: {}", e))?;
    let mut saw_db = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe path in backup: {}", entry.name()))?;
        if enclosed.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if enclosed == Path::new("skipi.db") {
            saw_db = true;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {}", out_path.display(), e))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract {}: {}", entry.name(), e))?;
    }
    if !saw_db {
        return Err("Backup does not contain skipi.db".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn import_vault_backup(
    state: State<AppState>,
    zip_path: String,
    target_path: String,
) -> Result<VaultInfo, String> {
    let zip_path = PathBuf::from(&zip_path);
    if !zip_path.exists() {
        return Err("Backup file not found".to_string());
    }
    let target = PathBuf::from(&target_path);
    target_dir_is_empty_or_missing(&target)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Target folder must have a parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".skipi-import-{}", uuid::Uuid::new_v4()));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    fs::create_dir_all(&temp).map_err(|e| e.to_string())?;

    let result = (|| -> Result<VaultInfo, String> {
        extract_backup_zip(&zip_path, &temp)?;
        let db_file = temp.join("skipi.db");
        if !db_file.exists() {
            return Err("Imported backup has no skipi.db".to_string());
        }
        {
            let conn =
                db::open_db(&temp).map_err(|e| format!("Imported database is invalid: {}", e))?;
            let _ = db::get_vault_info(&conn)
                .map_err(|e| format!("Imported vault metadata is invalid: {}", e))?;
        }
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
        }
        fs::rename(&temp, &target).map_err(|e| format!("finalize import: {}", e))?;

        let conn = db::open_db(&target).map_err(|e| e.to_string())?;
        let info = db::get_vault_info(&conn).map_err(|e| e.to_string())?;
        let _ = crate::commands::profile::ensure_profile_templates(&conn, &target);
        let path_str = target.to_string_lossy().to_string();
        crate::save_last_vault(&path_str);
        *state.vault_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
        *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
        Ok(info)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}

#[tauri::command]
pub fn get_recent_vaults() -> Vec<String> {
    crate::load_recent_vaults()
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_dir())
        .collect()
}

#[tauri::command]
pub fn forget_recent_vault(path: String) -> Result<(), String> {
    use std::fs;
    let cfg = crate::config_path();
    let mut data: serde_json::Value = match fs::read_to_string(&cfg)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
    {
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let recent = crate::load_recent_vaults();
    let kept: Vec<String> = recent.into_iter().filter(|p| p != &path).collect();
    data["recent_vaults"] = serde_json::Value::Array(
        kept.iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );
    fs::write(&cfg, data.to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn test_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "skipi-vault-test-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn vault_tree_export_skips_live_db_and_backup_targets() {
        let root = test_dir("zip-skip");
        fs::write(root.join("skipi.db"), b"db").unwrap();
        fs::write(root.join("Certificate.txt"), b"cert").unwrap();
        fs::write(root.join("backup.zip"), b"old").unwrap();
        fs::write(root.join("backup.zip.part"), b"partial").unwrap();
        fs::create_dir_all(root.join("Nested")).unwrap();
        fs::write(root.join("Nested").join("note.txt"), b"note").unwrap();

        let zip_path = root.join("out.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let skipped = vec![
            zip_path.clone(),
            root.join("backup.zip"),
            root.join("backup.zip.part"),
        ];
        let count = add_vault_tree_to_zip(&mut zip, &root, &root, &skipped, options).unwrap();
        zip.finish().unwrap();

        let file = fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names = BTreeSet::new();
        for i in 0..archive.len() {
            names.insert(archive.by_index(i).unwrap().name().to_string());
        }
        assert_eq!(count, 2);
        assert!(names.contains("Certificate.txt"));
        assert!(names.contains("Nested/note.txt"));
        assert!(!names.contains("skipi.db"));
        assert!(!names.contains("backup.zip"));
        assert!(!names.contains("backup.zip.part"));
        assert!(!names.contains("out.zip"));

        let _ = fs::remove_dir_all(root);
    }
}

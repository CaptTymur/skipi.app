use crate::cv;
use crate::db;
use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

// ════════════════════════════════════════════════════════════════════════════
// The automatic "All documents" package (№321).
//
// One system package per vault, found by a RESERVED ID and by nothing else.
// Title is not an identity (it is localised on screen and a user may have a
// package of their own called "All Documents"), and `file_count` is not an
// identity either — replacing a file with new bytes under the same name keeps
// the count and changes everything that matters. That exact assumption is what
// made the old title+count lookup hand a stale ZIP to a recipient.
// ════════════════════════════════════════════════════════════════════════════

/// Reserved service identity of the automatic package. Look-ups use THIS and
/// never the title, the file count or the expiry date.
pub const ALL_DOCS_PACKAGE_ID: &str = "skipi-all-documents";

/// Neutral title in SQLite. The phone draws its own localised caption from the
/// reserved id (so switching RU/EN never rewrites a database row and never
/// disagrees with the desktop list, which is frozen).
const ALL_DOCS_PACKAGE_TITLE: &str = "All documents";

/// Refreshed on EVERY successful rebuild: `validDispatchPackages` in the
/// mailing wizard filters by `expires_on`, so a system package that was allowed
/// to go stale would silently drop out of the wizard a year later and the old
/// title-based code would create a second one.
const ALL_DOCS_EXPIRY_DAYS: i64 = 365;

const ALL_DOCS_DOWNLOAD_LIMIT: i32 = 999;
const PACKAGE_STAMP_SCHEMA: &str = "skipi.package-build.v1";

/// One file as it was actually written into the archive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PackageEntryStamp {
    doc_id: String,
    /// Name in the vault.
    file_name: String,
    /// Name inside the ZIP — may carry a `-2` suffix after de-duplication.
    zip_name: String,
    size: u64,
    sha256: String,
}

/// `_packages/<id>.json` — written ONLY after a complete, renamed archive.
/// It carries the single honest answer to "how fresh is this package": the time
/// of the last SUCCESSFUL build. `mtime` of the ZIP deliberately is NOT that
/// answer — vault export/import goes through `ZipWriter`/`ZipArchive`, so after
/// a restore the mtime is the time of unpacking, i.e. exactly the "unknown time
/// replaced by today" the owner forbade.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackageBuildStamp {
    schema: String,
    /// ISO-8601 WITH a zone (`…Z`), unlike the naive `created_on` in SQLite.
    built_at: String,
    vault_identity: String,
    fingerprint: String,
    entries: Vec<PackageEntryStamp>,
}

/// A file the build is about to write, plus where to read it from.
struct PlannedEntry {
    doc_id: String,
    source: PathBuf,
    stamp: PackageEntryStamp,
}

fn packages_dir(vault_path: &Path) -> PathBuf {
    vault_path.join("_packages")
}

fn package_zip_path(vault_path: &Path, id: &str) -> PathBuf {
    packages_dir(vault_path).join(format!("{}.zip", id))
}

fn package_stamp_path(vault_path: &Path, id: &str) -> PathBuf {
    packages_dir(vault_path).join(format!("{}.json", id))
}

fn iso8601_utc_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// The last path component, and only that. A `file_name` carrying `../` never
/// reaches `vault_path.join(...)` and never becomes a ZIP entry name.
fn safe_vault_file_name(raw: &str) -> Option<String> {
    let name = Path::new(raw).file_name()?.to_str()?.to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some(name)
}

/// Two documents in different categories may carry the same `file_name`. Written
/// as-is they become two ZIP entries with one name: unzip keeps ONE file while
/// `file_count` still claims two. The suffix keeps the count honest.
fn dedupe_zip_name(used: &mut HashSet<String>, name: &str) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 2u32;
    loop {
        let candidate = format!("{}-{}{}", stem, n, ext);
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

fn sha256_of_file(path: &Path) -> Result<(String, u64), String> {
    let data = fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok((format!("{:x}", hasher.finalize()), data.len() as u64))
}

/// Content fingerprint of a would-be package: the vault identity plus every
/// file's id, name, size and sha256. Sizes and counts alone cannot see a
/// same-name/same-size replacement; the sha256 can, which is the whole point.
fn fingerprint_of(vault_identity: &str, entries: &[PackageEntryStamp]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"skipi.package-fingerprint.v1\n");
    hasher.update(vault_identity.as_bytes());
    hasher.update(b"\n");
    let mut sorted: Vec<&PackageEntryStamp> = entries.iter().collect();
    sorted.sort_by(|a, b| a.doc_id.cmp(&b.doc_id).then(a.zip_name.cmp(&b.zip_name)));
    for e in sorted {
        hasher.update(
            format!(
                "{}\t{}\t{}\t{}\t{}\n",
                e.doc_id, e.file_name, e.zip_name, e.size, e.sha256
            )
            .as_bytes(),
        );
    }
    format!("{:x}", hasher.finalize())
}

/// Which vault/account these bytes belong to. Switching account (or restoring a
/// different vault over a surviving sidecar) changes this string, so the
/// fingerprint no longer matches and the package is rebuilt instead of shipping
/// the previous account's attachments.
fn vault_identity(conn: &Connection) -> String {
    let user = db::get_vault_info_value(conn, "user_id").unwrap_or_default();
    let key = db::get_vault_info_value(conn, "identity_pubkey").unwrap_or_default();
    format!("user:{}|key:{}", user, key)
}

fn read_build_stamp(vault_path: &Path, id: &str) -> Option<PackageBuildStamp> {
    let raw = fs::read_to_string(package_stamp_path(vault_path, id)).ok()?;
    serde_json::from_str::<PackageBuildStamp>(&raw).ok()
}

/// Written atomically and LAST, so "Updated" can never run ahead of the bytes a
/// recipient would actually get.
fn write_build_stamp(vault_path: &Path, id: &str, stamp: &PackageBuildStamp) -> Result<(), String> {
    let dir = packages_dir(vault_path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = package_stamp_path(vault_path, id);
    let tmp = dir.join(format!("{}.json.tmp", id));
    let data = serde_json::to_vec_pretty(stamp).map_err(|e| e.to_string())?;
    fs::write(&tmp, &data).map_err(|e| format!("Write package stamp: {}", e))?;
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Commit package stamp: {}", e)
    })
}

/// The sidecar lives and dies with the archive. An orphaned stamp would report a
/// successful build time for a package that no longer exists.
fn remove_build_stamp(vault_path: &Path, id: &str) {
    let _ = fs::remove_file(package_stamp_path(vault_path, id));
}

/// Stamp every file that would go into the package, in archive order.
/// Reading each file here is what makes "same name, same size, new bytes"
/// detectable at all. A document whose file cannot be read is an ERROR, not a
/// silent omission: a partial archive must never be handed over as
/// "all documents".
fn plan_entries(vault_path: &Path, docs: &[db::DocRecord]) -> Result<Vec<PlannedEntry>, String> {
    let mut used: HashSet<String> = HashSet::new();
    let mut out: Vec<PlannedEntry> = Vec::new();
    let mut unreadable: Vec<String> = Vec::new();
    for doc in docs {
        let raw = match doc.file_name.as_ref() {
            Some(f) if !f.trim().is_empty() => f.clone(),
            _ => continue,
        };
        let fname = match safe_vault_file_name(&raw) {
            Some(f) => f,
            None => {
                unreadable.push(format!("{} (unsupported file name)", doc.title));
                continue;
            }
        };
        let source = vault_path.join(&doc.category).join(&fname);
        let (sha256, size) = match sha256_of_file(&source) {
            Ok(v) => v,
            Err(_) => {
                unreadable.push(format!("{} ({})", doc.title, fname));
                continue;
            }
        };
        let zip_name = dedupe_zip_name(&mut used, &fname);
        out.push(PlannedEntry {
            doc_id: doc.id.clone(),
            source,
            stamp: PackageEntryStamp {
                doc_id: doc.id.clone(),
                file_name: fname,
                zip_name,
                size,
                sha256,
            },
        });
    }
    if !unreadable.is_empty() {
        return Err(format!(
            "Cannot build the package — {} document file(s) cannot be read:\n• {}",
            unreadable.len(),
            unreadable.join("\n• ")
        ));
    }
    Ok(out)
}

fn write_package_zip(entries: &[PlannedEntry], dest: &Path) -> Result<(), String> {
    let file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in entries {
        let data =
            fs::read(&entry.source).map_err(|e| format!("{}: {}", entry.source.display(), e))?;
        zip.start_file(entry.stamp.zip_name.clone(), options)
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Build into a temp file next to the destination and publish it with ONE
/// atomic rename.
///
/// The rename is the single commit point, and it happens BEFORE the database
/// transaction on purpose. `get_packages` derives `file_count` from
/// `package_files` while `prepare_dispatch_attachments` only checks that the ZIP
/// exists and hands over the path — so if the database were committed first,
/// every Share in the window between COMMIT and rename would carry the OLD
/// archive under the NEW count. In this order the only transient state is
/// "archive already new, counter still old": a recipient may get fresher bytes
/// than promised, never staler ones. A failure at any step leaves the previous
/// working archive and its stamp untouched.
fn build_package_zip_atomically(
    vault_path: &Path,
    id: &str,
    entries: &[PlannedEntry],
) -> Result<(), String> {
    let dir = packages_dir(vault_path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = package_zip_path(vault_path, id);
    let tmp = dir.join(format!("{}.zip.tmp", id));
    let _ = fs::remove_file(&tmp);
    if let Err(e) = write_package_zip(entries, &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Commit package archive: {}", e)
    })
}

/// Deleting the automatic package is refused in RUST, not in a button: the
/// desktop list has its own delete control that this slice does not touch, and
/// `db::delete_package` has exactly one caller in the whole tree, so the guard
/// here closes the entire path.
fn reject_system_package_deletion(package_id: &str) -> Result<(), String> {
    if package_id == ALL_DOCS_PACKAGE_ID {
        return Err(
            "\"All documents\" is kept up to date by Skipi and cannot be deleted. Delete the documents themselves if you do not want them shared."
                .to_string(),
        );
    }
    Ok(())
}

/// Bring the automatic package in line with the vault. Idempotent and cheap:
/// it fingerprints the current files, compares, and rebuilds ONLY on a
/// mismatch — so opening the screen, restarting, switching language, repeating
/// a sync or double-tapping never moves "Updated" and never creates a copy.
///
/// Returns `true` when something was actually rebuilt (or removed).
fn ensure_all_documents_package_inner(
    conn: &Connection,
    vault_path: &Path,
) -> Result<bool, String> {
    let all_docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let exists = db::get_all_packages(conn)
        .map_err(|e| e.to_string())?
        .iter()
        .any(|p| p.id == ALL_DOCS_PACKAGE_ID);

    // Exactly `uploadedDocsForSharing()` on the JS side: documents of THIS vault
    // that have a file. Sea-service scans (`work_history_files`) are a different
    // export with a different contract and are NOT part of this package.
    let shareable: Vec<db::DocRecord> = all_docs
        .into_iter()
        .filter(|d| {
            d.file_name
                .as_ref()
                .map(|f| !f.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();

    if shareable.is_empty() {
        // Nothing to package: the system package is not created. An older one
        // does not survive as an empty promise either.
        if exists {
            db::delete_package(conn, ALL_DOCS_PACKAGE_ID).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(package_zip_path(vault_path, ALL_DOCS_PACKAGE_ID));
            remove_build_stamp(vault_path, ALL_DOCS_PACKAGE_ID);
            return Ok(true);
        }
        return Ok(false);
    }

    let entries = plan_entries(vault_path, &shareable)?;
    let identity = vault_identity(conn);
    let stamps: Vec<PackageEntryStamp> = entries.iter().map(|e| e.stamp.clone()).collect();
    let fingerprint = fingerprint_of(&identity, &stamps);

    let archive_present = package_zip_path(vault_path, ALL_DOCS_PACKAGE_ID).exists();
    let stamp_matches = read_build_stamp(vault_path, ALL_DOCS_PACKAGE_ID)
        .map(|s| s.fingerprint == fingerprint && s.vault_identity == identity)
        .unwrap_or(false);
    if exists && archive_present && stamp_matches {
        return Ok(false);
    }

    // Order is load-bearing — see build_package_zip_atomically.
    build_package_zip_atomically(vault_path, ALL_DOCS_PACKAGE_ID, &entries)?;

    let expires = (chrono::Utc::now() + chrono::Duration::days(ALL_DOCS_EXPIRY_DAYS))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    // One transaction: at no instant does a reader see "the system package is
    // gone" and create a second one.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::delete_package(&tx, ALL_DOCS_PACKAGE_ID).map_err(|e| e.to_string())?;
    db::create_package(
        &tx,
        ALL_DOCS_PACKAGE_ID,
        ALL_DOCS_PACKAGE_TITLE,
        &expires,
        ALL_DOCS_DOWNLOAD_LIMIT,
        None,
    )
    .map_err(|e| e.to_string())?;
    for entry in &entries {
        let pf_id = uuid::Uuid::new_v4().to_string();
        db::add_package_file(
            &tx,
            &pf_id,
            ALL_DOCS_PACKAGE_ID,
            &entry.doc_id,
            &entry.stamp.zip_name,
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    write_build_stamp(
        vault_path,
        ALL_DOCS_PACKAGE_ID,
        &PackageBuildStamp {
            schema: PACKAGE_STAMP_SCHEMA.to_string(),
            built_at: iso8601_utc_now(),
            vault_identity: identity,
            fingerprint,
            entries: stamps,
        },
    )?;
    Ok(true)
}

/// Refresh the automatic package and return its reserved id.
///
/// A separate command on purpose — NOT a second `create_package` call from JS:
/// the mobile screen must keep the property that a user action is the only
/// thing that ever creates a package of their own.
#[tauri::command]
pub fn ensure_all_documents_package(state: State<AppState>) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    ensure_all_documents_package_inner(conn, vault_path)?;
    let present = db::get_all_packages(conn)
        .map_err(|e| e.to_string())?
        .iter()
        .any(|p| p.id == ALL_DOCS_PACKAGE_ID);
    if !present {
        return Err("No uploaded document files yet — there is nothing to package.".to_string());
    }
    Ok(ALL_DOCS_PACKAGE_ID.to_string())
}

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

    // Same order as the automatic package: complete archive first, one atomic
    // rename, then the database. Previously the row was INSERTed before the ZIP
    // existed, so a failure halfway left a package the UI listed and no file to
    // attach to it.
    let ordered: Vec<db::DocRecord> = doc_ids
        .iter()
        .filter_map(|id| all_docs.iter().find(|d| &d.id == id).cloned())
        .collect();
    let entries = plan_entries(vault_path, &ordered)?;
    build_package_zip_atomically(vault_path, &pkg_id, &entries)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::create_package(&tx, &pkg_id, &title, &expires_str, download_limit, None)
        .map_err(|e| e.to_string())?;
    for entry in &entries {
        let pf_id = uuid::Uuid::new_v4().to_string();
        db::add_package_file(&tx, &pf_id, &pkg_id, &entry.doc_id, &entry.stamp.zip_name)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // A brand-new manual package: the time of its creation IS the time of its
    // last successful build, so it carries the same honest "Updated" mark as the
    // automatic one. Best-effort — a package that exists with a readable archive
    // must not be reported as a failure because its stamp could not be written;
    // without the stamp the card simply falls back to "Created: <created_on>".
    let identity = vault_identity(conn);
    let stamps: Vec<PackageEntryStamp> = entries.iter().map(|e| e.stamp.clone()).collect();
    let fingerprint = fingerprint_of(&identity, &stamps);
    let _ = write_build_stamp(
        vault_path,
        &pkg_id,
        &PackageBuildStamp {
            schema: PACKAGE_STAMP_SCHEMA.to_string(),
            built_at: iso8601_utc_now(),
            vault_identity: identity,
            fingerprint,
            entries: stamps,
        },
    );

    Ok(pkg_id)
}

/// The package list, with two derived fields the database does not hold:
/// `updated_on` (time of the last SUCCESSFUL build, from the sidecar — `null`
/// for a legacy package that has never been rebuilt) and `is_system`.
///
/// The automatic package is refreshed HERE, in Rust, rather than from the phone
/// screen: the desktop list also goes through this command, and its own
/// `!pkgs.length && uploadedDocs.length` branch would otherwise create a second,
/// title-based "All Documents" for a desktop-first user — and again in the split
/// second when a rebuild had emptied the table. With the ensure inside the
/// listing, the list is never empty while the vault has files, so that branch is
/// unreachable without a single byte of the frozen desktop code being touched.
///
/// An ensure failure must NOT hide the packages the user already has, so it is
/// not fatal here: the list still renders, "Updated" keeps showing the last
/// successful build (never a newer date), and the Share path calls the ensure
/// command explicitly, where the error is shown and nothing stale is sent.
#[tauri::command]
pub fn get_packages(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    if let Some(vault_path) = vault_lock.as_ref() {
        let _ = ensure_all_documents_package_inner(conn, vault_path);
    }
    let rows = db::get_all_packages(conn).map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(rows.len());
    for p in &rows {
        let mut value = serde_json::to_value(p).map_err(|e| e.to_string())?;
        let updated = vault_lock
            .as_ref()
            .and_then(|vp| read_build_stamp(vp, &p.id))
            .map(|s| s.built_at);
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "updated_on".to_string(),
                match updated {
                    Some(t) => serde_json::Value::String(t),
                    None => serde_json::Value::Null,
                },
            );
            obj.insert(
                "is_system".to_string(),
                serde_json::Value::Bool(p.id == ALL_DOCS_PACKAGE_ID),
            );
        }
        out.push(value);
    }
    Ok(out)
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
    reject_system_package_deletion(&package_id)?;

    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    let zip_path = package_zip_path(vault_path, &package_id);
    if zip_path.exists() {
        let _ = fs::remove_file(zip_path);
    }
    // The stamp dies with the archive: an orphan would report a successful
    // build time for a package that no longer exists.
    remove_build_stamp(vault_path, &package_id);
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
    use super::*;
    use super::normalize_mail_body;
    use std::io::Read;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "skipi-pkg-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put_doc(
        conn: &Connection,
        vault: &Path,
        id: &str,
        category: &str,
        title: &str,
        file_name: &str,
        bytes: &[u8],
    ) {
        let rec = db::DocRecord {
            id: id.to_string(),
            category: category.to_string(),
            title: title.to_string(),
            file_name: if file_name.is_empty() {
                None
            } else {
                Some(file_name.to_string())
            },
            has_expiry: false,
            is_permanent: false,
            valid_from: None,
            valid_to: None,
            issued_by: None,
            doc_number: None,
            notes: None,
            field_statuses: None,
            regulatory_basis: None,
            template_id: None,
            sha256: None,
            file_size: None,
            content_type: None,
            visibility: "private".to_string(),
            is_national: false,
        };
        db::insert_doc(conn, &rec).unwrap();
        if !file_name.is_empty() {
            let dir = vault.join(category);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(file_name), bytes).unwrap();
        }
    }

    fn system_zip(vault: &Path) -> PathBuf {
        package_zip_path(vault, ALL_DOCS_PACKAGE_ID)
    }

    fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
        let file = fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            out.push((name, buf));
        }
        out
    }

    fn system_record(conn: &Connection) -> Option<db::PackageRecord> {
        db::get_all_packages(conn)
            .unwrap()
            .into_iter()
            .find(|p| p.id == ALL_DOCS_PACKAGE_ID)
    }

    // ---- pure helpers -----------------------------------------------------

    #[test]
    fn dedupe_zip_name_keeps_every_colliding_file_and_its_extension() {
        let mut used = HashSet::new();
        assert_eq!(dedupe_zip_name(&mut used, "passport.pdf"), "passport.pdf");
        assert_eq!(dedupe_zip_name(&mut used, "passport.pdf"), "passport-2.pdf");
        assert_eq!(dedupe_zip_name(&mut used, "passport.pdf"), "passport-3.pdf");
        assert_eq!(dedupe_zip_name(&mut used, "noext"), "noext");
        assert_eq!(dedupe_zip_name(&mut used, "noext"), "noext-2");
        assert_eq!(dedupe_zip_name(&mut used, ".hidden"), ".hidden");
        assert_eq!(dedupe_zip_name(&mut used, ".hidden"), ".hidden-2");
    }

    #[test]
    fn safe_vault_file_name_strips_any_path_component() {
        assert_eq!(
            safe_vault_file_name("../../skipi.db"),
            Some("skipi.db".to_string())
        );
        assert_eq!(
            safe_vault_file_name("_identity/key.pem"),
            Some("key.pem".to_string())
        );
        assert_eq!(safe_vault_file_name(".."), None);
        assert_eq!(safe_vault_file_name(""), None);
        for raw in ["../../skipi.db", "a/b/c.pdf", "_identity/key.pem"] {
            let name = safe_vault_file_name(raw).unwrap();
            assert!(!name.contains('/') && !name.contains('\\'), "{}", name);
        }
    }

    #[test]
    fn fingerprint_sees_new_bytes_under_the_same_name_and_size() {
        let base = PackageEntryStamp {
            doc_id: "d1".into(),
            file_name: "passport.pdf".into(),
            zip_name: "passport.pdf".into(),
            size: 10,
            sha256: "aaaa".into(),
        };
        let mut replaced = base.clone();
        replaced.sha256 = "bbbb".into();
        assert_ne!(
            fingerprint_of("user:u1|key:", std::slice::from_ref(&base)),
            fingerprint_of("user:u1|key:", std::slice::from_ref(&replaced)),
            "same name, same size, different bytes must change the fingerprint"
        );
        assert_ne!(
            fingerprint_of("user:u1|key:", std::slice::from_ref(&base)),
            fingerprint_of("user:u2|key:", std::slice::from_ref(&base)),
            "another vault identity must change the fingerprint"
        );
        assert_eq!(
            fingerprint_of("user:u1|key:", std::slice::from_ref(&base)),
            fingerprint_of("user:u1|key:", std::slice::from_ref(&base)),
            "the fingerprint is stable for identical input"
        );
    }

    #[test]
    fn build_stamp_time_carries_a_zone() {
        let now = iso8601_utc_now();
        assert!(now.ends_with('Z'), "got {}", now);
        assert!(
            chrono::DateTime::parse_from_rfc3339(&now).is_ok(),
            "got {}",
            now
        );
    }

    #[test]
    fn delete_package_refuses_the_reserved_id() {
        let err = reject_system_package_deletion(ALL_DOCS_PACKAGE_ID).unwrap_err();
        assert!(err.contains("All documents"), "got {}", err);
        assert!(err.contains("cannot be deleted"), "got {}", err);
        assert!(reject_system_package_deletion("pkg-a").is_ok());
    }

    // ---- the automatic package against a real vault ------------------------

    #[test]
    fn system_package_is_created_once_and_is_idempotent() {
        let vault = temp_vault("idem");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        put_doc(&conn, &vault, "d2", "personal", "Seaman Book", "sb.pdf", b"B");

        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let first = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        let rec = system_record(&conn).unwrap();
        assert_eq!(rec.file_count, 2);
        assert_eq!(zip_entries(&system_zip(&vault)).len(), 2);

        // Opening the screen again, restarting, switching language, repeating a
        // sync, double-tapping: all of them land here, and none of them may
        // rebuild anything or move the date.
        for _ in 0..5 {
            assert!(
                !ensure_all_documents_package_inner(&conn, &vault).unwrap(),
                "a second ensure with unchanged files must not rebuild"
            );
        }
        let again = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        assert_eq!(first.built_at, again.built_at, "Updated must not move");
        assert_eq!(first.fingerprint, again.fingerprint);
        assert_eq!(
            db::get_all_packages(&conn)
                .unwrap()
                .iter()
                .filter(|p| p.id == ALL_DOCS_PACKAGE_ID)
                .count(),
            1,
            "exactly one system package"
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn system_package_rebuilds_on_add_replace_and_delete() {
        let vault = temp_vault("content");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"AAAA");
        put_doc(&conn, &vault, "d2", "personal", "Seaman Book", "sb.pdf", b"BBBB");
        put_doc(&conn, &vault, "d3", "medical", "Yellow Fever", "yf.pdf", b"CCCC");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let after_three = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        assert_eq!(system_record(&conn).unwrap().file_count, 3);

        // add a fourth
        put_doc(&conn, &vault, "d4", "certificates", "GMDSS", "gmdss.pdf", b"DDDD");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert_eq!(system_record(&conn).unwrap().file_count, 4);
        assert_eq!(zip_entries(&system_zip(&vault)).len(), 4);

        // replace the BYTES of one file, keeping the same name, the same size
        // and the same count — the case a file counter can never see.
        let after_four = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        fs::write(vault.join("personal").join("passport.pdf"), b"ZZZZ").unwrap();
        assert!(
            ensure_all_documents_package_inner(&conn, &vault).unwrap(),
            "same name, same size, new bytes MUST rebuild"
        );
        let replaced = zip_entries(&system_zip(&vault));
        assert_eq!(replaced.len(), 4);
        assert_eq!(
            replaced
                .iter()
                .find(|(n, _)| n == "passport.pdf")
                .map(|(_, b)| b.clone())
                .unwrap(),
            b"ZZZZ".to_vec()
        );
        let after_replace = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        assert_ne!(after_four.fingerprint, after_replace.fingerprint);
        assert_ne!(after_three.fingerprint, after_replace.fingerprint);

        // delete one document
        conn.execute("DELETE FROM documents WHERE id = 'd3'", [])
            .unwrap();
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let left = zip_entries(&system_zip(&vault));
        assert_eq!(left.len(), 3);
        assert!(!left.iter().any(|(n, _)| n == "yf.pdf"));
        assert_eq!(system_record(&conn).unwrap().file_count, 3);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn system_package_follows_the_vault_identity() {
        let vault = temp_vault("identity");
        let conn = db::open_db(&vault).unwrap();
        db::set_vault_info(&conn, "user_id", "account-one").unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert!(!ensure_all_documents_package_inner(&conn, &vault).unwrap());

        // The same files, another account: the surviving sidecar must not be
        // accepted as proof that the archive belongs to this vault.
        db::set_vault_info(&conn, "user_id", "account-two").unwrap();
        assert!(
            ensure_all_documents_package_inner(&conn, &vault).unwrap(),
            "an account switch must rebuild"
        );
        assert_eq!(
            read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID)
                .unwrap()
                .vault_identity,
            "user:account-two|key:"
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn colliding_file_names_stay_readable_and_the_count_stays_honest() {
        let vault = temp_vault("collide");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Scan", "scan.pdf", b"PERSONAL");
        put_doc(&conn, &vault, "d2", "medical", "Scan", "scan.pdf", b"MEDICAL");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());

        let entries = zip_entries(&system_zip(&vault));
        assert_eq!(entries.len(), 2, "both files are in the archive");
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"scan.pdf") && names.contains(&"scan-2.pdf"), "got {:?}", names);
        let bodies: Vec<Vec<u8>> = entries.iter().map(|(_, b)| b.clone()).collect();
        assert!(bodies.contains(&b"PERSONAL".to_vec()) && bodies.contains(&b"MEDICAL".to_vec()));
        assert_eq!(
            system_record(&conn).unwrap().file_count as usize,
            entries.len(),
            "file_count must equal the number of entries actually in the ZIP"
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn system_package_carries_only_vault_documents_with_a_file() {
        let vault = temp_vault("scope");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        put_doc(&conn, &vault, "d2", "certificates", "GMDSS", "", b"");
        // Private material that must never be swept in by a directory walk.
        fs::create_dir_all(vault.join("_identity")).unwrap();
        fs::write(vault.join("_identity").join("key.pem"), b"SECRET").unwrap();
        fs::create_dir_all(vault.join("_sync")).unwrap();
        fs::write(vault.join("_sync").join("queue.json"), b"QUEUE").unwrap();

        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let entries = zip_entries(&system_zip(&vault));
        assert_eq!(entries.len(), 1, "the document with no file is not an attachment");
        assert_eq!(entries[0].0, "passport.pdf");
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        for forbidden in ["key.pem", "queue.json", "skipi.db"] {
            assert!(!names.iter().any(|n| n.contains(forbidden)), "{:?}", names);
        }
        assert!(!names.iter().any(|n| n.contains("..")), "{:?}", names);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_file_name_that_tries_to_escape_the_vault_never_builds_a_package() {
        let vault = temp_vault("traversal");
        let conn = db::open_db(&vault).unwrap();
        fs::write(vault.join("skipi-secret.txt"), b"SECRET").unwrap();
        put_doc(
            &conn,
            &vault,
            "d1",
            "personal",
            "Hostile",
            "../skipi-secret.txt",
            b"",
        );
        let err = ensure_all_documents_package_inner(&conn, &vault).unwrap_err();
        assert!(err.contains("cannot be read"), "got {}", err);
        assert!(
            !system_zip(&vault).exists(),
            "a partial/hostile archive must not be published"
        );
        assert!(system_record(&conn).is_none());
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unreadable_file_keeps_the_previous_package_and_its_date() {
        let vault = temp_vault("failure");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let good_stamp = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();
        let good_zip = fs::read(system_zip(&vault)).unwrap();

        // A second document whose file never made it to disk.
        put_doc(&conn, &vault, "d2", "medical", "Missing", "gone.pdf", b"");
        fs::remove_file(vault.join("medical").join("gone.pdf")).unwrap();
        let err = ensure_all_documents_package_inner(&conn, &vault).unwrap_err();
        assert!(err.contains("Missing"), "the error names the document: {}", err);

        assert_eq!(fs::read(system_zip(&vault)).unwrap(), good_zip, "old archive intact");
        assert_eq!(
            read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap().built_at,
            good_stamp.built_at,
            "a failed build must not move Updated"
        );
        assert_eq!(system_record(&conn).unwrap().file_count, 1);
        assert!(!packages_dir(&vault)
            .join(format!("{}.zip.tmp", ALL_DOCS_PACKAGE_ID))
            .exists(), "no half-written archive left behind");

        // Fix the cause and repeat: the rebuild then completes normally.
        fs::write(vault.join("medical").join("gone.pdf"), b"BB").unwrap();
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert_eq!(zip_entries(&system_zip(&vault)).len(), 2);
        assert_ne!(
            read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap().built_at.len(),
            0
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_interruption_between_rename_and_commit_never_ships_the_older_archive() {
        let vault = temp_vault("order");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"OLD");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let before = read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap();

        // Replay exactly the window the commit order creates: the archive has
        // been renamed into place, the transaction and the sidecar have not
        // happened yet (process killed in between).
        put_doc(&conn, &vault, "d2", "medical", "Yellow Fever", "yf.pdf", b"NEW");
        let docs = db::get_all_docs(&conn).unwrap();
        let entries = plan_entries(&vault, &docs).unwrap();
        build_package_zip_atomically(&vault, ALL_DOCS_PACKAGE_ID, &entries).unwrap();

        // What a Share started in that window would carry: the NEW bytes.
        let staged = zip_entries(&system_zip(&vault));
        assert_eq!(staged.len(), 2, "the archive on disk is already the new one");
        // What the list still claims, and what "Updated" still says: the OLD,
        // smaller truth. A recipient can get fresher bytes than promised, never
        // staler ones.
        assert_eq!(system_record(&conn).unwrap().file_count, 1);
        assert_eq!(
            read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).unwrap().built_at,
            before.built_at
        );

        // The next ensure heals the state: the fingerprint no longer matches the
        // sidecar, so the package is rebuilt in full and there is still one.
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert_eq!(system_record(&conn).unwrap().file_count, 2);
        assert_eq!(
            db::get_all_packages(&conn)
                .unwrap()
                .iter()
                .filter(|p| p.id == ALL_DOCS_PACKAGE_ID)
                .count(),
            1
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_users_own_all_documents_package_is_never_adopted_or_rewritten() {
        let vault = temp_vault("legacy");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        // A legacy vault: the user's own package, created by the old title-based
        // code, with the very same name.
        db::create_package(&conn, "legacy-uuid", "All Documents", "2027-01-01T00:00:00", 999, None)
            .unwrap();
        db::add_package_file(&conn, "pf-legacy", "legacy-uuid", "d1", "passport.pdf").unwrap();

        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let all = db::get_all_packages(&conn).unwrap();
        assert_eq!(all.len(), 2, "the user's package survives beside the system one");
        let legacy = all.iter().find(|p| p.id == "legacy-uuid").unwrap();
        assert_eq!(legacy.title, "All Documents", "not renamed");
        assert_eq!(legacy.file_count, 1, "its chosen content is untouched");
        assert!(all.iter().any(|p| p.id == ALL_DOCS_PACKAGE_ID));
        assert!(
            read_build_stamp(&vault, "legacy-uuid").is_none(),
            "a package that was never rebuilt has no Updated mark — the card says Created instead"
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_expired_system_package_is_refreshed_not_duplicated() {
        let vault = temp_vault("expiry");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());

        // Age it past its expiry, exactly as a year of use would.
        conn.execute(
            "UPDATE packages SET expires_on = '2020-01-01T00:00:00' WHERE id = ?1",
            rusqlite::params![ALL_DOCS_PACKAGE_ID],
        )
        .unwrap();
        // Content is unchanged, so nothing is rebuilt …
        assert!(!ensure_all_documents_package_inner(&conn, &vault).unwrap());
        // … and the lookup still finds it by id despite the dead expiry: no
        // second package appears.
        assert_eq!(
            db::get_all_packages(&conn)
                .unwrap()
                .iter()
                .filter(|p| p.id == ALL_DOCS_PACKAGE_ID)
                .count(),
            1
        );
        // On the next real change the expiry is refreshed with the rebuild.
        fs::write(vault.join("personal").join("passport.pdf"), b"BB").unwrap();
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        let rec = system_record(&conn).unwrap();
        assert!(rec.expires_on.as_str() > "2026-09-14T00:00:00", "got {}", rec.expires_on);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_empty_vault_gets_no_system_package_and_a_emptied_one_loses_it() {
        let vault = temp_vault("empty");
        let conn = db::open_db(&vault).unwrap();
        assert!(!ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert!(system_record(&conn).is_none());
        assert!(!system_zip(&vault).exists());

        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert!(system_record(&conn).is_some());

        conn.execute("DELETE FROM documents", []).unwrap();
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        assert!(system_record(&conn).is_none(), "no empty promise is left behind");
        assert!(!system_zip(&vault).exists());
        assert!(
            read_build_stamp(&vault, ALL_DOCS_PACKAGE_ID).is_none(),
            "the sidecar dies with the archive"
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_missing_archive_is_rebuilt_even_when_the_sidecar_still_matches() {
        let vault = temp_vault("zipgone");
        let conn = db::open_db(&vault).unwrap();
        put_doc(&conn, &vault, "d1", "personal", "Passport", "passport.pdf", b"A");
        assert!(ensure_all_documents_package_inner(&conn, &vault).unwrap());
        fs::remove_file(system_zip(&vault)).unwrap();
        assert!(
            ensure_all_documents_package_inner(&conn, &vault).unwrap(),
            "a stamp alone is not proof that the archive exists"
        );
        assert!(system_zip(&vault).exists());
        let _ = fs::remove_dir_all(&vault);
    }

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

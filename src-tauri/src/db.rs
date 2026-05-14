use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DocRecord {
    pub id: String,
    pub category: String,
    pub title: String,
    pub file_name: Option<String>,
    pub has_expiry: bool,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub issued_by: Option<String>,
    pub doc_number: Option<String>,
    pub notes: Option<String>,
    pub field_statuses: Option<String>,
    pub regulatory_basis: Option<String>,
    pub template_id: Option<String>,
    // Phase-2 readiness (ARCHITECTURE_PHASE2.md I-4, I-5).
    // `sha256` / `file_size` / `content_type` make documents content-addressable
    // for future peer-to-peer exchange; `visibility` carries the per-document
    // opt-in flag (`private` by default, `shareable` once the user marks it).
    // All four are Option/default so legacy rows and freshly-framework-generated
    // rows keep working until a file is actually attached.
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default = "default_visibility")]
    pub visibility: String,
    // Whether this is the national/primary document in its category
    // (e.g. national seaman's book vs flag-state books).
    #[serde(default)]
    pub is_national: bool,
}

fn default_visibility() -> String {
    "private".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VaultInfo {
    pub account_type: String,
    pub name: String,
    pub rank: Option<String>,
    pub vessel_type: Option<String>,
    /// Wizard slug, e.g. "second_officer" — used as Jobs filter fallback
    /// when the user hasn't filled Personal Details > Rank.
    pub position: Option<String>,
    /// Wizard slug, e.g. "bulker".
    pub vessel_category: Option<String>,
}

/// Ordered list of schema migrations.
/// Each entry: (version, sql). Versions MUST be sequential starting at 1.
/// NEVER edit past migrations — only append new ones. Old vaults rely on
/// each migration being byte-identical to what they saw on first run.
///
/// Migration #1 is the baseline: matches what existing vaults already have
/// after the original `CREATE TABLE IF NOT EXISTS + ALTER TABLE` pattern.
/// Because of `IF NOT EXISTS` it's safe to re-run on fresh vaults.
fn migrations() -> Vec<(u32, &'static str)> {
    vec![
        (
            1,
            r#"
            CREATE TABLE IF NOT EXISTS vault_info (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                file_name TEXT,
                has_expiry INTEGER DEFAULT 0,
                valid_from TEXT,
                valid_to TEXT,
                issued_by TEXT,
                doc_number TEXT,
                notes TEXT,
                field_statuses TEXT DEFAULT '{}',
                regulatory_basis TEXT,
                template_id TEXT
            );
            CREATE TABLE IF NOT EXISTS packages (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_on TEXT NOT NULL,
                expires_on TEXT NOT NULL,
                download_count INTEGER DEFAULT 0,
                download_limit INTEGER DEFAULT 10,
                password TEXT
            );
            CREATE TABLE IF NOT EXISTS package_files (
                id TEXT PRIMARY KEY,
                package_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                FOREIGN KEY(package_id) REFERENCES packages(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS ai_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_type TEXT NOT NULL,
                field_name TEXT NOT NULL,
                ai_value TEXT,
                correct_value TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS work_history (
                id TEXT PRIMARY KEY,
                vessel_name TEXT NOT NULL,
                vessel_type TEXT,
                imo TEXT,
                flag TEXT,
                company TEXT,
                position TEXT NOT NULL,
                sign_on TEXT,
                sign_off TEXT,
                notes TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS work_history_files (
                id TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                kind TEXT,
                FOREIGN KEY(entry_id) REFERENCES work_history(id) ON DELETE CASCADE
            );
        "#,
        ),
        // Dispatch history (Рассылка): record of each package + CV send-off
        (
            2,
            r#"
            CREATE TABLE IF NOT EXISTS dispatches (
                id TEXT PRIMARY KEY,
                package_id TEXT NOT NULL,
                recipients TEXT NOT NULL,
                subject TEXT,
                cv_path TEXT,
                created_at TEXT NOT NULL
            );
        "#,
        ),
        // Phase-2 readiness — see docs/ARCHITECTURE_PHASE2.md (I-4..I-6).
        //   * Content-addressable columns on documents so the phase-2 server
        //     and receiving parties can verify integrity and diff versions
        //     without re-sending the whole file.
        //   * Visibility column so per-document opt-in can be recorded
        //     locally before the server even exists.
        //   * events table: append-only log of structured mutations; will
        //     become the phase-2 incremental sync journal. In phase 1 it's
        //     written but never read by anything outside the vault.
        //
        // ALTER TABLE is wrapped in subqueries that no-op if the column
        // already exists so re-running on freshly-created vaults is safe.
        // rusqlite does not support "ALTER TABLE ... ADD COLUMN IF NOT EXISTS"
        // so we rely on the migration version check to run this exactly once.
        (
            3,
            r#"
            ALTER TABLE documents ADD COLUMN sha256 TEXT;
            ALTER TABLE documents ADD COLUMN file_size INTEGER;
            ALTER TABLE documents ADD COLUMN content_type TEXT;
            ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                kind TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT,
                payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        "#,
        ),
        // Migration 4: is_national flag for Seaman's Books and CoCs.
        // Only one document per category can be marked national.
        (
            4,
            r#"
            ALTER TABLE documents ADD COLUMN is_national INTEGER NOT NULL DEFAULT 0;
        "#,
        ),
        // Migration 5: evidence_folder on work-history entries — absolute
        // path to a folder on the user's device that holds contract evidence
        // (photos aboard, crew list, discharge letter, payslips). Skipi only
        // stores the pointer; files live outside the vault and Skipi opens
        // the folder in the OS file manager on request.
        (
            5,
            r#"
            ALTER TABLE work_history ADD COLUMN evidence_folder TEXT;
        "#,
        ),
        // Migration 6: promote AI corrections into a local OCR-label stream.
        // Values may contain document identifiers and OCR text, so this stays
        // inside the private vault unless the user explicitly exports labels.
        (
            6,
            r#"
            ALTER TABLE ai_corrections ADD COLUMN doc_id TEXT;
            ALTER TABLE ai_corrections ADD COLUMN file_sha256 TEXT;
            ALTER TABLE ai_corrections ADD COLUMN label_json TEXT;
        "#,
        ),
        // Migration 7: optional vessel capacity on Sea Service entries.
        // HR teams often screen CV emails from preview text; DWT / TEU lets
        // Skipi summarize the last vessel without forcing them to open a CV.
        (
            7,
            r#"
            ALTER TABLE work_history ADD COLUMN dwt TEXT;
            ALTER TABLE work_history ADD COLUMN teu TEXT;
        "#,
        ),
        // Migration 8: local receipt of vessel reviews sent by this vault.
        // The public review goes to the server; this table keeps the user's
        // own rating visible in Sea Service and enforces the local edit lock.
        (
            8,
            r#"
            CREATE TABLE IF NOT EXISTS vessel_review_receipts (
                id TEXT PRIMARY KEY,
                work_history_id TEXT NOT NULL,
                vessel_imo TEXT NOT NULL,
                vessel_name TEXT,
                overall_rating REAL NOT NULL,
                summary_json TEXT NOT NULL DEFAULT '{}',
                submitted_at TEXT NOT NULL,
                lock_until TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(work_history_id) REFERENCES work_history(id) ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_vessel_review_receipts_work_history_id
                ON vessel_review_receipts(work_history_id);
            CREATE INDEX IF NOT EXISTS idx_vessel_review_receipts_imo
                ON vessel_review_receipts(vessel_imo);
        "#,
        ),
    ]
}

/// Run pending migrations inside a single transaction per migration.
/// Records applied versions in schema_migrations so we never double-apply.
fn run_migrations(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;

    let current: u32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    for (v, sql) in migrations() {
        if v <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, datetime('now'))",
            params![v],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// Back-compat: existing vaults that predate the migration framework
/// were patched via loose `ALTER TABLE` calls. We still run those once
/// (idempotently) for vaults created before schema_migrations existed,
/// then mark them as up-to-date.
///
/// The trick: if `documents` exists but `schema_migrations` has no rows,
/// we're looking at a legacy vault. In that case we add any missing columns
/// and stamp version=1 so future migrations start from a known point.
fn legacy_backfill(conn: &Connection) -> Result<()> {
    let has_docs: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_docs {
        return Ok(());
    }

    let baseline_applied: bool = conn
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE version=1",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if baseline_applied {
        return Ok(());
    }

    // Run legacy ALTERs idempotently (errors ignored when column exists).
    let _ = conn.execute("ALTER TABLE documents ADD COLUMN valid_from TEXT", []);
    let _ = conn.execute("ALTER TABLE documents ADD COLUMN issued_by TEXT", []);
    let _ = conn.execute("ALTER TABLE documents ADD COLUMN doc_number TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE documents ADD COLUMN field_statuses TEXT DEFAULT '{}'",
        [],
    );
    let _ = conn.execute("ALTER TABLE documents ADD COLUMN regulatory_basis TEXT", []);
    let _ = conn.execute("ALTER TABLE documents ADD COLUMN template_id TEXT", []);

    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))",
        [],
    )?;
    Ok(())
}

pub fn open_db(vault_path: &Path) -> Result<Connection> {
    let db_path = vault_path.join("skipi.db");
    // rusqlite::Connection::open uses SQLite's normal read-write/create mode.
    // We keep that behavior intentionally: Skipi vaults must always be writable
    // by the local app instance.
    let mut conn = Connection::open(&db_path)?;

    // Use WAL on local vaults so normal app writes don't trip over the default
    // rollback journal path on Linux. This also surfaces writeability problems
    // immediately at open time instead of later on first update.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    // 1. Ensure schema_migrations + run any pending migrations for new vaults.
    run_migrations(&mut conn)?;
    // 2. For pre-framework vaults, backfill missing columns and mark baseline.
    legacy_backfill(&conn)?;
    // 3. Best-effort Unix permissions. The DB file itself should be a normal
    // owner-writable file (0644), and the vault directory must stay writable
    // so SQLite can create sidecars like `-wal` / `-shm`.
    let _ = ensure_vault_fs_permissions(vault_path, &db_path);

    Ok(conn)
}

#[cfg(unix)]
fn ensure_vault_fs_permissions(vault_path: &Path, db_path: &Path) -> std::io::Result<()> {
    if let Ok(meta) = fs::metadata(vault_path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(vault_path, perms)?;
    }
    if let Ok(meta) = fs::metadata(db_path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o644);
        fs::set_permissions(db_path, perms)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_vault_fs_permissions(_vault_path: &Path, _db_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};
    use uuid::Uuid;

    #[test]
    fn open_db_enables_wal_and_sets_unix_permissions() {
        let vault_path = env::temp_dir().join(format!("skipi-open-db-{}", Uuid::new_v4()));
        fs::create_dir_all(&vault_path).unwrap();

        let conn = open_db(&vault_path).unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_lowercase(), "wal");

        let db_path = vault_path.join("skipi.db");
        assert!(db_path.exists());

        #[cfg(unix)]
        {
            let db_mode = fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(&vault_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(db_mode, 0o644);
            assert_eq!(dir_mode, 0o755);
        }

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }

    #[test]
    fn open_db_handles_cyrillic_and_spaces_path() {
        let vault_path = env::temp_dir().join(format!(
            "Skipi Vault {} {}",
            "\u{0422}\u{0435}\u{0441}\u{0442}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&vault_path).unwrap();

        let conn = open_db(&vault_path).unwrap();
        assert!(vault_path.join("skipi.db").exists());
        conn.query_row("SELECT 1 FROM schema_migrations LIMIT 1", [], |row| {
            row.get::<_, i32>(0)
        })
        .unwrap();

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }

    #[test]
    fn work_history_roundtrips_vessel_capacity() {
        let vault_path = env::temp_dir().join(format!("skipi-work-capacity-{}", Uuid::new_v4()));
        fs::create_dir_all(&vault_path).unwrap();
        let conn = open_db(&vault_path).unwrap();

        add_work_entry(
            &conn,
            "entry-1",
            "MV Capacity Test",
            Some("Container Ship"),
            Some("9123456"),
            Some("Liberia"),
            Some("Test Manager"),
            "Chief Officer",
            Some("2025-01-10"),
            Some("2025-07-20"),
            Some(""),
            Some("5100"),
            Some("Synthetic test entry"),
        )
        .unwrap();

        let entries = get_work_history(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["dwt"], "");
        assert_eq!(entries[0]["teu"], "5100");

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }

    #[test]
    fn work_history_includes_local_vessel_review_receipt() {
        let vault_path = env::temp_dir().join(format!("skipi-review-receipt-{}", Uuid::new_v4()));
        fs::create_dir_all(&vault_path).unwrap();
        let conn = open_db(&vault_path).unwrap();

        add_work_entry(
            &conn,
            "entry-review-1",
            "MV Rated",
            Some("Bulk Carrier"),
            Some("9855551"),
            Some("Panama"),
            Some("Test Manager"),
            "Third Officer",
            Some("2025-01-10"),
            Some("2025-07-20"),
            Some("82000"),
            None,
            None,
        )
        .unwrap();

        upsert_vessel_review_receipt(
            &conn,
            "receipt-1",
            "entry-review-1",
            "9855551",
            Some("MV Rated"),
            4.2,
            r#"{"sections":[{"title":"Food","rating":4}]}"#,
            "2026-05-14T10:00:00Z",
            "2026-06-13T10:00:00Z",
        )
        .unwrap();

        let entries = get_work_history(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["local_review"]["overall_rating"], 4.2);
        assert_eq!(
            entries[0]["local_review"]["summary"]["sections"][0]["title"],
            "Food"
        );
        assert_eq!(
            entries[0]["local_review"]["lock_until"],
            "2026-06-13T10:00:00Z"
        );

        drop(conn);
        let _ = fs::remove_dir_all(&vault_path);
    }
}

pub fn set_vault_info(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO vault_info (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_vault_info(conn: &Connection) -> Result<VaultInfo> {
    let get = |key: &str| -> String {
        conn.query_row(
            "SELECT value FROM vault_info WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };
    let opt = |k: &str| {
        let v = get(k);
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    Ok(VaultInfo {
        account_type: get("account_type"),
        name: get("name"),
        rank: opt("rank"),
        vessel_type: opt("vessel_type"),
        position: opt("position"),
        vessel_category: opt("vessel_category"),
    })
}

pub fn insert_doc(conn: &Connection, doc: &DocRecord) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO documents
            (id, category, title, file_name, has_expiry, valid_from, valid_to,
             issued_by, doc_number, notes, field_statuses, regulatory_basis,
             template_id, sha256, file_size, content_type, visibility, is_national)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            doc.id,
            doc.category,
            doc.title,
            doc.file_name,
            doc.has_expiry as i32,
            doc.valid_from,
            doc.valid_to,
            doc.issued_by,
            doc.doc_number,
            doc.notes,
            doc.field_statuses,
            doc.regulatory_basis,
            doc.template_id,
            doc.sha256,
            doc.file_size,
            doc.content_type,
            doc.visibility,
            doc.is_national as i32,
        ],
    )?;
    Ok(())
}

pub fn get_all_docs(conn: &Connection) -> Result<Vec<DocRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, category, title, file_name, has_expiry, valid_from, valid_to,
                issued_by, doc_number, notes, field_statuses, regulatory_basis,
                template_id, sha256, file_size, content_type, visibility, is_national
         FROM documents ORDER BY category, is_national DESC, title",
    )?;
    let docs = stmt
        .query_map([], |row| {
            Ok(DocRecord {
                id: row.get(0)?,
                category: row.get(1)?,
                title: row.get(2)?,
                file_name: row.get(3)?,
                has_expiry: row.get::<_, i32>(4)? != 0,
                valid_from: row.get(5)?,
                valid_to: row.get(6)?,
                issued_by: row.get(7)?,
                doc_number: row.get(8)?,
                notes: row.get(9)?,
                field_statuses: row.get(10).unwrap_or(None),
                regulatory_basis: row.get(11).unwrap_or(None),
                template_id: row.get(12).unwrap_or(None),
                sha256: row.get(13).unwrap_or(None),
                file_size: row.get(14).unwrap_or(None),
                content_type: row.get(15).unwrap_or(None),
                visibility: row
                    .get::<_, Option<String>>(16)
                    .unwrap_or(None)
                    .unwrap_or_else(default_visibility),
                is_national: row.get::<_, i32>(17).unwrap_or(0) != 0,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(docs)
}

// ===== Phase-2 readiness helpers — see docs/ARCHITECTURE_PHASE2.md =====

/// Update the content-addressable columns for a document after a file was
/// attached or replaced. Called from lib.rs::attach_file once the copy
/// succeeds. PII MUST NOT go through this helper.
pub fn update_doc_content_hash(
    conn: &Connection,
    id: &str,
    sha256: &str,
    size: i64,
    content_type: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE documents SET sha256 = ?1, file_size = ?2, content_type = ?3 WHERE id = ?4",
        params![sha256, size, content_type, id],
    )?;
    Ok(())
}

/// Update a document's visibility flag. The phase-2 matchmaking server will
/// only ever see documents that are marked `shareable`, and only after the
/// user explicitly opts in to a crewing operator.
pub fn update_doc_visibility(conn: &Connection, id: &str, visibility: &str) -> Result<()> {
    conn.execute(
        "UPDATE documents SET visibility = ?1 WHERE id = ?2",
        params![visibility, id],
    )?;
    Ok(())
}

/// Append an event to the journal. In phase 1 nothing reads it; in phase 2
/// this becomes the incremental sync cursor. Payload MUST NOT contain PII —
/// the arch doc spells out the allowed contents (template_id, category,
/// file name, sha256, visibility).
pub fn log_event(
    conn: &Connection,
    kind: &str,
    entity_type: &str,
    entity_id: Option<&str>,
    payload_json: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO events (ts, kind, entity_type, entity_id, payload_json)
         VALUES (datetime('now'), ?1, ?2, ?3, ?4)",
        params![kind, entity_type, entity_id, payload_json],
    )?;
    Ok(())
}

pub fn update_doc_expiry(conn: &Connection, id: &str, valid_to: &str) -> Result<()> {
    conn.execute(
        "UPDATE documents SET valid_to = ?1 WHERE id = ?2",
        params![valid_to, id],
    )?;
    Ok(())
}

pub fn update_doc_field(conn: &Connection, id: &str, field: &str, value: &str) -> Result<()> {
    // Only allow known fields
    let sql = match field {
        "valid_from" => "UPDATE documents SET valid_from = ?1 WHERE id = ?2",
        "valid_to" => "UPDATE documents SET valid_to = ?1 WHERE id = ?2",
        "issued_by" => "UPDATE documents SET issued_by = ?1 WHERE id = ?2",
        "doc_number" => "UPDATE documents SET doc_number = ?1 WHERE id = ?2",
        _ => return Ok(()),
    };
    conn.execute(sql, params![value, id])?;
    Ok(())
}

pub fn update_field_statuses(conn: &Connection, id: &str, statuses_json: &str) -> Result<()> {
    conn.execute(
        "UPDATE documents SET field_statuses = ?1 WHERE id = ?2",
        params![statuses_json, id],
    )?;
    Ok(())
}

pub fn update_doc_file(conn: &Connection, id: &str, file_name: &str) -> Result<()> {
    conn.execute(
        "UPDATE documents SET file_name = ?1 WHERE id = ?2",
        params![file_name, id],
    )?;
    Ok(())
}

// --- Packages ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackageRecord {
    pub id: String,
    pub title: String,
    pub created_on: String,
    pub expires_on: String,
    pub download_count: i32,
    pub download_limit: i32,
    pub password: Option<String>,
    pub file_count: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackageFileRecord {
    pub id: String,
    pub package_id: String,
    pub doc_id: String,
    pub file_name: String,
}

pub fn create_package(
    conn: &Connection,
    id: &str,
    title: &str,
    expires_on: &str,
    download_limit: i32,
    password: Option<&str>,
) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO packages (id, title, created_on, expires_on, download_limit, password) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, title, now, expires_on, download_limit, password],
    )?;
    Ok(())
}

pub fn add_package_file(
    conn: &Connection,
    id: &str,
    package_id: &str,
    doc_id: &str,
    file_name: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO package_files (id, package_id, doc_id, file_name) VALUES (?1, ?2, ?3, ?4)",
        params![id, package_id, doc_id, file_name],
    )?;
    Ok(())
}

pub fn get_all_packages(conn: &Connection) -> Result<Vec<PackageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.created_on, p.expires_on, p.download_count, p.download_limit, p.password,
                (SELECT COUNT(*) FROM package_files WHERE package_id = p.id)
         FROM packages p ORDER BY p.created_on DESC"
    )?;
    let pkgs = stmt
        .query_map([], |row| {
            Ok(PackageRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                created_on: row.get(2)?,
                expires_on: row.get(3)?,
                download_count: row.get(4)?,
                download_limit: row.get(5)?,
                password: row.get(6)?,
                file_count: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(pkgs)
}

pub fn get_package_files(conn: &Connection, package_id: &str) -> Result<Vec<PackageFileRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, package_id, doc_id, file_name FROM package_files WHERE package_id = ?1",
    )?;
    let files = stmt
        .query_map(params![package_id], |row| {
            Ok(PackageFileRecord {
                id: row.get(0)?,
                package_id: row.get(1)?,
                doc_id: row.get(2)?,
                file_name: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(files)
}

// --- AI Corrections (learning from user edits) ---

pub fn save_correction(
    conn: &Connection,
    doc_type: &str,
    field_name: &str,
    ai_value: &str,
    correct_value: &str,
) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO ai_corrections (doc_type, field_name, ai_value, correct_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![doc_type, field_name, ai_value, correct_value, now],
    )?;
    Ok(())
}

pub fn save_ocr_label(
    conn: &Connection,
    doc_id: &str,
    doc_type: &str,
    field_name: &str,
    ai_value: &str,
    correct_value: &str,
    file_sha256: Option<&str>,
) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let label_json = serde_json::json!({
        "entity_type": "ocr_field",
        "entity_id": doc_id,
        "task": "maritime_document_ocr",
        "doc_type": doc_type,
        "field_name": field_name,
        "prediction": ai_value,
        "human_label": correct_value,
        "file_sha256": file_sha256,
        "created_at": now,
    })
    .to_string();
    conn.execute(
        "INSERT INTO ai_corrections
         (doc_type, field_name, ai_value, correct_value, created_at, doc_id, file_sha256, label_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![doc_type, field_name, ai_value, correct_value, now, doc_id, file_sha256, label_json],
    )?;
    Ok(())
}

pub fn get_corrections(conn: &Connection, doc_type: &str) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT field_name, ai_value, correct_value FROM ai_corrections WHERE doc_type = ?1 ORDER BY created_at DESC LIMIT 10"
    )?;
    let rows = stmt
        .query_map(params![doc_type], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_package(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM package_files WHERE package_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM packages WHERE id = ?1", params![id])?;
    Ok(())
}

// --- Generic vault_info reader (single key) ---

pub fn get_vault_info_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM vault_info WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.is_empty())
}

// --- Work history ---

pub fn add_work_entry(
    conn: &Connection,
    id: &str,
    vessel_name: &str,
    vessel_type: Option<&str>,
    imo: Option<&str>,
    flag: Option<&str>,
    company: Option<&str>,
    position: &str,
    sign_on: Option<&str>,
    sign_off: Option<&str>,
    dwt: Option<&str>,
    teu: Option<&str>,
    notes: Option<&str>,
) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO work_history (id, vessel_name, vessel_type, imo, flag, company, position, sign_on, sign_off, dwt, teu, notes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![id, vessel_name, vessel_type, imo, flag, company, position, sign_on, sign_off, dwt, teu, notes, now],
    )?;
    Ok(())
}

pub fn get_work_history(conn: &Connection) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT wh.id, wh.vessel_name, wh.vessel_type, wh.imo, wh.flag, wh.company, wh.position,
                wh.sign_on, wh.sign_off, wh.notes, wh.created_at, wh.evidence_folder, wh.dwt, wh.teu,
                vr.overall_rating, vr.summary_json, vr.submitted_at, vr.lock_until
         FROM work_history wh
         LEFT JOIN vessel_review_receipts vr ON vr.work_history_id = wh.id
         ORDER BY COALESCE(wh.sign_on, wh.created_at) DESC"
    )?;
    let rows = stmt
        .query_map([], |row| {
            let overall_rating = row.get::<_, Option<f64>>(14)?;
            let summary = row
                .get::<_, Option<String>>(15)?
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            let local_review = if let Some(rating) = overall_rating {
                serde_json::json!({
                    "overall_rating": rating,
                    "summary": summary,
                    "submitted_at": row.get::<_, Option<String>>(16)?,
                    "lock_until": row.get::<_, Option<String>>(17)?,
                })
            } else {
                serde_json::Value::Null
            };
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "vessel_name": row.get::<_, String>(1)?,
                "vessel_type": row.get::<_, Option<String>>(2)?,
                "imo": row.get::<_, Option<String>>(3)?,
                "flag": row.get::<_, Option<String>>(4)?,
                "company": row.get::<_, Option<String>>(5)?,
                "position": row.get::<_, String>(6)?,
                "sign_on": row.get::<_, Option<String>>(7)?,
                "sign_off": row.get::<_, Option<String>>(8)?,
                "notes": row.get::<_, Option<String>>(9)?,
                "created_at": row.get::<_, String>(10)?,
                "evidence_folder": row.get::<_, Option<String>>(11)?,
                "dwt": row.get::<_, Option<String>>(12)?,
                "teu": row.get::<_, Option<String>>(13)?,
                "local_review": local_review,
            }))
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_vessel_review_receipt(
    conn: &Connection,
    work_history_id: &str,
) -> Result<Option<serde_json::Value>> {
    conn.query_row(
        "SELECT vessel_imo, vessel_name, overall_rating, summary_json, submitted_at, lock_until
         FROM vessel_review_receipts WHERE work_history_id = ?1",
        params![work_history_id],
        |row| {
            let summary = row
                .get::<_, Option<String>>(3)?
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            Ok(serde_json::json!({
                "work_history_id": work_history_id,
                "vessel_imo": row.get::<_, String>(0)?,
                "vessel_name": row.get::<_, Option<String>>(1)?,
                "overall_rating": row.get::<_, f64>(2)?,
                "summary": summary,
                "submitted_at": row.get::<_, String>(4)?,
                "lock_until": row.get::<_, String>(5)?,
            }))
        },
    )
    .optional()
}

pub fn upsert_vessel_review_receipt(
    conn: &Connection,
    id: &str,
    work_history_id: &str,
    vessel_imo: &str,
    vessel_name: Option<&str>,
    overall_rating: f64,
    summary_json: &str,
    submitted_at: &str,
    lock_until: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vessel_review_receipts
            (id, work_history_id, vessel_imo, vessel_name, overall_rating, summary_json, submitted_at, lock_until, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))
         ON CONFLICT(work_history_id) DO UPDATE SET
            vessel_imo = excluded.vessel_imo,
            vessel_name = excluded.vessel_name,
            overall_rating = excluded.overall_rating,
            summary_json = excluded.summary_json,
            submitted_at = excluded.submitted_at,
            lock_until = excluded.lock_until,
            updated_at = datetime('now')",
        params![
            id,
            work_history_id,
            vessel_imo,
            vessel_name,
            overall_rating,
            summary_json,
            submitted_at,
            lock_until
        ],
    )?;
    Ok(())
}

pub fn set_work_evidence_folder(
    conn: &Connection,
    entry_id: &str,
    folder: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE work_history SET evidence_folder = ?1 WHERE id = ?2",
        params![folder, entry_id],
    )?;
    Ok(())
}

pub fn get_work_evidence_folder(conn: &Connection, entry_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT evidence_folder FROM work_history WHERE id = ?1",
        params![entry_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .map_err(|e| e.into())
}

pub fn delete_work_entry(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM work_history_files WHERE entry_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM work_history WHERE id = ?1", params![id])?;
    Ok(())
}

// --- Work history file attachments ---

pub fn add_work_file(
    conn: &Connection,
    id: &str,
    entry_id: &str,
    file_name: &str,
    kind: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO work_history_files (id, entry_id, file_name, kind) VALUES (?1, ?2, ?3, ?4)",
        params![id, entry_id, file_name, kind],
    )?;
    Ok(())
}

pub fn get_work_files(conn: &Connection, entry_id: &str) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_name, kind FROM work_history_files WHERE entry_id = ?1 ORDER BY file_name",
    )?;
    let rows = stmt
        .query_map(params![entry_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "file_name": row.get::<_, String>(1)?,
                "kind": row.get::<_, Option<String>>(2)?,
            }))
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_work_file(conn: &Connection, id: &str) -> Result<Option<(String, String)>> {
    // Returns (entry_id, file_name) so the caller can locate the file on disk
    let mut stmt =
        conn.prepare("SELECT entry_id, file_name FROM work_history_files WHERE id = ?1")?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
    } else {
        Ok(None)
    }
}

pub fn delete_work_file(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM work_history_files WHERE id = ?1", params![id])?;
    Ok(())
}

// --- Dispatch (Рассылка) ---

pub fn add_dispatch(
    conn: &Connection,
    id: &str,
    package_id: &str,
    recipients: &str,
    subject: &str,
    cv_path: &str,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO dispatches (id, package_id, recipients, subject, cv_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, package_id, recipients, subject, cv_path, now],
    )?;
    Ok(())
}

pub fn get_dispatches(conn: &Connection) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.package_id, d.recipients, d.subject, d.cv_path, d.created_at,
                p.title
         FROM dispatches d
         LEFT JOIN packages p ON p.id = d.package_id
         ORDER BY d.created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "package_id": row.get::<_, String>(1)?,
                "recipients": row.get::<_, String>(2)?,
                "subject": row.get::<_, Option<String>>(3)?,
                "cv_path": row.get::<_, Option<String>>(4)?,
                "created_at": row.get::<_, String>(5)?,
                "package_title": row.get::<_, Option<String>>(6)?,
            }))
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

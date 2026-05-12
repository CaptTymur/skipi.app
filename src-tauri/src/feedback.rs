use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use std::path::PathBuf;
use uuid::Uuid;

use crate::api;

const APP_SLUG: &str = "seafarer";
const FIRST_PROMPT_LAUNCHES: i64 = 3;
const PROMPT_COOLDOWN_DAYS: i64 = 14;

#[derive(Debug, Clone, Serialize)]
pub struct FeedbackPromptState {
    pub should_prompt: bool,
    pub launch_count: i64,
    pub prompt_count: i64,
    pub last_prompted_at: Option<String>,
    pub last_submitted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedbackSubmitResult {
    pub id: String,
    pub synced: bool,
    pub sync_error: Option<String>,
    pub db_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppFeedback {
    pub id: String,
    pub app: String,
    pub app_version: String,
    pub rating: i64,
    pub comment: String,
    pub locale: Option<String>,
    pub context: Option<String>,
    pub created_at: String,
    pub synced_at: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticSubmitResult {
    pub id: String,
    pub synced: bool,
    pub sync_error: Option<String>,
    pub db_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppDiagnostic {
    pub id: String,
    pub app: String,
    pub app_version: String,
    pub event_type: String,
    pub severity: String,
    pub message: String,
    pub locale: Option<String>,
    pub context: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub arch: Option<String>,
    pub session_id: Option<String>,
    pub install_id: Option<String>,
    pub details_json: Option<String>,
    pub created_at: String,
    pub synced_at: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ServerFeedback<'a> {
    id: &'a str,
    app: &'a str,
    app_version: &'a str,
    rating: i64,
    comment: &'a str,
    locale: Option<&'a str>,
    context: Option<&'a str>,
    client_created_at: &'a str,
}

#[derive(Debug, Serialize)]
struct ServerDiagnostic<'a> {
    id: &'a str,
    app: &'a str,
    app_version: &'a str,
    event_type: &'a str,
    severity: &'a str,
    message: &'a str,
    locale: Option<&'a str>,
    context: Option<&'a str>,
    platform: Option<&'a str>,
    os_version: Option<&'a str>,
    arch: Option<&'a str>,
    session_id: Option<&'a str>,
    install_id: Option<&'a str>,
    details: Option<JsonValue>,
    client_created_at: &'a str,
}

fn feedback_db_path() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("skipi");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("feedback.sqlite")
}

fn open_feedback_db() -> Result<Connection, String> {
    let conn = Connection::open(feedback_db_path()).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_feedback (
            id TEXT PRIMARY KEY,
            app TEXT NOT NULL,
            app_version TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
            comment TEXT NOT NULL,
            locale TEXT,
            context TEXT,
            created_at TEXT NOT NULL,
            synced_at TEXT,
            sync_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_app_feedback_created_at ON app_feedback(created_at);
        CREATE TABLE IF NOT EXISTS feedback_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_diagnostics (
            id TEXT PRIMARY KEY,
            app TEXT NOT NULL,
            app_version TEXT NOT NULL,
            event_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            message TEXT NOT NULL,
            locale TEXT,
            context TEXT,
            platform TEXT,
            os_version TEXT,
            arch TEXT,
            session_id TEXT,
            install_id TEXT,
            details_json TEXT,
            created_at TEXT NOT NULL,
            synced_at TEXT,
            sync_error TEXT
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_diagnostics_created_at ON app_diagnostics(created_at)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn get_state(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM feedback_state WHERE key=?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn set_state(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO feedback_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn state_i64(conn: &Connection, key: &str) -> Result<i64, String> {
    Ok(get_state(conn, key)?
        .as_deref()
        .unwrap_or("0")
        .parse::<i64>()
        .unwrap_or(0))
}

fn parse_utc(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn sync_feedback_to_server(feedback: &AppFeedback) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let payload = ServerFeedback {
        id: &feedback.id,
        app: APP_SLUG,
        app_version: &feedback.app_version,
        rating: feedback.rating,
        comment: &feedback.comment,
        locale: feedback.locale.as_deref(),
        context: feedback.context.as_deref(),
        client_created_at: &feedback.created_at,
    };
    api::post_json_empty(&client, "/api/feedback", &payload)
}

fn clean_optional(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|s| clean_text(&s, max_chars))
        .filter(|s| !s.is_empty())
}

fn clean_text(value: &str, max_chars: usize) -> String {
    let s = value.replace('\0', "").trim().to_string();
    s.chars().take(max_chars).collect()
}

fn details_value(details_json: Option<&str>) -> Option<JsonValue> {
    let raw = details_json?.trim();
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<JsonValue>(raw) {
        Ok(v) if v.is_object() => Some(v),
        Ok(v) => Some(json!({ "value": v })),
        Err(_) => Some(json!({ "raw": clean_text(raw, 4000) })),
    }
}

fn ensure_install_id(conn: &Connection) -> Result<String, String> {
    if let Some(existing) = get_state(conn, "install_id")? {
        return Ok(existing);
    }
    let install_id = Uuid::new_v4().to_string();
    set_state(conn, "install_id", &install_id)?;
    Ok(install_id)
}

fn current_session_id(conn: &Connection) -> Result<Option<String>, String> {
    get_state(conn, "session_id")
}

fn sync_diagnostic_to_server(diagnostic: &AppDiagnostic) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let payload = ServerDiagnostic {
        id: &diagnostic.id,
        app: APP_SLUG,
        app_version: &diagnostic.app_version,
        event_type: &diagnostic.event_type,
        severity: &diagnostic.severity,
        message: &diagnostic.message,
        locale: diagnostic.locale.as_deref(),
        context: diagnostic.context.as_deref(),
        platform: diagnostic.platform.as_deref(),
        os_version: diagnostic.os_version.as_deref(),
        arch: diagnostic.arch.as_deref(),
        session_id: diagnostic.session_id.as_deref(),
        install_id: diagnostic.install_id.as_deref(),
        details: details_value(diagnostic.details_json.as_deref()),
        client_created_at: &diagnostic.created_at,
    };
    api::post_json_empty(&client, "/api/diagnostics/report", &payload)
}

fn store_diagnostic(
    conn: &Connection,
    app_version: String,
    event_type: String,
    severity: String,
    message: String,
    locale: Option<String>,
    context: Option<String>,
    details_json: Option<String>,
    session_id: Option<String>,
    install_id: Option<String>,
) -> Result<DiagnosticSubmitResult, String> {
    let mut diagnostic = AppDiagnostic {
        id: Uuid::new_v4().to_string(),
        app: APP_SLUG.to_string(),
        app_version: clean_text(&app_version, 32),
        event_type: clean_text(&event_type, 64),
        severity: match severity.as_str() {
            "info" | "warn" | "fatal" => severity,
            _ => "error".to_string(),
        },
        message: clean_text(&message, 2000),
        locale: clean_optional(locale, 16),
        context: clean_optional(context, 80),
        platform: Some(std::env::consts::OS.to_string()),
        os_version: None,
        arch: Some(std::env::consts::ARCH.to_string()),
        session_id,
        install_id,
        details_json: clean_optional(details_json, 12_000),
        created_at: Utc::now().to_rfc3339(),
        synced_at: None,
        sync_error: None,
    };
    if diagnostic.event_type.is_empty() {
        diagnostic.event_type = "unknown".to_string();
    }
    if diagnostic.message.is_empty() {
        diagnostic.message = "(empty diagnostic message)".to_string();
    }

    conn.execute(
        "INSERT INTO app_diagnostics
         (id, app, app_version, event_type, severity, message, locale, context, platform, os_version, arch, session_id, install_id, details_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            diagnostic.id,
            diagnostic.app,
            diagnostic.app_version,
            diagnostic.event_type,
            diagnostic.severity,
            diagnostic.message,
            diagnostic.locale,
            diagnostic.context,
            diagnostic.platform,
            diagnostic.os_version,
            diagnostic.arch,
            diagnostic.session_id,
            diagnostic.install_id,
            diagnostic.details_json,
            diagnostic.created_at
        ],
    )
    .map_err(|e| e.to_string())?;

    let sync_result = sync_diagnostic_to_server(&diagnostic);
    let synced = sync_result.is_ok();
    let sync_error = sync_result.err();
    let synced_at = if synced {
        Some(Utc::now().to_rfc3339())
    } else {
        None
    };
    conn.execute(
        "UPDATE app_diagnostics SET synced_at=?2, sync_error=?3 WHERE id=?1",
        params![diagnostic.id, synced_at, sync_error],
    )
    .map_err(|e| e.to_string())?;

    Ok(DiagnosticSubmitResult {
        id: diagnostic.id,
        synced,
        sync_error,
        db_path: feedback_db_path().to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn get_feedback_prompt_state(app_version: String) -> Result<FeedbackPromptState, String> {
    let conn = open_feedback_db()?;
    let now = Utc::now();
    let now_s = now.to_rfc3339();

    let mut launch_count = state_i64(&conn, "launch_count")? + 1;
    if launch_count < 0 {
        launch_count = 1;
    }
    set_state(&conn, "launch_count", &launch_count.to_string())?;
    set_state(&conn, "last_app_version", &app_version)?;

    let submitted_count = state_i64(&conn, "submitted_count")?;
    let mut prompt_count = state_i64(&conn, "prompt_count")?;
    let last_prompted_at = get_state(&conn, "last_prompted_at")?;
    let last_submitted_at = get_state(&conn, "last_submitted_at")?;

    let cooldown_ok = match parse_utc(last_prompted_at.as_deref()) {
        Some(ts) => now.signed_duration_since(ts) >= Duration::days(PROMPT_COOLDOWN_DAYS),
        None => true,
    };
    let should_prompt =
        submitted_count == 0 && launch_count >= FIRST_PROMPT_LAUNCHES && cooldown_ok;

    let last_prompted_at = if should_prompt {
        prompt_count += 1;
        set_state(&conn, "prompt_count", &prompt_count.to_string())?;
        set_state(&conn, "last_prompted_at", &now_s)?;
        Some(now_s)
    } else {
        last_prompted_at
    };

    Ok(FeedbackPromptState {
        should_prompt,
        launch_count,
        prompt_count,
        last_prompted_at,
        last_submitted_at,
    })
}

#[tauri::command]
pub fn init_app_diagnostics(
    app_version: String,
    locale: Option<String>,
    context: Option<String>,
) -> Result<(), String> {
    let conn = open_feedback_db()?;
    let install_id = ensure_install_id(&conn)?;
    if get_state(&conn, "session_active")?.as_deref() == Some("1") {
        let previous_session = get_state(&conn, "session_id")?;
        let last_heartbeat_at = get_state(&conn, "last_heartbeat_at")?;
        let last_screen = get_state(&conn, "last_screen")?;
        let details = json!({
            "previous_session_id": previous_session,
            "last_heartbeat_at": last_heartbeat_at,
            "last_screen": last_screen
        })
        .to_string();
        let _ = store_diagnostic(
            &conn,
            app_version.clone(),
            "unclean_shutdown".to_string(),
            "warn".to_string(),
            "Previous app session did not close cleanly".to_string(),
            locale.clone(),
            context.clone(),
            Some(details),
            get_state(&conn, "session_id")?,
            Some(install_id.clone()),
        );
    }
    let session_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    set_state(&conn, "session_id", &session_id)?;
    set_state(&conn, "session_active", "1")?;
    set_state(&conn, "session_started_at", &now)?;
    set_state(&conn, "last_heartbeat_at", &now)?;
    set_state(&conn, "last_app_version", &app_version)?;
    Ok(())
}

#[tauri::command]
pub fn app_heartbeat(app_version: String, last_screen: Option<String>) -> Result<(), String> {
    let conn = open_feedback_db()?;
    ensure_install_id(&conn)?;
    set_state(&conn, "session_active", "1")?;
    set_state(&conn, "last_app_version", &app_version)?;
    set_state(&conn, "last_heartbeat_at", &Utc::now().to_rfc3339())?;
    if let Some(screen) = clean_optional(last_screen, 80) {
        set_state(&conn, "last_screen", &screen)?;
    }
    Ok(())
}

#[tauri::command]
pub fn mark_app_shutdown() -> Result<(), String> {
    let conn = open_feedback_db()?;
    set_state(&conn, "session_active", "0")?;
    set_state(&conn, "last_shutdown_at", &Utc::now().to_rfc3339())
}

#[tauri::command]
pub fn record_app_diagnostic(
    app_version: String,
    event_type: String,
    severity: String,
    message: String,
    locale: Option<String>,
    context: Option<String>,
    details_json: Option<String>,
) -> Result<DiagnosticSubmitResult, String> {
    let conn = open_feedback_db()?;
    let install_id = ensure_install_id(&conn)?;
    store_diagnostic(
        &conn,
        app_version,
        event_type,
        severity,
        message,
        locale,
        context,
        details_json,
        current_session_id(&conn)?,
        Some(install_id),
    )
}

#[tauri::command]
pub fn postpone_app_feedback() -> Result<(), String> {
    let conn = open_feedback_db()?;
    set_state(&conn, "last_prompted_at", &Utc::now().to_rfc3339())
}

#[tauri::command]
pub fn submit_app_feedback(
    app_version: String,
    rating: i64,
    comment: String,
    locale: Option<String>,
    context: Option<String>,
) -> Result<FeedbackSubmitResult, String> {
    if !(1..=5).contains(&rating) {
        return Err("rating must be between 1 and 5".to_string());
    }
    let comment = comment.trim().to_string();
    if comment.len() < 2 {
        return Err("comment is required".to_string());
    }
    let conn = open_feedback_db()?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let locale = locale
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let context = context
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut feedback = AppFeedback {
        id,
        app: APP_SLUG.to_string(),
        app_version,
        rating,
        comment,
        locale,
        context,
        created_at,
        synced_at: None,
        sync_error: None,
    };

    conn.execute(
        "INSERT INTO app_feedback
         (id, app, app_version, rating, comment, locale, context, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            feedback.id,
            feedback.app,
            feedback.app_version,
            feedback.rating,
            feedback.comment,
            feedback.locale,
            feedback.context,
            feedback.created_at
        ],
    )
    .map_err(|e| e.to_string())?;

    let sync_result = sync_feedback_to_server(&feedback);
    let synced = sync_result.is_ok();
    let sync_error = sync_result.err();
    let synced_at = if synced {
        Some(Utc::now().to_rfc3339())
    } else {
        None
    };
    feedback.synced_at = synced_at.clone();
    feedback.sync_error = sync_error.clone();
    conn.execute(
        "UPDATE app_feedback SET synced_at=?2, sync_error=?3 WHERE id=?1",
        params![feedback.id, synced_at, sync_error],
    )
    .map_err(|e| e.to_string())?;
    set_state(
        &conn,
        "submitted_count",
        &(state_i64(&conn, "submitted_count")? + 1).to_string(),
    )?;
    set_state(&conn, "last_submitted_at", &Utc::now().to_rfc3339())?;

    Ok(FeedbackSubmitResult {
        id: feedback.id,
        synced,
        sync_error: feedback.sync_error,
        db_path: feedback_db_path().to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn list_app_feedback() -> Result<Vec<AppFeedback>, String> {
    let conn = open_feedback_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, app, app_version, rating, comment, locale, context, created_at, synced_at, sync_error
             FROM app_feedback
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AppFeedback {
                id: row.get(0)?,
                app: row.get(1)?,
                app_version: row.get(2)?,
                rating: row.get(3)?,
                comment: row.get(4)?,
                locale: row.get(5)?,
                context: row.get(6)?,
                created_at: row.get(7)?,
                synced_at: row.get(8)?,
                sync_error: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

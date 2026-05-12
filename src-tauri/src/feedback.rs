use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
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
        );",
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

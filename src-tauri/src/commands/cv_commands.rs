use crate::cv;
use crate::AppState;
use std::path::PathBuf;
use tauri::State;

/// Return the CV data as a structured JSON payload for the in-app view.
#[tauri::command]
pub fn get_cv_data(state: State<AppState>) -> Result<cv::CvData, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    cv::build_cv_data(conn)
}

/// Render the CV to a .docx file at the given path.
#[tauri::command]
pub fn export_cv_docx(state: State<AppState>, output_path: String) -> Result<String, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let data = cv::build_cv_data(conn)?;
    let out = PathBuf::from(&output_path);
    cv::render_cv_docx(&data, &out)?;
    Ok(output_path)
}

/// Render the CV to a .pdf file at the given path using printpdf.
#[tauri::command]
pub fn export_cv_pdf(state: State<AppState>, output_path: String) -> Result<String, String> {
    let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
    let vault_path = vault_lock.as_ref().ok_or("No vault open")?;
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let data = cv::build_cv_data(conn)?;
    let photo_abs = data
        .personal
        .photo_path
        .as_ref()
        .map(|rel| vault_path.join(rel))
        .filter(|p| p.exists());
    let out = PathBuf::from(&output_path);
    cv::render_cv_pdf(&data, &out, photo_abs.as_deref())?;
    Ok(output_path)
}

/// Render a privacy-protected (redacted) CV PDF. PII is stripped via
/// whitelist: the renderer only sees professional signals (rank, sea time,
/// cert statuses, career pattern) — no names, contacts, cert numbers,
/// vessel/company names.
#[tauri::command]
pub fn export_redacted_cv_pdf(state: State<AppState>, output_path: String) -> Result<String, String> {
    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;
    let data = cv::build_cv_data(conn)?;
    let extras = cv::build_redacted_extras(conn);
    let out = PathBuf::from(&output_path);
    cv::render_redacted_cv_pdf(&data, &extras, &out)?;
    Ok(output_path)
}

use crate::db;
use crate::templates;
use crate::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::State;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct AiRecognizeResult {
    pub doc_number: Option<String>,
    pub issued_by: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub title_suggestion: Option<String>,
}

const CLAUDE_OCR_PRIMARY_MODEL: &str = "claude-haiku-4-5-20251001";
const CLAUDE_OCR_FALLBACK_MODEL: &str = "claude-sonnet-4-6";

fn bundled_api_key() -> String {
    option_env!("SKIPI_ANTHROPIC_API_KEY")
        .unwrap_or("")
        .trim()
        .to_string()
}

fn read_saved_api_key(conn: &rusqlite::Connection) -> String {
    conn.query_row(
        "SELECT value FROM vault_info WHERE key = 'api_key'",
        [],
        |row| row.get(0),
    )
    .unwrap_or_default()
}

fn result_has_core_fields(result: &AiRecognizeResult) -> bool {
    result
        .doc_number
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || result
            .issued_by
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || result
            .valid_from
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || result
            .valid_to
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

/// Repair unquoted scalar values in JSON produced by LLMs.
/// e.g. `"valid_from": 01-06-1984` → `"valid_from": "01-06-1984"`
fn repair_unquoted_scalars(s: &str) -> String {
    // Regex-free approach: scan for `: <value>` where value doesn't start with
    // `"`, `{`, `[`, `null`, `true`, `false`, or a digit.
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 64);
    let mut i = 0;
    while i < bytes.len() {
        // Look for `": ` pattern (colon after a closing quote, optional space)
        if bytes[i] == b':' {
            out.push(':');
            i += 1;
            // Skip whitespace after colon
            let mut trailing = String::new();
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                trailing.push(bytes[i] as char);
                i += 1;
            }
            out.push_str(&trailing);
            // If the next char is NOT a quote, brace, bracket, digit, or keyword start
            // (starts with `"`, `{`, `[`), we wrap it in double quotes.
            if i < bytes.len() {
                let c = bytes[i];
                let is_quoted = c == b'"';
                let is_structural = c == b'{' || c == b'[';
                let is_keyword = (i + 4 <= bytes.len() && &s[i..i + 4] == "null")
                    || (i + 4 <= bytes.len() && &s[i..i + 4] == "true")
                    || (i + 5 <= bytes.len() && &s[i..i + 5] == "false");
                let is_digit = c.is_ascii_digit() || c == b'-';

                if !is_quoted && !is_structural && !is_keyword && !is_digit {
                    // Unquoted value — collect until comma, `}`, or newline
                    out.push('"');
                    let mut j = i;
                    while j < bytes.len()
                        && bytes[j] != b','
                        && bytes[j] != b'}'
                        && bytes[j] != b'\n'
                    {
                        j += 1;
                    }
                    let val = s[i..j].trim_end();
                    // Escape any embedded quotes
                    out.push_str(&val.replace('"', "\\\""));
                    out.push('"');
                    i = j;
                    continue;
                }
            }
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn parse_ai_result(content_text: &str) -> Result<AiRecognizeResult, String> {
    // Extract JSON from response
    let json_str = if let Some(start) = content_text.find('{') {
        if let Some(end) = content_text.rfind('}') {
            let raw = &content_text[start..=end];
            raw.lines()
                .map(|line| {
                    let mut in_str = false;
                    let bytes = line.as_bytes();
                    for i in 0..bytes.len() {
                        if bytes[i] == b'"' && (i == 0 || bytes[i - 1] != b'\\') {
                            in_str = !in_str;
                        }
                        if !in_str
                            && i + 1 < bytes.len()
                            && bytes[i] == b'/'
                            && bytes[i + 1] == b'/'
                        {
                            return line[..i].trim_end().to_string();
                        }
                    }
                    line.to_string()
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            content_text.to_string()
        }
    } else {
        content_text.to_string()
    };

    let json_str = repair_unquoted_scalars(&json_str);

    // Normalize JSON: convert array values to joined strings
    match serde_json::from_str::<serde_json::Value>(&json_str) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                for (_key, val) in obj.iter_mut() {
                    if let Some(arr) = val.as_array() {
                        let joined = arr
                            .iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        *val = serde_json::Value::String(joined);
                    }
                    if let Some(s) = val.as_str() {
                        if s.len() > 10 && s.contains('T') {
                            *val = serde_json::Value::String(s[..10].to_string());
                        }
                    }
                }
            }
            serde_json::from_value(v)
                .map_err(|e| format!("Cannot parse AI response: {} — raw: {}", e, json_str))
        }
        Err(e) => Err(format!(
            "Cannot parse AI response: {} — raw: {}",
            e, json_str
        )),
    }
}

fn claude_ocr_request(
    client: &reqwest::blocking::Client,
    api_key: &str,
    model: &str,
    file_block: &serde_json::Value,
    prompt: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 300,
        "messages": [{
            "role": "user",
            "content": [
                file_block.clone(),
                { "type": "text", "text": prompt }
            ]
        }]
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("API request failed with {}: {}", model, e))?;

    let status = resp.status();
    let resp_text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "API error {} with {}: {}",
            status, model, resp_text
        ));
    }

    let resp_json: serde_json::Value =
        serde_json::from_str(&resp_text).map_err(|e| format!("Cannot parse response: {}", e))?;
    Ok(resp_json["content"][0]["text"]
        .as_str()
        .unwrap_or("{}")
        .to_string())
}

/// Cloud recognition via the Skipi server proxy: POST the page image + OCR
/// prompt under the seafarer's `sks_` key. The server holds the Anthropic key,
/// does the vision call and returns the raw model text (same shape the direct
/// Anthropic call returned). Walks the same api_bases() fallback chain the rest
/// of the app uses; auth/limit failures (401/429/503) return immediately.
fn server_ocr_request(
    client: &reqwest::blocking::Client,
    sks_key: &str,
    media_type: &str,
    image_b64: &str,
    prompt: &str,
) -> Result<String, String> {
    #[derive(serde::Serialize)]
    struct Req<'a> {
        image_base64: &'a str,
        media_type: &'a str,
        prompt: &'a str,
    }
    #[derive(serde::Deserialize)]
    struct Resp {
        text: String,
    }
    let body = Req {
        image_base64: image_b64,
        media_type,
        prompt,
    };
    let mut last = String::from("recognition server unavailable");
    for base in crate::api::api_bases() {
        let url = format!("{}/api/assistant/recognize", base.trim_end_matches('/'));
        match client.post(&url).bearer_auth(sks_key).json(&body).send() {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                if status.is_success() {
                    let r: Resp =
                        serde_json::from_str(&text).map_err(|e| format!("parse error: {}", e))?;
                    return Ok(r.text);
                }
                last = format!("HTTP {}: {}", status.as_u16(), text);
                if matches!(status.as_u16(), 401 | 429 | 503) {
                    return Err(last);
                }
            }
            Err(e) => last = format!("{}", e),
        }
    }
    Err(last)
}

async fn ai_recognize_fields(
    state: &AppState,
    doc_id: &str,
    api_key: String,
    use_local: bool,
    ollama_model: Option<String>,
    ollama_endpoint: Option<String>,
    doc_title: Option<String>,
) -> Result<AiRecognizeResult, String> {
    let (file_path, ext, prompt): (PathBuf, String, String) = {
        let vault_lock = state.vault_path.lock().unwrap_or_else(|e| e.into_inner());
        let vault_path = vault_lock.as_ref().ok_or("No vault open")?;

        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;

        let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
        let doc = docs
            .iter()
            .find(|d| d.id == doc_id)
            .ok_or("Document not found")?;
        let file_name = doc.file_name.as_ref().ok_or("No file attached")?.clone();
        let file_path = vault_path.join(&doc.category).join(&file_name);
        let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();

        let base_prompt = "You are a strict OCR assistant for maritime identity documents. Read ONLY what is literally printed on the page. DO NOT guess, infer, or invent any value. If a field is not clearly legible, return null for that field.\n\nRULES:\n- Copy every value EXACTLY as printed, character by character. Do not correct typos, do not autocomplete, do not reformat except where explicitly allowed below.\n- Never output a value that is not visible on the document. Null is always preferred over a guess.\n- Do not read MRZ lines (lines with `<<<`) — those are machine-readable and often confuse dates.\n- Return ONLY valid JSON. All string values MUST be inside double quotes. Dates MUST be quoted strings, not bare tokens.\n\nFields to extract:\n1. doc_number — the official document number as printed next to a label like 'No.', 'Document No.', 'Passport No.', 'Certificate No.', 'card No.', or 'Серія та номер'. Letters + digits (e.g. 'AB 516117', 'GG332748'). Copy exactly.\n2. issued_by — the text next to 'Issuing authority', 'Authority', 'Issued by', or 'Issuing authority of office'. Could be a port or office name (e.g. 'PORT SEVASTOPOL') or a numeric code (e.g. '2110'). Copy exactly.\n3. valid_from — the date next to 'Date of issue' / 'Issued' / 'Date of Issue'. Return as string 'YYYY-MM-DD'. Month names: JAN=01 FEB=02 MAR/БЕР=03 APR/КВІ=04 MAY/ТРА=05 JUN/ЧЕР=06 JUL/ЛИП=07 AUG/СЕР=08 SEP/ВЕР=09 OCT/ЖОВ=10 NOV/ЛИС=11 DEC/ГРУ=12. If unreadable, return null.\n4. valid_to — the date next to 'Date of expiry' / 'Valid until' / 'Prolonged till'. If there is a handwritten extension date, use that. Return as string 'YYYY-MM-DD'. If not present or unreadable, return null.\n5. title_suggestion — the type of document in English (Passport, Seaman's Identity Document, Certificate of Competency, etc.).\n\nOutput format — a single JSON object, nothing else, no prose, no markdown fences:\n{\"doc_number\": \"...\" or null, \"issued_by\": \"...\" or null, \"valid_from\": \"YYYY-MM-DD\" or null, \"valid_to\": \"YYYY-MM-DD\" or null, \"title_suggestion\": \"...\"}";

        let _ = doc_title; // param kept for backwards-compat with frontend
        let tpl_key: String = doc
            .template_id
            .clone()
            .unwrap_or_else(|| doc.category.clone());
        let corrections_text = {
            let cat = tpl_key.as_str();
            match db::get_corrections(conn, cat) {
                Ok(corrs) if !corrs.is_empty() => {
                    let mut lines = String::from("\n\nPAST CORRECTIONS for this document type — these are GROUND TRUTH examples of mistakes previously made on similar documents. Study them and DO NOT repeat the same errors:\n");
                    for (field, ai_val, correct_val) in &corrs {
                        lines.push_str(&format!(
                            "- Field '{}': you once wrote '{}' but the correct value on a similar document was '{}'. On this new document, read very carefully before filling '{}'.\n",
                            field, ai_val, correct_val, field
                        ));
                    }
                    lines.push_str("\nThese corrections are hints about recurring mistakes, not exact answers — the new document has its own values that you must read from the page.\n");
                    lines
                }
                _ => String::new(),
            }
        };

        let template_text = match templates::get_template(tpl_key.as_str()) {
            Some(t) => format!("\n==== DOCUMENT-SPECIFIC GUIDE ====\n{}\n==== END GUIDE ====\n\nUse the guide above as your primary reference for this document type. The generic rules below apply when the guide is silent.\n\n", t),
            None => String::new(),
        };

        (
            file_path,
            ext,
            format!("{}{}{}", template_text, base_prompt, corrections_text),
        )
    };

    // When the seafarer has no local Anthropic key, route cloud recognition
    // through the server proxy — it holds the key, issues a per-device `sks_`
    // key and rate-limits, exactly like the AI assistant. No key in the app.
    let server_key: Option<String> = if !use_local && api_key.trim().is_empty() {
        let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = conn_lock.as_ref().ok_or("No vault open")?;
        let http = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Some(crate::commands::assistant::ensure_key(conn, &http)?)
    } else {
        None
    };

    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<AiRecognizeResult, String> {
            let is_pdf = ext == "pdf";
            if is_pdf && use_local {
                return Err(
                    "Local AI не читает PDF. Пожалуйста, прикрепите страницу как JPG/PNG или \
                 переключитесь на Cloud AI (Claude) — он поддерживает PDF напрямую."
                        .to_string(),
                );
            }
            let data = fs::read(&file_path).map_err(|e| format!("Cannot read file: {}", e))?;
            let b64 = crate::base64_encode(&data);
            let media_type: &str = if is_pdf {
                "application/pdf"
            } else {
                match ext.as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => "image/jpeg",
                }
            };

            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| e.to_string())?;

            let result = if use_local {
                // Ollama API (local)
                let model = ollama_model.unwrap_or_else(|| "minicpm-v:12b".to_string());
                let endpoint =
                    ollama_endpoint.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ollama_url = format!("{}/api/generate", endpoint);
                let body = serde_json::json!({
                    "model": model,
                    "prompt": prompt,
                    "images": [b64],
                    "stream": false
                });

                let resp = client.post(&ollama_url).json(&body).send().map_err(|e| {
                    format!(
                        "Ollama request failed ({}): {}. Is Ollama running?",
                        ollama_url, e
                    )
                })?;

                let status = resp.status();
                let resp_text = resp.text().map_err(|e| e.to_string())?;
                if !status.is_success() {
                    return Err(format!("Ollama error {}: {}", status, resp_text));
                }

                let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
                    .map_err(|e| format!("Cannot parse Ollama response: {}", e))?;
                let content_text = resp_json["response"].as_str().unwrap_or("{}").to_string();
                parse_ai_result(&content_text)?
            } else if let Some(skey) = server_key.as_ref() {
                // Server proxy (no local key): the server holds the Anthropic key
                // and picks the vision model. Single call, no fallback chain.
                let text = server_ocr_request(&client, skey, media_type, &b64, &prompt)?;
                parse_ai_result(&text)?
            } else {
                // Claude API (cloud): use the low-cost model first, then a stronger
                // fallback only when the first pass produces no core fields or invalid JSON.
                let file_block = if is_pdf {
                    serde_json::json!({
                        "type": "document",
                        "source": { "type": "base64", "media_type": media_type, "data": b64 }
                    })
                } else {
                    serde_json::json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": media_type, "data": b64 }
                    })
                };

                let primary = claude_ocr_request(
                    &client,
                    &api_key,
                    CLAUDE_OCR_PRIMARY_MODEL,
                    &file_block,
                    &prompt,
                );

                match primary {
                    Ok(text) => match parse_ai_result(&text) {
                        Ok(result) if result_has_core_fields(&result) => result,
                        Ok(empty_result) => {
                            let fallback = claude_ocr_request(
                                &client,
                                &api_key,
                                CLAUDE_OCR_FALLBACK_MODEL,
                                &file_block,
                                &prompt,
                            );
                            match fallback {
                                Ok(text) => parse_ai_result(&text)?,
                                Err(_) => empty_result,
                            }
                        }
                        Err(primary_parse_error) => {
                            let fallback = claude_ocr_request(
                                &client,
                                &api_key,
                                CLAUDE_OCR_FALLBACK_MODEL,
                                &file_block,
                                &prompt,
                            );
                            match fallback {
                                Ok(text) => parse_ai_result(&text)?,
                                Err(fallback_error) => {
                                    return Err(format!(
                                        "{} failed to produce valid JSON: {}; {} also failed: {}",
                                        CLAUDE_OCR_PRIMARY_MODEL,
                                        primary_parse_error,
                                        CLAUDE_OCR_FALLBACK_MODEL,
                                        fallback_error
                                    ))
                                }
                            }
                        }
                    },
                    Err(primary_error) => {
                        let fallback = claude_ocr_request(
                            &client,
                            &api_key,
                            CLAUDE_OCR_FALLBACK_MODEL,
                            &file_block,
                            &prompt,
                        );
                        match fallback {
                            Ok(text) => parse_ai_result(&text)?,
                            Err(fallback_error) => {
                                return Err(format!(
                                    "{} failed: {}; {} also failed: {}",
                                    CLAUDE_OCR_PRIMARY_MODEL,
                                    primary_error,
                                    CLAUDE_OCR_FALLBACK_MODEL,
                                    fallback_error
                                ))
                            }
                        }
                    }
                }
            };

            Ok(result)
        })
        .await
        .map_err(|e| format!("AI task failed: {}", e))??;

    Ok(result)
}

#[tauri::command]
pub async fn ai_preview_recognize(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    api_key: String,
    use_local: bool,
    ollama_model: Option<String>,
    ollama_endpoint: Option<String>,
    doc_title: Option<String>,
) -> Result<AiRecognizeResult, String> {
    ai_recognize_fields(
        &state,
        &doc_id,
        api_key,
        use_local,
        ollama_model,
        ollama_endpoint,
        doc_title,
    )
    .await
}

#[tauri::command]
pub async fn ai_recognize(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    api_key: String,
    use_local: bool,
    ollama_model: Option<String>,
    ollama_endpoint: Option<String>,
    doc_title: Option<String>,
) -> Result<AiRecognizeResult, String> {
    let result = ai_recognize_fields(
        &state,
        &doc_id,
        api_key,
        use_local,
        ollama_model,
        ollama_endpoint,
        doc_title,
    )
    .await?;

    let conn_lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = conn_lock.as_ref().ok_or("No vault open")?;

    // Auto-save recognized fields to DB
    let mut statuses = std::collections::HashMap::new();
    if let Some(ref v) = result.doc_number {
        let _ = db::update_doc_field(conn, &doc_id, "doc_number", v);
        statuses.insert("doc_number", "ai");
    }
    if let Some(ref v) = result.issued_by {
        let _ = db::update_doc_field(conn, &doc_id, "issued_by", v);
        statuses.insert("issued_by", "ai");
    }
    if let Some(ref v) = result.valid_from {
        let _ = db::update_doc_field(conn, &doc_id, "valid_from", v);
        statuses.insert("valid_from", "ai");
    }
    if let Some(ref v) = result.valid_to {
        let _ = db::update_doc_field(conn, &doc_id, "valid_to", v);
        statuses.insert("valid_to", "ai");
    }
    let statuses_json = serde_json::to_string(&statuses).unwrap_or_else(|_| "{}".to_string());
    let _ = db::update_field_statuses(conn, &doc_id, &statuses_json);

    Ok(result)
}

#[tauri::command]
pub fn save_api_key(state: State<AppState>, key: String) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::set_vault_info(conn, "api_key", &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key(state: State<AppState>) -> Result<String, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    Ok(read_saved_api_key(conn))
}

#[tauri::command]
pub fn get_effective_api_key(state: State<AppState>) -> Result<String, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let saved_key = read_saved_api_key(conn);
    if !saved_key.trim().is_empty() {
        return Ok(saved_key);
    }
    Ok(bundled_api_key())
}

#[tauri::command]
pub fn update_field_statuses(
    state: State<AppState>,
    id: String,
    statuses: String,
) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::update_field_statuses(conn, &id, &statuses).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_ai_correction(
    state: State<AppState>,
    doc_type: String,
    field_name: String,
    ai_value: String,
    correct_value: String,
) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::save_correction(conn, &doc_type, &field_name, &ai_value, &correct_value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_ocr_label(
    state: State<AppState>,
    doc_id: String,
    doc_type: String,
    field_name: String,
    ai_value: String,
    correct_value: String,
) -> Result<(), String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    let docs = db::get_all_docs(conn).map_err(|e| e.to_string())?;
    let file_sha256 = docs
        .iter()
        .find(|d| d.id == doc_id)
        .and_then(|d| d.sha256.as_deref());
    db::save_ocr_label(
        conn,
        &doc_id,
        &doc_type,
        &field_name,
        &ai_value,
        &correct_value,
        file_sha256,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ai_corrections(
    state: State<AppState>,
    doc_type: String,
) -> Result<Vec<(String, String, String)>, String> {
    let lock = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let conn = lock.as_ref().ok_or("No vault open")?;
    db::get_corrections(conn, &doc_type).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn category_has_template(category: String) -> bool {
    templates::get_template(&category).is_some()
}

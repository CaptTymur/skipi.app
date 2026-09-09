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

/// Generic OCR prompt sent to the vision model (client-side; the server proxy
/// forwards it verbatim). Kept as a const so unit tests can assert on it.
const BASE_PROMPT: &str = "You are a strict OCR assistant for maritime identity documents. Read ONLY what is literally printed on the page. DO NOT guess, infer, or invent any value. If a field is not clearly legible, return null for that field.\n\nRULES:\n- Copy every value EXACTLY as printed, character by character. Do not correct typos, do not autocomplete, do not reformat except where explicitly allowed below.\n- Never output a value that is not visible on the document. Null is always preferred over a guess.\n- Do not read MRZ lines (lines with `<<<`) — those are machine-readable and often confuse dates.\n- Return ONLY valid JSON. All string values MUST be inside double quotes. Dates MUST be quoted strings, not bare tokens.\n\nFields to extract:\n1. doc_number — the official document number as printed next to a label like 'No.', 'Document No.', 'Passport No.', 'Certificate No.', 'card No.', or 'Серія та номер'. Letters + digits (e.g. 'AB 516117', 'GG332748'). Copy exactly.\n2. issued_by — the text next to 'Issuing authority', 'Authority', 'Issued by', 'Issuing authority of office', 'Issued by (organisation)', 'Issuing institution', 'Training centre', 'Training center', 'Approved medical practitioner', 'Examiner', 'Видано', or 'Орган, що видав'. Could be a port or office name (e.g. 'PORT SEVASTOPOL'), a training centre or institution name, a medical practitioner / examiner name, or a numeric code (e.g. '2110'). If the page has no such label but an institution or centre name is printed on a line of its own next to or under the date of issue, that printed name is issued_by. Copy exactly.\n3. valid_from — the date next to 'Date of issue' / 'Issued' / 'Date of Issue'. Return as string 'YYYY-MM-DD'. Month names: JAN=01 FEB=02 MAR/БЕР=03 APR/КВІ=04 MAY/ТРА=05 JUN/ЧЕР=06 JUL/ЛИП=07 AUG/СЕР=08 SEP/ВЕР=09 OCT/ЖОВ=10 NOV/ЛИС=11 DEC/ГРУ=12. If unreadable, return null.\n4. valid_to — the date next to 'Date of expiry' / 'Valid until' / 'Prolonged till'. If there is a handwritten extension date, use that. Return as string 'YYYY-MM-DD'. If not present or unreadable, return null.\n5. title_suggestion — the type of document in English (Passport, Seaman's Identity Document, Certificate of Competency, etc.).\n\nOutput format — a single JSON object, nothing else, no prose, no markdown fences:\n{\"doc_number\": \"...\" or null, \"issued_by\": \"...\" or null, \"valid_from\": \"YYYY-MM-DD\" or null, \"valid_to\": \"YYYY-MM-DD\" or null, \"title_suggestion\": \"...\"}";

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
                // Compare on bytes: a `&s[i..i + n]` str slice panics when
                // `i + n` lands inside a multi-byte codepoint (any value that
                // starts with a Cyrillic letter, e.g. "Порт Одеса").
                let rest = &bytes[i..];
                let is_keyword = rest.starts_with(b"null")
                    || rest.starts_with(b"true")
                    || rest.starts_with(b"false");
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
        // Copy the whole codepoint, never `bytes[i] as char`: that re-encoded
        // every non-ASCII byte as a Latin-1 char and turned Cyrillic values
        // into mojibake ("Порт Одеса" → "ÐÐ¾ÑÑ…").
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Truncate a raw model response for inclusion in an error message.
///
/// Bug #1: `parse_ai_result` used to embed the ENTIRE raw model output in its
/// error string. When that error reached the UI it painted a full-width red
/// surface flooded with the raw response. Cap it at a short, codepoint-safe
/// prefix (slice by chars, never by byte index) so the error stays a hint, not
/// a screen-filling dump.
fn truncate_raw(s: &str) -> String {
    const MAX: usize = 200;
    let mut out: String = s.chars().take(MAX).collect();
    if s.chars().count() > MAX {
        out.push('…');
    }
    out
}

/// True when `s` starts with the literal form `DDDD-DD-DDT` (4 digits, '-',
/// 2 digits, '-', 2 digits, 'T'), checked codepoint by codepoint — never by
/// byte index, so multi-byte input can neither panic nor match by accident.
fn starts_with_iso_datetime(s: &str) -> bool {
    let mut it = s.chars();
    for expected in ['d', 'd', 'd', 'd', '-', 'd', 'd', '-', 'd', 'd', 'T'] {
        let ok = match (it.next(), expected) {
            (Some(c), 'd') => c.is_ascii_digit(),
            (Some(c), e) => c == e,
            (None, _) => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Keys the model sometimes uses instead of `issued_by`; mapped onto
/// `issued_by` only when it is absent / null / blank (`issued_by` wins).
const ISSUED_BY_SYNONYM_KEYS: [&str; 3] = ["issuing_authority", "authority", "issuer"];

/// Normalize the parsed model JSON in place, before it is mapped onto
/// `AiRecognizeResult` (and therefore before `result_has_core_fields`).
/// Pure function, no I/O — unit-tested on fixtures.
///
/// №257: the date cut applies ONLY to `valid_from` / `valid_to` and ONLY when
/// the value starts with `DDDD-DD-DDT`; every other string is left untouched
/// (doc numbers, issuers and titles used to be cut to 10 chars whenever they
/// contained a 'T', e.g. "COC-TEST-7788" → "COC-TEST-7").
fn normalize_ai_json(v: &mut serde_json::Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    for (key, val) in obj.iter_mut() {
        if let Some(arr) = val.as_array() {
            let joined = arr
                .iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            *val = serde_json::Value::String(joined);
        }
        if key == "valid_from" || key == "valid_to" {
            if let Some(s) = val.as_str() {
                if starts_with_iso_datetime(s) {
                    let date: String = s.chars().take(10).collect();
                    *val = serde_json::Value::String(date);
                }
            }
        }
    }
    // A6: issuer synonym keys → issued_by (issued_by has priority); the synonym
    // keys are removed so the struct never sees two candidates for one field.
    let issued_by_blank = obj
        .get("issued_by")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    let mut filled = !issued_by_blank;
    for syn in ISSUED_BY_SYNONYM_KEYS {
        // Always remove the synonym key; use it only while issued_by is blank.
        if let Some(candidate) = obj.remove(syn) {
            let is_str = candidate
                .as_str()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !filled && is_str {
                obj.insert("issued_by".to_string(), candidate);
                filled = true;
            }
        }
    }
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

    // Normalize JSON (arrays, dates, key synonyms) before mapping onto the struct
    match serde_json::from_str::<serde_json::Value>(&json_str) {
        Ok(mut v) => {
            normalize_ai_json(&mut v);
            serde_json::from_value(v).map_err(|e| {
                format!("Cannot parse AI response: {} — raw: {}", e, truncate_raw(&json_str))
            })
        }
        Err(e) => Err(format!(
            "Cannot parse AI response: {} — raw: {}",
            e,
            truncate_raw(&json_str)
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

        let base_prompt = BASE_PROMPT;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> AiRecognizeResult {
        parse_ai_result(json).expect("fixture must parse")
    }

    // ---- №257: only valid_from / valid_to are date-normalized -------------

    #[test]
    fn doc_number_with_T_is_not_truncated() {
        let r = parse(r#"{"doc_number": "COC-TEST-7788", "issued_by": null, "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.doc_number.as_deref(), Some("COC-TEST-7788"));
    }

    #[test]
    fn issued_by_with_T_not_truncated() {
        let r = parse(r#"{"doc_number": null, "issued_by": "Maritime Training Centre", "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.issued_by.as_deref(), Some("Maritime Training Centre"));
    }

    #[test]
    fn title_suggestion_not_truncated() {
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": null, "valid_to": null, "title_suggestion": "Certificate of Training"}"#);
        assert_eq!(r.title_suggestion.as_deref(), Some("Certificate of Training"));
    }

    #[test]
    fn valid_to_iso_datetime_is_cut_to_date() {
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": null, "valid_to": "2027-03-04T00:00:00", "title_suggestion": null}"#);
        assert_eq!(r.valid_to.as_deref(), Some("2027-03-04"));
    }

    #[test]
    fn valid_from_iso_datetime_is_cut_to_date() {
        // PRESERVE: the pre-existing behaviour for ISO datetimes stays.
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": "2026-01-01T00:00:00", "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.valid_from.as_deref(), Some("2026-01-01"));
    }

    #[test]
    fn valid_from_non_date_with_T_untouched() {
        // Strings containing 'T' that are NOT of the form DDDD-DD-DDT are left as-is,
        // whatever their length.
        for v in [
            "TBD 2026",
            "Tuesday",
            "Tuesday, 12 March 2026",
            "2027/03/04T00:00:00",
            "27-03-2004T00:00:00",
            "TILL 2027-03-04",
        ] {
            let json = format!(
                r#"{{"doc_number": null, "issued_by": null, "valid_from": "{v}", "valid_to": "{v}", "title_suggestion": null}}"#
            );
            let r = parse(&json);
            assert_eq!(r.valid_from.as_deref(), Some(v), "valid_from {v:?}");
            assert_eq!(r.valid_to.as_deref(), Some(v), "valid_to {v:?}");
        }
    }

    #[test]
    fn cyrillic_long_string_no_panic_no_cut() {
        // Bytes 11 and 13 land mid-codepoint here ("aa" + Cyrillic): any
        // byte-index slice such as `&s[..11]` panics. Values contain an ASCII
        // 'T' and are longer than 10 chars.
        let v = "aaМорський Тренувальний центр TRAINING, 2026";
        assert!(!v.is_char_boundary(11));
        let json = format!(
            r#"{{"doc_number": "{v}", "issued_by": "{v}", "valid_from": "{v}", "valid_to": "{v}", "title_suggestion": "{v}"}}"#
        );
        let r = parse(&json);
        assert_eq!(r.doc_number.as_deref(), Some(v));
        assert_eq!(r.issued_by.as_deref(), Some(v));
        assert_eq!(r.valid_from.as_deref(), Some(v));
        assert_eq!(r.valid_to.as_deref(), Some(v));
        assert_eq!(r.title_suggestion.as_deref(), Some(v));
    }

    #[test]
    fn repair_unquoted_scalars_cyrillic_value_no_panic() {
        // Latent panic found by №257 tests: `&s[i..i + 4]` in
        // repair_unquoted_scalars sliced mid-codepoint for quoted values that
        // start with a multi-byte letter. Must neither panic nor alter the value.
        // `title_suggestion` is an unquoted multi-byte scalar (the repair path).
        let raw = r#"{"doc_number": "AB 516117", "issued_by": "Порт Одеса", "valid_from": "2026-01-01", "valid_to": null, "title_suggestion": Посвідчення}"#;
        let repaired = repair_unquoted_scalars(raw);
        assert!(repaired.contains(r#""issued_by": "Порт Одеса""#), "{repaired}");
        assert!(repaired.contains(r#""title_suggestion": "Посвідчення""#), "{repaired}");
        let r = parse(raw);
        assert_eq!(r.issued_by.as_deref(), Some("Порт Одеса"));
        assert_eq!(r.title_suggestion.as_deref(), Some("Посвідчення"));
        assert_eq!(r.valid_from.as_deref(), Some("2026-01-01"));
    }

    #[test]
    fn exactly_11_chars_date_form() {
        // Exactly "DDDD-DD-DDT" (11 chars): the date form matches, keep the date.
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": "2027-03-04T", "valid_to": "2027-03-04T", "title_suggestion": null}"#);
        assert_eq!(r.valid_from.as_deref(), Some("2027-03-04"));
        assert_eq!(r.valid_to.as_deref(), Some("2027-03-04"));
        // A plain date (10 chars, no 'T') is untouched.
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": "2027-03-04", "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.valid_from.as_deref(), Some("2027-03-04"));
    }

    // ---- A6: issuer synonym keys -------------------------------------------

    #[test]
    fn synonym_key_issuing_authority_maps_to_issued_by() {
        // issued_by absent
        let r = parse(r#"{"doc_number": "X1", "issuing_authority": "Maritime Training Centre", "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.issued_by.as_deref(), Some("Maritime Training Centre"));
        // issued_by null
        let r = parse(r#"{"doc_number": "X1", "issued_by": null, "authority": "PORT SEVASTOPOL", "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.issued_by.as_deref(), Some("PORT SEVASTOPOL"));
        // issued_by empty string
        let r = parse(r#"{"doc_number": "X1", "issued_by": "  ", "issuer": "Approved medical practitioner Dr. T. Smith", "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.issued_by.as_deref(), Some("Approved medical practitioner Dr. T. Smith"));
    }

    #[test]
    fn both_keys_present_no_duplicate_field_error_issued_by_wins() {
        let r = parse(r#"{"doc_number": "X1", "issued_by": "PORT ODESA", "issuing_authority": "SOMEONE ELSE", "authority": "THIRD", "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.issued_by.as_deref(), Some("PORT ODESA"));
        let mut v: serde_json::Value = serde_json::from_str(r#"{"issued_by": "PORT ODESA", "issuing_authority": "SOMEONE ELSE"}"#).unwrap();
        normalize_ai_json(&mut v);
        assert_eq!(v.get("issued_by").and_then(|x| x.as_str()), Some("PORT ODESA"));
        assert!(v.get("issuing_authority").is_none(), "synonym key removed after mapping");
    }

    #[test]
    fn arrays_still_joined() {
        let r = parse(r#"{"doc_number": ["AB", "516117"], "issued_by": ["Port", "Odesa"], "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert_eq!(r.doc_number.as_deref(), Some("AB, 516117"));
        assert_eq!(r.issued_by.as_deref(), Some("Port, Odesa"));
    }

    #[test]
    fn null_field_stays_none() {
        let r = parse(r#"{"doc_number": null, "issued_by": null, "valid_from": null, "valid_to": null, "title_suggestion": null}"#);
        assert!(r.doc_number.is_none());
        assert!(r.issued_by.is_none());
        assert!(r.valid_from.is_none());
        assert!(r.valid_to.is_none());
        assert!(r.title_suggestion.is_none());
        let mut v: serde_json::Value = serde_json::from_str(r#"{"issued_by": null, "issuing_authority": null}"#).unwrap();
        normalize_ai_json(&mut v);
        assert!(v.get("issued_by").map(|x| x.is_null()).unwrap_or(true));
    }

    // ---- A6: prompt ---------------------------------------------------------

    #[test]
    fn prompt_mentions_training_centre_and_medical_practitioner() {
        let p = BASE_PROMPT;
        let item2_start = p.find("2. issued_by").expect("item 2 present");
        let item2_end = p.find("3. valid_from").expect("item 3 present");
        let item2 = &p[item2_start..item2_end];
        for needle in [
            "Training centre",
            "Training center",
            "Issuing institution",
            "Approved medical practitioner",
            "Examiner",
            "Issued by (organisation)",
            "Видано",
            "Орган, що видав",
        ] {
            assert!(item2.contains(needle), "item 2 must mention {needle:?}");
        }
        assert!(item2.contains("date of issue"), "label-less institution line near the date of issue rule");
        assert!(!item2.to_lowercase().contains("guess"), "no 'guess' wording in issued_by rule");
    }

    #[test]
    fn prompt_length_under_4000() {
        assert!(BASE_PROMPT.chars().count() < 4000, "prompt is {} chars", BASE_PROMPT.chars().count());
    }

    #[test]
    fn prompt_output_format_five_keys_unchanged() {
        const HEAD: &str = "You are a strict OCR assistant for maritime identity documents. Read ONLY what is literally printed on the page. DO NOT guess, infer, or invent any value. If a field is not clearly legible, return null for that field.\n\nRULES:\n- Copy every value EXACTLY as printed, character by character. Do not correct typos, do not autocomplete, do not reformat except where explicitly allowed below.\n- Never output a value that is not visible on the document. Null is always preferred over a guess.\n- Do not read MRZ lines (lines with `<<<`) — those are machine-readable and often confuse dates.\n- Return ONLY valid JSON. All string values MUST be inside double quotes. Dates MUST be quoted strings, not bare tokens.\n\nFields to extract:\n";
        const ITEM1: &str = "1. doc_number — the official document number as printed next to a label like 'No.', 'Document No.', 'Passport No.', 'Certificate No.', 'card No.', or 'Серія та номер'. Letters + digits (e.g. 'AB 516117', 'GG332748'). Copy exactly.\n";
        const ITEM3: &str = "3. valid_from — the date next to 'Date of issue' / 'Issued' / 'Date of Issue'. Return as string 'YYYY-MM-DD'. Month names: JAN=01 FEB=02 MAR/БЕР=03 APR/КВІ=04 MAY/ТРА=05 JUN/ЧЕР=06 JUL/ЛИП=07 AUG/СЕР=08 SEP/ВЕР=09 OCT/ЖОВ=10 NOV/ЛИС=11 DEC/ГРУ=12. If unreadable, return null.\n";
        const ITEM4: &str = "4. valid_to — the date next to 'Date of expiry' / 'Valid until' / 'Prolonged till'. If there is a handwritten extension date, use that. Return as string 'YYYY-MM-DD'. If not present or unreadable, return null.\n";
        const ITEM5: &str = "5. title_suggestion — the type of document in English (Passport, Seaman's Identity Document, Certificate of Competency, etc.).\n\n";
        const OUTPUT: &str = "Output format — a single JSON object, nothing else, no prose, no markdown fences:\n{\"doc_number\": \"...\" or null, \"issued_by\": \"...\" or null, \"valid_from\": \"YYYY-MM-DD\" or null, \"valid_to\": \"YYYY-MM-DD\" or null, \"title_suggestion\": \"...\"}";
        let p = BASE_PROMPT;
        assert!(p.starts_with(HEAD), "header/rules changed");
        assert!(p.ends_with(OUTPUT), "output format changed");
        assert!(p.contains(ITEM1), "item 1 changed");
        assert!(p.contains(ITEM3), "item 3 changed");
        assert!(p.contains(ITEM4), "item 4 changed");
        assert!(p.contains(ITEM5), "item 5 changed");
        let i1 = p.find(ITEM1).unwrap();
        let i2 = p.find("2. issued_by").unwrap();
        let i3 = p.find(ITEM3).unwrap();
        let i4 = p.find(ITEM4).unwrap();
        let i5 = p.find(ITEM5).unwrap();
        assert!(i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5, "item order changed");
        assert_eq!(p.matches("2. issued_by").count(), 1);
        for key in ["doc_number", "issued_by", "valid_from", "valid_to", "title_suggestion"] {
            assert!(OUTPUT.contains(&format!("\"{key}\"")));
        }
    }
}

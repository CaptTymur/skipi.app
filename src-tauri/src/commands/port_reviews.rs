//! Survey and reviews of ports (Port DB → a port's page).
//!
//! Owner, 26.11.2026: «нужно дать пользователям найти порт и оставить по нему отзыв»;
//! «сюрвей и отзыв. сход на берег, бюрократия и ограничения и так далее, пока эти 2».
//!
//! The port list itself ships with the app (`dist/skipi-ports.data.js`, UN/LOCODE);
//! what people say about a port lives with the Skipi account on assistant.skipi.app
//! (`webapp/port_reviews.py`). Reading is open; answering, rating, removing and
//! reporting need the signed-in account. The page never holds the account token.

use serde_json::{json, Map, Value};
use tauri::State;

use crate::commands::plugin_reviews::{
    cap, run, session_token, Call, MAX_REASON_CHARS, MAX_TEXT_CHARS,
};
use crate::AppState;

/// The survey topics the server knows; anything else never leaves the device.
const SURVEY_TOPICS: [&str; 2] = ["shore_leave", "bureaucracy"];

/// A UN/LOCODE code as the port list writes it (`UAODS`); anything else never reaches a URL.
fn valid_code(code: &str) -> bool {
    let b = code.as_bytes();
    b.len() == 5
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn code_or_err(code: &str) -> Result<&str, String> {
    if valid_code(code) {
        Ok(code)
    } else {
        Err("unknown port".to_string())
    }
}

/// `{topic: 1..5 | null}` with known topics only; `null` clears an answer.
fn survey_answers(answers: &Value) -> Result<Map<String, Value>, String> {
    let given = answers.as_object().ok_or_else(|| "bad_request".to_string())?;
    if given.is_empty() {
        return Err("bad_request".to_string());
    }
    let mut out = Map::new();
    for (topic, score) in given {
        if !SURVEY_TOPICS.contains(&topic.as_str()) {
            return Err("bad_topic".to_string());
        }
        match score {
            Value::Null => {}
            Value::Number(n) if n.as_u64().is_some_and(|v| (1..=5).contains(&v)) => {}
            _ => return Err("bad_score".to_string()),
        }
        out.insert(topic.clone(), score.clone());
    }
    Ok(out)
}

/// `{ratings: {code: {average, count}}}` for every port somebody has rated. Open.
#[tauri::command]
pub async fn port_ratings() -> Result<Value, String> {
    run("/api/app/ports/ratings".to_string(), Call::Get, None).await
}

/// `{rating, reviews, more, mine, survey, my_survey, signed_in}` for one port.
#[tauri::command]
pub async fn port_reviews_list(
    state: State<'_, AppState>,
    code: String,
    offset: Option<u32>,
) -> Result<Value, String> {
    let code = code_or_err(&code)?.to_string();
    let token = session_token(&state);
    let signed_in = token.is_some();
    let path = format!(
        "/api/app/ports/{}/reviews?offset={}",
        code,
        offset.unwrap_or(0)
    );
    let mut body = run(path, Call::Get, token).await?;
    if let Some(map) = body.as_object_mut() {
        map.insert("signed_in".to_string(), json!(signed_in));
    }
    Ok(body)
}

/// Rate a port 1–5 with optional chips and text; replaces the account's earlier review.
#[tauri::command]
pub async fn port_review_save(
    state: State<'_, AppState>,
    code: String,
    stars: u8,
    tags: Option<Vec<String>>,
    text: Option<String>,
    lang: Option<String>,
) -> Result<Value, String> {
    let code = code_or_err(&code)?.to_string();
    if !(1..=5).contains(&stars) {
        return Err("bad_stars".to_string());
    }
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    // Chips («таблетки»): the server knows the keys and drops the ones that do not fit the rating.
    let tags: Vec<String> = tags.unwrap_or_default().into_iter().take(8).collect();
    let body = json!({ "stars": stars, "tags": tags, "text": cap(text, MAX_TEXT_CHARS), "lang": lang });
    run(
        format!("/api/app/ports/{}/review", code),
        Call::Put(body),
        Some(token),
    )
    .await
}

#[tauri::command]
pub async fn port_review_delete(state: State<'_, AppState>, code: String) -> Result<Value, String> {
    let code = code_or_err(&code)?.to_string();
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    run(
        format!("/api/app/ports/{}/review", code),
        Call::Delete,
        Some(token),
    )
    .await
}

/// Report someone else's review to the owner.
#[tauri::command]
pub async fn port_review_report(
    state: State<'_, AppState>,
    code: String,
    review_id: u64,
    reason: Option<String>,
) -> Result<Value, String> {
    let code = code_or_err(&code)?.to_string();
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    run(
        format!("/api/app/ports/{}/reviews/{}/report", code, review_id),
        Call::Post(json!({ "reason": cap(reason, MAX_REASON_CHARS) })),
        Some(token),
    )
    .await
}

/// Answer the port survey: `answers = {shore_leave: 1..5 | null, bureaucracy: 1..5 | null}`.
#[tauri::command]
pub async fn port_survey_save(
    state: State<'_, AppState>,
    code: String,
    answers: Value,
) -> Result<Value, String> {
    let code = code_or_err(&code)?.to_string();
    let answers = survey_answers(&answers)?;
    let token = session_token(&state).ok_or_else(|| "sign_in".to_string())?;
    run(
        format!("/api/app/ports/{}/survey", code),
        Call::Put(json!({ "answers": answers })),
        Some(token),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_port_code_reaches_a_url() {
        for ok in ["UAODS", "NLRTM", "NLA2Z", "US2AB"] {
            assert!(valid_code(ok), "{ok}");
        }
        for bad in [
            "", "uaods", "UA ODS", "UA-ODS", "UAOD", "UAODSS", "12345", "U1ODS", "UA/..", "UAOD?",
            "ЮАОДС",
        ] {
            assert!(!valid_code(bad), "{bad}");
        }
        assert_eq!(code_or_err("../etc"), Err("unknown port".to_string()));
    }

    #[test]
    fn survey_takes_known_topics_with_a_score_or_a_clear() {
        let ok = survey_answers(&json!({"shore_leave": 5, "bureaucracy": null})).unwrap();
        assert_eq!(Value::Object(ok), json!({"shore_leave": 5, "bureaucracy": null}));
        assert_eq!(survey_answers(&json!({})), Err("bad_request".to_string()));
        assert_eq!(survey_answers(&json!("x")), Err("bad_request".to_string()));
        assert_eq!(survey_answers(&json!({"weather": 3})), Err("bad_topic".to_string()));
        for bad in [json!(0), json!(6), json!("5"), json!(true), json!(4.5), json!(-1)] {
            assert_eq!(
                survey_answers(&json!({ "shore_leave": bad })),
                Err("bad_score".to_string())
            );
        }
    }
}

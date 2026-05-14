use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::Serialize;

pub(crate) const PRIMARY_API: &str = "https://api.skipi.app";
pub(crate) const RU_API: &str = "https://api-ru.skipi.app";

pub(crate) fn env_api_base() -> Option<String> {
    std::env::var("SKIPI_API_BASE")
        .ok()
        .map(|s| normalize_api_base(&s))
        .filter(|s| !s.is_empty())
}

fn is_loopback_api_base(base: &str) -> bool {
    let trimmed = base.trim().trim_end_matches('/').to_ascii_lowercase();
    trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("https://127.0.0.1")
        || trimmed.starts_with("http://localhost")
        || trimmed.starts_with("https://localhost")
}

pub(crate) fn api_bases() -> Vec<String> {
    if let Some(base) = env_api_base() {
        if is_loopback_api_base(&base) {
            return vec![base, PRIMARY_API.to_string(), RU_API.to_string()];
        }
        return vec![base];
    }
    vec![PRIMARY_API.to_string(), RU_API.to_string()]
}

fn normalize_api_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

fn api_url(base: &str, path: &str) -> String {
    let suffix = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("{}{suffix}", normalize_api_base(base))
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(crate) fn get_json<T>(client: &Client, path: &str) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let bases = api_bases();
    let mut last_err = String::from("API unavailable");

    for (idx, base) in bases.iter().enumerate() {
        let url = api_url(base, path);
        match client.get(&url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp.json().map_err(|e| format!("bad JSON: {e}"));
                }
                let body = resp.text().unwrap_or_default();
                let msg = format!("{base} returned {status}: {body}");
                if idx + 1 < bases.len() && retryable_status(status) {
                    last_err = msg;
                    continue;
                }
                return Err(format!("server returned {status}: {body}"));
            }
            Err(e) => {
                last_err = format!("{base} network: {e}");
                continue;
            }
        }
    }

    Err(last_err)
}

pub(crate) fn post_empty(client: &Client, path: &str) -> Result<(), String> {
    let bases = api_bases();
    let mut last_err = String::from("API unavailable");

    for base in &bases {
        let url = api_url(base, path);
        match client.post(&url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() || status.as_u16() == 204 {
                    return Ok(());
                }
                let body = resp.text().unwrap_or_default();
                return Err(format!("server returned {status}: {body}"));
            }
            Err(e) => {
                last_err = format!("{base} network: {e}");
                continue;
            }
        }
    }

    Err(last_err)
}

pub(crate) fn post_json<T, B>(client: &Client, path: &str, body: &B) -> Result<T, String>
where
    T: DeserializeOwned,
    B: Serialize + ?Sized,
{
    let bases = api_bases();
    let mut last_err = String::from("API unavailable");

    for base in &bases {
        let url = api_url(base, path);
        match client.post(&url).json(body).send() {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp.json().map_err(|e| format!("bad JSON: {e}"));
                }
                let body = resp.text().unwrap_or_default();
                return Err(format!("server returned {status}: {body}"));
            }
            Err(e) => {
                last_err = format!("{base} network: {e}");
                continue;
            }
        }
    }

    Err(last_err)
}

pub(crate) fn post_json_empty<B>(client: &Client, path: &str, body: &B) -> Result<(), String>
where
    B: Serialize + ?Sized,
{
    let bases = api_bases();
    let mut last_err = String::from("API unavailable");

    for base in &bases {
        let url = api_url(base, path);
        match client.post(&url).json(body).send() {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() || status.as_u16() == 204 {
                    return Ok(());
                }
                let body = resp.text().unwrap_or_default();
                return Err(format!("server returned {status}: {body}"));
            }
            Err(e) => {
                last_err = format!("{base} network: {e}");
                continue;
            }
        }
    }

    Err(last_err)
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfigPublic {
    pub email: String,
    pub display_name: Option<String>,
    pub host: String,
    pub port: u16,
    pub encryption: String,
    pub has_password: bool,
}

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub recipients: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

fn mobile_smtp_unavailable() -> String {
    "Direct SMTP sending is desktop-only in this build. Use the mobile share/mail flow instead."
        .to_string()
}

#[tauri::command]
pub fn suggest_smtp_from_email(_email: String) -> serde_json::Value {
    serde_json::json!({
        "host": "",
        "port": 587,
        "encryption": "starttls",
        "provider": "Mobile builds use the system mail/share flow."
    })
}

#[tauri::command]
pub fn get_smtp_config() -> Option<SmtpConfigPublic> {
    None
}

#[tauri::command]
pub fn save_smtp_config(
    _email: String,
    _display_name: Option<String>,
    _host: String,
    _port: u16,
    _encryption: String,
    _password: Option<String>,
) -> Result<(), String> {
    Err(mobile_smtp_unavailable())
}

#[tauri::command]
pub fn clear_smtp_config() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn test_smtp_connection(
    _email: String,
    _host: String,
    _port: u16,
    _encryption: String,
    _password: Option<String>,
) -> Result<String, String> {
    Err(mobile_smtp_unavailable())
}

#[tauri::command]
pub fn send_email_smtp(_req: SendEmailRequest) -> Result<String, String> {
    Err(mobile_smtp_unavailable())
}

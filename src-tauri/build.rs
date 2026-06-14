use std::{env, fs, path::PathBuf};

fn configured_anthropic_key() -> Option<String> {
    if let Ok(key) = env::var("SKIPI_ANTHROPIC_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }

    let home = env::var("HOME").ok()?;
    let env_path = PathBuf::from(home).join(".config/skipi/anthropic_ocr.env");
    println!("cargo:rerun-if-changed={}", env_path.display());

    let raw = fs::read_to_string(env_path).ok()?;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("ANTHROPIC_API_KEY=") {
            let key = value.trim().trim_matches('"').to_string();
            if !key.is_empty() {
                return Some(key);
            }
        }
    }
    None
}

fn main() {
    println!("cargo:rerun-if-env-changed=SKIPI_ANTHROPIC_API_KEY");
    if let Some(key) = configured_anthropic_key() {
        println!("cargo:rustc-env=SKIPI_ANTHROPIC_API_KEY={}", key);
    }

    tauri_build::build()
}

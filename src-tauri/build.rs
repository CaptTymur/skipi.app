use std::{env, fs, path::PathBuf, process::Command};

fn build_sha() -> String {
    if let Ok(sha) = env::var("SKIPI_BUILD_SHA").or_else(|_| env::var("GITHUB_SHA")) {
        let sha = sha.trim();
        if !sha.is_empty() {
            return sha.chars().take(12).collect();
        }
    }

    if let Ok(out) = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
    {
        if out.status.success() {
            let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !sha.is_empty() {
                return sha;
            }
        }
    }

    "unknown".to_string()
}

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
    println!("cargo:rerun-if-env-changed=SKIPI_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rustc-env=SKIPI_BUILD_SHA={}", build_sha());
    if let Some(key) = configured_anthropic_key() {
        println!("cargo:rustc-env=SKIPI_ANTHROPIC_API_KEY={}", key);
    }

    tauri_build::build()
}

//! Speech and vibration for plugins (host-runtime 1.3: grants `speech` and `vibrate`).
//!
//! Camera, microphone and location need no native command: the page captures them in the
//! host document (`dist/plugin-remote-boot.js`) and the runtime hands the data to the plugin.
//! Native code is needed only where the WebView has nothing to offer:
//!   - Android has no speech synthesis in the WebView → the system text-to-speech engine
//!     (`MainActivity.speakSkipi`);
//!   - iOS has no `navigator.vibrate` → the system vibration (`AudioServicesPlaySystemSound`).
//! Each command answers `true` when it did the job and `false` when this platform has no
//! native path (the page then uses the web one, or tells the plugin it is unavailable).

/// Phrase limits as the runtime fixes them; applied again here, the command is callable
/// from the page.
fn clean_phrase(text: &str) -> Option<String> {
    let text: String = text.chars().take(500).collect();
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// A plain language tag (`ru`, `en-GB`); anything else means "the engine's own language".
fn clean_lang(lang: Option<String>) -> String {
    let lang = lang.unwrap_or_default();
    let ok = !lang.is_empty()
        && lang.len() <= 20
        && lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        lang
    } else {
        String::new()
    }
}

fn clamp_voice(v: Option<f32>) -> f32 {
    match v {
        Some(v) if v.is_finite() => v.clamp(0.5, 2.0),
        _ => 1.0,
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_speak(
    window: tauri::WebviewWindow,
    text: String,
    lang: Option<String>,
    rate: Option<f32>,
    pitch: Option<f32>,
) -> Result<bool, String> {
    use super::motion::android::{string_result, with_activity};
    use jni::objects::{JObject, JValue};

    let Some(text) = clean_phrase(&text) else {
        return Err("nothing to say".to_string());
    };
    let (lang, rate, pitch) = (clean_lang(lang), clamp_voice(rate), clamp_voice(pitch));
    let answer = with_activity(&window, move |env, activity| {
        let text = JObject::from(
            env.new_string(text)
                .map_err(|e| format!("Speech text: {}", e))?,
        );
        let lang = JObject::from(
            env.new_string(lang)
                .map_err(|e| format!("Speech language: {}", e))?,
        );
        let value = env
            .call_method(
                activity,
                "speakSkipi",
                "(Ljava/lang/String;Ljava/lang/String;FF)Ljava/lang/String;",
                &[
                    JValue::Object(&text),
                    JValue::Object(&lang),
                    JValue::Float(rate),
                    JValue::Float(pitch),
                ],
            )
            .map_err(|e| format!("Speak on Android: {}", e))?
            .l()
            .map_err(|e| format!("Speak on Android: {}", e))?;
        string_result(env, value)
    })?;
    match answer.strip_prefix("ERROR:") {
        Some(reason) => Err(reason.to_string()),
        None => Ok(true),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_speech_stop(window: tauri::WebviewWindow) -> Result<bool, String> {
    use super::motion::android::with_activity;
    with_activity(&window, move |env, activity| {
        env.call_method(activity, "stopSkipiSpeech", "()V", &[])
            .map_err(|e| format!("Stop speech: {}", e))?;
        Ok(true)
    })
}

/// Android vibrates from the page (`navigator.vibrate`, the VIBRATE permission is declared).
#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_vibrate(pattern: Vec<u32>) -> Result<bool, String> {
    let _ = pattern;
    Ok(false)
}

// iOS and desktop speak from the page (`speechSynthesis`), where the WebView has it.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn plugin_speak(
    text: String,
    lang: Option<String>,
    rate: Option<f32>,
    pitch: Option<f32>,
) -> Result<bool, String> {
    let _ = (
        clean_phrase(&text),
        clean_lang(lang),
        clamp_voice(rate),
        clamp_voice(pitch),
    );
    Ok(false)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn plugin_speech_stop() -> Result<bool, String> {
    Ok(false)
}

/// iOS: one system vibration per call (the system does not take a duration); the page
/// repeats it for each step of a pattern.
#[cfg(target_os = "ios")]
#[tauri::command]
pub fn plugin_vibrate(pattern: Vec<u32>) -> Result<bool, String> {
    use std::ffi::{c_char, c_int, c_void, CString};
    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const VIBRATE: u32 = 4095; // kSystemSoundID_Vibrate
    if !pattern.iter().any(|ms| *ms > 0) {
        return Ok(true);
    }
    unsafe {
        let path = CString::new("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox")
            .map_err(|_| "bad path".to_string())?;
        let name =
            CString::new("AudioServicesPlaySystemSound").map_err(|_| "bad name".to_string())?;
        let handle = dlopen(path.as_ptr(), 2 /* RTLD_NOW */);
        if handle.is_null() {
            return Ok(false);
        }
        let symbol = dlsym(handle, name.as_ptr());
        if symbol.is_null() {
            return Ok(false);
        }
        let play: unsafe extern "C" fn(u32) = std::mem::transmute(symbol);
        play(VIBRATE);
    }
    Ok(true)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn plugin_vibrate(pattern: Vec<u32>) -> Result<bool, String> {
    let _ = pattern;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phrase_is_capped_and_an_empty_one_refused() {
        assert_eq!(
            clean_phrase("Левый борт, двенадцать").as_deref(),
            Some("Левый борт, двенадцать")
        );
        assert_eq!(
            clean_phrase(&"я".repeat(900)).map(|s| s.chars().count()),
            Some(500)
        );
        assert_eq!(clean_phrase("  \n "), None);
    }

    #[test]
    fn only_a_plain_language_tag_passes() {
        assert_eq!(clean_lang(Some("ru-RU".into())), "ru-RU");
        assert_eq!(clean_lang(Some("en".into())), "en");
        assert_eq!(clean_lang(Some("ru; rm -rf".into())), "");
        assert_eq!(clean_lang(Some("x".repeat(40))), "");
        assert_eq!(clean_lang(None), "");
    }

    #[test]
    fn rate_and_pitch_are_clamped() {
        assert_eq!(clamp_voice(Some(9.0)), 2.0);
        assert_eq!(clamp_voice(Some(0.1)), 0.5);
        assert_eq!(clamp_voice(Some(f32::NAN)), 1.0);
        assert_eq!(clamp_voice(None), 1.0);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_has_no_native_path() {
        assert_eq!(plugin_speak("hello".into(), None, None, None), Ok(false));
        assert_eq!(plugin_speech_stop(), Ok(false));
        assert_eq!(plugin_vibrate(vec![100]), Ok(false));
    }
}

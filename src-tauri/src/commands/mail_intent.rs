//! `.eml` mail-intent generation — cross-platform deterministic Apply fallback.
//!
//! Per `EMAIL_DELIVERY_DECISION.md` and PM audit (2026-04-28): when SMTP is
//! not configured and E2E is unavailable, write a fully-formed `.eml` file
//! into `~/Downloads/Skipi/Outbox/` and hand it to the OS opener. Users
//! land in their mail client with a draft they can review and send.
//!
//! `mailto:` is intentionally NOT used — attachments don't survive across
//! mail clients on Linux/macOS/Windows.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct MailIntent {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailIntentResult {
    pub status: String,
    pub eml_path: String,
    pub folder_path: String,
    pub message: String,
}

const FOOTER: &str = "Sent via Skipi (https://skipi.app)";

#[cfg(target_os = "android")]
fn outbox_dir() -> PathBuf {
    PathBuf::from("/storage/emulated/0/Download")
        .join("Skipi")
        .join("Outbox")
}

#[cfg(not(target_os = "android"))]
fn outbox_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Downloads").join("Skipi").join("Outbox")
}

/// Map common file extensions to MIME types. Falls back to
/// `application/octet-stream` for unknown extensions — receivers will still
/// open the attachment, just without a preview hint.
fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("txt") => "text/plain",
        Some("csv") => "text/csv",
        Some("eml") => "message/rfc822",
        _ => "application/octet-stream",
    }
}

/// RFC 2047 encoded-word for headers containing non-ASCII — Cyrillic vessel
/// names and seafarer surnames are common.
fn encode_header(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    format!("=?UTF-8?B?{}?=", b64)
}

/// Filesystem-safe filename slug.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn rfc2822_date_now() -> String {
    // Use chrono via tauri's existing transitive dep if available; otherwise
    // hand-format from SystemTime. The SMTP module already pulls chrono.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0)
        .map(|dt| dt.format("%a, %d %b %Y %H:%M:%S +0000").to_string())
        .unwrap_or_else(|| "Mon, 01 Jan 2026 00:00:00 +0000".to_string())
}

fn build_eml(intent: &MailIntent) -> Result<String, String> {
    let boundary = format!(
        "=_skipi_{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let mut body_with_footer = intent.body.clone();
    if !body_with_footer.contains(FOOTER) {
        if !body_with_footer.is_empty() && !body_with_footer.ends_with('\n') {
            body_with_footer.push('\n');
        }
        body_with_footer.push('\n');
        body_with_footer.push_str(FOOTER);
        body_with_footer.push('\n');
    }
    // Normalize to CRLF for MIME compliance.
    let body_crlf = body_with_footer.replace("\r\n", "\n").replace('\n', "\r\n");

    let to_header = intent.to.join(", ");
    let mut out = String::new();
    out.push_str(&format!("To: {}\r\n", to_header));
    out.push_str(&format!("Subject: {}\r\n", encode_header(&intent.subject)));
    out.push_str(&format!("Date: {}\r\n", rfc2822_date_now()));
    out.push_str("MIME-Version: 1.0\r\n");
    out.push_str(&format!(
        "Content-Type: multipart/mixed; boundary=\"{}\"\r\n",
        boundary
    ));
    out.push_str("\r\n");
    out.push_str("This is a multi-part message in MIME format.\r\n");

    // Text/plain part.
    out.push_str(&format!("--{}\r\n", boundary));
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n");
    out.push_str("\r\n");
    out.push_str(&body_crlf);
    out.push_str("\r\n");

    // Attachment parts.
    for path_str in &intent.attachments {
        let path = Path::new(path_str);
        if !path.exists() {
            return Err(format!("attachment not found: {}", path_str));
        }
        let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path_str, e))?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment.bin");
        let mime = guess_mime(path);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        out.push_str(&format!("--{}\r\n", boundary));
        out.push_str(&format!(
            "Content-Type: {}; name=\"{}\"\r\n",
            mime,
            encode_header(filename)
        ));
        out.push_str("Content-Transfer-Encoding: base64\r\n");
        out.push_str(&format!(
            "Content-Disposition: attachment; filename=\"{}\"\r\n",
            encode_header(filename)
        ));
        out.push_str("\r\n");
        // Wrap base64 to 76-char lines per RFC 2045.
        for chunk in b64.as_bytes().chunks(76) {
            out.push_str(std::str::from_utf8(chunk).unwrap());
            out.push_str("\r\n");
        }
    }

    out.push_str(&format!("--{}--\r\n", boundary));
    Ok(out)
}

#[cfg(target_os = "android")]
fn open_path(_path: &Path) {}

#[cfg(not(target_os = "android"))]
fn open_path(path: &Path) {
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}

#[tauri::command]
pub fn create_email_file(intent: MailIntent) -> Result<MailIntentResult, String> {
    if intent.to.is_empty() {
        return Err("at least one recipient required".into());
    }
    let dir = outbox_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create outbox: {}", e))?;

    let eml = build_eml(&intent)?;

    let purpose = intent
        .purpose
        .as_deref()
        .map(slugify)
        .unwrap_or_else(|| "apply".to_string());
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let fname = format!("Skipi_{}_{}.eml", purpose, stamp);
    let eml_path = dir.join(&fname);

    fs::write(&eml_path, eml).map_err(|e| format!("write {}: {}", eml_path.display(), e))?;

    // Try to open the .eml itself; if the OS has no handler the user can find
    // it via the folder path. Fire and forget — we never want this to block.
    open_path(&eml_path);

    Ok(MailIntentResult {
        status: "ok".into(),
        eml_path: eml_path.to_string_lossy().to_string(),
        folder_path: dir.to_string_lossy().to_string(),
        message: format!("Email file created: {}", fname),
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn safe_share_file_name(path: &Path, idx: usize) -> String {
    let original = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment");
    let clean: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_matches('_');
    if clean.is_empty() {
        format!("skipi-attachment-{}", idx + 1)
    } else {
        clean.to_string()
    }
}

/// How long a staged Share copy may stay in `app_cache/skipi-share` before the
/// NEXT share removes it.
///
/// LIMIT, stated rather than dressed up: Android gives no "the recipient has
/// read it" signal back. `shareSkipiDispatch` grants read access with
/// `FLAG_GRANT_READ_URI_PERMISSION` and no `FLAG_GRANT_PERSISTABLE_URI_PERMISSION`,
/// so nothing ever tells us the file was opened. Any retention window is
/// therefore a guess; this one is deliberately far longer than a hand-off takes,
/// and it is checked BEFORE the new copies are staged, so the files of the
/// CURRENT share can never fall inside it.
const SHARE_CACHE_RETENTION_MS: u128 = 24 * 60 * 60 * 1000;

/// The millisecond stamp a staged copy carries in its name
/// (`<stamp>-<index>-<safe name>`). Anything else is not ours to delete.
#[allow(dead_code)]
fn share_cache_stamp(name: &str) -> Option<u128> {
    let head = name.split('-').next()?;
    if head.is_empty() || !head.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    head.parse::<u128>().ok()
}

/// A staged copy is removable only when its own stamp is at least a whole
/// retention window older than the stamp of the share being prepared right now.
/// Files written by the current call carry `now_ms` itself, so they can never
/// satisfy this — the cleanup physically cannot touch the session it precedes.
#[allow(dead_code)]
fn share_cache_entry_is_stale(name: &str, now_ms: u128, retention_ms: u128) -> bool {
    match share_cache_stamp(name) {
        Some(stamp) => stamp.saturating_add(retention_ms) <= now_ms,
        None => false,
    }
}

/// Bounded cleanup of the Share staging folder. Runs before new copies are
/// staged; leaves anything it does not recognise alone.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn purge_stale_share_cache(cache_dir: &Path, now_ms: u128) {
    let entries = match fs::read_dir(cache_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n,
            None => continue,
        };
        if !share_cache_entry_is_stale(name, now_ms, SHARE_CACHE_RETENTION_MS) {
            continue;
        }
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn copy_attachments_to_share_cache(
    app: &tauri::AppHandle,
    attachments: &[String],
) -> Result<Vec<String>, String> {
    use tauri::Manager;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Resolve share cache dir: {}", e))?
        .join("skipi-share");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Create share cache: {}", e))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Until this slice the folder was only ever written to: every Share (both
    // the `share` and the `email` mode of the mailing wizard go through this one
    // function) left a full readable copy of every attachment behind forever.
    purge_stale_share_cache(&cache_dir, stamp);
    let mut out = Vec::new();
    for (idx, path_str) in attachments.iter().enumerate() {
        let source = Path::new(path_str);
        if !source.exists() {
            return Err(format!("Attachment not found: {}", path_str));
        }
        let target = cache_dir.join(format!(
            "{}-{}-{}",
            stamp,
            idx + 1,
            safe_share_file_name(source, idx)
        ));
        fs::copy(source, &target).map_err(|e| format!("Prepare share attachment: {}", e))?;
        out.push(target.to_string_lossy().to_string());
    }
    Ok(out)
}

/// Open the native Android share sheet with a Skipi dispatch draft.
/// The frontend prepares CV/PDF/ZIP files first, then this command copies
/// them into app cache and hands content URIs to Android via FileProvider.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn mobile_share_dispatch(
    window: tauri::WebviewWindow,
    recipients: Vec<String>,
    subject: String,
    body: String,
    attachments: Vec<String>,
    mode: Option<String>,
) -> Result<String, String> {
    use jni::objects::{JObject, JString, JValue};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Manager;

    let share_paths = copy_attachments_to_share_cache(window.app_handle(), &attachments)?;
    let recipients_joined = recipients.join("\n");
    let paths_joined = share_paths.join("\n");
    let mode = mode.unwrap_or_else(|| "share".to_string());
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = (|| -> Result<String, String> {
                    let subject_string = env
                        .new_string(subject)
                        .map_err(|e| format!("Android subject string: {}", e))?;
                    let body_string = env
                        .new_string(body)
                        .map_err(|e| format!("Android body string: {}", e))?;
                    let recipients_string = env
                        .new_string(recipients_joined)
                        .map_err(|e| format!("Android recipients string: {}", e))?;
                    let paths_string = env
                        .new_string(paths_joined)
                        .map_err(|e| format!("Android attachment string: {}", e))?;
                    let mode_string = env
                        .new_string(mode)
                        .map_err(|e| format!("Android mode string: {}", e))?;

                    let subject_object = JObject::from(subject_string);
                    let body_object = JObject::from(body_string);
                    let recipients_object = JObject::from(recipients_string);
                    let paths_object = JObject::from(paths_string);
                    let mode_object = JObject::from(mode_string);

                    let value = env
                        .call_method(
                            activity,
                            "shareSkipiDispatch",
                            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                            &[
                                JValue::Object(&subject_object),
                                JValue::Object(&body_object),
                                JValue::Object(&recipients_object),
                                JValue::Object(&paths_object),
                                JValue::Object(&mode_object),
                            ],
                        )
                        .map_err(|e| format!("Open Android share sheet: {}", e))?
                        .l()
                        .map_err(|e| format!("Android share result: {}", e))?;

                    if value.is_null() {
                        return Ok("Share sheet opened".to_string());
                    }
                    let message: String = env
                        .get_string(&JString::from(value))
                        .map_err(|e| format!("Android share result string: {}", e))?
                        .into();
                    Err(message)
                })();
                let _ = tx.send(result);
            });
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while opening Android share sheet".to_string())?
}

// ---- BEGIN iOS system share ----
//
// The iOS half of `mobile_share_dispatch`: UIActivityViewController — AirDrop, Mail,
// Messages, "Save to Files" — reached through the Objective-C runtime straight from
// Rust.
//
// WHY BY HAND AND NOT THROUGH A CRATE, said out loud rather than implied: `objc2` is
// already in the dependency graph transitively and would give type checking for every
// call below. Adding it to Cargo.toml changes the file set of this change, and with it
// the route the guard takes for this card. The cheaper path was chosen and its price is
// paid right here — every message send below is hand-typed, nothing checks the
// selectors, and the only thing that proves this code right is a run on the simulator.
//
// LINKING: the Xcode target links `libapp.a` and seven system frameworks; `libobjc` is
// NOT one of them, so the `#[link(name = "objc", …)]` below is what keeps the build from
// dying on an undefined `_objc_msgSend`. UIKit itself the target already links
// (gen/apple/project.yml → `sdk: UIKit.framework`), so it needs no attribute here.
//
// ABI: the transmutes are correct on arm64, where every signature used below travels
// through the ordinary C ABI — the CGRect return included, because four doubles are a
// homogeneous float aggregate passed in v0..v3. On x86_64 struct and float returns go
// through `objc_msgSend_stret` / `_fpret` instead, so this branch is built for
// aarch64-apple-ios{,-sim} and run on an arm64 host, and nothing else.
//
// MEMORY: `alloc` + `init…` hands back an object we own (+1). That +1 goes to
// `presentViewController:animated:completion:`, which keeps the sheet alive for as long
// as it is on screen, and it is deliberately NOT released here: an over-release kills
// the app at the moment of the tap just as reliably as leaking one controller per share
// fails to. Everything else touched below (NSString, NSURL, NSMutableArray, the popover
// controller) is autoreleased or owned by somebody else, and is likewise not released.
//
// THREADING: every line of this region runs inside `with_webview`, which the event loop
// executes on the main thread. UIKit is not touched anywhere else.
//
// HOUSE PRECEDENT: this is NOT the first objc FFI in this app. `vault.rs` → `mod
// ios_open_url` already reaches UIApplication the same way for the iOS branch of
// `open_external_url`. The types and the `msg_send` shape below are deliberately the
// same as there — declaring the same runtime symbol with a different pointer type in a
// second module is exactly what `clashing_extern_declarations` is for.
#[cfg(target_os = "ios")]
mod ios_share {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};

    pub type Id = *mut c_void;
    pub type Sel = *mut c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub width: f64,
        pub height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }

    fn msg_send_entry() -> unsafe extern "C" fn() {
        objc_msgSend
    }

    /// A class by name, or a readable error instead of a null receiver that would
    /// silently swallow every message sent to it afterwards.
    fn class(name: &str) -> Result<Id, String> {
        let c = CString::new(name).map_err(|_| format!("iOS class name: {}", name))?;
        let cls = unsafe { objc_getClass(c.as_ptr()) };
        if cls.is_null() {
            return Err(format!("iOS runtime has no class {}", name));
        }
        Ok(cls)
    }

    /// A selector by name, checked for the same reason.
    fn sel(name: &str) -> Result<Sel, String> {
        let c = CString::new(name).map_err(|_| format!("iOS selector name: {}", name))?;
        let s = unsafe { sel_registerName(c.as_ptr()) };
        if s.is_null() {
            return Err(format!("iOS runtime has no selector {}", name));
        }
        Ok(s)
    }

    unsafe fn send(obj: Id, s: Sel) -> Id {
        let f: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(msg_send_entry());
        f(obj, s)
    }

    unsafe fn send1(obj: Id, s: Sel, a: Id) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(msg_send_entry());
        f(obj, s, a)
    }

    unsafe fn send2(obj: Id, s: Sel, a: Id, b: Id) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, Id, Id) -> Id = std::mem::transmute(msg_send_entry());
        f(obj, s, a, b)
    }

    unsafe fn send_rect_ret(obj: Id, s: Sel) -> CGRect {
        let f: unsafe extern "C" fn(Id, Sel) -> CGRect = std::mem::transmute(msg_send_entry());
        f(obj, s)
    }

    unsafe fn send_rect(obj: Id, s: Sel, r: CGRect) {
        let f: unsafe extern "C" fn(Id, Sel, CGRect) = std::mem::transmute(msg_send_entry());
        f(obj, s, r)
    }

    unsafe fn send_uint(obj: Id, s: Sel, v: usize) {
        let f: unsafe extern "C" fn(Id, Sel, usize) = std::mem::transmute(msg_send_entry());
        f(obj, s, v)
    }

    unsafe fn send_present(obj: Id, s: Sel, a: Id, animated: bool, completion: Id) {
        let f: unsafe extern "C" fn(Id, Sel, Id, bool, Id) = std::mem::transmute(msg_send_entry());
        f(obj, s, a, animated, completion)
    }

    unsafe fn send1_cstr(obj: Id, s: Sel, a: *const c_char) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, *const c_char) -> Id =
            std::mem::transmute(msg_send_entry());
        f(obj, s, a)
    }

    fn ns_string(value: &str) -> Result<Id, String> {
        let cls = class("NSString")?;
        let selector = sel("stringWithUTF8String:")?;
        let c = CString::new(value).map_err(|_| "iOS string has an interior NUL".to_string())?;
        let out = unsafe { send1_cstr(cls, selector, c.as_ptr()) };
        if out.is_null() {
            return Err("iOS could not build an NSString".to_string());
        }
        Ok(out)
    }

    /// A FILE url. `fileURLWithPath:` is the whole point of this function: the
    /// string-taking constructor produces a URL with no scheme, and the sheet then
    /// hands the recipient the PATH AS TEXT — it opens, it looks right, nothing is
    /// attached, and no harness in this repository can see the difference. Only a
    /// screenshot can.
    fn file_url(path: &str) -> Result<Id, String> {
        let cls = class("NSURL")?;
        let string = ns_string(path)?;
        let selector = sel("fileURLWithPath:")?;
        let url = unsafe { send1(cls, selector, string) };
        if url.is_null() {
            return Err(format!("iOS could not build a file URL for {}", path));
        }
        Ok(url)
    }

    /// Build the sheet over `paths` and present it on `view_controller`, anchored to
    /// `source_view`. Runs on the main thread — see the THREADING note above.
    pub fn present_share_sheet(
        view_controller: Id,
        source_view: Id,
        paths: &[String],
    ) -> Result<(), String> {
        if view_controller.is_null() {
            return Err("iOS webview has no view controller to present the share sheet on".to_string());
        }
        if paths.is_empty() {
            return Err("Nothing to share".to_string());
        }

        let items = unsafe { send(class("NSMutableArray")?, sel("array")?) };
        if items.is_null() {
            return Err("iOS could not build the activity item list".to_string());
        }
        let add = sel("addObject:")?;
        for path in paths {
            let url = file_url(path)?;
            unsafe {
                send1(items, add, url);
            }
        }

        let allocated = unsafe { send(class("UIActivityViewController")?, sel("alloc")?) };
        if allocated.is_null() {
            return Err("iOS could not allocate the share sheet".to_string());
        }
        // The +1 from alloc/init — see the MEMORY note at the top of this region. It is
        // handed to the presenting controller below and never released here.
        let sheet = unsafe {
            send2(
                allocated,
                sel("initWithActivityItems:applicationActivities:")?,
                items,
                std::ptr::null_mut(),
            )
        };
        if sheet.is_null() {
            return Err("iOS could not build the share sheet".to_string());
        }

        // iPad: the sheet is a POPOVER there, and a popover with no anchor does not
        // open — it takes the app down at the moment of the tap. So the anchor is
        // filled whenever the system gives us a popover controller at all (on iPhone
        // it hands back nil, and nothing below runs).
        let popover = unsafe { send(sheet, sel("popoverPresentationController")?) };
        if !popover.is_null() && !source_view.is_null() {
            unsafe {
                send1(popover, sel("setSourceView:")?, source_view);
                let bounds = send_rect_ret(source_view, sel("bounds")?);
                let anchor = CGRect {
                    origin: CGPoint {
                        x: bounds.origin.x + bounds.size.width / 2.0,
                        y: bounds.origin.y + bounds.size.height / 2.0,
                    },
                    size: CGSize { width: 1.0, height: 1.0 },
                };
                send_rect(popover, sel("setSourceRect:")?, anchor);
                // UIPopoverArrowDirectionUnknown (0): centred, with no arrow pointing
                // at a rectangle the user never tapped.
                send_uint(popover, sel("setPermittedArrowDirections:")?, 0);
            }
        }

        unsafe {
            send_present(
                view_controller,
                sel("presentViewController:animated:completion:")?,
                sheet,
                true,
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }
}

/// Open the native iOS share sheet with the prepared Skipi files.
///
/// The frontend prepares the CV/PDF/ZIP first (exactly as on Android), then this
/// command stages them in the app cache — the SAME staging, dedup and bounded cleanup
/// Android uses — and hands file URLs to UIKit.
///
/// WHAT THIS BRANCH DELIBERATELY DOES NOT CARRY, so nobody reads a promise into it:
/// `recipients`, `subject` and `body` are not passed to the sheet. UIActivityViewController
/// takes activity items, not addressees; it pre-fills nobody, and the supported way to
/// give Mail a subject is an activity-item source object, which would mean defining an
/// Objective-C class at runtime. The packages screen — the only caller that reaches this
/// on iOS — shares a package with no recipient and no body anyway. The mailing wizard,
/// whose `mode: "email"` DOES promise named recipients, stays Android-only for exactly
/// this reason (dist/index.html:5794 and :15651).
#[cfg(target_os = "ios")]
#[tauri::command]
pub fn mobile_share_dispatch(
    window: tauri::WebviewWindow,
    recipients: Vec<String>,
    subject: String,
    body: String,
    attachments: Vec<String>,
    mode: Option<String>,
) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Manager;

    // Accepted for one signature across platforms, and knowingly unused here — see the
    // doc comment above for what the iOS sheet can and cannot carry.
    let _ = (&recipients, &subject, &body, &mode);

    let share_paths = copy_attachments_to_share_cache(window.app_handle(), &attachments)?;
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            // `view_controller()` is the webview's own controller and `inner()` is the
            // WKWebView, which is a UIView and therefore a legal popover anchor. No
            // keyWindow, no sharedApplication, nothing global.
            let result = ios_share::present_share_sheet(
                webview.view_controller() as ios_share::Id,
                webview.inner() as ios_share::Id,
                &share_paths,
            )
            .map(|_| "Share sheet opened".to_string());
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;

    // The answer is due when the sheet is ON SCREEN, not when the user picks something.
    // Waiting for the sheet to finish would time out while it is still open in the
    // user's hands — and an open sheet is not proof of delivery anyway, which is why
    // the screen says "opened" and marks nothing as sent. The five seconds are for the
    // hop to the main thread, the same as on Android, not for the human.
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while opening the iOS share sheet".to_string())?
}
// ---- END iOS system share ----

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn mobile_share_dispatch(
    _window: tauri::WebviewWindow,
    _recipients: Vec<String>,
    _subject: String,
    _body: String,
    _attachments: Vec<String>,
    _mode: Option<String>,
) -> Result<String, String> {
    Err("Mobile share sheet is only available in the iPhone and Android app.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_cache_cleanup_can_never_touch_the_share_it_precedes() {
        // The files of the current call carry `now` itself as their stamp, and
        // the cleanup runs BEFORE they are written. Both facts together are why
        // the window cannot reach the session being prepared.
        let now: u128 = 1_760_000_000_000;
        for idx in 0..3u128 {
            let name = format!("{}-{}-passport.pdf", now, idx + 1);
            assert!(
                !share_cache_entry_is_stale(&name, now, SHARE_CACHE_RETENTION_MS),
                "{} must survive",
                name
            );
        }
        // …and so does anything staged inside the window.
        let recent = format!("{}-1-cv.pdf", now - SHARE_CACHE_RETENTION_MS + 1);
        assert!(!share_cache_entry_is_stale(&recent, now, SHARE_CACHE_RETENTION_MS));
    }

    #[test]
    fn share_cache_cleanup_removes_only_entries_past_the_window() {
        let now: u128 = 1_760_000_000_000;
        let old = format!("{}-1-passport.pdf", now - SHARE_CACHE_RETENTION_MS);
        let older = format!("{}-2-sb.pdf", now - 10 * SHARE_CACHE_RETENTION_MS);
        assert!(share_cache_entry_is_stale(&old, now, SHARE_CACHE_RETENTION_MS));
        assert!(share_cache_entry_is_stale(&older, now, SHARE_CACHE_RETENTION_MS));
    }

    #[test]
    fn share_cache_cleanup_leaves_anything_it_does_not_recognise_alone() {
        let now: u128 = 1_760_000_000_000;
        for name in [
            "passport.pdf",
            "-1-passport.pdf",
            "notastamp-1-cv.pdf",
            ".nomedia",
            "",
        ] {
            assert_eq!(share_cache_stamp(name), None, "{}", name);
            assert!(
                !share_cache_entry_is_stale(name, now, SHARE_CACHE_RETENTION_MS),
                "{} is not ours to delete",
                name
            );
        }
        assert_eq!(share_cache_stamp("1760000000000-1-cv.pdf"), Some(1_760_000_000_000));
    }

    #[test]
    fn word_attachment_mime_is_case_insensitive() {
        for name in ["cv.doc", "CV.DOC", "résumé.final.DoC"] {
            assert_eq!(guess_mime(Path::new(name)), "application/msword", "{name}");
        }
        for name in ["cv.docx", "CV.DOCX", "резюме.final.DoCx"] {
            assert_eq!(guess_mime(Path::new(name)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "{name}");
        }
    }

    #[test]
    fn existing_attachment_mime_and_fallback_are_preserved() {
        for (extension, expected) in [
            ("pdf", "application/pdf"), ("zip", "application/zip"),
            ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"),
            ("gif", "image/gif"), ("txt", "text/plain"), ("csv", "text/csv"),
            ("eml", "message/rfc822"), ("unknown", "application/octet-stream"),
        ] {
            for suffix in [extension.to_string(), extension.to_uppercase()] {
                assert_eq!(guess_mime(Path::new(&format!("résumé.final.{suffix}"))), expected);
            }
        }
        for name in ["noextension", ".doc", "cv.docx.bak", "cv."] {
            assert_eq!(guess_mime(Path::new(name)), "application/octet-stream");
        }
    }

    #[test]
    fn plain_body_headers_footer_and_crlf_are_preserved() {
        for body in ["", "plain\ntext", "<b>literal</b>\r\nnext", FOOTER] {
            let intent = MailIntent {
                to: vec!["one@example.invalid".into(), "two@example.invalid".into()],
                subject: "Резюме".into(), body: body.into(), attachments: vec![], purpose: None,
            };
            let eml = build_eml(&intent).unwrap();
            assert!(eml.starts_with("To: one@example.invalid, two@example.invalid\r\n"));
            assert!(eml.contains(&format!("Subject: {}\r\n", encode_header("Резюме"))));
            assert!(eml.contains("Content-Type: text/plain; charset=utf-8\r\n"));
            assert!(!eml.contains("Content-Type: text/html"));
            assert_eq!(eml.matches(FOOTER).count(), 1);
            assert!(!eml.replace("\r\n", "").contains('\n'));
            if body.starts_with('<') { assert!(eml.contains("<b>literal</b>\r\nnext")); }
        }
    }

    #[test]
    fn header_encoding_and_filename_slug_are_preserved() {
        assert_eq!(encode_header("ASCII subject"), "ASCII subject");
        let encoded = encode_header("Резюме");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.strip_prefix("=?UTF-8?B?").unwrap().strip_suffix("?=").unwrap()).unwrap();
        assert_eq!(decoded, "Резюме".as_bytes());
        assert_eq!(slugify(" /Apply CV-1_ "), "Apply_CV-1");
        assert!(chrono::DateTime::parse_from_rfc2822(&rfc2822_date_now()).is_ok());
    }
}

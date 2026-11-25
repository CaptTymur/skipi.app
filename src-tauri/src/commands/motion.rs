//! Motion sensors and keep-awake for plugins (host-runtime 1.2: grants `motion` and
//! `keep_awake`).
//!
//! A plugin runs in an isolated frame and cannot read the device sensors. The host
//! reads them natively and the page (`dist/plugin-remote-boot.js`) drains the buffered
//! rows about every 100 ms and hands them to the runtime, which forwards them only to
//! the plugin that started the sensors.
//!
//! Row: `[t_ms, ax, ay, az, wx, wy, wz]`, or `[t_ms, ax, ay, az]` without a gyroscope.
//! `t_ms` — monotonic time of the measurement; `a` — specific force INCLUDING gravity,
//! m/s², device axes x right / y to the top of the device / z out of the screen, so a
//! phone lying screen-up reads `az ≈ +9.81` on every platform; `w` — rad/s about the
//! same axes.
//!
//! Android: `SensorManager` through `MainActivity` (JNI), raw accelerometer and
//! gyroscope. iOS: `CMMotionManager` through the Objective-C runtime, polled by a
//! thread. Desktop: there are no motion sensors — `start` answers `no-sensors`.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionStart {
    pub ok: bool,
    pub rate_hz: u32,
    pub source: &'static str,
    pub platform: &'static str,
    pub gyro: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
fn refused(platform: &'static str, reason: &str) -> MotionStart {
    MotionStart {
        ok: false,
        rate_hz: 0,
        source: "none",
        platform,
        gyro: false,
        reason: Some(reason.to_string()),
    }
}

fn clamp_rate(rate_hz: Option<u32>) -> u32 {
    rate_hz.unwrap_or(50).clamp(1, 100)
}

/// Rows as `MainActivity.drainSkipiMotion` writes them: one per line,
/// `t_ms,ax,ay,az[,wx,wy,wz]`. Anything that is not 4 or 7 finite numbers is dropped.
#[cfg(any(test, target_os = "android"))]
fn parse_rows(text: &str) -> Vec<Vec<f64>> {
    text.lines()
        .filter_map(|line| {
            let row: Vec<f64> = line
                .split(',')
                .map(|v| v.trim().parse::<f64>().ok().filter(|n| n.is_finite()))
                .collect::<Option<Vec<f64>>>()?;
            if row.len() == 4 || row.len() == 7 {
                Some(row)
            } else {
                None
            }
        })
        .collect()
}

/// `"OK <rateHz> <gyro 0|1>"` or `"ERROR:<reason>"` from `MainActivity.startSkipiMotion`.
#[cfg(any(test, target_os = "android"))]
fn parse_start(answer: &str) -> Result<(u32, bool), String> {
    if let Some(reason) = answer.strip_prefix("ERROR:") {
        return Err(reason.to_string());
    }
    let mut parts = answer.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some("OK"), Some(rate), Some(gyro)) => {
            let rate = rate
                .parse::<u32>()
                .map_err(|_| "bad sensor answer".to_string())?;
            Ok((rate, gyro == "1"))
        }
        _ => Err("bad sensor answer".to_string()),
    }
}

// ---------------------------------------------------------------- Android --

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Runs `f` with the activity on the Android main thread and waits for its answer.
    pub fn with_activity<T, F>(window: &tauri::WebviewWindow, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut JNIEnv, &JObject) -> Result<T, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let _ = tx.send(f(env, activity));
                });
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Timed out while talking to the motion sensors".to_string())?
    }

    pub fn string_result(env: &mut JNIEnv, value: JObject) -> Result<String, String> {
        if value.is_null() {
            return Ok(String::new());
        }
        Ok(env
            .get_string(&JString::from(value))
            .map_err(|e| format!("Motion sensor answer: {}", e))?
            .into())
    }

    pub fn start(window: &tauri::WebviewWindow, rate: u32) -> Result<String, String> {
        with_activity(window, move |env, activity| {
            let value = env
                .call_method(
                    activity,
                    "startSkipiMotion",
                    "(I)Ljava/lang/String;",
                    &[JValue::Int(rate as i32)],
                )
                .map_err(|e| format!("Start motion sensors: {}", e))?
                .l()
                .map_err(|e| format!("Start motion sensors: {}", e))?;
            string_result(env, value)
        })
    }

    pub fn drain(window: &tauri::WebviewWindow) -> Result<String, String> {
        with_activity(window, move |env, activity| {
            let value = env
                .call_method(activity, "drainSkipiMotion", "()Ljava/lang/String;", &[])
                .map_err(|e| format!("Read motion sensors: {}", e))?
                .l()
                .map_err(|e| format!("Read motion sensors: {}", e))?;
            string_result(env, value)
        })
    }

    pub fn stop(window: &tauri::WebviewWindow) -> Result<(), String> {
        with_activity(window, move |env, activity| {
            env.call_method(activity, "stopSkipiMotion", "()V", &[])
                .map_err(|e| format!("Stop motion sensors: {}", e))?;
            Ok(())
        })
    }

    pub fn keep_awake(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
        with_activity(window, move |env, activity| {
            env.call_method(
                activity,
                "setSkipiKeepAwake",
                "(Z)V",
                &[JValue::Bool(if on { 1 } else { 0 })],
            )
            .map_err(|e| format!("Keep the screen on: {}", e))?;
            Ok(())
        })
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_motion_start(
    window: tauri::WebviewWindow,
    rate_hz: Option<u32>,
) -> Result<MotionStart, String> {
    let answer = android::start(&window, clamp_rate(rate_hz))?;
    Ok(match parse_start(&answer) {
        Ok((rate, gyro)) => MotionStart {
            ok: true,
            rate_hz: rate,
            source: "android-sensor-manager",
            platform: "android",
            gyro,
            reason: None,
        },
        Err(reason) => refused("android", &reason),
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_motion_drain(window: tauri::WebviewWindow) -> Result<Vec<Vec<f64>>, String> {
    Ok(parse_rows(&android::drain(&window)?))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_motion_stop(window: tauri::WebviewWindow) -> Result<(), String> {
    android::stop(&window)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn plugin_keep_awake(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    android::keep_awake(&window, on)
}

// -------------------------------------------------------------------- iOS --

/// CoreMotion through the Objective-C runtime, in the manner of `vault::ios_open_url`:
/// no new crate, every `objc_msgSend` call goes through a pointer typed exactly like the
/// method. CoreMotion is loaded with `dlopen` (a system framework), so the Xcode project
/// is not touched.
#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    }

    type Id = *mut c_void;
    type Sel = *mut c_void;

    /// `CMAcceleration` and `CMRotationRate`: three doubles, returned in registers on arm64.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Vec3 {
        x: f64,
        y: f64,
        z: f64,
    }

    const G: f64 = 9.806_65;
    const MAX_ROWS: usize = 6000;

    /// The one `CMMotionManager` of the app (Apple: create a single instance), as an address.
    static MANAGER: AtomicUsize = AtomicUsize::new(0);
    /// Bumped on every start/stop: a polling thread from an earlier start sees it and exits.
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static ROWS: Mutex<Vec<Vec<f64>>> = Mutex::new(Vec::new());

    fn base() -> unsafe extern "C" fn() {
        objc_msgSend
    }
    unsafe fn class_named(name: &str) -> Id {
        match CString::new(name) {
            Ok(c) => objc_getClass(c.as_ptr()),
            Err(_) => std::ptr::null_mut(),
        }
    }
    unsafe fn sel(name: &str) -> Sel {
        let c = CString::new(name).expect("selector");
        sel_registerName(c.as_ptr())
    }
    unsafe fn send_id(r: Id, s: Sel) -> Id {
        let f: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(base());
        f(r, s)
    }
    unsafe fn send_void(r: Id, s: Sel) {
        let f: unsafe extern "C" fn(Id, Sel) = std::mem::transmute(base());
        f(r, s)
    }
    unsafe fn send_bool(r: Id, s: Sel) -> bool {
        let f: unsafe extern "C" fn(Id, Sel) -> bool = std::mem::transmute(base());
        f(r, s)
    }
    unsafe fn send_f64(r: Id, s: Sel) -> f64 {
        let f: unsafe extern "C" fn(Id, Sel) -> f64 = std::mem::transmute(base());
        f(r, s)
    }
    unsafe fn send_vec3(r: Id, s: Sel) -> Vec3 {
        let f: unsafe extern "C" fn(Id, Sel) -> Vec3 = std::mem::transmute(base());
        f(r, s)
    }
    unsafe fn send_set_f64(r: Id, s: Sel, v: f64) {
        let f: unsafe extern "C" fn(Id, Sel, f64) = std::mem::transmute(base());
        f(r, s, v)
    }
    unsafe fn send_set_bool(r: Id, s: Sel, v: bool) {
        let f: unsafe extern "C" fn(Id, Sel, bool) = std::mem::transmute(base());
        f(r, s, v)
    }

    unsafe fn manager() -> Id {
        let existing = MANAGER.load(Ordering::SeqCst);
        if existing != 0 {
            return existing as Id;
        }
        let path = CString::new("/System/Library/Frameworks/CoreMotion.framework/CoreMotion")
            .expect("path");
        dlopen(path.as_ptr(), 2 /* RTLD_NOW */);
        let class = class_named("CMMotionManager");
        if class.is_null() {
            return std::ptr::null_mut();
        }
        let m = send_id(send_id(class, sel("alloc")), sel("init"));
        if !m.is_null() {
            MANAGER.store(m as usize, Ordering::SeqCst);
        }
        m
    }

    /// Returns `(gyro available)` or the refusal reason.
    pub fn start(rate: u32) -> Result<bool, String> {
        unsafe {
            let m = manager();
            if m.is_null() || !send_bool(m, sel("isAccelerometerAvailable")) {
                return Err("no-sensors".to_string());
            }
            let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
            if let Ok(mut rows) = ROWS.lock() {
                rows.clear();
            }
            let interval = 1.0 / rate as f64;
            send_set_f64(m, sel("setAccelerometerUpdateInterval:"), interval);
            send_void(m, sel("startAccelerometerUpdates"));
            let gyro = send_bool(m, sel("isGyroAvailable"));
            if gyro {
                send_set_f64(m, sel("setGyroUpdateInterval:"), interval);
                send_void(m, sel("startGyroUpdates"));
            }
            let addr = m as usize;
            // Poll at twice the sensor rate so no reading is skipped; a reading is taken
            // once (its own timestamp tells a new one from the one already seen).
            let sleep = Duration::from_micros((500_000 / rate.max(1)) as u64);
            std::thread::spawn(move || {
                let m = addr as Id;
                let mut last_t = f64::NAN;
                while GENERATION.load(Ordering::SeqCst) == generation {
                    let pool = objc_autoreleasePoolPush();
                    let data = send_id(m, sel("accelerometerData"));
                    if !data.is_null() {
                        let t = send_f64(data, sel("timestamp"));
                        if t != last_t {
                            last_t = t;
                            // CoreMotion reports g with the opposite sign (flat, screen up →
                            // z = −1): convert to the contract's +9.81 m/s².
                            let a = send_vec3(data, sel("acceleration"));
                            let mut row = vec![t * 1000.0, -a.x * G, -a.y * G, -a.z * G];
                            if gyro {
                                let gd = send_id(m, sel("gyroData"));
                                if !gd.is_null() {
                                    let w = send_vec3(gd, sel("rotationRate"));
                                    row.extend_from_slice(&[w.x, w.y, w.z]);
                                }
                            }
                            if row.iter().all(|v| v.is_finite()) {
                                if let Ok(mut rows) = ROWS.lock() {
                                    if rows.len() >= MAX_ROWS {
                                        rows.clear();
                                    }
                                    rows.push(row);
                                }
                            }
                        }
                    }
                    objc_autoreleasePoolPop(pool);
                    std::thread::sleep(sleep);
                }
            });
            Ok(gyro)
        }
    }

    pub fn drain() -> Vec<Vec<f64>> {
        match ROWS.lock() {
            Ok(mut rows) => std::mem::take(&mut *rows),
            Err(_) => Vec::new(),
        }
    }

    pub fn stop() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        unsafe {
            let m = MANAGER.load(Ordering::SeqCst) as Id;
            if !m.is_null() {
                send_void(m, sel("stopAccelerometerUpdates"));
                send_void(m, sel("stopGyroUpdates"));
            }
        }
        if let Ok(mut rows) = ROWS.lock() {
            rows.clear();
        }
    }

    /// MUST run on the main thread (UIKit).
    pub fn keep_awake_on_main_thread(on: bool) {
        unsafe {
            let class = class_named("UIApplication");
            if class.is_null() {
                return;
            }
            let app = send_id(class, sel("sharedApplication"));
            if !app.is_null() {
                send_set_bool(app, sel("setIdleTimerDisabled:"), on);
            }
        }
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn plugin_motion_start(rate_hz: Option<u32>) -> Result<MotionStart, String> {
    let rate = clamp_rate(rate_hz);
    // The struct-returning CoreMotion getters are called the arm64 way (values in
    // registers); every iPhone is arm64.
    if !cfg!(target_arch = "aarch64") {
        return Ok(refused("ios", "no-sensors"));
    }
    Ok(match ios::start(rate) {
        Ok(gyro) => MotionStart {
            ok: true,
            rate_hz: rate,
            source: "ios-core-motion",
            platform: "ios",
            gyro,
            reason: None,
        },
        Err(reason) => refused("ios", &reason),
    })
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn plugin_motion_drain() -> Result<Vec<Vec<f64>>, String> {
    Ok(ios::drain())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn plugin_motion_stop() -> Result<(), String> {
    ios::stop();
    Ok(())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn plugin_keep_awake(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    app.run_on_main_thread(move || ios::keep_awake_on_main_thread(on))
        .map_err(|e| format!("Could not reach the iOS main thread: {}", e))
}

// ---------------------------------------------------------------- desktop --

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn plugin_motion_start(rate_hz: Option<u32>) -> Result<MotionStart, String> {
    let _ = clamp_rate(rate_hz);
    Ok(refused("desktop", "no-sensors"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn plugin_motion_drain() -> Result<Vec<Vec<f64>>, String> {
    Ok(Vec::new())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn plugin_motion_stop() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn plugin_keep_awake(on: bool) -> Result<(), String> {
    let _ = on;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_with_and_without_gyro_are_parsed() {
        let rows = parse_rows("1000.5,0.1,-0.2,9.81,0.01,0.02,-0.03\n1010.5,0.1,-0.2,9.81\n");
        assert_eq!(
            rows,
            vec![
                vec![1000.5, 0.1, -0.2, 9.81, 0.01, 0.02, -0.03],
                vec![1010.5, 0.1, -0.2, 9.81],
            ]
        );
    }

    #[test]
    fn malformed_rows_are_dropped() {
        let rows =
            parse_rows("1,2,3\nx,0,0,9.8\n1,NaN,0,9.8\n1,inf,0,9.8\n\n1,0,0,9.8,0,0\n2,0,0,9.8\n");
        assert_eq!(rows, vec![vec![2.0, 0.0, 0.0, 9.8]]);
        assert!(parse_rows("").is_empty());
    }

    #[test]
    fn start_answer_is_parsed() {
        assert_eq!(parse_start("OK 50 1"), Ok((50, true)));
        assert_eq!(parse_start("OK 100 0"), Ok((100, false)));
        assert_eq!(
            parse_start("ERROR:no-sensors"),
            Err("no-sensors".to_string())
        );
        assert!(parse_start("").is_err());
        assert!(parse_start("OK fifty 1").is_err());
    }

    #[test]
    fn rate_is_clamped_to_the_contract_range() {
        assert_eq!(clamp_rate(None), 50);
        assert_eq!(clamp_rate(Some(0)), 1);
        assert_eq!(clamp_rate(Some(5000)), 100);
        assert_eq!(clamp_rate(Some(25)), 25);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_has_no_sensors() {
        let r = plugin_motion_start(Some(50)).unwrap();
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("no-sensors"));
        assert!(plugin_motion_drain().unwrap().is_empty());
    }
}

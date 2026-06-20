// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer crashes the web process ("WebKitWebProcess
    // has stopped unexpectedly") on many Linux GPU/driver combos, notably
    // NVIDIA. Disable it before GTK initialises so the WebView falls back to a
    // stable rendering path. Honour an explicit user override if already set.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run();
}

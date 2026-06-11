# Skipi Mobile Start

Status: Android scaffold and the first mobile document-intake shell are live on branch `mobile-start`.

## Product Direction

Skipi mobile starts with the seafarer app, not HR/Broker.

First mobile loop:

- create/open a local Skipi vault;
- add documents from phone camera or photo library;
- edit certificate fields and expiry/permanent status;
- show profile completeness and document warnings;
- generate/share CV and packages after the document capture loop is stable.

Desktop remains the source of truth for the full workflow. Mobile should reuse the existing Rust/local-first core where possible, then replace desktop-only integrations with native mobile flows.

## Android Environment

This machine has:

- Android SDK: `/home/linux/Android/Sdk`
- Android NDK: `/home/linux/Android/Sdk/ndk/27.0.12077973`
- local JDK: `/home/linux/.jdks/temurin-21`

Use:

```bash
cd /home/linux/Developer/skipi-mobile-start
export JAVA_HOME=/home/linux/.jdks/temurin-21
export ANDROID_HOME=/home/linux/Android/Sdk
export NDK_HOME=/home/linux/Android/Sdk/ndk/27.0.12077973
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$JAVA_HOME/bin:$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"
```

Backend check:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android
```

Debug APK:

```bash
cargo tauri android build --debug --apk --target aarch64 --ci
```

Current debug APK output:

```text
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

## Current Technical Decisions

- `tauri.android.conf.json` sets Android product identity to `Skipi Seafarer` / `app.skipi.seafarer`.
- Android manifest includes `CAMERA`; the first real document-capture UI still needs a native camera/photo flow.
- The first mobile shell is rendered from `dist/index.html` on Android/iOS or phone-width screens.
- Mobile file/camera upload uses `attach_file_bytes`, so WebView `File/Blob` objects can be saved into the vault without a desktop filesystem path.
- `reqwest` now uses `rustls-tls` so Android builds do not require OpenSSL.
- Desktop updater permission is split into `capabilities/desktop-updater.json`; common capabilities stay mobile-safe.
- Direct SMTP/password storage is desktop-only. Mobile has command-compatible stubs and should use native share/mail intents.
- Some desktop opener commands are stubbed on mobile until native intents are implemented.

## iOS Notes

iOS cannot be built on this Linux machine. On the MacBook:

```bash
cargo tauri ios init
cargo tauri ios build
```

`tauri.ios.conf.json` already sets the initial iOS product identity to `Skipi Seafarer` / `app.skipi.seafarer`. Confirm this bundle id in Apple Developer before TestFlight/App Store work.

## Next Implementation Step

Next implementation step:

1. Test the debug APK on a real Android phone.
2. Add a native share/mail flow for mobile packages.
3. Replace the quick mobile vault create with a compact seafarer profile wizard.
4. Add iOS scaffold on the MacBook and confirm camera/photo picker behavior.
5. Keep CV/packages/mailings behind later mobile tabs until document capture is reliable.

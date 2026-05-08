#!/usr/bin/env python3
"""Pre-release smoke runner for the Skipi desktop client.

This script turns the P0 checklist into a repeatable local gate. It covers the
checks that can be automated without clicking through the GUI, and it emits a
Markdown report with explicit manual follow-ups for the rest.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zipfile
from typing import Iterable


PASS = "PASS"
WARN = "WARN"
FAIL = "FAIL"
SKIP = "SKIP"


@dataclasses.dataclass
class Result:
    name: str
    status: str
    details: str
    duration_s: float = 0.0


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1]


def run_cmd(args: list[str], cwd: pathlib.Path, timeout: int) -> tuple[int, str, float]:
    started = time.time()
    proc = subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, time.time() - started


def read_text(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def truncate(text: str, limit: int = 1400) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... output truncated ..."


def status_from_code(code: int) -> str:
    return PASS if code == 0 else FAIL


def cargo_test(repo: pathlib.Path, test_name: str, timeout: int) -> Result:
    code, out, elapsed = run_cmd(
        ["cargo", "test", "--lib", test_name],
        repo / "src-tauri",
        timeout,
    )
    details = "ok" if code == 0 else truncate(out)
    return Result(f"rust test: {test_name}", status_from_code(code), details, elapsed)


def cargo_check(repo: pathlib.Path, timeout: int) -> Result:
    code, out, elapsed = run_cmd(
        ["cargo", "check", "--lib"],
        repo / "src-tauri",
        timeout,
    )
    details = "ok" if code == 0 else truncate(out)
    return Result("cargo check --lib", status_from_code(code), details, elapsed)


def extract_regex(text: str, pattern: str, label: str) -> str:
    m = re.search(pattern, text, re.MULTILINE)
    if not m:
        raise ValueError(f"could not extract {label}")
    return m.group(1)


def version_consistency(repo: pathlib.Path) -> Result:
    started = time.time()
    cargo = extract_regex(read_text(repo / "src-tauri" / "Cargo.toml"), r'^version\s*=\s*"([^"]+)"', "Cargo.toml version")
    tauri = json.loads(read_text(repo / "src-tauri" / "tauri.conf.json"))
    tauri_version = tauri.get("version", "")
    title = tauri.get("app", {}).get("windows", [{}])[0].get("title", "")
    title_version = extract_regex(title, r"Skipi\s+([0-9]+\.[0-9]+\.[0-9]+)", "window title version")
    html = read_text(repo / "dist" / "index.html")
    welcome_version = extract_regex(html, r'id="welcome-version">([^<]+)<', "welcome UI version")
    values = {
        "Cargo.toml": cargo,
        "tauri.conf.json": tauri_version,
        "window title": title_version,
        "welcome UI": welcome_version,
    }
    unique = set(values.values())
    if len(unique) == 1:
        return Result("artifact version consistency", PASS, f"all version fields = {cargo}", time.time() - started)
    return Result("artifact version consistency", FAIL, json.dumps(values, indent=2), time.time() - started)


def artifact_sanity(repo: pathlib.Path, expected_version: str) -> Result:
    started = time.time()
    bundle_dir = repo / "src-tauri" / "target" / "release" / "bundle"
    if not bundle_dir.exists():
        return Result(
            "bundle artifact sanity",
            WARN,
            "No release bundle directory found. Run `cargo tauri build` before final release.",
            time.time() - started,
        )
    suffixes = {".deb", ".rpm", ".AppImage", ".msi", ".exe", ".dmg"}
    artifacts = [
        p for p in bundle_dir.rglob("*")
        if p.is_file() and (p.suffix in suffixes or p.name.endswith(".AppImage"))
    ]
    if not artifacts:
        return Result("bundle artifact sanity", WARN, f"No installer artifacts under {bundle_dir}", time.time() - started)
    current = [str(p.relative_to(bundle_dir)) for p in artifacts if expected_version in p.name]
    if not current:
        old = "\n".join(str(p.relative_to(bundle_dir)) for p in artifacts[-20:])
        return Result(
            "bundle artifact sanity",
            WARN,
            f"No installer artifacts for {expected_version}. Historical artifacts present:\n{old}",
            time.time() - started,
        )
    return Result("bundle artifact sanity", PASS, "\n".join(current), time.time() - started)


def latest_json_check(source: str | None, expected_version: str) -> Result:
    started = time.time()
    if not source:
        return Result("latest.json sanity", SKIP, "No --latest-json source supplied.", 0.0)
    try:
        if source.startswith("http://") or source.startswith("https://"):
            with urllib.request.urlopen(source, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
        else:
            raw = pathlib.Path(source).read_text(encoding="utf-8")
        data = json.loads(raw)
        version = str(data.get("version", ""))
        if version != expected_version:
            return Result("latest.json sanity", FAIL, f"latest.json version {version!r} != expected {expected_version!r}", time.time() - started)
        return Result("latest.json sanity", PASS, f"latest.json version = {version}", time.time() - started)
    except Exception as exc:  # noqa: BLE001
        return Result("latest.json sanity", FAIL, str(exc), time.time() - started)


def extract_js_function(source: str, name: str) -> str:
    marker_options = [f"async function {name}(", f"function {name}("]
    starts = [source.find(marker) for marker in marker_options if source.find(marker) >= 0]
    if not starts:
        raise ValueError(f"JS function {name} not found")
    pos = min(starts)
    brace = source.find("{", pos)
    if brace < 0:
        raise ValueError(f"JS function {name} has no body")
    depth = 0
    for idx in range(brace, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[brace + 1:idx]
    raise ValueError(f"JS function {name} body not closed")


def network_privacy_static(repo: pathlib.Path) -> Result:
    started = time.time()
    html = read_text(repo / "dist" / "index.html")
    rust_documents = read_text(repo / "src-tauri" / "src" / "commands" / "documents.rs")
    rust_cv = read_text(repo / "src-tauri" / "src" / "commands" / "cv_commands.rs")
    checked = []
    problems = []
    for fn in ["attachFFromPath", "renderDocFilePreview", "exportCvPdf", "exportCvDocx"]:
        body = extract_js_function(html, fn)
        checked.append(fn)
        for token in ["fetch(", "api.skipi.app", "upload_encrypted_attachment", "send_email_smtp"]:
            if token in body:
                problems.append(f"{fn} contains {token}")
    attach_section = rust_documents[rust_documents.find("fn attach_file_to_vault"):rust_documents.find("#[tauri::command]\npub fn attach_file")]
    if "reqwest" in attach_section or "http://" in attach_section or "https://" in attach_section:
        problems.append("Rust attach_file_to_vault contains network code")
    if "reqwest" in rust_cv or "http://" in rust_cv or "https://" in rust_cv:
        problems.append("CV command module contains network code")
    if problems:
        return Result("network privacy static gate", FAIL, "\n".join(problems), time.time() - started)
    note = "Checked local attach/preview/CV export paths: " + ", ".join(checked)
    if "aiRec(id,true)" in extract_js_function(html, "attachFFromPath"):
        note += ". Auto-scan path is guarded by user AI settings."
    return Result("network privacy static gate", PASS, note, time.time() - started)


def config_privacy_scan() -> Result:
    started = time.time()
    home = pathlib.Path.home()
    candidates = [
        home / ".config" / "skipi",
        home / ".local" / "share" / "app.skipi.desktop",
        home / ".local" / "share" / "Skipi",
        home / ".cache" / "skipi",
    ]
    files: list[pathlib.Path] = []
    for root in candidates:
        if root.exists():
            for p in root.rglob("*"):
                if not p.is_file() or p.stat().st_size >= 2_000_000:
                    continue
                parts = set(p.parts)
                if {"WebKitCache", "CacheStorage", "mediakeys"} & parts:
                    continue
                files.append(p)
    if not files:
        return Result("logs/config privacy scan", SKIP, "No known Skipi config/log files found.", time.time() - started)
    patterns = [
        ("anthropic api key", re.compile(r"sk-ant-[A-Za-z0-9_-]{12,}")),
        ("smtp password field", re.compile(r"password\s*[:=]\s*['\"]?[^'\"\s,}]{6,}", re.IGNORECASE)),
        ("raw recovery key", re.compile(r"recovery[_ -]?key\s*[:=]", re.IGNORECASE)),
    ]
    hits: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for label, pattern in patterns:
            if pattern.search(text):
                hits.append(f"{path}: {label}")
    if hits:
        return Result("logs/config privacy scan", FAIL, "\n".join(hits[:20]), time.time() - started)
    return Result("logs/config privacy scan", PASS, f"Scanned {len(files)} config/log file(s); no secret patterns found.", time.time() - started)


def default_last_vault() -> pathlib.Path | None:
    cfg = pathlib.Path.home() / ".config" / "skipi" / "config.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    value = data.get("last_vault")
    return pathlib.Path(value) if value else None


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def vault_integrity_audit(vault_path: pathlib.Path | None) -> Result:
    started = time.time()
    if not vault_path:
        return Result("vault attachment integrity audit", SKIP, "No vault path supplied and no last_vault in config.", 0.0)
    db_path = vault_path / "skipi.db"
    if not db_path.exists():
        return Result("vault attachment integrity audit", FAIL, f"No skipi.db at {vault_path}", time.time() - started)
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, category, title, file_name, sha256, file_size FROM documents WHERE file_name IS NOT NULL"
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        return Result("vault attachment integrity audit", FAIL, f"Could not read vault DB: {exc}", time.time() - started)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    duplicate_paths: dict[tuple[str, str], list[sqlite3.Row]] = {}
    missing: list[str] = []
    hash_mismatch: list[str] = []
    no_hash = 0
    actual_hashes: dict[str, list[str]] = {}
    for row in rows:
        key = (row["category"], row["file_name"])
        duplicate_paths.setdefault(key, []).append(row)
        file_path = vault_path / row["category"] / row["file_name"]
        if not file_path.exists():
            missing.append(f"{row['id']} -> {row['category']}/{row['file_name']}")
            continue
        actual = sha256_file(file_path)
        actual_hashes.setdefault(actual, []).append(f"{row['id']} ({row['title']})")
        stored = row["sha256"]
        if stored:
            if stored != actual:
                hash_mismatch.append(f"{row['id']} stored hash does not match file")
        else:
            no_hash += 1
    duplicates = [
        f"{cat}/{fname}: " + ", ".join(r["id"] for r in refs)
        for (cat, fname), refs in duplicate_paths.items()
        if len(refs) > 1
    ]
    same_hash = [refs for refs in actual_hashes.values() if len(refs) > 1]
    failures = []
    if duplicates:
        failures.append("Duplicate category/file_name references:\n" + "\n".join(duplicates[:20]))
    if missing:
        failures.append("Missing attached files:\n" + "\n".join(missing[:20]))
    if hash_mismatch:
        failures.append("SHA256 mismatches:\n" + "\n".join(hash_mismatch[:20]))
    if failures:
        return Result("vault attachment integrity audit", FAIL, "\n\n".join(failures), time.time() - started)
    warnings = []
    if same_hash:
        warnings.append("Same file hash used by multiple docs (may be intentional): " + "; ".join(", ".join(g[:4]) for g in same_hash[:5]))
    if no_hash:
        warnings.append(f"{no_hash} attached doc(s) have no stored sha256; reattach or migrate if strict integrity is needed.")
    if warnings:
        return Result("vault attachment integrity audit", WARN, " ".join(warnings), time.time() - started)
    return Result("vault attachment integrity audit", PASS, f"Checked {len(rows)} attached document(s) in {vault_path}", time.time() - started)


def backup_zip_static(repo: pathlib.Path) -> Result:
    started = time.time()
    source = read_text(repo / "src-tauri" / "src" / "commands" / "vault.rs")
    required = [
        "conn.backup(DatabaseName::Main",
        "skipi.db-wal",
        "skipi.db-shm",
        "_skipi_export.json",
        "enclosed_name()",
        "Imported backup has no skipi.db",
    ]
    missing = [token for token in required if token not in source]
    if missing:
        return Result("backup/restore static gate", FAIL, "Missing expected safeguards: " + ", ".join(missing), time.time() - started)
    return Result("backup/restore static gate", PASS, "SQLite backup API, WAL/shm skip, manifest, and safe zip extraction are present.", time.time() - started)


def demo_vault_zip_sanity(repo: pathlib.Path) -> Result:
    started = time.time()
    path = repo / "src-tauri" / "resources" / "demo-vault.zip"
    if not path.exists():
        return Result("packaged demo vault sanity", FAIL, "resources/demo-vault.zip missing", time.time() - started)
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            has_db = "skipi.db" in names
            unsafe = [n for n in names if n.startswith("/") or ".." in pathlib.PurePosixPath(n).parts]
            if not has_db:
                return Result("packaged demo vault sanity", FAIL, "demo-vault.zip does not contain skipi.db", time.time() - started)
            if unsafe:
                return Result("packaged demo vault sanity", FAIL, "Unsafe zip paths: " + ", ".join(unsafe[:10]), time.time() - started)
            return Result("packaged demo vault sanity", PASS, f"{len(names)} entries, skipi.db present", time.time() - started)
    except Exception as exc:  # noqa: BLE001
        return Result("packaged demo vault sanity", FAIL, str(exc), time.time() - started)


def manual_gates() -> list[Result]:
    items = [
        "Fresh install GUI: create vault, close app, open again.",
        "Old-version upgrade GUI: install previous release, update, verify profile/docs/sea service.",
        "Server offline/bad network GUI: Files/Profile/CV/Packages must stay usable.",
        "Large/corrupt file GUI: 30-100 MB and damaged PDF/image must not freeze or white-screen.",
        "Two instances same vault: verify SQLite lock behavior and no data loss.",
        "Kill during write: terminate during attach/export/package, reopen vault.",
        "Updater smoke: AppImage auto-update; deb opens release page.",
        "Small screen/scaling: 1366x768 and 125-150 percent scale.",
        "Timezone/system date: expiry classification remains correct.",
        "Permission denied/read-only vault: clear error, no silent failure.",
    ]
    return [Result(f"manual gate: {item}", SKIP, "Manual GUI/runtime check required.", 0.0) for item in items]


def write_report(repo: pathlib.Path, results: list[Result]) -> pathlib.Path:
    out_dir = repo / "src-tauri" / "target" / "smoke"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"pre_release_smoke_{stamp}.md"
    counts = {status: sum(1 for r in results if r.status == status) for status in [PASS, WARN, FAIL, SKIP]}
    lines = [
        "# Skipi Pre-Release Smoke Report",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %z')}",
        f"Summary: PASS={counts[PASS]} WARN={counts[WARN]} FAIL={counts[FAIL]} SKIP={counts[SKIP]}",
        "",
        "| Status | Check | Details | Seconds |",
        "|---|---|---|---:|",
    ]
    for r in results:
        details = r.details.replace("|", "\\|").replace("\n", "<br>")
        lines.append(f"| {r.status} | {r.name} | {details} | {r.duration_s:.2f} |")
    lines.append("")
    lines.append("Exit rule: any FAIL blocks a public release; WARN requires explicit decision; SKIP requires manual completion before announcement.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description="Run Skipi pre-release smoke checks.")
    parser.add_argument("--vault", type=pathlib.Path, default=None, help="Vault folder to audit. Defaults to last_vault from ~/.config/skipi/config.json.")
    parser.add_argument("--latest-json", default=None, help="Path or URL to latest.json for release metadata validation.")
    parser.add_argument("--skip-cargo", action="store_true", help="Skip cargo check/test steps.")
    parser.add_argument("--timeout", type=int, default=180, help="Timeout per cargo command in seconds.")
    args = parser.parse_args(list(argv))

    repo = repo_root()
    results: list[Result] = []

    version_result = version_consistency(repo)
    results.append(version_result)
    expected_version = "unknown"
    if version_result.status in {PASS, FAIL}:
        try:
            expected_version = extract_regex(read_text(repo / "src-tauri" / "Cargo.toml"), r'^version\s*=\s*"([^"]+)"', "Cargo.toml version")
        except Exception:
            pass

    if not args.skip_cargo:
        results.append(cargo_check(repo, args.timeout))
        for test_name in [
            "open_db_handles_cyrillic_and_spaces_path",
            "attach_file_uses_unique_paths_for_duplicate_titles",
            "synthetic_profile_upload_smoke_keeps_each_certificate_in_place",
            "vault_tree_export_skips_live_db_and_backup_targets",
            "packaged_demo_vault_has_db_and_no_runtime_secrets",
        ]:
            results.append(cargo_test(repo, test_name, args.timeout))

    results.append(network_privacy_static(repo))
    results.append(backup_zip_static(repo))
    results.append(demo_vault_zip_sanity(repo))
    results.append(config_privacy_scan())
    results.append(vault_integrity_audit(args.vault or default_last_vault()))
    results.append(artifact_sanity(repo, expected_version))
    results.append(latest_json_check(args.latest_json, expected_version))
    results.extend(manual_gates())

    report = write_report(repo, results)
    counts = {status: sum(1 for r in results if r.status == status) for status in [PASS, WARN, FAIL, SKIP]}
    print(f"Smoke report: {report}")
    print(f"PASS={counts[PASS]} WARN={counts[WARN]} FAIL={counts[FAIL]} SKIP={counts[SKIP]}")
    for r in results:
        print(f"{r.status:4} {r.name}")
    return 1 if counts[FAIL] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

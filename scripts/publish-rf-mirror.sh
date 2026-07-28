#!/usr/bin/env bash
# Atomic FTP:21 publisher for the api-ru release mirror.
#
# A real run captures the current live manifest before opening the sole FTP
# control session. That session uploads assets, pauses for public HTTP checks,
# uploads the manifest to a unique temporary name, atomically renames it, and
# pauses again for final live verification.

set -euo pipefail
set +x

die() {
  echo "FAIL: $*" >&2
  exit 1
}

file_size() {
  stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

lftp_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

verify_assets() {
  state_file="$1"
  while IFS="$(printf '\t')" read -r url expected_size expected_first16; do
    [ -n "$url" ] || continue
    headers="$(curl -sS -I --max-time 30 "$url")" || die "asset HEAD failed: $url"
    read -r code content_length content_range <<EOF_HEADERS
$(printf '%s\n' "$headers" | awk '
  BEGIN { c=0; l=-1; r="" }
  /^HTTP/ { c=$2 }
  tolower($1)=="content-length:" { l=$2; gsub(/\r/, "", l) }
  tolower($1)=="content-range:" {
    $1=""; sub(/^ /, ""); r=$0; gsub(/\r/, "", r)
  }
  END { print c" "l" "r }
')
EOF_HEADERS
    case "$code" in 200|206) ;; *) die "asset not reachable: $url (HTTP $code)" ;; esac
    served_size="$content_length"
    if [ "$code" = "206" ]; then
      range_total="$(printf '%s\n' "$content_range" | awk -F/ 'NF == 2 { print $2 }')"
      [ -z "$range_total" ] || [ "$range_total" = "*" ] || served_size="$range_total"
    fi
    [ "$served_size" = "$expected_size" ] || die "asset size mismatch: $url (served=$served_size expected=$expected_size)"

    part_tmp="$(mktemp "${TMPDIR:-/tmp}/skipi-rf-range.XXXXXX")"
    if ! range_code="$(curl -fsSL --max-time 30 --max-filesize 65536 -r 0-15 -o "$part_tmp" -w '%{http_code}' "$url")"; then
      rm -f "$part_tmp"
      die "asset range fetch failed: $url"
    fi
    case "$range_code" in 200|206) ;; *) rm -f "$part_tmp"; die "asset range fetch failed: $url (HTTP $range_code)" ;; esac
    remote_first16="$(od -An -tx1 -N16 -v "$part_tmp" | tr -d ' \n')"
    rm -f "$part_tmp"
    [ "$remote_first16" = "$expected_first16" ] || die "asset first bytes mismatch: $url"
    echo "  public asset OK: $(basename "$url") ($served_size bytes)"
  done < "$state_file"
}

verify_live() {
  state_file="$1"
  staged_manifest="$2"
  manifest_url="$3"
  rollback_evidence="$4"
  live_tmp="$(mktemp "${TMPDIR:-/tmp}/skipi-rf-live.XXXXXX")"
  trap 'rm -f "$live_tmp"' EXIT

  if ! curl -fsSL --max-time 30 -o "$live_tmp" "$manifest_url"; then
    die "post-rename live manifest fetch failed; rollback evidence: $rollback_evidence"
  fi
  cmp -s "$staged_manifest" "$live_tmp" || die "post-rename live manifest byte-compare failed; rollback evidence: $rollback_evidence"

  while IFS= read -r url; do
    [ -n "$url" ] || continue
    if ! code="$(curl -sS -I --max-time 30 -o /dev/null -w '%{http_code}' "$url")"; then
      die "post-rename asset verification failed: $url; rollback evidence: $rollback_evidence"
    fi
    case "$code" in
      200|206) echo "  live asset OK: $url ($code)" ;;
      *) die "post-rename asset verification failed: $url (HTTP $code); rollback evidence: $rollback_evidence" ;;
    esac
  done < <(jq -r '.platforms | to_entries[] | .value.url | select(type == "string" and length > 0)' "$live_tmp" | sort -u)

  [ -s "$state_file" ] || die "post-rename verification state is empty; rollback evidence: $rollback_evidence"
  echo "  live manifest byte-match OK"
}

# These two modes are callbacks from the already-open, single lftp process.
# They never open an FTP connection themselves.
case "${1:-}" in
  --internal-verify-assets)
    [ "$#" -eq 2 ] || die "invalid internal asset verification invocation"
    verify_assets "$2"
    exit 0
    ;;
  --internal-verify-live)
    [ "$#" -eq 5 ] || die "invalid internal live verification invocation"
    verify_live "$2" "$3" "$4" "$5"
    exit 0
    ;;
esac

STAGING=""
MANIFEST_LOCAL="latest.rf.json"
MANIFEST_URL=""
EXPECT_VERSION=""
ROLLBACK_EVIDENCE=""
DRY_RUN=0
FTP_HOST="${RF_FTP_HOST:-5.23.50.183}"
DOCROOT="api-ru/public_html"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staging) STAGING="$2"; shift 2 ;;
    --manifest-local) MANIFEST_LOCAL="$2"; shift 2 ;;
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --rollback-evidence) ROLLBACK_EVIDENCE="$2"; shift 2 ;;
    --ftp-host) FTP_HOST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "unknown arg: $1" ;;
  esac
done

for tool in curl jq python3 stat od sed awk cmp; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die "sha256sum or shasum is required"
fi

[ -n "$STAGING" ] && [ -d "$STAGING" ] || die "--staging dir missing: $STAGING"
[ -n "$MANIFEST_URL" ] || die "--manifest-url required"
case "$STAGING$MANIFEST_LOCAL$ROLLBACK_EVIDENCE" in *$'\n'*) die "paths must not contain newlines" ;; esac
case "$FTP_HOST" in ''|*[!A-Za-z0-9.-]*) die "FTP host must not contain a port or path" ;; esac

MANIFEST_PATH="$STAGING/$MANIFEST_LOCAL"
[ -f "$MANIFEST_PATH" ] || die "staged manifest not found: $MANIFEST_PATH"

MANIFEST_HOST="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).netloc)' "$MANIFEST_URL")"
[ "$MANIFEST_HOST" = "api-ru.skipi.app" ] || die "manifest URL must be on api-ru.skipi.app, got: $MANIFEST_HOST"
HOST_PREFIX="$(python3 -c 'import sys, urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p.scheme + "://" + p.netloc)' "$MANIFEST_URL")"
[ "$HOST_PREFIX" = "https://api-ru.skipi.app" ] || die "manifest URL must use public HTTPS"
MANIFEST_URL_PATH="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).path)' "$MANIFEST_URL")"
MANIFEST_REMOTE_PATH="$DOCROOT$MANIFEST_URL_PATH"
MANIFEST_REMOTE_DIR="$(dirname "$MANIFEST_REMOTE_PATH")"
MANIFEST_BASENAME="$(basename "$MANIFEST_REMOTE_PATH")"
[ "$MANIFEST_BASENAME" = "latest.json" ] || die "manifest URL must end in latest.json"

jq -e '.platforms | type == "object"' "$MANIFEST_PATH" >/dev/null || die "manifest .platforms must be an object"
MANIFEST_VERSION="$(jq -r '.version' "$MANIFEST_PATH")"
[ -n "$MANIFEST_VERSION" ] && [ "$MANIFEST_VERSION" != "null" ] || die "manifest has no .version"
[ -z "$EXPECT_VERSION" ] || [ "$MANIFEST_VERSION" = "$EXPECT_VERSION" ] || die "manifest version $MANIFEST_VERSION != expected $EXPECT_VERSION"
case "$MANIFEST_VERSION" in *[!A-Za-z0-9._-]*|'') die "manifest version is unsafe for a remote basename" ;; esac
MANIFEST_TEMP_BASENAME="${MANIFEST_BASENAME}.${MANIFEST_VERSION}.$(date -u +%Y%m%dT%H%M%SZ).$$.new"

EMPTY_SIGS="$(jq -r '.platforms | to_entries[] | select((.value.signature // "") == "") | .key' "$MANIFEST_PATH")"
[ -z "$EMPTY_SIGS" ] || die "manifest has empty signatures for: $(printf '%s' "$EMPTY_SIGS" | tr '\n' ' ')"

STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/skipi-rf-state.XXXXXX")"
ASSET_URLS_FILE="$(mktemp "${TMPDIR:-/tmp}/skipi-rf-urls.XXXXXX")"
UPLOAD_FILES_FILE="$(mktemp "${TMPDIR:-/tmp}/skipi-rf-uploads.XXXXXX")"
EVIDENCE_CAPTURE=""
cleanup() {
  rm -f "$STATE_FILE" "$ASSET_URLS_FILE" "$UPLOAD_FILES_FILE"
  [ -z "$EVIDENCE_CAPTURE" ] || rm -f "$EVIDENCE_CAPTURE"
}
trap cleanup EXIT HUP INT TERM

jq -r '.platforms | to_entries[] | .value.url | select(type == "string" and length > 0)' "$MANIFEST_PATH" | sort -u > "$ASSET_URLS_FILE"
[ -s "$ASSET_URLS_FILE" ] || die "manifest references no asset URLs"

while IFS= read -r url; do
  case "$url" in "$HOST_PREFIX"/*) ;; *) die "asset URL host mismatch: $url (expected $HOST_PREFIX)" ;; esac
done < "$ASSET_URLS_FILE"

ASSET_REMOTE_DIR="$(python3 - "$DOCROOT" "$ASSET_URLS_FILE" <<'PY'
import os
import sys
import urllib.parse as urlparse

docroot, urls_path = sys.argv[1:]
with open(urls_path, encoding="utf-8") as handle:
    dirs = {os.path.dirname(urlparse.urlsplit(line.strip()).path) for line in handle if line.strip()}
if len(dirs) != 1:
    raise SystemExit("asset URLs span multiple directories")
print(docroot + dirs.pop())
PY
)" || die "manifest assets span multiple remote dirs"

while IFS= read -r url; do
  base="$(basename "$url")"
  local_file="$STAGING/$base"
  [ -f "$local_file" ] || die "manifest asset has no local file: $base"
  size="$(file_size "$local_file")"
  first16="$(od -An -tx1 -N16 -v "$local_file" | tr -d ' \n')"
  printf '%s\t%s\t%s\n' "$url" "$size" "$first16" >> "$STATE_FILE"
done < "$ASSET_URLS_FILE"

while IFS="$(printf '\t')" read -r platform asset_name embedded_sig; do
  sig_file="$STAGING/$asset_name.sig"
  if [ -f "$sig_file" ]; then
    file_sig="$(tr -d '\r\n' < "$sig_file")"
    [ "$file_sig" = "$embedded_sig" ] || die "signature mismatch for $platform: $asset_name.sig does not match manifest"
  fi
done < <(jq -r '.platforms | to_entries[] | [.key, (.value.url | split("?")[0] | split("/")[-1]), .value.signature] | @tsv' "$MANIFEST_PATH")

find "$STAGING" -maxdepth 1 -type f | sort | while IFS= read -r file; do
  base="$(basename "$file")"
  [ "$base" = "$MANIFEST_LOCAL" ] && continue
  [ "$base" = "latest.json" ] && continue
  printf '%s\n' "$file"
done > "$UPLOAD_FILES_FILE"
[ -s "$UPLOAD_FILES_FILE" ] || die "staging contains no asset files to upload"

echo "== RF mirror bounded FTP:21 plan =="
echo "  manifest      : $MANIFEST_URL (version $MANIFEST_VERSION)"
echo "  FTP control   : $FTP_HOST:21 (one login attempt, no retries)"
echo "  FTP docroot   : $DOCROOT"
echo "  order         : rollback evidence -> assets first -> public verification -> temporary manifest -> atomic rename -> manifest last verification"
echo "  remote assets : $ASSET_REMOTE_DIR"
echo "  manifest flip : $MANIFEST_TEMP_BASENAME -> $MANIFEST_BASENAME"
while IFS="$(printf '\t')" read -r url size first16; do
  echo "  asset         : $(basename "$url") ($size bytes)"
done < "$STATE_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] zero network/login attempts; no live state changed."
  exit 0
fi

[ -n "$ROLLBACK_EVIDENCE" ] || die "--rollback-evidence is required for a real publish"
case "$ROLLBACK_EVIDENCE" in /*) ;; *) die "--rollback-evidence must be an absolute local path" ;; esac
[ ! -e "$ROLLBACK_EVIDENCE" ] || die "rollback evidence target already exists: $ROLLBACK_EVIDENCE"
EVIDENCE_DIR="$(dirname "$ROLLBACK_EVIDENCE")"
[ -d "$EVIDENCE_DIR" ] && [ -w "$EVIDENCE_DIR" ] || die "rollback evidence directory is missing or not writable: $EVIDENCE_DIR"
command -v lftp >/dev/null 2>&1 || die "lftp is required for FTP:21 upload"
[ -n "${RF_FTP_USER:-}" ] && [ -n "${RF_FTP_PASS:-}" ] || die "set RF_FTP_USER and RF_FTP_PASS"

umask 077
EVIDENCE_CAPTURE="$(mktemp "$EVIDENCE_DIR/.skipi-rf-evidence.XXXXXX")"
if ! curl -fsSL --max-time 30 -o "$EVIDENCE_CAPTURE" "$MANIFEST_URL"; then
  die "cannot capture current live manifest before FTP login"
fi
[ -s "$EVIDENCE_CAPTURE" ] || die "captured rollback evidence is empty"
jq -e '.version and (.platforms | type == "object")' "$EVIDENCE_CAPTURE" >/dev/null || die "captured rollback evidence is not a valid live manifest"
if ! ln "$EVIDENCE_CAPTURE" "$ROLLBACK_EVIDENCE"; then
  die "cannot create rollback evidence without overwriting: $ROLLBACK_EVIDENCE"
fi
rm -f "$EVIDENCE_CAPTURE"
EVIDENCE_CAPTURE=""
EVIDENCE_SHA="$(file_sha256 "$ROLLBACK_EVIDENCE")"
EVIDENCE_SIZE="$(file_size "$ROLLBACK_EVIDENCE")"
echo "rollback evidence: $ROLLBACK_EVIDENCE"
echo "SHA-256: $EVIDENCE_SHA"
echo "bytes: $EVIDENCE_SIZE"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "$0")"
VERIFY_ASSETS_COMMAND="$(shell_quote "$SCRIPT_PATH") --internal-verify-assets $(shell_quote "$STATE_FILE")"
VERIFY_LIVE_COMMAND="$(shell_quote "$SCRIPT_PATH") --internal-verify-live $(shell_quote "$STATE_FILE") $(shell_quote "$MANIFEST_PATH") $(shell_quote "$MANIFEST_URL") $(shell_quote "$ROLLBACK_EVIDENCE")"

# One command per line: the "!" command hands the rest of its line to the
# local shell, so with ";" separators everything after the first "!" would
# run in bash instead of lftp (live incident 2026-07-28).
LFTP_NL='
'
LFTP_COMMANDS="set cmd:fail-exit yes${LFTP_NL}set cmd:parallel 1${LFTP_NL}set net:max-retries 1${LFTP_NL}set dns:max-retries 1${LFTP_NL}set net:persist-retries 0${LFTP_NL}set net:connection-limit 1${LFTP_NL}set net:idle 24h${LFTP_NL}set xfer:parallel 1${LFTP_NL}set ftp:retry-530 \"\"${LFTP_NL}set ftp:proxy \"\"${LFTP_NL}set hftp:proxy \"\"${LFTP_NL}set ftp:ssl-allow no${LFTP_NL}set ftp:ssl-force no"
LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}mkdir -f -p $(lftp_quote "$ASSET_REMOTE_DIR")"
while IFS= read -r file; do
  LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}put -O $(lftp_quote "$ASSET_REMOTE_DIR") $(lftp_quote "$file")"
done < "$UPLOAD_FILES_FILE"
LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}! $VERIFY_ASSETS_COMMAND"
LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}put -O $(lftp_quote "$MANIFEST_REMOTE_DIR") $(lftp_quote "$MANIFEST_PATH") -o $(lftp_quote "$MANIFEST_TEMP_BASENAME")"
LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}mv $(lftp_quote "$MANIFEST_REMOTE_DIR/$MANIFEST_TEMP_BASENAME") $(lftp_quote "$MANIFEST_REMOTE_DIR/$MANIFEST_BASENAME")"
LFTP_COMMANDS="$LFTP_COMMANDS${LFTP_NL}! $VERIFY_LIVE_COMMAND${LFTP_NL}bye"

echo "== opening the sole FTP:21 control session =="
# The command script goes over stdin: with -e, lftp 4.9.2 tokenizes quotes
# only on the first line and every later line keeps literal quote characters
# in its paths (live incident 2026-07-28, second occurrence). Stdin parses
# every line alike. set -o pipefail (top of file) keeps the pipeline
# fail-closed: a failure of either stage makes the whole publish die.
if ! printf '%s\n' "$LFTP_COMMANDS" | lftp -u "$RF_FTP_USER,$RF_FTP_PASS" "ftp://$FTP_HOST:21"; then
  die "FTP publish failed without retry; rollback evidence: $ROLLBACK_EVIDENCE"
fi

echo "== PASS == $MANIFEST_URL is at version $MANIFEST_VERSION; rollback evidence: $ROLLBACK_EVIDENCE"

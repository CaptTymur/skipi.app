#!/usr/bin/env bash
# Atomic RF / Timeweb (api-ru) mirror publisher for Skipi desktop releases.
#
# The manifest is the source of truth. It must already point at api-ru URLs.
# Publish order is enforced:
#   1. Upload all staged asset files first.
#   2. Verify every manifest asset URL is public, size-matched, and range-readable.
#   3. Upload latest.json to a temporary name, then rename it to the live path.
#   4. Fetch the live manifest and verify it still points only at reachable assets.
#
# Example:
#   RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \
#   bash scripts/publish-rf-mirror.sh \
#     --staging /tmp/skipi-rf-seafarer-0.4.164 \
#     --manifest-local latest.rf.json \
#     --manifest-url https://api-ru.skipi.app/seafarer/latest.json \
#     --expect-version 0.4.164
#
# Requires: lftp, curl, jq, python3, stat, od.

set -euo pipefail

STAGING=""
MANIFEST_LOCAL="latest.rf.json"
MANIFEST_URL=""
EXPECT_VERSION=""
DRY_RUN=0
SFTP_HOST="${RF_SFTP_HOST:-5.23.50.183}"
DOCROOT="${RF_DOCROOT:-/home/c/cq62932/api-ru/public_html}"

while [ $# -gt 0 ]; do
  case "$1" in
    --staging) STAGING="$2"; shift 2 ;;
    --manifest-local) MANIFEST_LOCAL="$2"; shift 2 ;;
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --sftp-host) SFTP_HOST="$2"; shift 2 ;;
    --docroot) DOCROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

die() {
  echo "FAIL: $*" >&2
  exit 1
}

for tool in curl jq python3 stat od; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
[ -n "$STAGING" ] && [ -d "$STAGING" ] || die "--staging dir missing: $STAGING"
[ -n "$MANIFEST_URL" ] || die "--manifest-url required"

MANIFEST_PATH="$STAGING/$MANIFEST_LOCAL"
[ -f "$MANIFEST_PATH" ] || die "staged manifest not found: $MANIFEST_PATH"

if [ "$DRY_RUN" -eq 0 ]; then
  command -v lftp >/dev/null || die "lftp is required for upload"
  [ -n "${RF_SFTP_USER:-}" ] && [ -n "${RF_SFTP_PASS:-}" ] || die "set RF_SFTP_USER and RF_SFTP_PASS"
fi

MANIFEST_HOST="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).netloc)' "$MANIFEST_URL")"
[ "$MANIFEST_HOST" = "api-ru.skipi.app" ] || die "manifest URL must be on api-ru.skipi.app, got: $MANIFEST_HOST"

HOST_PREFIX="$(python3 -c 'import sys, urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p.scheme + "://" + p.netloc)' "$MANIFEST_URL")"
MANIFEST_REMOTE_PATH="$DOCROOT$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).path)' "$MANIFEST_URL")"
MANIFEST_REMOTE_DIR="$(dirname "$MANIFEST_REMOTE_PATH")"
MANIFEST_BASENAME="$(basename "$MANIFEST_REMOTE_PATH")"

jq -e '.platforms | type == "object"' "$MANIFEST_PATH" >/dev/null || die "manifest .platforms must be an object"
MANIFEST_VERSION="$(jq -r '.version' "$MANIFEST_PATH")"
[ -n "$MANIFEST_VERSION" ] && [ "$MANIFEST_VERSION" != "null" ] || die "manifest has no .version"
[ -z "$EXPECT_VERSION" ] || [ "$MANIFEST_VERSION" = "$EXPECT_VERSION" ] || die "manifest version $MANIFEST_VERSION != expected $EXPECT_VERSION"
MANIFEST_TEMP_BASENAME="${MANIFEST_BASENAME}.${MANIFEST_VERSION}.$(date -u +%Y%m%dT%H%M%SZ).new"

mapfile -t ASSET_URLS < <(jq -r '.platforms | to_entries[] | .value.url' "$MANIFEST_PATH" | grep -v '^null$' | sort -u)
[ "${#ASSET_URLS[@]}" -gt 0 ] || die "manifest references no asset URLs"

EMPTY_SIGS="$(jq -r '.platforms | to_entries[] | select((.value.signature // "") == "") | .key' "$MANIFEST_PATH")"
[ -z "$EMPTY_SIGS" ] || die "manifest has empty signatures for: $(echo "$EMPTY_SIGS" | tr '\n' ' ')"

for url in "${ASSET_URLS[@]}"; do
  [[ "$url" == "$HOST_PREFIX"/* ]] || die "asset URL host mismatch: $url (expected $HOST_PREFIX)"
done

ASSET_REMOTE_DIR="$(python3 - "$DOCROOT" "${ASSET_URLS[@]}" <<'PY'
import os
import sys
import urllib.parse as urlparse

docroot = sys.argv[1]
dirs = {os.path.dirname(urlparse.urlsplit(asset).path) for asset in sys.argv[2:]}
if len(dirs) != 1:
    raise SystemExit("asset URLs span multiple directories")
print(docroot + dirs.pop())
PY
)" || die "manifest assets span multiple remote dirs"

declare -A URL_SIZE URL_FIRST16
for url in "${ASSET_URLS[@]}"; do
  base="$(basename "$url")"
  local_file="$STAGING/$base"
  [ -f "$local_file" ] || die "manifest asset has no local file: $base"
  URL_SIZE["$url"]="$(stat -c%s "$local_file")"
  URL_FIRST16["$url"]="$(od -An -tx1 -N16 -v "$local_file" | tr -d ' \n')"
done

while IFS=$'\t' read -r platform asset_name embedded_sig; do
  sig_file="$STAGING/$asset_name.sig"
  if [ -f "$sig_file" ]; then
    file_sig="$(tr -d '\r\n' < "$sig_file")"
    [ "$file_sig" = "$embedded_sig" ] || die "signature mismatch for $platform: $asset_name.sig does not match manifest"
  fi
done < <(
  jq -r '.platforms | to_entries[] | [.key, (.value.url | split("?")[0] | split("/")[-1]), .value.signature] | @tsv' "$MANIFEST_PATH"
)

UPLOAD_FILES=()
while IFS= read -r file; do
  base="$(basename "$file")"
  [ "$base" = "$MANIFEST_LOCAL" ] && continue
  [ "$base" = "latest.json" ] && continue
  UPLOAD_FILES+=("$file")
done < <(find "$STAGING" -maxdepth 1 -type f | sort)

echo "== RF mirror publish plan =="
echo "  manifest : $MANIFEST_URL (version $MANIFEST_VERSION)"
echo "  sftp host: $SFTP_HOST"
echo "  assets   : $ASSET_REMOTE_DIR"
echo "  manifest : $MANIFEST_REMOTE_PATH ($MANIFEST_TEMP_BASENAME -> $MANIFEST_BASENAME)"
for url in "${ASSET_URLS[@]}"; do
  echo "  asset    : $(basename "$url") (${URL_SIZE[$url]} bytes)"
done

run_lftp() {
  lftp -u "$RF_SFTP_USER,$RF_SFTP_PASS" "sftp://$SFTP_HOST" \
    -e "set sftp:auto-confirm yes; set net:max-retries 2; set net:timeout 30; $1; bye"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] no upload performed."
  exit 0
fi

echo "== 1. uploading asset files first =="
CMDS="mkdir -f -p \"$ASSET_REMOTE_DIR\";"
for file in "${UPLOAD_FILES[@]}"; do
  CMDS="$CMDS put -O \"$ASSET_REMOTE_DIR\" \"$file\";"
done
run_lftp "$CMDS"

echo "== 2. verifying public asset URLs =="
for url in "${ASSET_URLS[@]}"; do
  expected_size="${URL_SIZE[$url]}"
  read -r code content_length content_range < <(
    curl -sSI -m 30 "$url" |
      awk '
        BEGIN { c=0; l=-1; r="" }
        /^HTTP/ { c=$2 }
        tolower($1)=="content-length:" { l=$2; gsub(/\r/, "", l) }
        tolower($1)=="content-range:" {
          $1=""; sub(/^ /, ""); r=$0; gsub(/\r/, "", r)
        }
        END { print c" "l" "r }
      '
  )
  [[ "$code" = "200" || "$code" = "206" ]] || die "asset not reachable: $url (HTTP $code)"
  served_size="$content_length"
  if [ "$code" = "206" ]; then
    range_total="$(printf '%s\n' "$content_range" | awk -F/ 'NF == 2 { print $2 }')"
    [ -z "$range_total" ] || [ "$range_total" = "*" ] || served_size="$range_total"
  fi
  [ "$served_size" = "$expected_size" ] || die "asset size mismatch: $url (served=$served_size expected=$expected_size)"

  part_tmp="$(mktemp)"
  if ! range_code="$(curl -fsSL -m 30 --max-filesize 65536 -r 0-15 -o "$part_tmp" -w '%{http_code}' "$url")"; then
    rm -f "$part_tmp"
    die "asset range fetch failed: $url"
  fi
  if ! [[ "$range_code" = "200" || "$range_code" = "206" ]]; then
    rm -f "$part_tmp"
    die "asset range fetch failed: $url (HTTP $range_code)"
  fi
  remote_first16="$(od -An -tx1 -N16 -v "$part_tmp" | tr -d ' \n')"
  rm -f "$part_tmp"
  [ "$remote_first16" = "${URL_FIRST16[$url]}" ] || die "asset first bytes mismatch: $url"
  echo "  ok $(basename "$url") ($served_size bytes, HEAD $code, range $range_code)"
done

echo "== 3. publishing manifest last, atomically =="
run_lftp "mkdir -f -p \"$MANIFEST_REMOTE_DIR\"; put -O \"$MANIFEST_REMOTE_DIR\" \"$MANIFEST_PATH\" -o \"$MANIFEST_TEMP_BASENAME\"; mv \"$MANIFEST_REMOTE_DIR/$MANIFEST_TEMP_BASENAME\" \"$MANIFEST_REMOTE_DIR/$MANIFEST_BASENAME\""

echo "== 4. verifying live manifest =="
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -sSLf -m 30 -o "$TMP" "$MANIFEST_URL" || die "live manifest not reachable: $MANIFEST_URL"
cmp -s "$MANIFEST_PATH" "$TMP" || die "live manifest differs from staged manifest"

while IFS= read -r url; do
  code="$(curl -sI -m 30 -o /dev/null -w '%{http_code}' "$url")"
  [[ "$code" = "200" || "$code" = "206" ]] || die "live manifest references unreachable asset: $url (HTTP $code)"
  echo "  ok $url ($code)"
done < <(jq -r '.platforms | to_entries[] | .value.url' "$TMP" | grep -v '^null$' | sort -u)

echo "== PASS == RF mirror for $MANIFEST_URL is at version $MANIFEST_VERSION; all assets are reachable."

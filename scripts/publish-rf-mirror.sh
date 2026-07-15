#!/usr/bin/env bash
# ============================================================================
# Atomic RF / Timeweb (api-ru) mirror publisher for Skipi desktop releases.
# Works for seafarer / broker / crewing / onboard — it is driven entirely by the
# manifest you give it (the manifest is the source of truth for which assets go
# where), so it is app-agnostic.
#
# WHY THIS EXISTS
#   A release 404'd because api-ru `latest.json` pointed to an AppImage before
#   that AppImage finished mirroring. This script makes publish order ATOMIC so
#   the manifest can never go live before its assets are reachable:
#     1. Upload all ASSETS the manifest references (assets FIRST).
#     2. Verify each asset URL returns 200 with Content-Length == local size.
#     3. Upload latest.json to a TEMP name, then ATOMIC rename -> live path.
#     4. Verify the live manifest: version matches + every referenced asset 200/206.
#     5. Only then print PASS (exit 0). Any failure -> manifest NOT flipped, exit !=0.
#
# USAGE
#   RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \
#   bash scripts/publish-rf-mirror.sh \
#     --staging       /tmp/skipi-rf-seafarer-0.4.164 \
#     --manifest-local latest.rf.json \
#     --manifest-url  https://api-ru.skipi.app/latest.json
#   # broker  : --manifest-url https://api-ru.skipi.app/broker/latest.json
#   # crewing : --manifest-url https://api-ru.skipi.app/crewing/latest.json
#   # onboard : --manifest-url https://api-ru.skipi.app/onboard/latest.json
#
#   Optional: --dry-run        (do everything except upload/rename; print plan)
#             --sftp-host HOST  (default $RF_SFTP_HOST or 5.23.50.183)
#             --docroot PATH    (default $RF_DOCROOT or /home/c/cq62932/api-ru/public_html)
#
# REQUIREMENTS: lftp, curl, jq, python3, sha256sum, stat.
#   install lftp once:  sudo apt-get install -y lftp
#
# SECRETS: credentials come ONLY from env (RF_SFTP_USER / RF_SFTP_PASS) or a
#   600-perm ~/.netrc. They are NEVER hardcoded and NEVER echoed by this script.
# ============================================================================
set -euo pipefail

STAGING="" ; MANIFEST_LOCAL="latest.rf.json" ; MANIFEST_URL="" ; DRY_RUN=0
SFTP_HOST="${RF_SFTP_HOST:-5.23.50.183}"
DOCROOT="${RF_DOCROOT:-/home/c/cq62932/api-ru/public_html}"

while [ $# -gt 0 ]; do
  case "$1" in
    --staging) STAGING="$2"; shift 2;;
    --manifest-local) MANIFEST_LOCAL="$2"; shift 2;;
    --manifest-url) MANIFEST_URL="$2"; shift 2;;
    --sftp-host) SFTP_HOST="$2"; shift 2;;
    --docroot) DOCROOT="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

die(){ echo "FAIL: $*" >&2; exit 1; }
for t in curl jq python3 sha256sum stat; do command -v "$t" >/dev/null || die "$t is required"; done
[ -n "$STAGING" ] && [ -d "$STAGING" ] || die "--staging dir missing: $STAGING"
[ -n "$MANIFEST_URL" ] || die "--manifest-url required"
MAN="$STAGING/$MANIFEST_LOCAL"
[ -f "$MAN" ] || die "staged manifest not found: $MAN"
if [ "$DRY_RUN" -eq 0 ]; then
  command -v lftp >/dev/null || die "lftp is required for upload (sudo apt-get install -y lftp)"
  [ -n "${RF_SFTP_USER:-}" ] && [ -n "${RF_SFTP_PASS:-}" ] || die "set RF_SFTP_USER and RF_SFTP_PASS (never hardcode)"
fi

# --- derive host + remote paths from the manifest URL ----------------------
HOST_PREFIX="$(python3 -c 'import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(p.scheme+"://"+p.netloc)' "$MANIFEST_URL")"
MAN_REMOTE_PATH="$DOCROOT$(python3 -c 'import sys,urllib.parse as u;print(u.urlsplit(sys.argv[1]).path)' "$MANIFEST_URL")"
MAN_REMOTE_DIR="$(dirname "$MAN_REMOTE_PATH")"
MAN_BASENAME="$(basename "$MAN_REMOTE_PATH")"
MAN_VERSION="$(jq -r '.version' "$MAN")"
[ -n "$MAN_VERSION" ] && [ "$MAN_VERSION" != "null" ] || die "manifest has no .version"

# Every distinct asset URL the manifest references (updater installer URLs).
mapfile -t ASSET_URLS < <(jq -r '.platforms | to_entries[] | .value.url' "$MAN" | grep -v '^null$' | sort -u)
[ "${#ASSET_URLS[@]}" -gt 0 ] || die "manifest references no asset URLs"

# All asset URLs must share the SAME host as the manifest (no cross-host leak).
for url in "${ASSET_URLS[@]}"; do
  [[ "$url" == "$HOST_PREFIX"/* ]] || die "asset URL host mismatch: $url (expected $HOST_PREFIX)"
done
# Common remote asset directory (for our layouts all assets share one dir).
ASSET_DIR_PATH="$(python3 - "$DOCROOT" "${ASSET_URLS[@]}" <<'PY'
import sys,os,urllib.parse as u
docroot=sys.argv[1]; dirs={os.path.dirname(u.urlsplit(a).path) for a in sys.argv[2:]}
if len(dirs)!=1:
    print("MULTI",file=sys.stderr); sys.exit(3)
print(docroot+dirs.pop())
PY
)" || die "manifest assets span multiple remote dirs — unsupported layout (extend script)"

echo "== RF mirror publish plan =="
echo "  app manifest : $MANIFEST_URL  (version $MAN_VERSION)"
echo "  sftp host    : $SFTP_HOST"
echo "  asset dir    : $ASSET_DIR_PATH"
echo "  manifest path: $MAN_REMOTE_PATH  (atomic via .new + rename)"
echo "  assets ($(echo "${ASSET_URLS[@]}" | wc -w)): $(for u in "${ASSET_URLS[@]}"; do basename "$u"; done | tr '\n' ' ')"

# --- map each manifest asset URL to a local staged file + record size ------
declare -A LOCAL_OF URL_SIZE
for url in "${ASSET_URLS[@]}"; do
  base="$(basename "$url")"
  lf="$STAGING/$base"
  [ -f "$lf" ] || die "manifest asset has no local file: $base (expected $lf)"
  LOCAL_OF["$url"]="$lf"; URL_SIZE["$url"]="$(stat -c%s "$lf")"
done
# Files to upload to the asset dir = ALL staged files EXCEPT the manifest itself.
UPLOAD_FILES=()
while IFS= read -r f; do [ "$(basename "$f")" = "$MANIFEST_LOCAL" ] || UPLOAD_FILES+=("$f"); done \
  < <(find "$STAGING" -maxdepth 1 -type f | sort)

run_lftp(){  # commands on stdin; creds from env only (never logged)
  lftp -u "$RF_SFTP_USER,$RF_SFTP_PASS" "sftp://$SFTP_HOST" -e "set sftp:auto-confirm yes; set net:max-retries 2; set net:timeout 30; $1; bye"
}

if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] stopping before any upload."; exit 0; fi

# ---- STEP 1: upload assets FIRST -------------------------------------------
echo "== 1. uploading ${#UPLOAD_FILES[@]} asset file(s) to $ASSET_DIR_PATH =="
CMDS="mkdir -f -p \"$ASSET_DIR_PATH\";"
for f in "${UPLOAD_FILES[@]}"; do CMDS="$CMDS put -O \"$ASSET_DIR_PATH\" \"$f\";"; done
run_lftp "$CMDS"

# ---- STEP 2: verify every referenced asset URL over HTTPS -------------------
echo "== 2. verifying asset URLs (200 + size match) =="
for url in "${ASSET_URLS[@]}"; do
  read -r code clen < <(curl -sI -m 30 "$url" | awk 'BEGIN{c=0;l=-1}/^HTTP/{c=$2}tolower($1)=="content-length:"{l=$2}END{print c" "l}')
  [ "$code" = "200" ] || die "asset not reachable: $url (HTTP $code)"
  [ "$clen" = "${URL_SIZE[$url]}" ] || die "asset size mismatch: $url (served=$clen expected=${URL_SIZE[$url]})"
  echo "  ok  $url  ($clen bytes)"
done

# ---- STEP 3: publish manifest LAST, atomically (temp + rename) -------------
echo "== 3. publishing manifest atomically (.new -> rename) =="
run_lftp "mkdir -f -p \"$MAN_REMOTE_DIR\"; put -O \"$MAN_REMOTE_DIR\" \"$MAN\" -o \"$MAN_BASENAME.new\"; mv \"$MAN_REMOTE_DIR/$MAN_BASENAME.new\" \"$MAN_REMOTE_DIR/$MAN_BASENAME\""

# ---- STEP 4: verify live manifest + that it points ONLY to reachable assets -
echo "== 4. verifying live manifest =="
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
curl -sSLf -m 30 -o "$TMP" "$MANIFEST_URL" || die "live manifest not reachable: $MANIFEST_URL"
LIVE_VER="$(jq -r '.version' "$TMP")"
[ "$LIVE_VER" = "$MAN_VERSION" ] || die "live manifest version mismatch (live=$LIVE_VER expected=$MAN_VERSION)"
while IFS= read -r url; do
  code="$(curl -sI -m 30 -o /dev/null -w '%{http_code}' "$url")"
  [[ "$code" = "200" || "$code" = "206" ]] || die "live manifest references unreachable asset: $url (HTTP $code)"
  echo "  ok  $url ($code)"
done < <(jq -r '.platforms | to_entries[] | .value.url' "$TMP" | grep -v '^null$' | sort -u)

echo "== PASS == RF mirror for $MANIFEST_URL is at version $MAN_VERSION; all assets reachable."

#!/usr/bin/env bash
# Prepare Seafarer release files for the RF/Timeweb mirror route.
#
# Usage:
#   bash scripts/prepare-rf-mirror.sh 0.4.128
#
# Output:
#   /tmp/skipi-rf-seafarer-<version>/
#     - installers + .sig files from GitHub release
#     - latest.rf.json (manifest for https://api-ru.skipi.app/latest.json)
#
# Then publish ATOMICALLY (assets first, verified, manifest last) — DO NOT
# hand-upload latest.json before the assets (that caused the v0.4.164 404):
#   RF_SFTP_USER=... RF_SFTP_PASS=... bash scripts/publish-rf-mirror.sh \
#     --staging /tmp/skipi-rf-seafarer-<version> \
#     --manifest-local latest.rf.json \
#     --manifest-url https://api-ru.skipi.app/latest.json

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required (GitHub CLI)." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>, e.g. $0 0.4.128" >&2
  exit 1
fi

TAG="v${VERSION}"
STAGE="/tmp/skipi-rf-seafarer-${VERSION}"
BASE_URL="https://api-ru.skipi.app/downloads/seafarer/${VERSION}"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cd "$STAGE"

FILES=(
  "Skipi_${VERSION}_x64-setup.exe"
  "Skipi_${VERSION}_x64-setup.exe.sig"
  "Skipi_${VERSION}_x64_en-US.msi"
  "Skipi_${VERSION}_x64_en-US.msi.sig"
  "Skipi_${VERSION}_amd64.deb"
  "Skipi_${VERSION}_amd64.deb.sig"
  "Skipi_${VERSION}_amd64.AppImage"
  "Skipi_${VERSION}_amd64.AppImage.sig"
  "Skipi-${VERSION}-1.x86_64.rpm"
  "Skipi-${VERSION}-1.x86_64.rpm.sig"
  "latest.json"
)

for f in "${FILES[@]}"; do
  gh release download "$TAG" -R CaptTymur/skipi.app -p "$f" --clobber
done

jq --arg version "$VERSION" --arg base "$BASE_URL" '
{
  version: $version,
  pub_date: .pub_date,
  notes: ("Skipi " + $version),
  platforms: {
    "windows-x86_64": {
      signature: .platforms["windows-x86_64"].signature,
      url: ($base + "/Skipi_" + $version + "_x64-setup.exe")
    },
    "linux-x86_64": {
      signature: .platforms["linux-x86_64"].signature,
      url: ($base + "/Skipi_" + $version + "_amd64.AppImage")
    },
    "linux-x86_64-deb": {
      signature: (.platforms["linux-x86_64-deb"].signature // ""),
      url: ($base + "/Skipi_" + $version + "_amd64.deb")
    }
  }
}
' latest.json > latest.rf.json

echo "Prepared RF mirror payload:"
echo "  $STAGE"
echo
echo "Publish ATOMICALLY (assets first -> verify -> manifest last -> verify):"
echo "  RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \\"
echo "  bash $(dirname "$0")/publish-rf-mirror.sh \\"
echo "    --staging \"$STAGE\" \\"
echo "    --manifest-local latest.rf.json \\"
echo "    --manifest-url https://api-ru.skipi.app/latest.json"
echo
echo "  (dry-run first: add --dry-run. NEVER hand-upload latest.json before the"
echo "   assets — that race caused the v0.4.164 HTTP 404.)"
echo
ls -lh "$STAGE"

#!/usr/bin/env bash
# Prepare Seafarer release files for the RF/Timeweb mirror route.
#
# Usage:
#   bash scripts/prepare-rf-mirror.sh 0.4.128
#
# Output:
#   /tmp/skipi-rf-seafarer-<version>/
#     - installers + .sig files from GitHub release
#     - latest.rf.json (manifest for https://api-ru.skipi.app/seafarer/latest.json)
#
# Then publish atomically. Do not hand-upload latest.json before assets:
#   RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \
#   bash scripts/publish-rf-mirror.sh \
#     --staging /tmp/skipi-rf-seafarer-<version> \
#     --manifest-local latest.rf.json \
#     --manifest-url https://api-ru.skipi.app/seafarer/latest.json \
#     --expect-version <version>

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

gh release download "$TAG" -R CaptTymur/skipi.app -p latest.json --clobber

mapfile -t ASSET_NAMES < <(
  jq -r '.platforms | to_entries[] | .value.url | split("?")[0] | split("/")[-1]' latest.json |
    sort -u
)
if [ "${#ASSET_NAMES[@]}" -eq 0 ]; then
  echo "latest.json has no platform asset URLs" >&2
  exit 1
fi

for f in "${ASSET_NAMES[@]}"; do
  gh release download "$TAG" -R CaptTymur/skipi.app -p "$f" --clobber
  gh release download "$TAG" -R CaptTymur/skipi.app -p "$f.sig" --clobber || true
done

jq --arg version "$VERSION" --arg base "$BASE_URL" '
{
  version: $version,
  pub_date: .pub_date,
  notes: ("Skipi Seafarer " + $version),
  platforms: (
    .platforms
    | with_entries(
        .value.url = ($base + "/" + (.value.url | split("?")[0] | split("/")[-1]))
      )
  )
}
' latest.json > latest.rf.json

echo "Prepared RF mirror payload:"
echo "  $STAGE"
echo
echo "Publish atomically (assets first -> verify -> manifest last -> verify):"
echo "  RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \\"
echo "  bash scripts/publish-rf-mirror.sh \\"
echo "    --staging \"$STAGE\" \\"
echo "    --manifest-local latest.rf.json \\"
echo "    --manifest-url https://api-ru.skipi.app/seafarer/latest.json \\"
echo "    --expect-version \"$VERSION\""
echo
echo "  Dry-run first: add --dry-run. Never publish latest.json before every"
echo "  referenced asset is reachable from the public api-ru URL."
echo
ls -lh "$STAGE"

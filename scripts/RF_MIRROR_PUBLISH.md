# RF mirror atomic publish runbook

This runbook covers `api-ru.skipi.app` static release mirrors for Skipi
desktop updater metadata and download assets. The invariant is:

1. Stage a manifest that already points to `https://api-ru.skipi.app/...`.
2. Upload every referenced asset first.
3. Verify every public asset URL before the manifest goes live.
4. Publish `latest.json` last by temporary upload plus rename.
5. Fetch the live `latest.json` and verify every URL inside it.

Do not update `skipi.app/downloads` until the mirror publisher exits `PASS`.

## Stop lines

- Do not run the publish command without explicit manager GO.
- Do not hand-upload `latest.json`.
- Do not delete remote assets during a normal publish.
- Do not print or paste SFTP secrets into logs, notes, commits, or chat.
- Use `--dry-run` for rehearsal. Dry-run never opens SFTP and never mutates live state.

## Script contract

`scripts/publish-rf-mirror.sh` is manifest-driven. The staged manifest is the
source of truth for app name, version, platform keys, signatures, and asset
URLs.

The script refuses to proceed if:

- the manifest URL is not on `api-ru.skipi.app`;
- `.version` is missing or does not match `--expect-version`;
- `.platforms` is not an object;
- any platform has an empty embedded Tauri updater signature;
- any present `.sig` file does not match the embedded manifest signature;
- any asset URL points to a different host than the manifest;
- referenced assets are spread across multiple remote directories;
- a referenced asset is missing from the staging directory.

During a real publish it then:

- uploads all staged asset files except `latest.json` and the local manifest file;
- checks each public asset URL for HTTP `200` or `206`, exact served size, and matching first 16 bytes;
- uploads the manifest to a versioned temporary name and renames it to `latest.json`;
- downloads the live manifest, byte-compares it with the staged manifest, and checks all live URLs.

## Seafarer

Seafarer has a helper that builds the staging directory from the GitHub release
manifest and rewrites all asset URLs to the RF mirror.

```bash
cd /home/linux/Developer/skipi-public
bash scripts/prepare-rf-mirror.sh 0.4.164

bash scripts/publish-rf-mirror.sh \
  --dry-run \
  --staging /tmp/skipi-rf-seafarer-0.4.164 \
  --manifest-local latest.rf.json \
  --manifest-url https://api-ru.skipi.app/seafarer/latest.json \
  --expect-version 0.4.164
```

Real publish, only after GO:

```bash
RF_SFTP_USER=<user> RF_SFTP_PASS=<pass> \
bash scripts/publish-rf-mirror.sh \
  --staging /tmp/skipi-rf-seafarer-0.4.164 \
  --manifest-local latest.rf.json \
  --manifest-url https://api-ru.skipi.app/seafarer/latest.json \
  --expect-version 0.4.164
```

## Broker

Broker staging can be built from the GitHub `latest.json` with the same URL
rewrite pattern.

```bash
cd /home/linux/Developer/skipi-public
VERSION=0.1.145
REPO=CaptTymur/skipi-broker
APP=broker
STAGE=/tmp/skipi-rf-${APP}-${VERSION}
BASE=https://api-ru.skipi.app/downloads/${APP}/${VERSION}

rm -rf "$STAGE" && mkdir -p "$STAGE" && cd "$STAGE"
gh release download "v${VERSION}" -R "$REPO" -p latest.json --clobber
jq -r '.platforms | to_entries[] | .value.url | split("?")[0] | split("/")[-1]' latest.json |
  sort -u |
  while read -r asset; do
    gh release download "v${VERSION}" -R "$REPO" -p "$asset" --clobber
    gh release download "v${VERSION}" -R "$REPO" -p "$asset.sig" --clobber || true
  done
jq --arg version "$VERSION" --arg base "$BASE" '
  {
    version: $version,
    pub_date: .pub_date,
    notes: ("Skipi Broker " + $version),
    platforms: (
      .platforms
      | with_entries(.value.url = ($base + "/" + (.value.url | split("?")[0] | split("/")[-1])))
    )
  }
' latest.json > latest.rf.json

cd /home/linux/Developer/skipi-public
bash scripts/publish-rf-mirror.sh \
  --dry-run \
  --staging "$STAGE" \
  --manifest-local latest.rf.json \
  --manifest-url https://api-ru.skipi.app/broker/latest.json \
  --expect-version "$VERSION"
```

## Crewing

Crewing uses the same pattern with the private GitHub release as source.

```bash
cd /home/linux/Developer/skipi-public
VERSION=0.4.128
REPO=CaptTymur/skipi-crewing
APP=crewing
STAGE=/tmp/skipi-rf-${APP}-${VERSION}
BASE=https://api-ru.skipi.app/downloads/${APP}/${VERSION}

rm -rf "$STAGE" && mkdir -p "$STAGE" && cd "$STAGE"
gh release download "v${VERSION}" -R "$REPO" -p latest.json --clobber
jq -r '.platforms | to_entries[] | .value.url | split("?")[0] | split("/")[-1]' latest.json |
  sort -u |
  while read -r asset; do
    gh release download "v${VERSION}" -R "$REPO" -p "$asset" --clobber
    gh release download "v${VERSION}" -R "$REPO" -p "$asset.sig" --clobber || true
  done
jq --arg version "$VERSION" --arg base "$BASE" '
  {
    version: $version,
    pub_date: .pub_date,
    notes: ("Skipi Crewing " + $version),
    platforms: (
      .platforms
      | with_entries(.value.url = ($base + "/" + (.value.url | split("?")[0] | split("/")[-1])))
    )
  }
' latest.json > latest.rf.json

cd /home/linux/Developer/skipi-public
bash scripts/publish-rf-mirror.sh \
  --dry-run \
  --staging "$STAGE" \
  --manifest-local latest.rf.json \
  --manifest-url https://api-ru.skipi.app/crewing/latest.json \
  --expect-version "$VERSION"
```

## Future On Board

On Board is not publicly released yet. Do not create `/onboard/latest.json`
until the release manager has approved the repo/remote, signing key, app
version, release source, and downloads-page block.

When that exists, the expected paths are:

```bash
VERSION=0.1.0
APP=onboard
STAGE=/tmp/skipi-rf-${APP}-${VERSION}
BASE=https://api-ru.skipi.app/downloads/${APP}/${VERSION}

bash scripts/publish-rf-mirror.sh \
  --dry-run \
  --staging "$STAGE" \
  --manifest-local latest.rf.json \
  --manifest-url https://api-ru.skipi.app/onboard/latest.json \
  --expect-version "$VERSION"
```

## Verification after PASS

```bash
curl -fsSL https://api-ru.skipi.app/<app>/latest.json | jq .
curl -fsSL https://api-ru.skipi.app/<app>/latest.json |
  jq -r '.platforms | to_entries[] | .value.url' |
  sort -u |
  while read -r url; do
    curl -sSI "$url" | awk '/^HTTP|[Cc]ontent-[Ll]ength|[Aa]ccept-[Rr]anges/'
    curl -fsSL -r 0-15 "$url" | od -An -tx1 -N16 -v
  done
```

Use these concrete manifest URLs:

- Seafarer: `https://api-ru.skipi.app/seafarer/latest.json`
- Broker: `https://api-ru.skipi.app/broker/latest.json`
- Crewing: `https://api-ru.skipi.app/crewing/latest.json`
- On Board, future only: `https://api-ru.skipi.app/onboard/latest.json`

## Failure modes

- Missing local asset: no SFTP is opened; fix staging and rerun.
- Asset upload failure: live `latest.json` is still old; rerun after network/SFTP recovery.
- Public asset verification failure: live `latest.json` is still old; overwrite the bad staged remote asset by rerunning the publish command.
- Manifest temp upload failure: live `latest.json` is still old; rerun after SFTP recovery.
- Rename succeeds but live verify fails: do not update downloads page. Treat mirror as failed and restore the previous manifest.
- Empty or mismatched signatures: stop and rebuild staging from the GitHub release manifest. Do not edit signatures by hand.

## Rollback

Before a real publish, capture the currently live manifest:

```bash
curl -fsSL https://api-ru.skipi.app/<app>/latest.json > /tmp/<app>-latest.prev.json
```

If rollback is needed after a manifest flip, re-publish the previous manifest
only after confirming every URL in `/tmp/<app>-latest.prev.json` is reachable.
Rollback is a live manifest change and needs manager GO. Do not delete the
newer assets; leaving them inert is safer than deleting files during incident
response.

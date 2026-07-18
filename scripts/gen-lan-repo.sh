#!/usr/bin/env bash
# Generate a Logos Basecamp package repository under dist/lan from every .lgx
# there, so Basecamp installs KYM over the LAN instead of GitHub.
#
# Add this URL in Basecamp -> Settings -> Package Repositories:
#     https://<host>:8443/logos-repo.json
#
# TWO GOTCHAS Perun paid for (kept here):
#  1. The repo URL MUST be https:// — logos-package-downloader hard-rejects
#     any other scheme ("https required in v1"); v1 is the registry feature
#     version, not index.json's schemaVersion. Hence the self-signed cert.
#  2. The URL points at logos-repo.json (the catalog identity card, carrying
#     indexUrl -> index.json), NOT index.json directly.
set -euo pipefail
LAN_DIR="${LAN_DIR:-$(cd "$(dirname "$0")/.."; pwd)/dist/lan}"
PORT="${PORT:-8443}"
HOST="${1:-$(hostname -I | awk '{print $1}')}"
BASE="https://${HOST}:${PORT}"
mkdir -p "$LAN_DIR"
cd "$LAN_DIR"

# logos-repo.json (catalog) points at the LAN index.json.
cat > logos-repo.json <<JSON
{
  "schemaVersion": 1,
  "name": "kym-lan",
  "displayName": "KYM (LAN)",
  "description": "KYM budget module served on the local network.",
  "homepage": "https://github.com/vpavlin/kym",
  "indexUrl": "${BASE}/index.json",
  "trustedSigners": []
}
JSON

python3 - "$BASE" <<'PY' > index.json
import glob, hashlib, json, subprocess, sys, datetime
base = sys.argv[1]
packages = []
for lgx in sorted(glob.glob("*.lgx")):
    try:
        manifest = json.loads(subprocess.check_output(["tar", "xzOf", lgx, "manifest.json"]))
    except Exception as e:
        print(f"skip {lgx}: {e}", file=sys.stderr); continue
    data = open(lgx, "rb").read()
    name, ver = manifest["name"], manifest.get("version", "0.0.0")
    packages.append({
        "name": name,
        "versions": [{
            "releasedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "publisherRef": f"{name}-v{ver}",
            "url": f"{base}/{lgx}",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rootHash": manifest["hashes"]["root"],
            "manifest": manifest,
        }],
    })
json.dump({
    "schemaVersion": 2,
    "repositoryName": "kym-lan",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "packages": packages,
}, sys.stdout, indent=2)
print()
PY
echo "LAN Basecamp repo ready: ${BASE}/logos-repo.json  ($(ls *.lgx 2>/dev/null | wc -l) package(s))" >&2
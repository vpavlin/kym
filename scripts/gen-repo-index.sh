#!/usr/bin/env bash
# Regenerate repo/index.json from the portable KYM .lgx for a given tag.
# Run after building/releasing a new module version:
#     scripts/gen-repo-index.sh module-v0.1.0
#
# The index carries the .lgx's size + sha256 + rootHash, so it MUST be
# regenerated whenever the .lgx changes — a stale index means Basecamp downloads
# bytes that don't match the hash and silently refuses to install.
set -euo pipefail
TAG="${1:?usage: gen-repo-index.sh <module-vX.Y.Z>}"
cd "$(dirname "$0")/.."

echo "building ./module#lgx-portable …" >&2
nix build ./module#lgx-portable -o /tmp/kym-lgx-out >/dev/null
LGX=$(echo /tmp/kym-lgx-out/*.lgx)
LGX_BASE=$(basename "$LGX" .lgx)   # e.g. logos-kym-module  (CI publishes <base>-linux-amd64.lgx)

SIZE=$(stat -c%s "$LGX")
SHA=$(sha256sum "$LGX" | cut -d' ' -f1)
MANIFEST=$(tar xzOf "$LGX" manifest.json)

TAG="$TAG" SIZE="$SIZE" SHA="$SHA" MANIFEST="$MANIFEST" LGX_BASE="$LGX_BASE" \
python3 - > repo/index.json <<'PY'
import os, json, datetime
m = json.loads(os.environ["MANIFEST"])
tag = os.environ["TAG"]
name = m["name"]
base = os.environ["LGX_BASE"]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
idx = {
    "schemaVersion": 2,
    "repositoryName": "kym",
    "generatedAt": now,
    "packages": [{
        "name": name,
        "versions": [{
            "releasedAt": now,
            "publisherRef": f"{name}-{tag}",
            # Matches the CI "arch-suffixed" upload: <base>-linux-amd64.lgx
            "url": f"https://github.com/vpavlin/kym/releases/download/{tag}/{base}-linux-amd64.lgx",
            "size": int(os.environ["SIZE"]),
            "sha256": os.environ["SHA"],
            "rootHash": m["hashes"]["root"],
            "manifest": m,
        }],
    }],
}
print(json.dumps(idx, indent=2))
PY
echo "wrote repo/index.json for ${TAG}" >&2
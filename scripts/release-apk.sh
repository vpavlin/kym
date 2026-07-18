#!/usr/bin/env bash
# Cut a GitHub release for the mobile app and attach the locally-built,
# locally-signed APK. Tag scheme: mobile-v<version> (independent of the module's
# module-v* tag). CI never signs — the key lives only on this machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.."; pwd)"
cd "$ROOT"

VERSION=$(python3 -c "import json;print(json.load(open('mobile/app.json'))['expo']['version'])")
TAG="mobile-v${VERSION}"
APK="dist/lan/kym-arm64.apk"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release $TAG already exists — bump mobile/app.json version first" >&2; exit 1
fi

echo "building signed APK for $VERSION …" >&2
bash scripts/build-apk.sh >/dev/null 2>&1 || { echo "APK build failed — run scripts/build-apk.sh to see why" >&2; exit 1; }

AAPT=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/aapt2 2>/dev/null | tail -1)
if [ -n "$AAPT" ]; then
  BUILT=$("$AAPT" dump badging "$APK" 2>/dev/null | grep -oP "versionName='\K[^']+")
  [ "$BUILT" = "$VERSION" ] || { echo "APK versionName $BUILT != $VERSION" >&2; exit 1; }
fi

gh release create "$TAG" "$APK#KYM ${VERSION} (arm64 APK)" \
  --title "KYM mobile ${VERSION}" \
  --notes "Android app, arm64. Signed with the KYM release key.

Install via the KYM F-Droid repo, or download the APK directly.
sha256: $(sha256sum "$APK" | cut -d' ' -f1)"
echo "done: https://github.com/vpavlin/kym/releases/tag/${TAG}" >&2

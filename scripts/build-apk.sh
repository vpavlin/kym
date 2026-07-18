#!/usr/bin/env bash
# Build the arm64 release APK, drop it at dist/lan/kym-arm64.apk, and publish it
# to the self-hosted F-Droid repo. Version comes from mobile/app.json
# (expo.version + android.versionCode) — bump those, not build.gradle.
#
# Signed with the KYM release key IF ~/.gradle/gradle.properties has
# KYM_STORE_FILE=… (see mobile/plugins/withReleaseSigning.js); otherwise it
# falls back to the debug key (fine for local testing, NOT for the repo).
set -uo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.."; pwd)"

# Regenerate the native project from app.json — NOT optional: android/ is
# generated (untracked) and carries its own versionCode/versionName, and this
# re-applies the config plugins (withReleaseSigning).
cd "$ROOT/mobile" || exit 3
echo "=== prebuild start $(date '+%H:%M:%S') ==="
npx expo prebuild --platform android || exit 3

cd "$ROOT/mobile/android" || exit 3
want_vc=$(python3 -c "import json;print(json.load(open('../app.json'))['expo']['android']['versionCode'])")
got_vc=$(grep -oP 'versionCode\s+\K\d+' app/build.gradle | head -1)
[ "$want_vc" = "$got_vc" ] || { echo "VERSION MISMATCH: app.json=$want_vc build.gradle=$got_vc"; exit 4; }

echo "=== assembleRelease start $(date '+%H:%M:%S') ==="
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
rc=$?
echo "=== assembleRelease rc=$rc $(date '+%H:%M:%S') ==="
[ $rc -eq 0 ] || { echo "BUILD_APK_DONE"; exit $rc; }

mkdir -p "$ROOT/dist/lan"
cp "$ROOT/mobile/android/app/build/outputs/apk/release/app-release.apk" "$ROOT/dist/lan/kym-arm64.apk"
ls -l "$ROOT/dist/lan/kym-arm64.apk"; echo "APK_COPIED"

bash "$ROOT/scripts/fdroid-publish.sh" && echo "FDROID_PUBLISHED"
echo "BUILD_APK_DONE"

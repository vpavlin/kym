#!/usr/bin/env bash
# Publish the current release APK to the self-hosted KYM F-Droid repo and rebuild
# the signed index. Run after each APK build (dist/lan/kym-arm64.apk must be fresh).
#
# The repo home (config.yml + signing keystore) lives OUTSIDE the served tree at
# $KYM_FDROID_HOME (default ~/kym-fdroid); serve-lan.sh symlinks it into dist/lan.
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
BT=$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
export PATH="$JAVA_HOME/bin:${BT}:$ANDROID_HOME/platform-tools:$PATH"
ROOT="$(cd "$(dirname "$0")/.."; pwd)"

# The SERVED repo (what the phone's F-Droid actually fetches) is ~/fdroid, reached
# via ~/vpavlin-home/fdroid -> ~/fdroid (vpavlin-home/serve.py). It carries the
# metadata/ (co.logos.kym.yml) that `fdroid update` needs to index the APK, and the
# repo fingerprint the phone already trusts. ~/kym-fdroid is a stale second repo with
# EMPTY metadata — publishing there silently produced an empty index. Default here.
FDROID_HOME="${KYM_FDROID_HOME:-$HOME/fdroid}"
FDROID="${FDROID_BIN:-$HOME/fdroid-venv/bin/fdroid}"
APK="$ROOT/dist/lan/kym-arm64.apk"

[ -f "$APK" ] || { echo "no APK at $APK — run scripts/build-apk.sh"; exit 1; }
[ -d "$FDROID_HOME/repo" ] || { echo "F-Droid repo not initialized at $FDROID_HOME — run: scripts/init-fdroid.sh"; exit 1; }

cd "$FDROID_HOME"
cp -f "$APK" repo/kym-arm64.apk
"$FDROID" update --pretty < /dev/null
echo "published $("${BT}aapt2" dump badging "$APK" 2>/dev/null | grep -oE "versionName='[^']+'") to the KYM F-Droid repo"

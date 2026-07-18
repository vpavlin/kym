#!/usr/bin/env bash
# One-time: initialize the self-hosted KYM F-Droid repo home at $KYM_FDROID_HOME
# (default ~/kym-fdroid). Creates config.yml + a fresh repo signing keystore +
# repo/ dir. The keystore/passwords stay here (outside the git repo) — losing the
# F-Droid repo key just means clients must re-add the repo, but keep it anyway.
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"
FDROID_HOME="${KYM_FDROID_HOME:-$HOME/kym-fdroid}"
FDROID="${FDROID_BIN:-$HOME/fdroid-venv/bin/fdroid}"

mkdir -p "$FDROID_HOME"
cd "$FDROID_HOME"
if [ -f config.yml ]; then echo "already initialized: $FDROID_HOME"; exit 0; fi

"$FDROID" init --repo-name "KYM" \
  --repo-description "KYM — Know Your Money. Android capture app (arm64)." 2>/dev/null || "$FDROID" init
# Make the repo describe itself nicely if init didn't take the flags.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("config.yml"); s = p.read_text()
def setkv(s, k, v):
    if re.search(rf'(?m)^{k}:', s): return re.sub(rf'(?m)^{k}:.*$', f'{k}: {v}', s)
    return s + f'\n{k}: {v}\n'
s = setkv(s, "repo_name", '"KYM"')
s = setkv(s, "repo_description", '"KYM — Know Your Money. Android capture app (arm64)."')
p.write_text(s)
PY
echo "initialized KYM F-Droid repo at $FDROID_HOME"
[ -f fingerprint ] && cat fingerprint || true

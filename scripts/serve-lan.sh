#!/usr/bin/env bash
# One HTTPS host on the LAN serving BOTH artifact repos:
#   - Basecamp package repo:  https://<host>:8443/logos-repo.json
#   - F-Droid repo:           https://<host>:8443/fdroid/repo   (if built)
#
# Builds the portable .lgx, drops it in dist/lan, (re)generates the Basecamp
# index, symlinks the F-Droid repo in, makes a self-signed cert, and serves.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LAN_DIR="$ROOT/dist/lan"
PORT="${PORT:-8444}"  # 8443 is Perun's LAN server; KYM uses 8444
HOST="${HOST:-$(hostname -I | awk '{print $1}')}"
FDROID_HOME="${KYM_FDROID_HOME:-$HOME/kym-fdroid}"
mkdir -p "$LAN_DIR"

echo "building portable .lgx …" >&2
nix build ./module#lgx-portable -o /tmp/kym-lgx-out >/dev/null
install -m644 /tmp/kym-lgx-out/*.lgx "$LAN_DIR/"

# self-signed cert for this host (Basecamp requires https)
CERT="$LAN_DIR/lan-cert.pem" KEY="$LAN_DIR/lan-key.pem"
if [ ! -f "$LAN_DIR/lan-cert.pem" ]; then
  # NB: must be a LEAF/server cert, not a CA cert. `openssl req -x509` defaults to
  # basicConstraints=CA:TRUE on OpenSSL 3, and Basecamp/Qt rejects a CA cert used
  # to terminate TLS ("fetch failed"). Force CA:FALSE + serverAuth (like Perun's).
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$LAN_DIR/lan-key.pem" -out "$LAN_DIR/lan-cert.pem" \
    -subj "/O=vpavlin LAN/CN=${HOST}" \
    -addext "subjectAltName=IP:${HOST},DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  echo "generated self-signed cert for ${HOST}" >&2
fi

PORT="$PORT" bash "$ROOT/scripts/gen-lan-repo.sh" "$HOST"

# expose the F-Droid repo if it has been built
if [ -d "$FDROID_HOME/repo" ]; then
  ln -sfn "$FDROID_HOME" "$LAN_DIR/fdroid"
  echo "F-Droid repo: https://${HOST}:${PORT}/fdroid/repo" >&2
else
  echo "F-Droid repo not built yet ($FDROID_HOME/repo missing) — run scripts/build-apk.sh" >&2
fi

echo "serving $LAN_DIR at https://${HOST}:${PORT}/ (Ctrl-C to stop)" >&2
exec python3 - "$LAN_DIR" "$HOST" "$PORT" <<'PY'
import http.server, ssl, sys, os, functools
directory, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.chdir(directory)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(os.path.join(directory, "lan-cert.pem"), os.path.join(directory, "lan-key.pem"))
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f"listening on https://{host}:{port}/")
httpd.serve_forever()
PY
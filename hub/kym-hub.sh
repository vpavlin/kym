#!/usr/bin/env bash
# Reliable KYM headless-hub launcher.
#
# Starts the logoscore daemon with the KYM modules and a Delivery config that PINS
# the logos.dev fleet entry nodes, then loads kym_core (which pulls delivery_module
# via its manifest dependency).
#
# Why the pinned entry nodes matter: the hub used to start from just
# {"mode":"Core","preset":"logos.dev"} — which gave it ZERO bootstrap nodes
# ("creating kademlia discovery as seed node (no bootstrap nodes)"). It relied purely
# on discovery, drifted off the fleet, and ended up logging "No peers for topic" /
# "NoPeersToPublish" on /waku/2/rs/2/7 — so nothing synced. Pinning entryNodes (the
# same fleet the mobile app dials) keeps it connected. Pair this with the systemd
# unit (kym-hub.service) for auto-restart on crash / reboot.
#
# Everything is overridable via env so this is not tied to one machine:
#   LOGOSCORE          path to the logoscore binary
#   KYM_MODULES_DIR    module search dir (contains kym_core + delivery_module)
#   KYM_CORE_DATA      kym_core persistence dir (the durable budget logs)
#   KYM_DEVICE_ID      author id stamped by the hub
#   KYM_DELIVERY_CFG   full Delivery config JSON (default pins the fleet below)
set -euo pipefail

LOGOSCORE="${LOGOSCORE:-$HOME/logoscore-new/result/bin/logoscore}"
KYM_MODULES_DIR="${KYM_MODULES_DIR:-$HOME/kym-hub/lmods-new2}"
export KYM_CORE_DATA="${KYM_CORE_DATA:-$HOME/.kym-core}"
export KYM_DEVICE_ID="${KYM_DEVICE_ID:-claude-hub}"
# KYM_HUB=1 arms kym_core's headless self-drive tick (a QTimer on the host event
# loop). Without it there is no view polling snapshot(), so delivery never starts
# and nothing syncs. This is what makes the module behave as an always-on hub.
export KYM_HUB="${KYM_HUB:-1}"
export QT_QPA_PLATFORM=offscreen
export EMIT_FROM_THREAD=1

# Delivery config with the logos.dev fleet entry nodes pinned. Override the whole
# JSON via KYM_DELIVERY_CFG to point at a different fleet / tweak protocols.
export KYM_DELIVERY_CFG="${KYM_DELIVERY_CFG:-$(cat <<'JSON'
{"logLevel":"INFO","mode":"Core","preset":"logos.dev","relay":true,"entryNodes":["/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby","/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH","/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397","/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH","/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP","/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE"]}
JSON
)}"

log() { echo "[kym-hub $(date -u +%H:%M:%SZ)] $*"; }

if [[ ! -x "$LOGOSCORE" ]]; then
  log "ERROR: logoscore not found/executable at: $LOGOSCORE (set LOGOSCORE=...)"; exit 1
fi
if [[ ! -d "$KYM_MODULES_DIR" ]]; then
  log "ERROR: modules dir not found: $KYM_MODULES_DIR (set KYM_MODULES_DIR=...)"; exit 1
fi

# Tear down any stale daemon so `-D` doesn't fail on "already running".
"$LOGOSCORE" stop >/dev/null 2>&1 || true
sleep 1

log "starting logoscore daemon (modules: $KYM_MODULES_DIR, data: $KYM_CORE_DATA)"
"$LOGOSCORE" -D -m "$KYM_MODULES_DIR" &
DAEMON_PID=$!

# Ensure the daemon is stopped when this script exits (systemd sends SIGTERM here).
cleanup() { log "stopping daemon"; "$LOGOSCORE" stop >/dev/null 2>&1 || kill "$DAEMON_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for the daemon to accept RPC (or bail if it died on startup).
for _ in $(seq 1 60); do
  if "$LOGOSCORE" status >/dev/null 2>&1; then break; fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then log "daemon exited during startup"; wait "$DAEMON_PID"; exit 1; fi
  sleep 1
done
log "daemon up; loading kym_core"

# Idempotent: if the daemon already auto-loaded modules from -m, this is a harmless
# no-op we ignore. kym_core's manifest dependency pulls in delivery_module.
"$LOGOSCORE" load-module kym_core || log "load-module kym_core returned nonzero (likely already loaded)"

log "hub running — kym_core loaded, delivery pinned to the logos.dev fleet."
"$LOGOSCORE" status || true

# Stay in the foreground for the daemon's lifetime so systemd tracks liveness and
# restarts us if it dies.
wait "$DAEMON_PID"

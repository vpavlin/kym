# KYM headless hub

The always-on peer for a KYM household: a `logoscore` daemon running `kym_core`
(+ `delivery_module`), pinned to the logos.dev fleet so it stays reachable on the
budget's shard and serves history to phones/desktops that come and go.

## Why this exists

Started naively (`{"mode":"Core","preset":"logos.dev"}`) the daemon gets **zero**
bootstrap nodes, relies purely on discovery, and drifts off the fleet — you see
`No peers for topic` / `NoPeersToPublish` on `/waku/2/rs/2/7` and nothing syncs.
`kym-hub.sh` fixes that by pinning the fleet `entryNodes` and setting `KYM_HUB=1`
(which arms `kym_core`'s headless self-drive tick — without it delivery never
starts).

## Run it (systemd --user, auto-restart)

```sh
# 1. Install the unit (edit ExecStart path if you cloned elsewhere than ~/kym)
cp hub/kym-hub.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 2. Survive logout / reboot, then enable + start
loginctl enable-linger "$USER"
systemctl --user enable --now kym-hub.service

# 3. Watch it
systemctl --user status kym-hub.service
journalctl --user -u kym-hub.service -f
```

`Restart=always` brings it back on crash; `enable-linger` keeps it running without
an active login.

## Run it by hand

```sh
./hub/kym-hub.sh          # foreground; Ctrl-C stops the daemon
```

## Configuration (all env-overridable)

| Var                | Default                               | Purpose                                   |
|--------------------|---------------------------------------|-------------------------------------------|
| `LOGOSCORE`        | `~/logoscore-new/result/bin/logoscore`| logoscore binary                          |
| `KYM_MODULES_DIR`  | `~/kym-hub/lmods-new2`                | module dir (`kym_core` + `delivery_module`)|
| `KYM_CORE_DATA`    | `~/.kym-core`                         | durable budget logs                       |
| `KYM_DEVICE_ID`    | `claude-hub`                          | author id stamped by the hub              |
| `KYM_DELIVERY_CFG` | pinned logos.dev fleet (see script)   | full Delivery config JSON                 |

## Health check

```sh
"$LOGOSCORE" status        # daemon + module list
```
A healthy hub logs `calculateConnectionState relayCount>0 ...` and
`Subscribe completed for topic: /kym/1/<hex>/proto with success`, with **no**
`No peers for topic` on the budget shard.

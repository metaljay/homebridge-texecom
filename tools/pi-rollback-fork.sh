#!/bin/bash
# Undo tools/pi-switch-to-fork.sh: restore the backed-up plugin and
# config.json (inside the container, as the files belong to root), then
# restart the homebridge container.
#
#   tools/pi-rollback-fork.sh [ssh-host]
set -euo pipefail
HOST=${1:-pi@192.168.2.254}

ssh "$HOST" "docker exec -i homebridge sh -s" <<'REMOTE'
set -eu
HB=/homebridge
PLUGIN=$HB/node_modules/homebridge-texecom-full
BACKUP=$HB/backup-texecom-before-fork
if [ ! -d "$BACKUP/plugin" ]; then echo "No backup at $BACKUP"; exit 1; fi
rm -rf "$PLUGIN"
cp -a "$BACKUP/plugin" "$PLUGIN"
cp -a "$BACKUP/config.json" "$HB/config.json"
mv "$BACKUP" "$BACKUP-restored-$(date +%Y%m%d-%H%M%S)"
echo "Restored the previous plugin and config.json"
REMOTE
ssh "$HOST" "docker restart homebridge >/dev/null && echo restarted"

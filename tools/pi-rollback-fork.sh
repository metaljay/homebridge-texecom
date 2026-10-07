#!/bin/bash
# Undo tools/pi-switch-to-fork.sh: restore the backed-up plugin, config.json
# and package.json (pinned to the backed-up plugin's exact version, so the
# image's start-up npm install keeps it), then restart the container.
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
cp -a "$BACKUP/package.json" "$HB/package.json"
node -e '
const fs = require("fs");
const version = require("/homebridge/backup-texecom-before-fork/plugin/package.json").version;
const pkg = JSON.parse(fs.readFileSync("/homebridge/package.json", "utf8"));
pkg.dependencies["homebridge-texecom-full"] = version;
fs.writeFileSync("/homebridge/package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("Pinned homebridge-texecom-full to " + version);
'
mv "$BACKUP" "$BACKUP-restored-$(date +%Y%m%d-%H%M%S)"
echo "Restored the previous plugin, config.json and package.json"
REMOTE
ssh "$HOST" "docker restart homebridge >/dev/null && echo restarted"

#!/bin/bash
# Switch a Docker Homebridge (on a Pi, over SSH) from the published plugin to
# this checkout of homebridge-texecom-full, keeping a backup for rollback.
#
#   tools/pi-switch-to-fork.sh [ssh-host] [night-part-arm]
#
# Backs up the installed plugin and config.json, installs lib/, index.js,
# package.json, config.schema.json, README.md and LICENSE from this checkout
# (reusing the installed node_modules), sets "night_part_arm" and turns the
# plugin's debug logging off, then restarts the homebridge container.
# The storage files belong to root, so the changes run inside the container
# (storage mounted at /homebridge). Undo with tools/pi-rollback-fork.sh.
# HomeKit sees the fork's accessories as new ones, so automations using the
# alarm need setting up again.
set -euo pipefail
HOST=${1:-pi@192.168.2.254}
NIGHT=${2:-1}
cd "$(dirname "$0")/.."

echo "Copying the fork to the Pi..."
ssh "$HOST" "rm -rf /home/pi/homebridge/texecom-fork-staging && mkdir /home/pi/homebridge/texecom-fork-staging"
tar czf - lib index.js package.json config.schema.json README.md LICENSE |
  ssh "$HOST" "tar xzf - -C /home/pi/homebridge/texecom-fork-staging"

ssh "$HOST" "docker exec -i homebridge sh -s" <<REMOTE
set -eu
HB=/homebridge
PLUGIN=\$HB/node_modules/homebridge-texecom-full
BACKUP=\$HB/backup-texecom-before-fork
if [ -e "\$BACKUP" ]; then echo "\$BACKUP already exists: roll back first or remove it."; exit 1; fi
mkdir -p "\$BACKUP"
cp -a "\$PLUGIN" "\$BACKUP/plugin"
cp -a "\$HB/config.json" "\$BACKUP/config.json"
rm -rf "\$PLUGIN.new"
mkdir "\$PLUGIN.new"
cp -a "\$HB/texecom-fork-staging/." "\$PLUGIN.new/"
cp -a "\$PLUGIN/node_modules" "\$PLUGIN.new/node_modules"
rm -rf "\$PLUGIN"
mv "\$PLUGIN.new" "\$PLUGIN"
rm -rf "\$HB/texecom-fork-staging"
node -e '
const fs = require("fs");
const path = "/homebridge/config.json";
const c = JSON.parse(fs.readFileSync(path, "utf8"));
for (const p of c.platforms) {
  if (p.platform === "Texecom") { p.night_part_arm = $NIGHT; p.debug = false; }
}
fs.writeFileSync(path, JSON.stringify(c, null, 4));
'
echo "Installed \$(node -p 'require("/homebridge/node_modules/homebridge-texecom-full/package.json").version'); backup in \$BACKUP"
REMOTE

echo "Restarting Homebridge..."
ssh "$HOST" "docker restart homebridge >/dev/null && echo restarted"

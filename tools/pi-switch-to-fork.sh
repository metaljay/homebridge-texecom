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
# Undo with tools/pi-rollback-fork.sh. HomeKit sees the fork's accessories
# as new ones, so automations using the alarm need setting up again.
set -euo pipefail
HOST=${1:-pi@192.168.2.254}
NIGHT=${2:-1}
HB=/home/pi/homebridge
PLUGIN=$HB/node_modules/homebridge-texecom-full
BACKUP=$HB/backup-texecom-before-fork
cd "$(dirname "$0")/.."

ssh "$HOST" "test ! -e $BACKUP" || { echo "$BACKUP already exists on the Pi: roll back first or remove it."; exit 1; }
echo "Copying the fork to the Pi..."
ssh "$HOST" "rm -rf /tmp/texecom-fork && mkdir -p /tmp/texecom-fork"
tar czf - lib index.js package.json config.schema.json README.md LICENSE | ssh "$HOST" "tar xzf - -C /tmp/texecom-fork"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
mkdir -p $BACKUP
cp -a $PLUGIN $BACKUP/plugin
cp -a $HB/config.json $BACKUP/config.json
rm -rf $PLUGIN.new && mkdir $PLUGIN.new
cp -a /tmp/texecom-fork/. $PLUGIN.new/
cp -a $PLUGIN/node_modules $PLUGIN.new/node_modules
rm -rf $PLUGIN && mv $PLUGIN.new $PLUGIN
python3 - <<PY
import json
path = "$HB/config.json"
c = json.load(open(path))
for p in c["platforms"]:
    if p.get("platform") == "Texecom":
        p["night_part_arm"] = $NIGHT
        p["debug"] = False
json.dump(c, open(path, "w"), indent=4)
PY
echo "Installed: \$(python3 -c 'import json;print(json.load(open("$PLUGIN/package.json"))["version"])'); backup in $BACKUP"
REMOTE

echo "Restarting Homebridge..."
ssh "$HOST" "docker restart homebridge >/dev/null && echo restarted"

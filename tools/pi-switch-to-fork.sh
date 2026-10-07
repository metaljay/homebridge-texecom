#!/bin/bash
# Switch a Docker Homebridge (on a Pi, over SSH) from the published plugin to
# this checkout of homebridge-texecom-full, keeping a backup for rollback.
#
#   tools/pi-switch-to-fork.sh [ssh-host] [night-part-arm]
#
# The homebridge Docker image reinstalls plugins from /homebridge/package.json
# on every start, so the fork is copied to /homebridge/texecom-fork and the
# dependency is pointed at it ("file:texecom-fork"). Also sets
# "night_part_arm" and turns the plugin's debug logging off, then restarts the
# container. The storage files belong to root, so the changes run inside the
# container (storage mounted at /homebridge). Undo with
# tools/pi-rollback-fork.sh. HomeKit sees the fork's accessories as new ones,
# so automations using the alarm need setting up again.
set -euo pipefail
HOST=${1:-pi@192.168.2.254}
NIGHT=${2:-1}
cd "$(dirname "$0")/.."

echo "Copying the fork to the Pi..."
ssh "$HOST" "rm -rf /home/pi/homebridge/texecom-fork-staging && mkdir /home/pi/homebridge/texecom-fork-staging"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - lib index.js package.json config.schema.json README.md LICENSE |
  ssh "$HOST" "tar xzf - -C /home/pi/homebridge/texecom-fork-staging 2>/dev/null"

ssh "$HOST" "docker exec -i homebridge sh -s" <<REMOTE
set -eu
HB=/homebridge
BACKUP=\$HB/backup-texecom-before-fork
mkdir -p "\$BACKUP"
[ -e "\$BACKUP/plugin" ] || cp -a "\$HB/node_modules/homebridge-texecom-full" "\$BACKUP/plugin"
[ -e "\$BACKUP/config.json" ] || cp -a "\$HB/config.json" "\$BACKUP/config.json"
[ -e "\$BACKUP/package.json" ] || cp -a "\$HB/package.json" "\$BACKUP/package.json"
rm -rf "\$HB/texecom-fork"
mv "\$HB/texecom-fork-staging" "\$HB/texecom-fork"
node -e '
const fs = require("fs");
const cfgPath = "/homebridge/config.json";
const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
for (const p of c.platforms) {
  if (p.platform === "Texecom") { p.night_part_arm = $NIGHT; p.debug = false; }
}
fs.writeFileSync(cfgPath, JSON.stringify(c, null, 4));
const pkgPath = "/homebridge/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies["homebridge-texecom-full"] = "file:texecom-fork";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
'
rm -rf "\$HB/node_modules/homebridge-texecom-full"
echo "Fork staged in \$HB/texecom-fork; backup in \$BACKUP"
REMOTE

echo "Restarting Homebridge (it links the fork on start)..."
ssh "$HOST" "docker restart homebridge >/dev/null && echo restarted"

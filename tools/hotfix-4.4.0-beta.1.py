#!/usr/bin/env python3
"""
Temporary hotfix for homebridge-texecom-full 4.4.0-beta.1 (COM-IP installs).

  sudo python3 hotfix-4.4.0-beta.1.py /path/to/homebridge-storage

What it does (backups are written first, into <storage>/backup-texecom-hotfix/):
  1. index.js: split the TCP stream into lines, so a second message in the
     same packet (e.g. a keypad disarm sent with the "user entered code"
     message) is no longer dropped; raise the command timeout from 2 s to 5 s.
  2. config.json: set each Texecom area's "zones" to [] so the plugin stops
     inferring alarms from zone activity (which misfires on every entry via
     the entry route) and relies on the panel's own alarm message instead.

Undo: copy the two files back from the backup folder and restart Homebridge.
Installing any plugin version through the Homebridge UI also replaces index.js.
Restart Homebridge afterwards for the change to take effect.
"""
import json, os, shutil, sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
storage = sys.argv[1]
plugin = os.path.join(storage, "node_modules", "homebridge-texecom-full")
index_js = os.path.join(plugin, "index.js")
config_json = os.path.join(storage, "config.json")

version = json.load(open(os.path.join(plugin, "package.json")))["version"]
if version != "4.4.0-beta.1":
    sys.exit(f"Installed version is {version}; this hotfix is only for 4.4.0-beta.1.")

s = open(index_js).read()
if "[local patch" in s:
    sys.exit("index.js is already patched.")

old_data="""            connection.on('data', function (data) {
                platform.log.debug(`IP data received: ${data}`);
                responseEmitter.emit('raw', data);
                responseEmitter.emit('data', data);
                processData(data);
            });"""
new_data="""            // [local patch 2026-10-06] TCP chunks don't respect message
            // boundaries: a real COM-IP sends e.g. "U0030 + "D0013 in one
            // chunk. Split into lines so no message after the first is lost.
            let pending = '';
            connection.on('data', function (data) {
                platform.log.debug(`IP data received: ${data}`);
                responseEmitter.emit('raw', data);
                pending += data.toString('latin1');
                const lines = pending.split(/\\r?\\n/);
                pending = lines.pop();
                lines.filter(line => line.trim() !== '').forEach(line => {
                    responseEmitter.emit('data', line);
                    processData(line);
                });
            });"""
old_to="""                reject(new Error("Timeout after retries"));
            }
        }, 2000);"""
new_to="""                reject(new Error("Timeout after retries"));
            }
        }, 5000); // [local patch 2026-10-06] real COM-IP took 3 s to answer a login"""

if s.count(old_data) != 1 or s.count(old_to) != 1:
    sys.exit("index.js is not the expected 4.4.0-beta.1 source; nothing changed.")

backup = os.path.join(storage, "backup-texecom-hotfix")
os.makedirs(backup, exist_ok=True)
shutil.copy2(index_js, os.path.join(backup, "index.js"))
shutil.copy2(config_json, os.path.join(backup, "config.json"))
print(f"Backed up index.js and config.json to {backup}")

open(index_js, "w").write(s.replace(old_data, new_data).replace(old_to, new_to))
print("Patched index.js (line splitting, 5 s command timeout)")

config = json.load(open(config_json))
for platform in config.get("platforms", []):
    if platform.get("platform") == "Texecom":
        for area in platform.get("areas", []):
            print(f"Area {area.get('name')!r}: zones {area.get('zones')} -> []")
            area["zones"] = []
with open(config_json, "w") as f:
    json.dump(config, f, indent=4)
    f.write("\n")
print("Updated config.json. Now restart Homebridge.")

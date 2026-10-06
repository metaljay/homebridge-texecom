#!/usr/bin/env python3
"""
Hotfix v2 for homebridge-texecom-full 4.4.0-beta.1 (COM-IP installs).
Apply on top of hotfix v1 (tools/hotfix-4.4.0-beta.1.py).

  sudo python3 hotfix-4.4.0-beta.1-v2.py /path/to/homebridge-storage

Adds:
  1. A Wintex logout (03 48 B4) straight after every arm/disarm command
     sequence. The UDL login switches the panel port into a Wintex session,
     during which the Crestron event feed is held back; logging out ends that
     ~30 s after the logout instead of ~60 s after the last command.
  2. Removal of Wintex binary frames (e.g. the logout ACK 03 06 F6, which
     arrives without a line terminator) from the incoming stream, so they are
     not glued onto the front of the next panel message.

Only IP connections send the logout (the serial path is unchanged).
A backup of index.js is written to <storage>/backup-texecom-hotfix-v2/ first.
Undo: copy index.js back from that folder and restart Homebridge.
Restart Homebridge afterwards for the change to take effect.
"""
import json
import os
import shutil
import sys

V1_MARKER = "[local patch 2026-10-06] TCP chunks"
V2_MARKER = "[local patch v2"

OLD_APPEND = """                pending += data.toString('latin1');"""
NEW_APPEND = """                // [local patch v2 2026-10-06] drop Wintex frames (e.g. logout ACK)
                pending = stripWintexFrames(pending + data.toString('latin1'));"""

OLD_COMMAND = """    writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
        .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command))
        .then(() => {"""
NEW_COMMAND = """    writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
        .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command))
        // [local patch v2 2026-10-06] end the UDL session so the event feed resumes sooner
        .finally(() => wintexLogout(platform))
        .then(() => {"""

HELPERS = """

// ─── [local patch v2 2026-10-06] Wintex session handling ─────────────────────
// After \\W<udl>/ the panel port runs a Wintex session: replies are binary
// frames [len][type]...[checksum] with (sum of all bytes & 0xFF) == 0xFF, and
// the Crestron text feed is held back until the session ends.

// Ends the session (Wintex message 'H'). The panel answers 03 06 F6 (ACK).
function wintexLogout(platform) {
    const connection = platform.texecomConnection;
    if (!platform.ip_address || platform.serial_device || !connection || connection.destroyed) {
        return;
    }
    try {
        connection.write(Buffer.from([0x03, 0x48, 0xB4]));
        platform.log.debug("Sent Wintex logout");
    } catch (e) {
        platform.log.debug(`Wintex logout failed: ${e.message}`);
    }
}

// Removes complete Wintex frames from the start of the buffered text. Panel
// text lines start with a printable character, frames with their length byte.
function stripWintexFrames(text) {
    while (text.length >= 3) {
        const len = text.charCodeAt(0);
        if (len < 3 || len >= 0x20 || text.length < len) {
            break;
        }
        let sum = 0;
        for (let i = 0; i < len; i++) {
            sum += text.charCodeAt(i);
        }
        if ((sum & 0xFF) !== 0xFF) {
            break;
        }
        text = text.slice(len);
    }
    return text;
}
"""


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    storage = sys.argv[1]
    plugin = os.path.join(storage, "node_modules", "homebridge-texecom-full")
    index_js = os.path.join(plugin, "index.js")

    version = json.load(open(os.path.join(plugin, "package.json")))["version"]
    if version != "4.4.0-beta.1":
        sys.exit(f"Installed version is {version}; this hotfix is only for 4.4.0-beta.1.")

    s = open(index_js).read()
    if V2_MARKER in s:
        sys.exit("index.js already has hotfix v2.")
    if V1_MARKER not in s:
        sys.exit("Hotfix v1 is not applied; run hotfix-4.4.0-beta.1.py first.")
    if s.count(OLD_APPEND) != 1 or s.count(OLD_COMMAND) != 1:
        sys.exit("index.js is not the expected v1-patched source; nothing changed.")

    backup = os.path.join(storage, "backup-texecom-hotfix-v2")
    os.makedirs(backup, exist_ok=True)
    shutil.copy2(index_js, os.path.join(backup, "index.js"))
    print(f"Backed up index.js to {backup}")

    s = s.replace(OLD_APPEND, NEW_APPEND).replace(OLD_COMMAND, NEW_COMMAND).rstrip("\n") + "\n" + HELPERS
    open(index_js, "w").write(s)
    print("Patched index.js (Wintex logout after commands, Wintex frame filter). Now restart Homebridge.")


if __name__ == "__main__":
    main()

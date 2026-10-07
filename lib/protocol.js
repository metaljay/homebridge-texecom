'use strict';

/**
 * Pure helpers for the Texecom Crestron (simple) protocol.
 * Kept free of Homebridge/IO dependencies so they can be unit tested.
 */

/** Zone status digits reported in `"Znnns` messages. */
const ZoneStatus = Object.freeze({
  SECURE: '0',
  ACTIVE: '1',
});

/**
 * Parse a single line received from the panel.
 *
 * Known formats (each line starts with a double quote). Formats marked * were
 * confirmed against a real Premier Elite over COM-IP on 2026-10-06:
 *   "Z0071      * zone 007, status 1 (active) / 0 (clear)
 *   "A0013      * area 001 armed by user 3 (user number is variable width)
 *   "D0013      * area 001 disarmed by user 3
 *   "L0010      * area 001 in alarm
 *   "X0010      * area 001 exit delay started
 *   "E0010      * area 001 entry delay started
 *   "U0030      * user 003 entered a code at a keypad
 *   OK          acknowledgement of a command
 *
 * @param {string} rawLine
 *   "NN         * ASTATUS reply: one letter per area (Y armed / N not armed)
 *
 * @returns {{type: 'zone', zone: number, status: string}
 *   | {type: 'astatus', armed: boolean[]}
 *   | {type: 'area', event: 'A'|'D'|'L'|'X'|'E', area: number, user: string}
 *   | {type: 'user', user: number}
 *   | {type: 'ok'}
 *   | {type: 'error'}
 *   | {type: 'unknown', line: string}}
 */
function parseLine(rawLine) {
  const line = String(rawLine).trim();

  // Reply to the ASTATUS query: one letter per area, Y = armed, N = not.
  const astatus = /^"([YN]+)$/.exec(line);
  if (astatus) {
    return { type: 'astatus', armed: [...astatus[1]].map((c) => c === 'Y') };
  }

  if (line === 'OK') {
    return { type: 'ok' };
  }
  if (line === 'ERROR') {
    return { type: 'error' };
  }

  if (line.startsWith('"Z')) {
    const zone = Number.parseInt(line.slice(2, 5), 10);
    const status = line.charAt(5);
    if (Number.isInteger(zone) && status !== '') {
      return { type: 'zone', zone, status };
    }
  }

  // "Saaauu…: event letter, 3-digit area, then the user number. The user
  // number is not fixed width (panels with >99 users send three digits).
  const area = /^"([ADLXE])(\d{3})(\d*)/.exec(line);
  if (area) {
    return { type: 'area', event: area[1], area: Number(area[2]), user: area[3] };
  }

  const user = /^"U(\d{3})/.exec(line);
  if (user) {
    return { type: 'user', user: Number(user[1]) };
  }

  return { type: 'unknown', line };
}

/**
 * After a UDL login (\\W<udl>/) the port runs a Wintex session and replies
 * with binary frames: [len][type]...[checksum], (sum of all bytes) & 0xFF ==
 * 0xFF. They have no line terminator, so remove complete frames from the
 * start of the buffer before splitting lines. Text lines always start with a
 * printable character; frames start with their length byte.
 *
 * @param {string} text latin1
 */
function stripWintexFrames(text, onFrame = () => {}) {
  while (text.length >= 3) {
    const len = text.charCodeAt(0);
    if (len < 3 || len >= 0x20 || text.length < len) {
      break;
    }
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += text.charCodeAt(i);
    }
    if ((sum & 0xff) !== 0xff) {
      break;
    }
    onFrame(Buffer.from(text.slice(0, len), 'latin1'));
    text = text.slice(len);
  }
  return text;
}

/**
 * A binary UDL frame: [length][command][payload…][checksum], where the
 * checksum makes the byte sum 0xFF.
 *
 * @param {number} command
 * @param {number[]} [payload]
 * @returns {Buffer}
 */
function wintexFrame(command, payload = []) {
  const bytes = [payload.length + 3, command, ...payload];
  const sum = bytes.reduce((a, b) => a + b, 0);
  return Buffer.from([...bytes, (0xff - sum) & 0xff]);
}

/** Wintex logout ('H'). Ends the UDL session; the Crestron feed resumes ~30 s later. */
const WINTEX_LOGOUT = wintexFrame(0x48);
const WINTEX_ACK = 0x06;
const WINTEX_NAK = 0x0f;

/**
 * Binary UDL part-arm ('S' <area index> <part arm>), sent inside the session a
 * \\W<udl>/ login opens. Unlike the Crestron \\Y command (always Part Arm 1)
 * it reaches Part Arm 1, 2 or 3. Area 1 is index 0 (ricol99/casa,
 * shuckc/pytexalarm; confirmed on an Elite 24 V6.05.03). Other areas are not
 * verified, so only area 1 is allowed.
 *
 * @param {number} area
 * @param {number} partArm 1-3
 * @returns {Buffer}
 */
function partArmFrame(area, partArm) {
  if (area !== 1 || ![1, 2, 3].includes(partArm)) {
    throw new RangeError(`Part arm ${partArm} of area ${area} is not supported (area 1, part arm 1-3 only)`);
  }
  return wintexFrame(0x53, [area - 1, partArm]);
}

/**
 * Binary UDL equivalent of a Crestron arm/part-arm/disarm letter (A, Y, D)
 * for area 1, or null for other areas. Y maps to Part Arm 1, as \\Y does.
 * Disarm and part arm are confirmed on an Elite 24 V6.05.03; full arm ('A')
 * is from ricol99/casa and shuckc/pytexalarm.
 *
 * @param {string} letter
 * @param {number} area
 * @returns {Buffer|null}
 */
function udlFrameFor(letter, area) {
  if (area !== 1) {
    return null;
  }
  switch (letter) {
    case 'A': return wintexFrame(0x41, [0]);
    case 'D': return wintexFrame(0x44, [0]);
    case 'Y': return partArmFrame(1, 1);
    default: return null;
  }
}

/**
 * Splits a byte stream into lines. TCP (and serial) chunks do not respect
 * message boundaries, so data must be buffered until a newline arrives.
 */
class LineSplitter {
  constructor(onLine, onFrame = () => {}) {
    this.onLine = onLine;
    this.onFrame = onFrame;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer = stripWintexFrames(this.buffer + chunk.toString('latin1'), this.onFrame);
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop();
    for (const part of parts) {
      if (part.trim() !== '') {
        this.onLine(part);
      }
    }
  }

  reset() {
    this.buffer = '';
  }
}

/** Highest area number the single-byte arm/disarm bitmask can address. */
const MAX_COMMAND_AREA = 8;

/**
 * Build the raw bytes for a command, e.g. `\W1234/` or `\A<bitmask>/`.
 * Encoded as latin1 so bitmask bytes >= 0x80 stay a single byte.
 *
 * @param {string} command
 * @returns {Buffer}
 */
function encodeCommand(command) {
  return Buffer.from(`\\${command}/`, 'latin1');
}

/**
 * Area bitmask character used by the arm/part-arm/disarm commands.
 * Area 1 → 0x01, area 2 → 0x02, area 3 → 0x04 … area 8 → 0x80.
 *
 * @param {number} area
 * @returns {string}
 */
function areaBitmask(area) {
  if (!Number.isInteger(area) || area < 1 || area > MAX_COMMAND_AREA) {
    throw new RangeError(`Area ${area} cannot be armed/disarmed (supported: 1-${MAX_COMMAND_AREA})`);
  }
  return String.fromCharCode(1 << (area - 1));
}

module.exports = {
  stripWintexFrames,
  wintexFrame,
  partArmFrame,
  udlFrameFor,
  WINTEX_LOGOUT,
  WINTEX_ACK,
  WINTEX_NAK,
  ZoneStatus,
  MAX_COMMAND_AREA,
  parseLine,
  LineSplitter,
  encodeCommand,
  areaBitmask,
};

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
 * Known formats (each line starts with a double quote):
 *   "Z0071      zone 007, status 1 (active)
 *   "A00117     area 001 armed by user 17
 *   "D00103     area 001 disarmed by user 03
 *   "L001       area 001 in alarm
 *   OK          acknowledgement of a command
 *
 * @param {string} rawLine
 * @returns {{type: 'zone', zone: number, status: string}
 *   | {type: 'area', event: 'A'|'D'|'L', area: number, user: string}
 *   | {type: 'ok'}
 *   | {type: 'error'}
 *   | {type: 'unknown', line: string}}
 */
function parseLine(rawLine) {
  const line = String(rawLine).trim();

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

  const event = line.charAt(1);
  if (line.startsWith('"') && (event === 'A' || event === 'D' || event === 'L')) {
    const area = Number.parseInt(line.slice(2, 5), 10);
    if (Number.isInteger(area)) {
      return { type: 'area', event, area, user: line.slice(5, 7) };
    }
  }

  return { type: 'unknown', line };
}

/**
 * Splits a byte stream into lines. TCP (and serial) chunks do not respect
 * message boundaries, so data must be buffered until a newline arrives.
 */
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk.toString('latin1');
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
  ZoneStatus,
  MAX_COMMAND_AREA,
  parseLine,
  LineSplitter,
  encodeCommand,
  areaBitmask,
};

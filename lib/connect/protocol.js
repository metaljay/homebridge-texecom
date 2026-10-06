'use strict';

/**
 * Texecom Connect protocol: framing, CRC and message decoding.
 *
 * Written for this project from the publicly released, Apache-2.0 licensed
 * Python implementation by Joseph Heenan (github.com/davidMbrooke/
 * texecom-connect), which Texecom approved for release, plus behaviour
 * observed on a real Premier Elite panel. Arm/disarm/reset and the zone
 * state / area flag reads are adapted from texecom2mqtt (MIT, Copyright (c)
 * 2020 Daniel Chesterton). See NOTICE and LICENSE-texecom2mqtt.
 *
 * Frame:  't' | type | length | sequence | body... | crc8
 *   type    'C' command (to panel), 'R' response, 'M' unsolicited message
 *   length  total frame length including header and CRC
 *   crc8    poly 0x85 (x^8+x^7+x^2+1), init 0xFF, not reflected, over all
 *           preceding bytes of the frame
 */

const START = 0x74; // 't'
const TYPE = Object.freeze({ COMMAND: 0x43, RESPONSE: 0x52, MESSAGE: 0x4d }); // 'C' 'R' 'M'

const COMMAND = Object.freeze({
  LOGIN: 1,
  GET_ZONE_STATE: 2,
  GET_ZONE_DETAILS: 3,
  ARM_AREA: 6,
  DISARM_AREA: 8,
  RESET_AREA: 9,
  GET_AREA_FLAGS: 11,
  GET_LCD_DISPLAY: 13,
  GET_LOG_POINTER: 15,
  GET_PANEL_IDENTIFICATION: 22,
  GET_DATE_TIME: 23,
  SET_DATE_TIME: 24,
  GET_SYSTEM_POWER: 25,
  GET_USER: 27,
  GET_AREA_DETAILS: 35,
  SET_EVENT_MESSAGES: 37,
});

const ACK = 0x06;
const NAK = 0x15;

const MESSAGE = Object.freeze({ DEBUG: 0, ZONE: 1, AREA: 2, OUTPUT: 3, USER: 4, LOG: 5 });

const EVENT_FLAG = Object.freeze({ DEBUG: 1, ZONE: 1 << 1, AREA: 1 << 2, OUTPUT: 1 << 3, USER: 1 << 4, LOG: 1 << 5 });

const ARM_TYPE = Object.freeze({ FULL: 0, PART_1: 1, PART_2: 2, PART_3: 3 });

/** Indices into the GET_AREA_FLAGS response (one bitmap of areas per flag). */
const AREA_FLAG = Object.freeze({ ALARM: 0, ARMED: 21, FULL_ARMED: 22, PART_ARMED: 23, FORCE_ARMED: 26, PART_ARM_1: 50, PART_ARM_2: 51, PART_ARM_3: 52 });

const AREA_STATES = ['disarmed', 'in exit', 'in entry', 'armed', 'part armed', 'in alarm'];
const ZONE_STATES = ['secure', 'active', 'tamper', 'short'];

/** Areas per panel size (zones -> areas). */
const AREAS_FOR_ZONES = { 12: 2, 24: 2, 48: 4, 64: 4, 88: 8, 168: 16, 640: 64 };

function crc8(bytes) {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x85) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * @param {number} sequence 0-255
 * @param {number} command
 * @param {Buffer} [body]
 */
function encodeCommand(sequence, command, body = Buffer.alloc(0)) {
  const frame = Buffer.alloc(6 + body.length);
  frame[0] = START;
  frame[1] = TYPE.COMMAND;
  frame[2] = frame.length;
  frame[3] = sequence & 0xff;
  frame[4] = command;
  body.copy(frame, 5);
  frame[frame.length - 1] = crc8(frame.subarray(0, frame.length - 1));
  return frame;
}

/**
 * Turns a byte stream into frames. Emits via callbacks:
 *   onFrame({type, sequence, body})   body excludes header and CRC
 *   onDrop(reason)                    panel dropped the session ("+++")
 *   onError(message)                  bad CRC / garbage skipped
 */
class FrameParser {
  constructor({ onFrame, onDrop = () => {}, onError = () => {} }) {
    this.onFrame = onFrame;
    this.onDrop = onDrop;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length === 0) {
        return;
      }
      if (this.buffer[0] !== START) {
        // The panel signals a forced hang-up (e.g. to send an alarm
        // notification through the module) with a modem-style "+++".
        if (this.buffer.subarray(0, 3).toString('latin1') === '+++') {
          this.buffer = Buffer.alloc(0);
          this.onDrop('panel dropped the connection (+++)');
          return;
        }
        const next = this.buffer.indexOf(START, 1);
        this.onError(`skipping ${next === -1 ? this.buffer.length : next} unexpected byte(s)`);
        this.buffer = next === -1 ? Buffer.alloc(0) : this.buffer.subarray(next);
        continue;
      }
      if (this.buffer.length < 4) {
        return;
      }
      const length = this.buffer[2];
      if (length < 5) {
        this.onError(`invalid frame length ${length}`);
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < length) {
        return;
      }
      const frame = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      if (crc8(frame.subarray(0, length - 1)) !== frame[length - 1]) {
        this.onError(`bad CRC on frame ${frame.toString('hex')}`);
        continue;
      }
      this.onFrame({ type: frame[1], sequence: frame[3], body: Buffer.from(frame.subarray(4, length - 1)) });
    }
  }
}

/** Bytes used for an area bitmap on a panel of this size. */
function areaBytes(panelZones) {
  return Math.ceil((AREAS_FOR_ZONES[panelZones] || 8) / 8);
}

/** Bytes used for a zone number on a panel of this size. */
function zoneNumberBytes(panelZones) {
  return panelZones > 256 ? 2 : 1;
}

/** Area bitmap for one area (1-based), little-endian, `size` bytes. */
function areaBitmap(area, size) {
  const buf = Buffer.alloc(size);
  let bits = 1n << BigInt(area - 1);
  for (let i = 0; i < size; i++) {
    buf[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return buf;
}

function encodeArm(area, armType, panelZones) {
  return Buffer.concat([Buffer.from([armType]), areaBitmap(area, areaBytes(panelZones))]);
}

function encodeDisarmOrReset(area, panelZones) {
  return areaBitmap(area, areaBytes(panelZones));
}

function encodeGetZoneState(startZone, count, panelZones) {
  const size = zoneNumberBytes(panelZones);
  const buf = Buffer.alloc(size + 1);
  buf.writeUIntLE(startZone, 0, size);
  buf[size] = count;
  return buf;
}

/** One byte per zone, same bit layout as a zone event. */
function decodeZoneStateByte(bits) {
  return {
    raw: bits, state: ZONE_STATES[bits & 3],
    fault: Boolean(bits & 4), failedTest: Boolean(bits & 8), alarmed: Boolean(bits & 16),
    manualBypass: Boolean(bits & 32), autoBypass: Boolean(bits & 64), masked: Boolean(bits & 128),
  };
}

/**
 * Works out each area's state from a GET_AREA_FLAGS response that starts at
 * flag 0. Returns {state, partArm} per area number.
 */
function decodeAreaFlags(flags, areas, panelZones) {
  const size = areaBytes(panelZones);
  const isSet = (flag, area) => {
    const offset = flag * size;
    if (offset + size > flags.length) {
      return false;
    }
    let bits = 0n;
    for (let i = 0; i < size; i++) {
      bits |= BigInt(flags[offset + i]) << BigInt(8 * i);
    }
    return (bits & (1n << BigInt(area - 1))) !== 0n;
  };
  const result = {};
  for (const area of areas) {
    if (isSet(AREA_FLAG.ALARM, area)) {
      result[area] = { state: 'in alarm', partArm: null };
    } else if ([AREA_FLAG.ARMED, AREA_FLAG.FULL_ARMED, AREA_FLAG.PART_ARMED, AREA_FLAG.FORCE_ARMED].some((f) => isSet(f, area))) {
      const partArm = isSet(AREA_FLAG.PART_ARM_1, area) ? 1 : isSet(AREA_FLAG.PART_ARM_2, area) ? 2 : isSet(AREA_FLAG.PART_ARM_3, area) ? 3 : null;
      result[area] = { state: partArm ? 'part armed' : 'armed', partArm };
    } else {
      result[area] = { state: 'disarmed', partArm: null };
    }
  }
  return result;
}

function cleanText(buf) {
  return buf.toString('latin1').replace(/\0/g, ' ').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Panel identification, e.g. "Elite 24     V6.05.03LS1". */
function decodePanelIdentification(payload) {
  const text = cleanText(payload);
  const parts = text.split(' ');
  return {
    text,
    model: parts[0] === 'Elite' ? 'Premier Elite' : parts[0],
    zones: Number.parseInt(parts[1], 10) || null,
    firmware: parts[parts.length - 1],
  };
}

function decodeZoneDetails(payload) {
  let areaBytes;
  switch (payload.length) {
    case 34: areaBytes = 1; break;
    case 35: areaBytes = 2; break;
    case 41: areaBytes = 8; break;
    default: return null;
  }
  let areas = 0n;
  for (let i = 0; i < areaBytes; i++) {
    areas |= BigInt(payload[1 + i]) << BigInt(8 * i);
  }
  return { type: payload[0], areaBitmap: areas, name: cleanText(payload.subarray(1 + areaBytes)) };
}

function decodeAreaDetails(payload) {
  if (payload.length !== 25) {
    return null;
  }
  const u16 = (i) => payload[i] | (payload[i + 1] << 8);
  return {
    number: payload[0],
    name: cleanText(payload.subarray(1, 17)),
    exitDelay: u16(17),
    entry1Delay: u16(19),
    entry2Delay: u16(21),
    secondEntry: u16(23),
  };
}

function decodeSystemPower(payload) {
  if (payload.length !== 5) {
    return null;
  }
  const [ref, sys, bat, sysI, batI] = payload;
  const round = (v) => Math.round(v * 100) / 100;
  return {
    panelVoltage: round(13.7 + (sys - ref) * 0.07),
    batteryVoltage: round(13.7 + (bat - ref) * 0.07),
    panelCurrent: sysI * 9,
    batteryCurrent: batI * 9,
  };
}

function decodeDateTime(payload) {
  if (payload.length < 6) {
    return null;
  }
  const [day, month, year, hours, minutes, seconds] = payload;
  return { year: 2000 + year, month, day, hours, minutes, seconds };
}

/** SET_DATE_TIME body: day, month, 2-digit year, hours, minutes, seconds. */
function encodeDateTime(date) {
  return Buffer.from([date.getDate(), date.getMonth() + 1, date.getFullYear() % 100,
    date.getHours(), date.getMinutes(), date.getSeconds()]);
}

/** Packed log timestamp (seconds:6, minutes:6, month:4, hours:5, day:5, year:6). */
function decodeLogTimestamp(value) {
  return {
    seconds: value & 63,
    minutes: (value >> 6) & 63,
    month: (value >> 12) & 15,
    hours: (value >> 16) & 31,
    day: (value >> 21) & 31,
    year: 2000 + ((value >>> 26) & 63),
  };
}

/** Decodes an unsolicited 'M' frame body. */
function decodeMessage(body) {
  const kind = body[0];
  const p = body.subarray(1);
  switch (kind) {
    case MESSAGE.ZONE: {
      if (p.length !== 2 && p.length !== 3) {
        break;
      }
      const zone = p.length === 2 ? p[0] : p[0] | (p[1] << 8);
      const bits = p[p.length - 1];
      return {
        kind: 'zone', zone, raw: bits,
        state: ZONE_STATES[bits & 3],
        fault: Boolean(bits & 4), failedTest: Boolean(bits & 8), alarmed: Boolean(bits & 16),
        manualBypass: Boolean(bits & 32), autoBypass: Boolean(bits & 64), masked: Boolean(bits & 128),
      };
    }
    case MESSAGE.AREA:
      if (p.length < 2) {
        break;
      }
      return { kind: 'area', area: p[0], stateCode: p[1], state: AREA_STATES[p[1]] || `unknown (${p[1]})` };
    case MESSAGE.OUTPUT:
      if (p.length < 2) {
        break;
      }
      return { kind: 'output', location: p[0], state: p[1] };
    case MESSAGE.USER:
      if (p.length < 2) {
        break;
      }
      return { kind: 'user', user: p[0], method: ['code', 'tag', 'code+tag'][p[1]] || `unknown (${p[1]})` };
    case MESSAGE.LOG: {
      let parameter, areas, ts;
      if (p.length === 8) {
        [parameter, areas, ts] = [p[2], p[3], p.readUInt32LE(4)];
      } else if (p.length === 9) {
        [parameter, areas, ts] = [p[2], p[3] | (p[8] << 8), p.readUInt32LE(4)];
      } else if (p.length === 10) {
        [parameter, areas, ts] = [p[2] | (p[3] << 8), p[4] | (p[5] << 8), p.readUInt32LE(6)];
      } else {
        break;
      }
      return {
        kind: 'log', type: p[0], group: p[1] & 0x3f,
        commDelayed: Boolean(p[1] & 0x40), communicated: Boolean(p[1] & 0x80),
        parameter, areas, time: decodeLogTimestamp(ts),
      };
    }
    case MESSAGE.DEBUG:
      return { kind: 'debug', data: p.toString('hex') };
    default:
      break;
  }
  return { kind: 'unknown', data: body.toString('hex') };
}

module.exports = {
  START, TYPE, COMMAND, ACK, NAK, MESSAGE, EVENT_FLAG, AREA_STATES, ZONE_STATES, AREAS_FOR_ZONES, ARM_TYPE, AREA_FLAG,
  areaBytes, areaBitmap, encodeArm, encodeDisarmOrReset, encodeGetZoneState, decodeZoneStateByte, decodeAreaFlags,
  crc8, encodeCommand, FrameParser, decodeMessage, decodePanelIdentification, decodeZoneDetails,
  decodeAreaDetails, decodeSystemPower, decodeDateTime, decodeLogTimestamp, encodeDateTime,
};

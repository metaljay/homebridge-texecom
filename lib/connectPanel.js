'use strict';

const EventEmitter = require('node:events');
const { ConnectClient } = require('./connect/client');
const P = require('./connect/protocol');

/** Log event types the panel logic reacts to (numbering as in texecom2mqtt). */
const LOG = Object.freeze({
  AUTO_OPEN_CLOSE: 39,
  INSTALLER_PROGRAMMING_END: 59,
  PART_ARM_1: 78, PART_ARM_2: 79, PART_ARM_3: 80,
  ARM_FAILED: 85,
  QUICK_PART_ARM_1: 204, QUICK_PART_ARM_2: 205, QUICK_PART_ARM_3: 206,
  REMOTE_PART_ARM_1: 207, REMOTE_PART_ARM_2: 208, REMOTE_PART_ARM_3: 209,
});

/** Log group types (low 6 bits); texecom2mqtt also checks 129/130 for fire. */
const GROUP = Object.freeze({ PRIORITY_ALARM_RESTORE: 2, ALARM: 3, TAMPER_ALARM: 11 });
const FIRE_ALARM = 129;
const FIRE_ALARM_END = 130;

const PART_ARM_FROM_LOG = {
  [LOG.PART_ARM_1]: 1, [LOG.QUICK_PART_ARM_1]: 1, [LOG.REMOTE_PART_ARM_1]: 1,
  [LOG.PART_ARM_2]: 2, [LOG.QUICK_PART_ARM_2]: 2, [LOG.REMOTE_PART_ARM_2]: 2,
  [LOG.PART_ARM_3]: 3, [LOG.QUICK_PART_ARM_3]: 3, [LOG.REMOTE_PART_ARM_3]: 3,
};

/** HomeKit modes a part arm can represent. */
const MODES = ['away', 'stay', 'night'];

/**
 * Texecom Connect panel driver: discovery, state sync and arm/disarm on top
 * of ConnectClient. Behaviour follows texecom2mqtt (MIT) where noted.
 *
 * Events:
 *   'discovered' {zones: [{number, name, type, areas}], areas: [{number, name}]}
 *   'zone'       {number, active, tampered, state}
 *   'area'       {number, state, partArm}   state: disarmed|in exit|in entry|armed|part armed|in alarm
 *   'online' / 'offline'
 */
class ConnectPanel extends EventEmitter {
  /**
   * @param {object} opts
   * @param {*} opts.log
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.udl
   * @param {{1?: string, 2?: string, 3?: string}} [opts.partArmModes]  HomeKit mode per part arm
   * @param {object} [opts.timing]  passed to ConnectClient (tests)
   */
  constructor({ log, host, port, udl, partArmModes = {}, timing }) {
    super();
    this.log = log;
    // Keep-alive doubles as a safety net for lost events: re-read zone and
    // area state when idle (as the Sjoerdfc/texecom-connect fork does; it
    // avoids GET_ZONE_CHANGES, which some newer firmware answers with NAK).
    this.client = new ConnectClient({ log, host, port, udl, timing, onIdle: () => this.refresh() });
    this.zoneStates = new Map();
    this.partArmModes = { 1: 'night', 2: 'stay', 3: null, ...partArmModes };
    this.panelZones = null;
    this.areaNumbers = [];
    this.areaStates = new Map(); // area -> {state, partArm}
    this.lastPartArm = null;
    this.discovered = null;
    this.zoneNames = new Map();
    this.client.on('ready', () => this._onReady());
    this.client.on('message', (m) => this._onMessage(m));
    this.client.on('disconnected', (reason) => this.emit('offline', reason));
  }

  start() {
    this.client.start();
  }

  stop() {
    clearTimeout(this.refreshTimer);
    this.client.stop();
  }

  async _onReady() {
    try {
      if (!this.discovered) {
        await this.discover();
      }
      await this.refresh();
      this.emit('online');
    } catch (err) {
      this.log.error(`Connect: start-up reads failed: ${err.message}`);
    }
  }

  /** Reads panel identity, areas and zones (names, types, area membership). */
  async discover() {
    const id = await this.client.panelIdentification();
    this.panelZones = id.zones;
    this.log.info(`Connect: ${id.model} ${id.zones} (firmware ${id.firmware})`);

    const zones = [];
    for (let number = 1; number <= id.zones; number++) {
      const d = await this.client.zoneDetails(number);
      if (!d || d.type === 0) {
        continue; // not used
      }
      const areas = [];
      for (let a = 1; a <= 64; a++) {
        if (d.areaBitmap & (1n << BigInt(a - 1))) {
          areas.push(a);
        }
      }
      zones.push({ number, name: d.name || `Zone ${number}`, type: d.type, areas });
      this.zoneNames.set(number, d.name || `Zone ${number}`);
    }

    // Like texecom2mqtt, only areas that contain zones are exposed.
    const used = [...new Set(zones.flatMap((z) => z.areas))].sort((a, b) => a - b);
    const areas = [];
    for (const number of used) {
      const d = await this.client.areaDetails(number);
      areas.push({ number, name: (d && d.name) || `Area ${String.fromCharCode(64 + number)}` });
    }
    this.areaNumbers = used;
    this.discovered = { zones, areas };
    this.emit('discovered', this.discovered);
    return this.discovered;
  }

  /** Reads the current state of every zone and area. */
  async refresh() {
    const zoneStates = await this.client.zoneStates(this.panelZones);
    for (const [number, s] of Object.entries(zoneStates)) {
      this._emitZone(Number(number), s.state);
    }
    await this.refreshAreas();
  }

  async refreshAreas() {
    if (this.areaNumbers.length === 0) {
      return;
    }
    const states = await this.client.areaStates(this.areaNumbers, this.panelZones);
    for (const [number, s] of Object.entries(states)) {
      this._setArea(Number(number), s.state, s.partArm);
    }
  }

  _emitZone(number, state) {
    if (this.zoneStates.get(number) === state) {
      return; // unchanged (periodic re-reads must not restart dwell timers)
    }
    this.zoneStates.set(number, state);
    this.emit('zone', { number, state, active: state === 'active', tampered: state === 'tamper' || state === 'short' });
  }

  _setArea(number, state, partArm) {
    const prev = this.areaStates.get(number);
    const next = { state, partArm: state === 'part armed' ? partArm : null };
    this.areaStates.set(number, next);
    if (!prev || prev.state !== next.state || prev.partArm !== next.partArm) {
      this.emit('area', { number, ...next });
    }
  }

  _onMessage(m) {
    try {
      switch (m.kind) {
        case 'zone':
          this._emitZone(m.zone, m.state);
          break;
        case 'area':
          if (m.stateCode > 5) {
            // e.g. state 6, seen straight after "Part Armed 1"; not in any
            // published list. Re-read the flags instead of guessing.
            this.log.debug(`Connect: area ${m.area} reported unknown state ${m.stateCode}; re-reading`);
            this._refreshAreasSoon();
          } else if (m.state === 'part armed') {
            this._setArea(m.area, m.state, this.lastPartArm);
            this._refreshAreasSoon(); // confirm which part arm from the flags
          } else {
            this._setArea(m.area, m.state, null);
          }
          break;
        case 'log':
          this._onLog(m);
          break;
        case 'user':
          this.log.debug(`Connect: user ${m.user} logged on by ${m.method}`);
          break;
        default:
          break;
      }
    } catch (err) {
      this.log.error(`Connect: error handling message ${JSON.stringify(m)}: ${err.stack || err}`);
    }
  }

  _onLog(m) {
    if (PART_ARM_FROM_LOG[m.type]) {
      this.lastPartArm = PART_ARM_FROM_LOG[m.type];
    }
    // Zone alarm events (types 1-21) carry the zone in `parameter`, which
    // Crestron never reports: log which zone set the alarm off.
    const rawGroup = m.group | (m.communicated ? 0x80 : 0) | (m.commDelayed ? 0x40 : 0);
    if (m.type >= 1 && m.type <= 21) {
      if (m.group === GROUP.ALARM || m.group === GROUP.TAMPER_ALARM || rawGroup === FIRE_ALARM) {
        const what = m.group === GROUP.TAMPER_ALARM ? 'tamper alarm' : 'alarm';
        this.log.warn(`Connect: zone ${m.parameter} (${this.zoneNames.get(m.parameter) || 'unknown'}) in ${what}`);
        this.emit('zone-alarm', { zone: m.parameter, tamper: m.group === GROUP.TAMPER_ALARM });
      }
      if (m.group === GROUP.PRIORITY_ALARM_RESTORE || rawGroup === FIRE_ALARM_END) {
        this._refreshAreasSoon();
      }
    }
    switch (m.type) {
      // These produce no area event, so re-read (texecom2mqtt does the same).
      case LOG.ARM_FAILED:
      case LOG.AUTO_OPEN_CLOSE:
        this._refreshAreasSoon();
        break;
      case LOG.INSTALLER_PROGRAMMING_END:
        this.log.info('Connect: engineer programming finished; re-reading zones and areas');
        this.discover().then(() => this.refresh()).catch((e) => this.log.warn(`Connect: re-discovery failed: ${e.message}`));
        break;
      default:
        break;
    }
  }

  _refreshAreasSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshAreas().catch((e) => this.log.debug(`Connect: area refresh failed: ${e.message}`));
    }, 500);
  }

  /** HomeKit mode ('away'|'stay'|'night') for the current part arm. */
  modeForPartArm(partArm) {
    return this.partArmModes[partArm] || null;
  }

  /** Panel arm type for a HomeKit mode. */
  armTypeForMode(mode) {
    if (mode === 'away') {
      return P.ARM_TYPE.FULL;
    }
    for (const n of [1, 2, 3]) {
      if (this.partArmModes[n] === mode) {
        return n;
      }
    }
    return mode === 'night' ? P.ARM_TYPE.PART_1 : P.ARM_TYPE.PART_2;
  }

  /**
   * Arm an area in a HomeKit mode, or disarm it (mode 'disarm').
   * Resets first when in alarm; disarms first when switching arm mode
   * (both as texecom2mqtt does). Throws if the panel refuses.
   */
  async setMode(area, mode) {
    const current = this.areaStates.get(area) || { state: 'disarmed' };
    const ok = (result, what) => {
      if (!result) {
        throw new Error(`panel refused ${what}`);
      }
    };
    if (mode === 'disarm') {
      if (current.state === 'in alarm') {
        ok(await this.client.reset(area, this.panelZones), 'reset');
      }
      ok(await this.client.disarm(area, this.panelZones), 'disarm');
      return;
    }
    if (!MODES.includes(mode)) {
      throw new Error(`unknown mode ${mode}`);
    }
    if (current.state === 'armed' || current.state === 'part armed') {
      ok(await this.client.disarm(area, this.panelZones), 'disarm before re-arm');
    }
    ok(await this.client.arm(area, this.armTypeForMode(mode), this.panelZones), `arm (${mode})`);
  }
}

/** Picks a HomeKit sensor type for a discovered zone (overridable in config). */
function guessZoneType(name, panelType) {
  if (panelType === 9) {
    return 'smoke';
  }
  if (panelType === 11) {
    return 'carbonmonoxide';
  }
  if (/\b(door|window|gate|shutter|patio|garage door)\b/i.test(name)) {
    return 'contact';
  }
  return 'motion';
}

module.exports = { ConnectPanel, guessZoneType, LOG };

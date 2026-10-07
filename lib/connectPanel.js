'use strict';

const EventEmitter = require('node:events');
const { ConnectClient, PanelBusyError } = require('./connect/client');
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

/** Non-zone tampers and faults, named as in the Apache-2.0 texecom-connect log list. */
const TAMPER_LOGS = {
  60: 'Panel Box Tamper', 61: 'Bell Tamper', 62: 'Auxiliary Tamper', 63: 'Expander Tamper',
  64: 'Keypad Tamper', 67: 'Fire Zone Tamper', 68: 'Zone Tamper', 70: 'Code Tamper Alarm',
  110: 'PSU Tamper', 121: 'GSM Tamper',
};
const FAULT_LOGS = {
  47: 'AC Fail', 48: 'Low Battery', 50: 'Mains Over Voltage', 51: 'Telephone Line Fault',
  52: 'Fail to Communicate', 96: 'Expander Low Voltage', 97: 'Supervision Fault',
  99: 'RF Device Low Battery', 101: 'Radio Jamming', 104: 'Zone Fault', 105: 'Zone Masked',
  107: 'PSU AC Fail', 108: 'PSU Battery Fail', 109: 'PSU Low Output Fail', 118: 'Power Unit Failure',
  119: 'Battery Charger Fault',
};
const MAINS_FAULTS = ['AC Fail', 'PSU AC Fail'];
// Log groups that start a condition, and those that end one.
const GROUPS_STARTING = new Set([1, 3, 9, 11, 20]);
const GROUPS_RESTORING = new Set([2, 4, 10, 12]);
// Below this with no current flowing, the panel is on battery (real panel:
// both currents read 0 and ~12.2-13.0 V on battery; ~300 mA at 13.6 V on mains).
const MAINS_VOLTAGE = 13.3;
// Longest a mode switch may sit between the panel's "disarmed" and the new exit delay.
const SWITCH_GRACE_MS = 10000;
const ZONE_ALARM_REPEAT_MS = 30000;

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
  constructor({ log, host, port, udl, partArmModes = {}, timing, timeSyncHours = 0, timeZone }) {
    super();
    this.log = log;
    // Keep-alive doubles as a safety net for lost events: re-read zone and
    // area state when idle (as the Sjoerdfc/texecom-connect fork does; it
    // avoids GET_ZONE_CHANGES, which some newer firmware answers with NAK).
    this.client = new ConnectClient({ log, host, port, udl, timing, onIdle: () => this._onIdle() });
    this.zoneStates = new Map();
    // Same option name and meaning as upstream 4.4: hours between checks, 0 = off.
    this.timeSyncMs = Math.min(Math.max(Number(timeSyncHours) || 0, 0), 744) * 3600 * 1000;
    this.timeSyncTimer = null;
    // The panel keeps local wall-clock time. Homebridge in Docker usually runs
    // on UTC, so the zone can be set explicitly (e.g. "Europe/London").
    this.timeZone = timeZone || undefined;
    this.partArmModes = { 1: 'night', 2: 'stay', 3: null, ...partArmModes };
    this.panelZones = null;
    this.areaNumbers = [];
    this.areaStates = new Map(); // area -> {state, partArm}
    this.lastPartArm = null;
    this.discovered = null;
    this.zoneNames = new Map();
    this.switching = new Map(); // area -> deadline while a mode switch disarms then re-arms
    this.recentZoneAlarms = new Map();
    this.tampers = new Set();
    this.faults = new Set();
    this.client.on('ready', () => this._onReady());
    this.client.on('message', (m) => this._onMessage(m));
    this.client.on('disconnected', (reason) => this.emit('offline', reason));
  }

  start() {
    this.client.start();
  }

  stop() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.timeSyncTimer);
    this.client.stop();
  }

  async _onReady() {
    try {
      if (!this.discovered) {
        await this.discover();
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await this.refresh();
          break;
        } catch (err) {
          if (!(err instanceof PanelBusyError) || attempt >= 3) {
            throw err;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      this.emit('online');
      this.readPower().catch((e) => this.log.debug(`Connect: power read failed: ${e.message}`));
      if (this.timeSyncMs > 0) {
        this._scheduleTimeSync(5000); // soon after connecting, e.g. after a power cut
      }
    } catch (err) {
      // Don't sit in a half-initialised session: reconnect and start over.
      this.log.error(`Connect: start-up reads failed: ${err.message}`);
      this.client.restart('start-up reads failed');
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
    // A busy/NAK reply throws PanelBusyError: nothing changes, retried later.
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
    // Switching mode disarms then re-arms 0.3 s apart (real panel); without
    // this the Home app shows (and may notify) Disarmed in between.
    if (state === 'disarmed' && (this.switching.get(number) || 0) > Date.now()) {
      this.log.debug(`Connect: area ${number}: disarmed while switching mode; ignoring`);
      return;
    }
    if (state !== 'disarmed') {
      this.switching.delete(number);
    }
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
            // Seen straight after "Part Armed 1". Not in the older published
            // lists; michaelmarconi/texecom_alarm's observations suggest 6/7 =
            // settled in Part Arm 1/2. Re-read the flags rather than rely on it.
            this.log.debug(`Connect: area ${m.area} reported state ${m.stateCode} (settled part arm?); re-reading`);
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
        // The panel logs an alarm twice (the second time once it has been
        // reported): report it once.
        const key = `${m.parameter}:${m.group === GROUP.TAMPER_ALARM}`;
        if (Date.now() - (this.recentZoneAlarms.get(key) || 0) < ZONE_ALARM_REPEAT_MS) {
          return;
        }
        this.recentZoneAlarms.set(key, Date.now());
        const what = m.group === GROUP.TAMPER_ALARM ? 'tamper alarm' : 'alarm';
        this.log.warn(`Connect: zone ${m.parameter} (${this.zoneNames.get(m.parameter) || 'unknown'}) in ${what}`);
        this.emit('zone-alarm', { zone: m.parameter, tamper: m.group === GROUP.TAMPER_ALARM });
      }
      if (m.group === GROUP.PRIORITY_ALARM_RESTORE || rawGroup === FIRE_ALARM_END) {
        this._refreshAreasSoon();
      }
    }
    if (TAMPER_LOGS[m.type] && (m.group === 11 || m.group === 12)) {
      this._setCondition(this.tampers, TAMPER_LOGS[m.type], m.group === 11);
    }
    if (FAULT_LOGS[m.type] && (GROUPS_STARTING.has(m.group) || GROUPS_RESTORING.has(m.group))) {
      this._setCondition(this.faults, FAULT_LOGS[m.type], GROUPS_STARTING.has(m.group));
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

  async _onIdle() {
    await this.refresh();
    await this.readPower();
  }

  /**
   * Mains from the power readings: the panel logs AC Fail at once but (on a
   * real Premier Elite 24, V6.05.03) never logs it coming back.
   */
  async readPower() {
    const power = await this.client.systemPower();
    if (!power) {
      return;
    }
    const onBattery = power.panelCurrent === 0 && power.panelVoltage < MAINS_VOLTAGE;
    const mainsOk = power.panelCurrent > 0 || power.panelVoltage >= MAINS_VOLTAGE;
    if (onBattery && !this.faults.has('AC Fail')) {
      this._setCondition(this.faults, 'AC Fail', true);
    } else if (mainsOk) {
      MAINS_FAULTS.filter((f) => this.faults.has(f)).forEach((f) => this._setCondition(this.faults, f, false));
    }
  }

  _setCondition(set, name, active) {
    if (active === set.has(name)) {
      return;
    }
    if (active) {
      set.add(name);
      this.log.warn(`Connect: ${name}`);
    } else {
      set.delete(name);
      this.log.info(`Connect: ${name} cleared`);
    }
    this.emit('status', { tampered: this.tampers.size > 0, fault: this.faults.size > 0,
      tampers: [...this.tampers], faults: [...this.faults] });
  }

  _refreshAreasSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshAreas().catch((e) => this.log.debug(`Connect: area refresh skipped: ${e.message}`));
    }, 500);
  }

  _scheduleTimeSync(delay) {
    clearTimeout(this.timeSyncTimer);
    // Long delays are stepped: setTimeout can't wait more than ~24.8 days.
    this.timeSyncTimer = setTimeout(() => {
      this.syncClock()
        .catch((e) => this.log.debug(`Connect: clock check failed: ${e.message}`))
        .finally(() => this._scheduleTimeSync(Math.min(this.timeSyncMs, 0x7fffffff)));
    }, delay);
  }

  /**
   * Sets the panel clock if it has drifted more than a minute from local time
   * in `time_zone` (default: this machine's zone). Without a configured zone,
   * a difference of about a whole number of hours is left alone: it's almost
   * always a time-zone mismatch (Docker defaults to UTC), not drift, and
   * "correcting" it would put the panel an hour out.
   */
  async syncClock(now = new Date()) {
    const t = await this.client.dateTime();
    if (!t) {
      return false;
    }
    const want = wallClock(now, this.timeZone);
    const asUtc = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hours, p.minutes, p.seconds);
    const drift = Math.round((asUtc(t) - asUtc(want)) / 1000);
    if (Math.abs(drift) <= 60) {
      this.log.debug(`Connect: panel clock within ${Math.abs(drift)} s`);
      return false;
    }
    const wholeHours = Math.round(drift / 3600);
    if (!this.timeZone && wholeHours !== 0 && Math.abs(drift - wholeHours * 3600) <= 300) {
      this.log.warn(`Connect: panel clock is about ${Math.abs(wholeHours)} hour(s) ${drift > 0 ? 'ahead of' : 'behind'} `
        + 'this machine, which looks like a time-zone difference, so it was left alone. '
        + 'Set "time_zone" (e.g. "Europe/London") to let the clock check correct it.');
      return false;
    }
    this.log.info(`Connect: panel clock is ${Math.abs(drift)} s ${drift > 0 ? 'ahead' : 'behind'}; setting it`);
    if (!(await this.client.setDateTime(want))) {
      throw new Error('panel refused the new time');
    }
    return true;
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
      this.switching.set(area, Date.now() + SWITCH_GRACE_MS);
      try {
        ok(await this.client.disarm(area, this.panelZones), 'disarm before re-arm');
      } catch (err) {
        this.switching.delete(area);
        throw err;
      }
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

/** Wall-clock parts of `date` in `timeZone` (IANA name; undefined = this machine's zone). */
function wallClock(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(date).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day,
    hours: parts.hour, minutes: parts.minute, seconds: parts.second };
}

module.exports = { ConnectPanel, guessZoneType, LOG };

'use strict';

const { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_IP_PORT } = require('./settings');
const { TexecomConnection } = require('./connection');
const { parseLine, ZoneStatus } = require('./protocol');
const { ZoneAccessory, ZONE_TYPES } = require('./zoneAccessory');
const { AreaAccessory } = require('./areaAccessory');
const { ConnectPanel, guessZoneType } = require('./connectPanel');

/**
 * Dynamic platform: accessories are cached by Homebridge, restored through
 * configureAccessory(), and reconciled against config on launch.
 *
 * @implements {import('homebridge').DynamicPlatformPlugin}
 */
class TexecomPlatform {
  /**
   * @param {import('homebridge').Logging} log
   * @param {import('homebridge').PlatformConfig} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.api = api;
    this.config = config || {};
    this.log = createLogger(log, Boolean(this.config.debug));

    /** @type {Map<string, import('homebridge').PlatformAccessory>} */
    this.cachedAccessories = new Map();
    /** @type {Map<number, ZoneAccessory>} */
    this.zones = new Map();
    /** @type {Map<number, AreaAccessory>} */
    this.areas = new Map();
    this.connection = null;
    this.firstStatusPending = false;
    this.connectPanel = null;
    // "crestron" (default): Crestron/Simple protocol over serial or a serial-to-IP
    // bridge. "connect": Texecom Connect protocol to a SmartCom/ComIP in normal mode.
    this.protocol = String(this.config.protocol || 'crestron').toLowerCase();

    // Which panel users mean what when an area is reported armed. Same config
    // keys as upstream 4.3.1+ so configs are interchangeable.
    this.remoteUsers = parseUserList(this.config.remote_users);
    this.defaultArmState = String(this.config.default_arm_state || 'away').toLowerCase();
    // Inferring an alarm from zone activity is off by default: the panel
    // reports real alarms itself ("L"), and inference misfires on every
    // normal entry through an entry/exit route.
    this.triggerFromZones = this.config.trigger_from_zones === true;
    // Arm modes offered in the Home app (Off is always offered).
    this.homekitModes = parseModes(this.config.homekit_modes);
    // How long an arm/exit event waits for a following event in the same burst.
    this.eventCoalesceMs = this.config._eventCoalesceMs ?? 500;
    // Crestron only: which part arm HomeKit Night/Home use. Unset keeps the
    // Crestron \Y command, which always sets Part Arm 1.
    this.crestronPartArms = {
      night: parsePartArm(this.config.night_part_arm),
      stay: parsePartArm(this.config.home_part_arm),
    };

    this.udl = this.config.udl !== undefined && this.config.udl !== null && this.config.udl !== ''
      ? String(this.config.udl).trim()
      : null;

    api.on('didFinishLaunching', () => this.didFinishLaunching());
    api.on('shutdown', () => this.shutdown());
  }

  /** Restores an accessory from the Homebridge cache. */
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  didFinishLaunching() {
    const zoneConfigs = normaliseZones(this.config.zones, this.log);
    const areaConfigs = normaliseAreas(this.config.areas, this.log);

    // With Connect and no zones/areas in the config, they are read from the
    // panel once connected (names, types, area membership).
    this.discoverFromPanel = this.protocol === 'connect' && zoneConfigs.length === 0 && areaConfigs.length === 0;
    if (this.discoverFromPanel) {
      this.log.info('No zones or areas configured: they will be read from the panel');
      this.startConnection();
      return;
    }
    this.createAccessories(zoneConfigs, areaConfigs);
    this.startConnection();
  }

  createAccessories(zoneConfigs, areaConfigs) {
    const wanted = new Set();
    for (const zone of zoneConfigs) {
      const accessory = this.getOrCreateAccessory('zone', zone.number, zone.name);
      wanted.add(accessory.UUID);
      this.zones.set(zone.number, new ZoneAccessory(this, accessory, zone));
    }
    for (const area of areaConfigs) {
      // The Home app reads an alarm's list of arm modes only when it first
      // sees the accessory, so a reduced homekit_modes gets its own UUID: the
      // alarm reappears as a new accessory with just those buttons.
      const modes = this.homekitModes.length < 3 ? `:modes-${[...this.homekitModes].sort().join('-')}` : '';
      const accessory = this.getOrCreateAccessory('area', area.number, area.name, modes);
      wanted.add(accessory.UUID);
      this.areas.set(area.number, new AreaAccessory(this, accessory, area));
    }

    const stale = [...this.cachedAccessories.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(s) no longer in config: ${stale.map((a) => a.displayName).join(', ')}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.cachedAccessories.delete(a.UUID));
    }
  }

  getOrCreateAccessory(kind, number, name, variant = '') {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${kind}:${number}${variant}`);
    let accessory = this.cachedAccessories.get(uuid);

    if (accessory) {
      this.log.debug(`Restoring ${kind} ${number} (${name}) from cache`);
      if (accessory.displayName !== name) {
        accessory.displayName = name;
        this.api.updatePlatformAccessories([accessory]);
      }
    } else {
      this.log.info(`Adding ${kind} ${number} (${name})`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.kind = kind;
      accessory.context.number = number;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory);
    }
    return accessory;
  }

  /** Removes services left over from a previous zone_type (e.g. motion → contact). */
  removeStaleServices(accessory, keepServiceType) {
    const { Service } = this.api.hap;
    for (const service of [...accessory.services]) {
      if (service.UUID !== Service.AccessoryInformation.UUID && service.UUID !== keepServiceType.UUID) {
        accessory.removeService(service);
      }
    }
  }

  startConnection() {
    if (this.protocol === 'connect') {
      this.startConnect();
      return;
    }
    const { serial_device: serialPath, baud_rate: baudRate, ip_address: host } = this.config;
    const port = Number(this.config.ip_port) || DEFAULT_IP_PORT;

    if (!serialPath && !host) {
      this.log.error('No connection configured: set either "serial_device" or "ip_address".');
      return;
    }
    if (serialPath && !baudRate) {
      this.log.error('"baud_rate" is required when using "serial_device".');
      return;
    }

    this.connection = new TexecomConnection({
      log: this.log,
      host,
      port,
      serialPath,
      baudRate: Number(baudRate),
      statusPollMs: 1000 * (this.config.status_poll_interval ?? 60),
    });
    this.connection.on('line', (line) => this.handleLine(line));
    // Ask the panel whether each area is armed: corrects a stale cached state
    // after a restart or reconnect (confirmed working on a real panel). The
    // connection repeats the query every status_poll_interval seconds.
    this.connection.on('connected', () => {
      this.firstStatusPending = true;
      this.connection.sendQuery('ASTATUS');
    });
    this.connection.start();
  }

  startConnect() {
    const host = this.config.ip_address;
    const port = Number(this.config.ip_port) || DEFAULT_IP_PORT;
    if (!host || !this.udl) {
      this.log.error('The Connect protocol needs "ip_address" (the SmartCom/ComIP) and "udl".');
      return;
    }
    const partArmModes = {};
    for (const n of [1, 2, 3]) {
      const mode = this.config[`part_arm_${n}`];
      if (mode !== undefined) {
        partArmModes[n] = mode ? String(mode).toLowerCase() : null;
      }
    }
    this.connectPanel = new ConnectPanel({
      log: this.log, host, port, udl: this.udl, partArmModes, timing: this.config._connectTiming,
      timeSyncHours: this.config.time_sync_interval,
      timeZone: validTimeZone(this.config.time_zone, this.log),
    });
    this.connectPanel.on('discovered', (d) => this.onPanelDiscovered(d));
    this.connectPanel.on('zone', (z) => {
      const zone = this.zones.get(z.number);
      if (zone) {
        zone.setState(z);
      }
    });
    this.connectPanel.on('area', (a) => {
      const area = this.areas.get(a.number);
      if (area) {
        area.applyConnectState(a);
      }
    });
    this.connectPanel.on('status', (status) => {
      for (const area of this.areas.values()) {
        area.applyStatus(status);
      }
    });
    this.connectPanel.start();
  }

  onPanelDiscovered({ zones, areas }) {
    for (const z of zones) {
      this.log.debug(`Panel zone ${z.number}: "${z.name}" type ${z.type}, areas ${z.areas.join(',')}`);
    }
    if (!this.discoverFromPanel) {
      return;
    }
    const zoneConfigs = zones.map((z) => ({ name: z.name, number: z.number, type: guessZoneType(z.name, z.type), dwell: 0 }));
    const areaConfigs = areas.map((a) => ({
      name: a.name,
      number: a.number,
      zones: zones.filter((z) => z.areas.includes(a.number)).map((z) => z.number),
    }));
    for (const z of this.zones.values()) {
      z.dispose();
    }
    this.zones.clear();
    this.areas.clear();
    this.createAccessories(zoneConfigs, areaConfigs);
  }

  handleLine(line) {
    this.log.debug(`Received: ${JSON.stringify(line)}`);
    try {
      const message = parseLine(line);
      switch (message.type) {
        case 'zone':
          this.handleZone(message.zone, message.status);
          break;
        case 'area':
          this.handleArea(message.area, message.event, message.user);
          break;
        case 'user':
          this.log.debug(`User ${message.user} entered a code at a keypad`);
          break;
        case 'astatus': {
          const afterConnect = this.firstStatusPending === true;
          this.firstStatusPending = false;
          message.armed.forEach((armed, i) => {
            const area = this.areas.get(i + 1);
            if (area) {
              area.applyArmedStatus(armed, { afterConnect });
            }
          });
          break;
        }
        case 'unknown':
          this.log.debug(`Ignoring unrecognised message: ${JSON.stringify(message.line)}`);
          break;
        default:
          break; // OK/ERROR are consumed by the command channel
      }
    } catch (err) {
      // Never let a malformed message take down the bridge.
      this.log.error(`Error handling message ${JSON.stringify(line)}: ${err.stack || err}`);
    }
  }

  handleZone(number, status) {
    this.log.debug(`Zone ${number} status ${status}`);
    const zone = this.zones.get(number);
    if (zone) {
      zone.update(status);
    }

    if (this.triggerFromZones && status === ZoneStatus.ACTIVE) {
      for (const area of this.areas.values()) {
        if (area.awayArmed && !area.inEntryDelay && area.containsZone(number)) {
          area.triggerFromZone(number);
        }
      }
    }
  }

  handleArea(number, event, user) {
    const area = this.areas.get(number);
    if (area) {
      area.handlePanelEvent(event, user);
    } else {
      this.log.debug(`Area ${number} event ${event} (not configured)`);
    }
  }

  shutdown() {
    if (this.connection) {
      this.connection.stop();
    }
    if (this.connectPanel) {
      this.connectPanel.stop();
    }
    for (const zone of this.zones.values()) {
      zone.dispose();
    }
  }
}

/**
 * Wraps the Homebridge logger so the plugin's own "debug" option surfaces
 * debug messages without needing Homebridge-wide debug mode (-D).
 */
function createLogger(log, debugEnabled) {
  return {
    info: (msg, ...args) => log.info(msg, ...args),
    warn: (msg, ...args) => log.warn(msg, ...args),
    error: (msg, ...args) => log.error(msg, ...args),
    debug: debugEnabled
      ? (msg, ...args) => log.info(`[debug] ${msg}`, ...args)
      : (msg, ...args) => log.debug(msg, ...args),
  };
}

/** An IANA time zone name the runtime accepts, or undefined (with a warning if one was given). */
function validTimeZone(value, log) {
  if (!value) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: String(value) });
    return String(value);
  } catch {
    log.warn(`Unknown time_zone "${value}"; using this machine's time zone`);
    return undefined;
  }
}

/** Subset of away/night/stay ("home" accepted for stay); all three when unset or empty. */
function parseModes(value) {
  const modes = Array.isArray(value)
    ? [...new Set(value.map((m) => String(m).toLowerCase()).map((m) => (m === 'home' ? 'stay' : m)))]
      .filter((m) => ['away', 'night', 'stay'].includes(m))
    : [];
  return modes.length > 0 ? modes : ['away', 'night', 'stay'];
}

/** 1, 2 or 3, or null when unset/invalid. */
function parsePartArm(value) {
  const n = Number(value);
  return [1, 2, 3].includes(n) ? n : null;
}

function parseUserList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n));
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normaliseZones(zones, log) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(zones) ? zones : []) {
    const number = toPositiveInt(raw && raw.zone_number);
    if (!number || !raw.name) {
      log.error(`Skipping zone with missing name or invalid zone_number: ${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(number)) {
      log.error(`Skipping duplicate zone_number ${number} (${raw.name})`);
      continue;
    }
    seen.add(number);

    let type = raw.zone_type || 'motion';
    if (!ZONE_TYPES[type]) {
      log.warn(`Zone ${number}: unknown zone_type "${type}", using motion`);
      type = 'motion';
    }
    result.push({
      name: String(raw.name),
      number,
      type,
      dwell: Math.max(0, Number(raw.dwell) || 0),
    });
  }
  return result;
}

function normaliseAreas(areas, log) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(areas) ? areas : []) {
    const number = toPositiveInt(raw && raw.area_number);
    if (!number || !raw.name) {
      log.error(`Skipping area with missing name or invalid area_number: ${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(number)) {
      log.error(`Skipping duplicate area_number ${number} (${raw.name})`);
      continue;
    }
    seen.add(number);

    const zoneList = Array.isArray(raw.zones) ? raw.zones : raw.zones !== undefined ? [raw.zones] : [];
    const zones = zoneList.map(toPositiveInt).filter((n) => n !== null);
    if (zones.length === 0) {
      // An empty list is normal: zones are only used with trigger_from_zones.
      if (zoneList.length > 0) {
        log.warn(`Area ${number} (${raw.name}): no valid zone numbers in "zones"`);
      }
    }
    result.push({ name: String(raw.name), number, zones });
  }
  return result;
}

module.exports = { TexecomPlatform, normaliseZones, normaliseAreas };

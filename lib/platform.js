'use strict';

const { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_IP_PORT } = require('./settings');
const { TexecomConnection } = require('./connection');
const { parseLine, ZoneStatus } = require('./protocol');
const { ZoneAccessory, ZONE_TYPES } = require('./zoneAccessory');
const { AreaAccessory } = require('./areaAccessory');

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

    // Which panel users mean what when an area is reported armed. Same config
    // keys as upstream 4.3.1+ so configs are interchangeable.
    this.remoteUsers = parseUserList(this.config.remote_users);
    this.defaultArmState = String(this.config.default_arm_state || 'away').toLowerCase();
    // Inferring an alarm from zone activity is off by default: the panel
    // reports real alarms itself ("L"), and inference misfires on every
    // normal entry through an entry/exit route.
    this.triggerFromZones = this.config.trigger_from_zones === true;

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

    const wanted = new Set();
    for (const zone of zoneConfigs) {
      const accessory = this.getOrCreateAccessory('zone', zone.number, zone.name);
      wanted.add(accessory.UUID);
      this.zones.set(zone.number, new ZoneAccessory(this, accessory, zone));
    }
    for (const area of areaConfigs) {
      const accessory = this.getOrCreateAccessory('area', area.number, area.name);
      wanted.add(accessory.UUID);
      this.areas.set(area.number, new AreaAccessory(this, accessory, area));
    }

    const stale = [...this.cachedAccessories.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(s) no longer in config: ${stale.map((a) => a.displayName).join(', ')}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.cachedAccessories.delete(a.UUID));
    }

    this.startConnection();
  }

  getOrCreateAccessory(kind, number, name) {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${kind}:${number}`);
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
    });
    this.connection.on('line', (line) => this.handleLine(line));
    this.connection.start();
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
      if (raw.zones !== undefined) {
        log.warn(`Area ${number} (${raw.name}): no valid zone numbers in "zones"`);
      }
    }
    result.push({ name: String(raw.name), number, zones });
  }
  return result;
}

module.exports = { TexecomPlatform, normaliseZones, normaliseAreas };

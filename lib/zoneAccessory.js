'use strict';

const { ZoneStatus } = require('./protocol');

/** Maps a configured zone_type to its HomeKit service and characteristic. */
const ZONE_TYPES = {
  motion: {
    service: 'MotionSensor',
    characteristic: 'MotionDetected',
    value: (C, active) => active,
  },
  contact: {
    service: 'ContactSensor',
    characteristic: 'ContactSensorState',
    value: (C, active) => active
      ? C.ContactSensorState.CONTACT_NOT_DETECTED
      : C.ContactSensorState.CONTACT_DETECTED,
  },
  smoke: {
    service: 'SmokeSensor',
    characteristic: 'SmokeDetected',
    value: (C, active) => active
      ? C.SmokeDetected.SMOKE_DETECTED
      : C.SmokeDetected.SMOKE_NOT_DETECTED,
  },
  carbonmonoxide: {
    service: 'CarbonMonoxideSensor',
    characteristic: 'CarbonMonoxideDetected',
    value: (C, active) => active
      ? C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
      : C.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
  },
};

/**
 * A single Texecom zone exposed as a HomeKit sensor.
 */
class ZoneAccessory {
  /**
   * @param {import('./platform').TexecomPlatform} platform
   * @param {import('homebridge').PlatformAccessory} accessory
   * @param {{name: string, number: number, type: string, dwell: number}} zone
   */
  constructor(platform, accessory, zone) {
    this.platform = platform;
    this.accessory = accessory;
    this.zone = zone;
    this.dwellTimer = null;

    const { Service, Characteristic } = platform.api.hap;
    const type = ZONE_TYPES[zone.type] || ZONE_TYPES.motion;
    this.type = type;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Texecom')
      .setCharacteristic(Characteristic.Model, 'Premier Elite Zone')
      .setCharacteristic(Characteristic.SerialNumber, `Z${String(zone.number).padStart(3, '0')}`);

    platform.removeStaleServices(accessory, Service[type.service]);

    this.service = accessory.getService(Service[type.service])
      || accessory.addService(Service[type.service], zone.name);
    this.service.setCharacteristic(Characteristic.Name, zone.name);
  }

  /**
   * Handle a zone status update from the panel.
   * @param {string} status raw status digit
   */
  update(status) {
    const { Characteristic } = this.platform.api.hap;
    const active = status === ZoneStatus.ACTIVE;
    const tampered = status !== ZoneStatus.ACTIVE && status !== ZoneStatus.SECURE;

    this.service.getCharacteristic(Characteristic.StatusTampered).updateValue(tampered
      ? Characteristic.StatusTampered.TAMPERED
      : Characteristic.StatusTampered.NOT_TAMPERED);

    clearTimeout(this.dwellTimer);
    this.dwellTimer = null;

    if (!active && this.zone.dwell > 0) {
      // Hold the active state for the dwell period after the panel clears it.
      this.dwellTimer = setTimeout(() => {
        this.dwellTimer = null;
        this._setActive(false);
      }, this.zone.dwell);
    } else {
      this._setActive(active);
    }
  }

  _setActive(active) {
    const { Characteristic } = this.platform.api.hap;
    this.service.getCharacteristic(Characteristic[this.type.characteristic])
      .updateValue(this.type.value(Characteristic, active));
  }

  dispose() {
    clearTimeout(this.dwellTimer);
    this.dwellTimer = null;
  }
}

module.exports = { ZoneAccessory, ZONE_TYPES };

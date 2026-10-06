'use strict';

const { areaBitmask } = require('./protocol');

/** User numbers reported by the panel when arming. */
const PANEL_USER_AWAY = '17';
const PANEL_USER_REMOTE = '25';

/**
 * A Texecom area exposed as a HomeKit Security System.
 */
class AreaAccessory {
  /**
   * @param {import('./platform').TexecomPlatform} platform
   * @param {import('homebridge').PlatformAccessory} accessory
   * @param {{name: string, number: number, zones: number[]}} area
   */
  constructor(platform, accessory, area) {
    this.platform = platform;
    this.accessory = accessory;
    this.area = area;

    const { Service, Characteristic } = platform.api.hap;
    const Current = Characteristic.SecuritySystemCurrentState;
    const Target = Characteristic.SecuritySystemTargetState;

    // Restore the last known state from the accessory cache rather than
    // claiming "disarmed" on every restart.
    const ctx = accessory.context;
    if (ctx.currentState === undefined) {
      ctx.currentState = Current.DISARMED;
    }
    if (ctx.targetState === undefined) {
      ctx.targetState = Target.DISARM;
    }
    this.awayArmed = Boolean(ctx.awayArmed);
    this.requestedTarget = ctx.targetState;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Texecom')
      .setCharacteristic(Characteristic.Model, 'Premier Elite Area')
      .setCharacteristic(Characteristic.SerialNumber, `A${String(area.number).padStart(3, '0')}`);

    platform.removeStaleServices(accessory, Service.SecuritySystem);

    this.service = accessory.getService(Service.SecuritySystem)
      || accessory.addService(Service.SecuritySystem, area.name);
    this.service.setCharacteristic(Characteristic.Name, area.name);

    this.service.getCharacteristic(Current).updateValue(ctx.currentState);
    this.service.getCharacteristic(Target)
      .updateValue(ctx.targetState)
      .onSet((value) => this.setTargetState(value));
  }

  /** @param {number} zone */
  containsZone(zone) {
    return this.area.zones.includes(zone);
  }

  /**
   * Handle an area event from the panel.
   * @param {'A'|'D'|'L'} event
   * @param {string} user
   */
  handlePanelEvent(event, user) {
    const log = this.platform.log;
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    let state;

    switch (event) {
      case 'L':
        state = Current.ALARM_TRIGGERED;
        log.warn(`${this.area.name}: alarm triggered`);
        break;

      case 'D':
        state = Current.DISARMED;
        this.awayArmed = false;
        log.info(`${this.area.name}: disarmed by user ${user}`);
        break;

      case 'A':
        if (user === PANEL_USER_AWAY) {
          state = Current.AWAY_ARM;
        } else if (user === PANEL_USER_REMOTE) {
          // Armed by us (via the Crestron interface): report the mode HomeKit asked for.
          state = this._currentForTarget(this.requestedTarget);
        } else {
          state = Current.NIGHT_ARM;
        }
        this.awayArmed = state === Current.AWAY_ARM;
        log.info(`${this.area.name}: armed (${this._stateName(state)}) by user ${user}`);
        break;

      default:
        return;
    }

    this.setCurrentState(state);
  }

  /** Called when a zone in this area goes active while the area is away-armed. */
  triggerFromZone(zone) {
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    this.platform.log.warn(`${this.area.name}: zone ${zone} activated while armed`);
    this.setCurrentState(Current.ALARM_TRIGGERED);
  }

  /**
   * Push a new current state to HomeKit (and the matching target state, so the
   * Home app does not show "Arming…" for changes made at the keypad).
   * `updateValue` never triggers `onSet`, so there is no feedback loop.
   */
  setCurrentState(state) {
    const { Characteristic } = this.platform.api.hap;
    const target = this._targetForCurrent(state);

    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(state);
    if (target !== null) {
      this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(target);
      this.requestedTarget = target;
    }
    this._persist(state, target);
  }

  /** onSet handler: arm/disarm the area from HomeKit. */
  async setTargetState(value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    const Target = this.platform.api.hap.Characteristic.SecuritySystemTargetState;
    const log = this.platform.log;

    if (!this.platform.udl) {
      log.warn(`${this.area.name}: cannot arm/disarm from HomeKit - no UDL code configured`);
      throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    let letter;
    switch (value) {
      case Target.AWAY_ARM:
        letter = 'A';
        break;
      case Target.STAY_ARM:
      case Target.NIGHT_ARM:
        letter = 'Y';
        break;
      case Target.DISARM:
        letter = 'D';
        break;
      default:
        throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    let command;
    try {
      command = letter + areaBitmask(this.area.number);
    } catch (err) {
      log.error(`${this.area.name}: ${err.message}`);
      throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    // Record the request first: the panel's arm event may arrive before the OK.
    this.requestedTarget = value;
    log.info(`${this.area.name}: requesting ${this._stateName(this._currentForTarget(value))}`);

    try {
      await this.platform.connection.sendCommands([`W${this.platform.udl}`, command]);
    } catch (err) {
      log.error(`${this.area.name}: arm/disarm failed - ${err.message}`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (value === Target.DISARM) {
      this.awayArmed = false;
    }
    this.setCurrentState(this._currentForTarget(value));
  }

  _currentForTarget(target) {
    const { SecuritySystemCurrentState: Current, SecuritySystemTargetState: Target } =
      this.platform.api.hap.Characteristic;
    switch (target) {
      case Target.AWAY_ARM: return Current.AWAY_ARM;
      case Target.STAY_ARM: return Current.STAY_ARM;
      case Target.NIGHT_ARM: return Current.NIGHT_ARM;
      default: return Current.DISARMED;
    }
  }

  _targetForCurrent(current) {
    const { SecuritySystemCurrentState: Current, SecuritySystemTargetState: Target } =
      this.platform.api.hap.Characteristic;
    switch (current) {
      case Current.AWAY_ARM: return Target.AWAY_ARM;
      case Current.STAY_ARM: return Target.STAY_ARM;
      case Current.NIGHT_ARM: return Target.NIGHT_ARM;
      case Current.DISARMED: return Target.DISARM;
      default: return null; // ALARM_TRIGGERED keeps the existing target
    }
  }

  _stateName(current) {
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    switch (current) {
      case Current.AWAY_ARM: return 'away';
      case Current.STAY_ARM: return 'stay';
      case Current.NIGHT_ARM: return 'night';
      case Current.DISARMED: return 'disarmed';
      case Current.ALARM_TRIGGERED: return 'triggered';
      default: return String(current);
    }
  }

  _persist(current, target) {
    const ctx = this.accessory.context;
    ctx.currentState = current;
    if (target !== null) {
      ctx.targetState = target;
    }
    ctx.awayArmed = this.awayArmed;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}

module.exports = { AreaAccessory };

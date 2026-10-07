'use strict';

const { areaBitmask, partArmFrame } = require('./protocol');

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
    // The arm mode last requested from HomeKit and accepted by the panel.
    // Null when the panel was armed by something else (keypad, fob, app).
    this.pendingTarget = null;
    // True between an entry-delay event and the disarm/alarm that ends it.
    this.inEntryDelay = false;

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
   * @param {'A'|'D'|'L'|'X'|'E'} event
   * @param {string} user
   */
  handlePanelEvent(event, user) {
    const log = this.platform.log;
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    let state;

    switch (event) {
      case 'X': {
        // Show "Arming…" in the Home app until the panel reports armed.
        const Target = this.platform.api.hap.Characteristic.SecuritySystemTargetState;
        this.service.getCharacteristic(Target)
          .updateValue(this.pendingTarget ?? this._targetForMode(this.platform.defaultArmState));
        log.info(`${this.area.name}: exit delay started`);
        return;
      }

      case 'E':
        this.inEntryDelay = true;
        log.warn(`${this.area.name}: entry delay started`);
        return;

      case 'L':
        state = Current.ALARM_TRIGGERED;
        log.warn(`${this.area.name}: alarm triggered`);
        break;

      case 'D':
        state = Current.DISARMED;
        this.awayArmed = false;
        this.pendingTarget = null;
        log.info(`${this.area.name}: disarmed by user ${user}`);
        break;

      case 'A':
        state = this._resolveArmedState(user);
        this.awayArmed = state === Current.AWAY_ARM;
        log.info(`${this.area.name}: armed (${this._stateName(state)}) by user ${user}`);
        break;

      default:
        return;
    }

    this.inEntryDelay = false;
    this.setCurrentState(state);
  }

  /**
   * The panel reports an arm without saying whether it was full or part, so
   * the HomeKit state is worked out (same order as upstream 4.3.1+) from:
   *   1. a user configured in `remote_users` (keyfob/remote) → away
   *   2. the mode requested from HomeKit, if this arm came from us
   *   3. `default_arm_state` for everything else, e.g. a keypad arm
   */
  _resolveArmedState(user) {
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    const userNumber = Number(user);

    if (this.platform.remoteUsers.includes(userNumber)) {
      return Current.AWAY_ARM;
    }
    if (this.pendingTarget !== null) {
      return this._currentForTarget(this.pendingTarget);
    }
    switch (this.platform.defaultArmState) {
      case 'night': return Current.NIGHT_ARM;
      case 'stay':
      case 'home': return Current.STAY_ARM;
      default: return Current.AWAY_ARM;
    }
  }

  /**
   * Apply an area state reported over Texecom Connect.
   * @param {{state: string, partArm: number|null}} panelState
   */
  applyConnectState({ state, partArm }) {
    const { SecuritySystemCurrentState: Current, SecuritySystemTargetState: Target } =
      this.platform.api.hap.Characteristic;
    const log = this.platform.log;
    switch (state) {
      case 'disarmed':
        this.pendingTarget = null;
        this.setCurrentState(Current.DISARMED);
        break;
      case 'in exit': {
        // An armed area can't start an exit delay without being disarmed
        // first. A flag re-read just after a remote arm can still show the
        // exit flag (seen on a real panel); ignore it rather than flip the
        // target to the default mode.
        const current = this.accessory.context.currentState;
        if (current !== Current.DISARMED && current !== Current.ALARM_TRIGGERED) {
          log.debug(`${this.area.name}: ignoring a stale exit flag while armed`);
          break;
        }
        // Show "Arming…": target set, current left as it is until armed.
        const target = this.pendingTarget ?? this._targetForMode(this.platform.defaultArmState);
        this.service.getCharacteristic(Target).updateValue(target);
        log.info(`${this.area.name}: exit delay started`);
        break;
      }
      case 'in entry':
        log.warn(`${this.area.name}: entry delay started`);
        break;
      case 'armed':
        this.pendingTarget = null;
        this.setCurrentState(Current.AWAY_ARM);
        log.info(`${this.area.name}: armed (away)`);
        break;
      case 'part armed': {
        const mode = (partArm && this.platform.connectPanel.modeForPartArm(partArm))
          || this._modeForTarget(this.pendingTarget)
          || 'night';
        this.pendingTarget = null;
        this.setCurrentState(this._currentForTarget(this._targetForMode(mode)));
        log.info(`${this.area.name}: part armed${partArm ? ` ${partArm}` : ''} (${mode})`);
        break;
      }
      case 'in alarm':
        this.setCurrentState(Current.ALARM_TRIGGERED);
        log.warn(`${this.area.name}: alarm triggered`);
        break;
      default:
        break;
    }
  }

  /**
   * Apply an ASTATUS reply (armed or not, no mode). Only corrects HomeKit when
   * it disagrees with the panel, e.g. after a restart or a missed event.
   *
   * The panel never reports an alarm ending, and an alarm can be raised in a
   * disarmed area (24-hour zones, tamper), so a periodic "not armed" reply
   * leaves Triggered alone. Only the first reply after connecting clears it,
   * because a cached Triggered state may be long out of date.
   *
   * @param {boolean} armed
   * @param {{afterConnect?: boolean}} [opts]
   */
  applyArmedStatus(armed, { afterConnect = true } = {}) {
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    const current = this.accessory.context.currentState;
    if (!armed && current === Current.ALARM_TRIGGERED && !afterConnect) {
      return;
    }
    if (!armed && current !== Current.DISARMED) {
      this.platform.log.info(`${this.area.name}: panel reports not armed; updating HomeKit`);
      this.awayArmed = false;
      this.setCurrentState(Current.DISARMED);
    } else if (armed && current === Current.DISARMED) {
      const state = this._resolveArmedState('');
      this.awayArmed = state === Current.AWAY_ARM;
      this.platform.log.info(`${this.area.name}: panel reports armed; updating HomeKit (${this._stateName(state)})`);
      this.setCurrentState(state);
    }
  }

  _targetForMode(mode) {
    const Target = this.platform.api.hap.Characteristic.SecuritySystemTargetState;
    return { away: Target.AWAY_ARM, stay: Target.STAY_ARM, home: Target.STAY_ARM, night: Target.NIGHT_ARM }[mode]
      ?? Target.AWAY_ARM;
  }

  _modeForTarget(target) {
    const Target = this.platform.api.hap.Characteristic.SecuritySystemTargetState;
    return { [Target.AWAY_ARM]: 'away', [Target.STAY_ARM]: 'stay', [Target.NIGHT_ARM]: 'night' }[target] || null;
  }

  /**
   * Only used with `trigger_from_zones`: a zone in this area went active while
   * the area is away-armed and not in its entry delay.
   */
  triggerFromZone(zone) {
    const Current = this.platform.api.hap.Characteristic.SecuritySystemCurrentState;
    if (this.accessory.context.currentState === Current.ALARM_TRIGGERED) {
      return;
    }
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

    if (this.platform.connectPanel) {
      const mode = value === Target.DISARM ? 'disarm' : this._modeForTarget(value);
      if (!mode) {
        throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      const previousPending = this.pendingTarget;
      this.pendingTarget = mode === 'disarm' ? null : value;
      log.info(`${this.area.name}: requesting ${mode}`);
      try {
        await this.platform.connectPanel.setMode(this.area.number, mode);
      } catch (err) {
        this.pendingTarget = previousPending;
        log.error(`${this.area.name}: ${mode} failed - ${err.message}`);
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return; // the current state follows the panel's area events
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
      const partArm = letter === 'Y'
        ? this.platform.crestronPartArms[value === Target.NIGHT_ARM ? 'night' : 'stay']
        : null;
      // A configured part arm uses the binary UDL 'S' command, which can
      // reach Part Arm 2/3; otherwise \Y (Part Arm 1), as before.
      command = partArm ? partArmFrame(this.area.number, partArm) : letter + areaBitmask(this.area.number);
    } catch (err) {
      log.error(`${this.area.name}: ${err.message}`);
      throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    // Record the request first: the panel's arm event may arrive before the OK.
    const previousPending = this.pendingTarget;
    this.pendingTarget = value === Target.DISARM ? null : value;
    log.info(`${this.area.name}: requesting ${this._stateName(this._currentForTarget(value))}`);

    try {
      await this.platform.connection.sendCommands([`W${this.platform.udl}`, command]);
    } catch (err) {
      this.pendingTarget = previousPending;
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

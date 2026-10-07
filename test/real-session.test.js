'use strict';

/**
 * Replays a session recorded from a real panel through the platform, using
 * real HAP-NodeJS characteristics, and checks what HomeKit would have shown.
 * The fixture keeps the original TCP chunking, which is what exposed lost
 * keypad disarms and false "triggered" states in 4.4.0-beta.1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
const { TexecomPlatform } = require('../lib/platform');
const { LineSplitter } = require('../lib/protocol');
const session = require('./fixtures/real-session-2026-10-06.json');

const Current = hap.Characteristic.SecuritySystemCurrentState;
const STATE_NAMES = { [Current.STAY_ARM]: 'stay', [Current.AWAY_ARM]: 'away', [Current.NIGHT_ARM]: 'night',
  [Current.DISARMED]: 'disarmed', [Current.ALARM_TRIGGERED]: 'triggered' };

function createApi() {
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  api.registerPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  return api;
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const config = {
  name: 'Texecom',
  // No connection configured: lines are fed in directly below.
  zones: Object.entries(session.zones).map(([n, name]) => ({ name, zone_number: n, zone_type: 'motion' })),
  areas: [{ name: 'Home', area_number: '1', zones: [1, 2, 3, 4, 5] }],
};

function replay(overrides = {}) {
  const api = createApi();
  const platform = new TexecomPlatform(silentLog, { ...config, ...overrides }, api);
  api.emit('didFinishLaunching');

  const area = platform.areas.get(1);
  const timeline = [];
  area.service.getCharacteristic(Current).on('change', ({ newValue }) => {
    timeline.push(STATE_NAMES[newValue]);
  });

  const splitter = new LineSplitter((line) => platform.handleLine(line));
  for (const [, messages] of session.chunks) {
    splitter.push(Buffer.from(messages.map((m) => `${m}\r\n`).join(''), 'latin1'));
  }
  return { platform, area, timeline };
}

test('real session: every keypad arm/disarm and the real alarm reach HomeKit', () => {
  const { timeline } = replay();
  assert.deepEqual(timeline, [
    'away', 'disarmed', // full arm, disarm
    'away', 'disarmed', // full arm, walk in, disarm during entry delay
    'away', 'triggered', 'disarmed', // full arm, alarm sounds, disarm
  ]);
});

test('real session: ends disarmed with every sensor clear', () => {
  const { platform, area } = replay();
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);
  for (const zone of platform.zones.values()) {
    assert.equal(zone.service.getCharacteristic(hap.Characteristic.MotionDetected).value, false, zone.zone.name);
  }
});

test('real session: walking in during the entry delay is not an alarm, even with trigger_from_zones', () => {
  // 15:32:22 the user walked in (entry delay) and disarmed at the keypad. Only
  // the 15:33:02 "L" is a real alarm.
  const { timeline } = replay({ trigger_from_zones: true });
  assert.deepEqual(timeline, ['away', 'disarmed', 'away', 'disarmed', 'away', 'triggered', 'disarmed']);
});

test('ASTATUS on connect corrects a stale cached state', () => {
  const api = createApi();
  const platform = new TexecomPlatform(silentLog, config, api);
  api.emit('didFinishLaunching');
  const area = platform.areas.get(1);
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);
  platform.handleLine('"YN'); // panel: area 1 armed, area 2 not
  assert.equal(area.service.getCharacteristic(Current).value, Current.AWAY_ARM); // default_arm_state away
  platform.handleLine('"NN');
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);
});

test('exit delay ("X") shows Arming... in HomeKit until the panel reports armed', () => {
  const api = createApi();
  const platform = new TexecomPlatform(silentLog, config, api);
  api.emit('didFinishLaunching');
  const area = platform.areas.get(1);
  const Target = hap.Characteristic.SecuritySystemTargetState;
  platform.handleLine('"X0010');
  assert.equal(area.service.getCharacteristic(Target).value, Target.AWAY_ARM);
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);
  platform.handleLine('"A0013');
  assert.equal(area.service.getCharacteristic(Current).value, Current.AWAY_ARM);
});

test('periodic ASTATUS corrects a missed disarm but leaves Triggered alone', () => {
  const api = createApi();
  const platform = new TexecomPlatform(silentLog, config, api);
  api.emit('didFinishLaunching');
  const area = platform.areas.get(1);
  platform.handleLine('"A0013'); // armed at the keypad
  assert.equal(area.service.getCharacteristic(Current).value, Current.AWAY_ARM);
  platform.handleLine('"NN'); // the disarm event was lost; the poll reports not armed
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);

  platform.handleLine('"L0010'); // alarm (e.g. a 24-hour zone in a disarmed area)
  assert.equal(area.service.getCharacteristic(Current).value, Current.ALARM_TRIGGERED);
  platform.handleLine('"NN');
  assert.equal(area.service.getCharacteristic(Current).value, Current.ALARM_TRIGGERED);

  platform.firstStatusPending = true; // as set on (re)connect
  platform.handleLine('"NN');
  assert.equal(area.service.getCharacteristic(Current).value, Current.DISARMED);
});

test('Crestron Night/Home use the configured part arm (binary S), else \\Y as before', async () => {
  const Target = hap.Characteristic.SecuritySystemTargetState;
  for (const [overrides, target, expected] of [
    [{}, Target.NIGHT_ARM, 'Y\x01'],
    [{ night_part_arm: 1, home_part_arm: 2 }, Target.NIGHT_ARM, Buffer.from([0x05, 0x53, 0x00, 0x01, 0xa6])],
    [{ night_part_arm: 1, home_part_arm: 2 }, Target.STAY_ARM, Buffer.from([0x05, 0x53, 0x00, 0x02, 0xa5])],
    [{ night_part_arm: 1, home_part_arm: 2 }, Target.AWAY_ARM, 'A\x01'],
  ]) {
    const api = createApi();
    const platform = new TexecomPlatform(silentLog, { ...config, udl: '1234', ...overrides }, api);
    api.emit('didFinishLaunching');
    let sent = null;
    platform.connection = { sendCommands: async (commands) => {
      sent = commands;
    } };
    await platform.areas.get(1).setTargetState(target);
    assert.deepEqual(sent, ['W1234', expected]);
  }
});

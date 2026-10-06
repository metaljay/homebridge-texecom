'use strict';

/**
 * End-to-end: TexecomPlatform in Connect mode with real HAP characteristics
 * against a fake Connect panel modelled on the test system.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
const { TexecomPlatform } = require('../lib/platform');
const { FakeConnectPanel } = require('./fake-connect-panel');
const P = require('../lib/connect/protocol');

const C = hap.Characteristic;
const Current = C.SecuritySystemCurrentState;
const Target = C.SecuritySystemTargetState;
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const fast = { loginDelayMs: 10, commandTimeoutMs: 400, commandAttempts: 2, reconnectMinMs: 100 };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return;
    }
    await wait(20);
  }
  throw new Error('condition not met in time');
}

async function setup(extraConfig = {}) {
  const panel = new FakeConnectPanel();
  const port = await panel.listen();
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, accs) => api.registered.push(...accs);
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  const platform = new TexecomPlatform(silentLog, {
    name: 'Texecom', protocol: 'connect', ip_address: '127.0.0.1', ip_port: port, udl: '1234',
    _connectTiming: fast, ...extraConfig,
  }, api);
  api.emit('didFinishLaunching');
  await until(() => platform.areas.size === 1 && platform.connectPanel.areaStates.size === 1);
  return { panel, platform, api, area: platform.areas.get(1) };
}

function teardown({ panel, platform }) {
  platform.shutdown();
  panel.close();
}

test('discovers zones and areas from the panel', async () => {
  const ctx = await setup();
  try {
    assert.deepEqual([...ctx.platform.zones.keys()], [1, 2, 3, 4, 5]);
    assert.deepEqual([...ctx.platform.zones.values()].map((z) => z.zone.name), ['Hallway', 'Lounge', 'Kitchen', 'Garage', 'Landing']);
    assert.equal(ctx.area.area.name, 'HOUSE');
    assert.deepEqual(ctx.area.area.zones, [1, 2, 3, 4, 5]);
    assert.equal(ctx.api.registered.length, 6);
  } finally {
    teardown(ctx);
  }
});

test('live zone events update HomeKit sensors', async () => {
  const ctx = await setup();
  try {
    const landing = ctx.platform.zones.get(5).service.getCharacteristic(C.MotionDetected);
    ctx.panel.setZone(5, 1);
    await until(() => landing.value === true);
    ctx.panel.setZone(5, 2); // tamper
    const tamper = ctx.platform.zones.get(5).service.getCharacteristic(C.StatusTampered);
    await until(() => tamper.value === C.StatusTampered.TAMPERED);
    assert.equal(landing.value, false);
  } finally {
    teardown(ctx);
  }
});

test('Night from HomeKit arms Part Arm 1 and reports Night; Off disarms', async () => {
  const ctx = await setup();
  try {
    const current = ctx.area.service.getCharacteristic(Current);
    await ctx.area.setTargetState(Target.NIGHT_ARM);
    const arm = ctx.panel.commands.find((c) => c.cmd === P.COMMAND.ARM_AREA);
    assert.deepEqual(arm.args, [1, 0x01]); // Part Arm 1, area 1
    await until(() => current.value === Current.NIGHT_ARM);

    await ctx.area.setTargetState(Target.DISARM);
    await until(() => current.value === Current.DISARMED);
  } finally {
    teardown(ctx);
  }
});

test('Away arms Full; switching to Night disarms first (texecom2mqtt behaviour)', async () => {
  const ctx = await setup();
  try {
    const current = ctx.area.service.getCharacteristic(Current);
    await ctx.area.setTargetState(Target.AWAY_ARM);
    await until(() => current.value === Current.AWAY_ARM);
    ctx.panel.commands.length = 0;
    await ctx.area.setTargetState(Target.NIGHT_ARM);
    assert.deepEqual(ctx.panel.commands.map((c) => c.cmd), [P.COMMAND.DISARM_AREA, P.COMMAND.ARM_AREA]);
    await until(() => current.value === Current.NIGHT_ARM);
  } finally {
    teardown(ctx);
  }
});

test('alarm during the panel drop is picked up on reconnect; disarm resets first', async () => {
  const ctx = await setup();
  try {
    const current = ctx.area.service.getCharacteristic(Current);
    await ctx.area.setTargetState(Target.AWAY_ARM);
    await until(() => current.value === Current.AWAY_ARM);
    ctx.panel.dropForAlarm(); // "+++" and hang up, as when the SmartCom reports an alarm
    await until(() => current.value === Current.ALARM_TRIGGERED, 5000);

    ctx.panel.commands.length = 0;
    await ctx.area.setTargetState(Target.DISARM);
    assert.deepEqual(ctx.panel.commands.map((c) => c.cmd), [P.COMMAND.RESET_AREA, P.COMMAND.DISARM_AREA]);
    await until(() => current.value === Current.DISARMED);
  } finally {
    teardown(ctx);
  }
});

test('part_arm_* config maps Home to a chosen part arm', async () => {
  const ctx = await setup({ part_arm_1: 'night', part_arm_2: '', part_arm_3: 'stay' });
  try {
    const current = ctx.area.service.getCharacteristic(Current);
    await ctx.area.setTargetState(Target.STAY_ARM);
    assert.deepEqual(ctx.panel.commands.find((c) => c.cmd === P.COMMAND.ARM_AREA).args, [3, 0x01]);
    await until(() => current.value === Current.STAY_ARM);
  } finally {
    teardown(ctx);
  }
});

test('a refused command is reported to HomeKit as a communication failure', async () => {
  const ctx = await setup();
  try {
    ctx.panel.area = { state: 5, partArm: null };
    ctx.platform.connectPanel.areaStates.set(1, { state: 'disarmed', partArm: null }); // stale view: no reset sent
    await assert.rejects(ctx.area.setTargetState(Target.DISARM), (e) => e instanceof hap.HapStatusError);
  } finally {
    teardown(ctx);
  }
});

test('logs which zone caused an alarm (log event parameter)', async () => {
  const warnings = [];
  const panel = new FakeConnectPanel();
  const port = await panel.listen();
  const api = new EventEmitter();
  Object.assign(api, {
    hap, platformAccessory: PlatformAccessory,
    registerPlatformAccessories() {}, updatePlatformAccessories() {}, unregisterPlatformAccessories() {},
  });
  const log = { ...silentLog, warn: (m) => warnings.push(m) };
  const platform = new TexecomPlatform(log, {
    protocol: 'connect', ip_address: '127.0.0.1', ip_port: port, udl: '1234', _connectTiming: fast,
  }, api);
  api.emit('didFinishLaunching');
  try {
    await until(() => platform.areas.size === 1);
    panel.sendLog(3, 3, 3); // Interior zone alarm, group Alarm, zone 3
    await until(() => warnings.some((w) => /zone 3 \(Kitchen\) in alarm/.test(w)));
  } finally {
    platform.shutdown();
    panel.close();
  }
});

test('idle keep-alive re-reads state and catches a missed zone change', async () => {
  const ctx = await setup({ _connectTiming: { ...fast, keepaliveMs: 150 } });
  try {
    const kitchen = ctx.platform.zones.get(3).service.getCharacteristic(C.MotionDetected);
    ctx.panel.zoneState[3] = 1; // changes on the panel without an event message
    await until(() => kitchen.value === true, 3000);
  } finally {
    teardown(ctx);
  }
});

test('periodic re-reads do not restart a zone dwell timer', async () => {
  const ctx = await setup({ _connectTiming: { ...fast, keepaliveMs: 100 } });
  try {
    let calls = 0;
    const zone = ctx.platform.zones.get(5);
    const original = zone.setState.bind(zone);
    zone.setState = (s) => {
      calls++;
      original(s);
    };
    await wait(450); // several idle re-reads with no change
    assert.equal(calls, 0);
  } finally {
    teardown(ctx);
  }
});

test('failed start-up reads cause a reconnect and a clean retry', async () => {
  const panel = new FakeConnectPanel();
  // Panel ignores the first two zone-details requests (one full command with 2 attempts).
  panel.ignoreNext = { [P.COMMAND.GET_ZONE_DETAILS]: 2 };
  const port = await panel.listen();
  const api = new EventEmitter();
  Object.assign(api, {
    hap, platformAccessory: PlatformAccessory,
    registerPlatformAccessories() {}, updatePlatformAccessories() {}, unregisterPlatformAccessories() {},
  });
  const platform = new TexecomPlatform(silentLog, {
    protocol: 'connect', ip_address: '127.0.0.1', ip_port: port, udl: '1234', _connectTiming: fast,
  }, api);
  api.emit('didFinishLaunching');
  try {
    await until(() => platform.areas.size === 1 && platform.zones.size === 5, 5000);
    const logins = panel.commands.filter((c) => c.cmd === P.COMMAND.LOGIN).length;
    assert.equal(logins, 2); // reconnected once
  } finally {
    platform.shutdown();
    panel.close();
  }
});

test('time_sync_interval sets a drifted panel clock and leaves an accurate one alone', async () => {
  const ctx = await setup({ time_sync_interval: 24 });
  try {
    const panel = ctx.platform.connectPanel;
    ctx.panel.clockOffsetMs = 20 * 1000;
    assert.equal(await panel.syncClock(), false); // 20 s: within tolerance
    ctx.panel.clockOffsetMs = -5 * 60 * 1000;
    assert.equal(await panel.syncClock(), true); // 5 min behind: set
    assert.equal(ctx.panel.clockSetTo.length, 6);
  } finally {
    teardown(ctx);
  }
});

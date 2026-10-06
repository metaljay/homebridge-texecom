'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const P = require('../lib/connect/protocol');
const { ConnectClient } = require('../lib/connect/client');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function frame(type, sequence, body) {
  const f = Buffer.alloc(5 + body.length);
  f[0] = P.START;
  f[1] = type;
  f[2] = f.length;
  f[3] = sequence;
  body.copy(f, 4);
  f[f.length - 1] = P.crc8(f.subarray(0, f.length - 1));
  return f;
}

test('crc8 matches the CRC-8 (poly 0x85, init 0xFF) check value', () => {
  // Standard check input "123456789" for this parameter set.
  let crc = 0xff;
  for (const b of Buffer.from('123456789')) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x85) & 0xff : (crc << 1) & 0xff;
    }
  }
  assert.equal(P.crc8(Buffer.from('123456789')), crc);
});

test('encodeCommand builds a framed, checksummed command', () => {
  const f = P.encodeCommand(7, P.COMMAND.LOGIN, Buffer.from('1234'));
  assert.equal(f.toString('latin1', 0, 2), 'tC');
  assert.equal(f[2], f.length);
  assert.equal(f[3], 7);
  assert.equal(f[4], P.COMMAND.LOGIN);
  assert.equal(f.toString('latin1', 5, 9), '1234');
  assert.equal(f[f.length - 1], P.crc8(f.subarray(0, f.length - 1)));
});

test('FrameParser handles split, coalesced and corrupt frames and +++ drops', () => {
  const frames = [];
  const drops = [];
  const errors = [];
  const parser = new P.FrameParser({ onFrame: (f) => frames.push(f), onDrop: (r) => drops.push(r), onError: (e) => errors.push(e) });
  const a = frame(P.TYPE.MESSAGE, 1, Buffer.from([P.MESSAGE.ZONE, 3, 1]));
  const b = frame(P.TYPE.MESSAGE, 2, Buffer.from([P.MESSAGE.AREA, 1, 3]));
  const bad = Buffer.from(a);
  bad[bad.length - 1] ^= 0xff;
  parser.push(a.subarray(0, 3));
  parser.push(Buffer.concat([a.subarray(3), Buffer.from('xx'), b, bad]));
  assert.equal(frames.length, 2);
  assert.deepEqual(P.decodeMessage(frames[0].body), {
    kind: 'zone', zone: 3, raw: 1, state: 'active', fault: false, failedTest: false, alarmed: false,
    manualBypass: false, autoBypass: false, masked: false,
  });
  assert.equal(P.decodeMessage(frames[1].body).state, 'armed');
  assert.equal(errors.length, 2); // skipped garbage + bad CRC
  parser.push(Buffer.from('+++'));
  assert.equal(drops.length, 1);
});

test('decodes area state 6 (seen on a real panel) without throwing', () => {
  assert.deepEqual(P.decodeMessage(Buffer.from([P.MESSAGE.AREA, 1, 6])), {
    kind: 'area', area: 1, stateCode: 6, state: 'unknown (6)',
  });
});

test('decodes a log event (Remote Part Arm 1 style) and its packed time', () => {
  // type 207, group 6, parameter 0, area A, 2026-10-06 18:38:15
  const t = 15 | (38 << 6) | (10 << 12) | (18 << 16) | (6 << 21) | (26 << 26);
  const body = Buffer.alloc(9);
  body[0] = P.MESSAGE.LOG;
  body[1] = 207;
  body[2] = 6;
  body[3] = 0;
  body[4] = 1;
  body.writeUInt32LE(t >>> 0, 5);
  const m = P.decodeMessage(body);
  assert.equal(m.kind, 'log');
  assert.equal(m.type, 207);
  assert.equal(m.areas, 1);
  assert.deepEqual(m.time, { seconds: 15, minutes: 38, month: 10, hours: 18, day: 6, year: 2026 });
});

test('decodes panel identification, area and zone details', () => {
  assert.deepEqual(P.decodePanelIdentification(Buffer.from('Elite 24     V6.05.03LS1'.padEnd(32))), {
    text: 'Elite 24 V6.05.03LS1', model: 'Premier Elite', zones: 24, firmware: 'V6.05.03LS1',
  });
  const area = Buffer.alloc(25);
  area[0] = 1;
  Buffer.from('HOUSE').copy(area, 1);
  area.writeUInt16LE(15, 17);
  area.writeUInt16LE(15, 19);
  assert.equal(P.decodeAreaDetails(area).name, 'HOUSE');
  assert.equal(P.decodeAreaDetails(area).exitDelay, 15);
  const zone = Buffer.alloc(34);
  zone[0] = 1;
  zone[1] = 1;
  Buffer.from('Hallway').copy(zone, 2);
  assert.deepEqual(P.decodeZoneDetails(zone), { type: 1, areaBitmap: 1n, name: 'Hallway' });
});

/** Minimal fake SmartCom speaking the Connect framing. */
async function startFakePanel({ udl = '1234', dropAfterLogin = false } = {}) {
  const server = net.createServer((socket) => {
    const parser = new P.FrameParser({
      onFrame: ({ type, sequence, body }) => {
        if (type !== P.TYPE.COMMAND) {
          return;
        }
        const cmd = body[0];
        const reply = (payload) => socket.write(frame(P.TYPE.RESPONSE, sequence, Buffer.concat([Buffer.from([cmd]), payload])));
        if (cmd === P.COMMAND.LOGIN) {
          reply(Buffer.from([body.subarray(1).toString() === udl ? P.ACK : P.NAK]));
          if (dropAfterLogin) {
            setTimeout(() => socket.write('+++'), 50);
          }
        } else if (cmd === P.COMMAND.SET_EVENT_MESSAGES) {
          reply(Buffer.from([P.ACK]));
          setTimeout(() => socket.write(Buffer.concat([
            frame(P.TYPE.MESSAGE, 0, Buffer.from([P.MESSAGE.ZONE, 1, 1])),
            frame(P.TYPE.MESSAGE, 1, Buffer.from([P.MESSAGE.AREA, 1, 1])),
          ])), 20);
        } else if (cmd === P.COMMAND.GET_PANEL_IDENTIFICATION) {
          reply(Buffer.from('Elite 24     V6.05.03LS1'.padEnd(32)));
        }
      },
    });
    socket.on('data', (d) => parser.push(d));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('client logs in, subscribes, reads panel id and receives events', async () => {
  const server = await startFakePanel();
  const client = new ConnectClient({ log: silentLog, host: '127.0.0.1', port: server.address().port, udl: '1234' });
  const messages = [];
  client.on('message', (m) => messages.push(m));
  const ready = once(client, 'ready');
  client.start();
  await ready;
  const id = await client.panelIdentification();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(id.zones, 24);
  assert.deepEqual(messages.map((m) => `${m.kind}:${m.state}`), ['zone:active', 'area:in exit']);
  client.stop();
  server.close();
});

test('client reports a rejected UDL and a panel-initiated drop', async () => {
  const server = await startFakePanel({ dropAfterLogin: true });
  const warnings = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };
  const bad = new ConnectClient({ log, host: '127.0.0.1', port: server.address().port, udl: '9999' });
  bad.start();
  await new Promise((r) => setTimeout(r, 700));
  bad.stop();
  assert.ok(warnings.some((w) => /login rejected/.test(w)), warnings.join('\n'));

  warnings.length = 0;
  const good = new ConnectClient({ log, host: '127.0.0.1', port: server.address().port, udl: '1234' });
  good.start();
  await new Promise((r) => setTimeout(r, 800));
  good.stop();
  server.close();
  assert.ok(warnings.some((w) => /\+\+\+/.test(w)), warnings.join('\n'));
});

test('arm/disarm/reset bodies use the area bitmap sized for the panel', () => {
  assert.deepEqual([...P.encodeArm(1, P.ARM_TYPE.PART_1, 24)], [1, 0x01]); // 2 areas -> 1 byte
  assert.deepEqual([...P.encodeArm(2, P.ARM_TYPE.FULL, 24)], [0, 0x02]);
  assert.deepEqual([...P.encodeDisarmOrReset(9, 168)], [0x00, 0x01]); // 16 areas -> 2 bytes
  assert.equal(P.encodeDisarmOrReset(64, 640).length, 8); // 64 areas -> 8 bytes
  assert.equal(P.encodeDisarmOrReset(64, 640)[7], 0x80);
  assert.deepEqual([...P.encodeGetZoneState(1, 24, 24)], [1, 24]);
  assert.deepEqual([...P.encodeGetZoneState(300, 10, 640)], [0x2c, 0x01, 10]);
});

test('area flags decode to disarmed / armed / part armed / in alarm', () => {
  const flags = Buffer.alloc(72); // 1-byte bitmaps, flags 0..71
  flags[P.AREA_FLAG.ARMED] = 0b01; // area 1 armed
  flags[P.AREA_FLAG.PART_ARM_1] = 0b01; // ... in part arm 1
  flags[P.AREA_FLAG.ALARM] = 0b10; // area 2 in alarm
  assert.deepEqual(P.decodeAreaFlags(flags, [1, 2], 24), {
    1: { state: 'part armed', partArm: 1 },
    2: { state: 'in alarm', partArm: null },
  });
  assert.deepEqual(P.decodeAreaFlags(Buffer.alloc(72), [1], 24), { 1: { state: 'disarmed', partArm: null } });
});

test('client arms, disarms and reads zone/area state from a fake panel', async () => {
  const commands = [];
  const server = net.createServer((socket) => {
    const parser = new P.FrameParser({
      onFrame: ({ sequence, body }) => {
        const cmd = body[0];
        commands.push([cmd, ...body.subarray(1)]);
        const reply = (payload) => socket.write(frame(P.TYPE.RESPONSE, sequence, Buffer.concat([Buffer.from([cmd]), payload])));
        if (cmd === P.COMMAND.GET_ZONE_STATE) {
          reply(Buffer.from([0x01, 0x00, 0x02]));
        } else if (cmd === P.COMMAND.GET_AREA_FLAGS) {
          const f = Buffer.alloc(72);
          f[P.AREA_FLAG.ARMED] = 1;
          reply(f);
        } else {
          reply(Buffer.from([P.ACK]));
        }
      },
    });
    socket.on('data', (d) => parser.push(d));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new ConnectClient({ log: silentLog, host: '127.0.0.1', port: server.address().port, udl: '1234' });
  const ready = once(client, 'ready');
  client.start();
  await ready;
  const zones = await client.zoneStates(3);
  const areas = await client.areaStates([1], 24);
  assert.equal(await client.arm(1, P.ARM_TYPE.PART_1, 24), true);
  assert.equal(await client.disarm(1, 24), true);
  client.stop();
  server.close();
  assert.deepEqual([zones[1].state, zones[2].state, zones[3].state], ['active', 'secure', 'tamper']);
  assert.deepEqual(areas, { 1: { state: 'armed', partArm: null } });
  assert.deepEqual(commands.slice(-2), [[P.COMMAND.ARM_AREA, 1, 1], [P.COMMAND.DISARM_AREA, 1]]);
});

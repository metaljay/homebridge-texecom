'use strict';

/**
 * Fake Texecom Connect panel modelled on the test system (Premier Elite 24,
 * five zones in area 1 "HOUSE"). Used by tests and for manual runs:
 *
 *   node test/fake-connect-panel.js [port]
 */

const net = require('node:net');
const P = require('../lib/connect/protocol');

const ZONES = [
  { number: 1, name: 'Hallway', type: 1 },
  { number: 2, name: 'Lounge', type: 3 },
  { number: 3, name: 'Kitchen', type: 3 },
  { number: 4, name: 'Garage', type: 3 },
  { number: 5, name: 'Landing', type: 3 },
];

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

function logBody(type, group, parameter, areas) {
  const now = new Date();
  const t = now.getSeconds() | (now.getMinutes() << 6) | ((now.getMonth() + 1) << 12) | (now.getHours() << 16)
    | (now.getDate() << 21) | ((now.getFullYear() - 2000) << 26);
  const b = Buffer.alloc(9);
  b[0] = P.MESSAGE.LOG;
  b[1] = type;
  b[2] = group;
  b[3] = parameter;
  b[4] = areas;
  b.writeUInt32LE(t >>> 0, 5);
  return b;
}

class FakeConnectPanel {
  constructor({ udl = '1234', exitMs = 50 } = {}) {
    this.udl = udl;
    this.exitMs = exitMs;
    this.zoneState = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    this.area = { state: 0, partArm: null };
    this.commands = [];
    this.sockets = new Set();
    this.msgSeq = 0;
    this.server = net.createServer((socket) => this._onSocket(socket));
  }

  listen(port = 0) {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    this.sockets.forEach((s) => s.destroy());
    this.server.close();
  }

  _onSocket(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    const parser = new P.FrameParser({ onFrame: (f) => this._onFrame(socket, f) });
    socket.on('data', (d) => parser.push(d));
  }

  send(body) {
    const f = frame(P.TYPE.MESSAGE, this.msgSeq, body);
    this.msgSeq = (this.msgSeq + 1) & 0xff;
    this.sockets.forEach((s) => s.write(f));
  }

  setZone(number, state) {
    this.zoneState[number] = state;
    this.send(Buffer.from([P.MESSAGE.ZONE, number, state]));
  }

  setArea(state, partArm = null) {
    this.area = { state, partArm };
    this.send(Buffer.from([P.MESSAGE.AREA, 1, state]));
  }

  /** Simulates the panel dropping the session to report an alarm. */
  dropForAlarm() {
    this.area = { state: 5, partArm: this.area.partArm };
    this.sockets.forEach((s) => {
      s.write('+++');
      s.destroy();
    });
  }

  _onFrame(socket, { type, sequence, body }) {
    if (type !== P.TYPE.COMMAND) {
      return;
    }
    const cmd = body[0];
    const args = body.subarray(1);
    this.commands.push({ cmd, args: [...args] });
    const reply = (payload) => socket.write(frame(P.TYPE.RESPONSE, sequence, Buffer.concat([Buffer.from([cmd]), payload])));
    const ack = () => reply(Buffer.from([P.ACK]));
    switch (cmd) {
      case P.COMMAND.LOGIN:
        reply(Buffer.from([args.toString('latin1') === this.udl ? P.ACK : P.NAK]));
        break;
      case P.COMMAND.SET_EVENT_MESSAGES:
      case P.COMMAND.GET_DATE_TIME:
        ack();
        break;
      case P.COMMAND.GET_PANEL_IDENTIFICATION:
        reply(Buffer.from('Elite 24     V6.05.03LS1'.padEnd(32)));
        break;
      case P.COMMAND.GET_ZONE_DETAILS: {
        const z = ZONES.find((x) => x.number === args[0]);
        const d = Buffer.alloc(34);
        if (z) {
          d[0] = z.type;
          d[1] = 0x01;
          Buffer.from(z.name).copy(d, 2);
        }
        reply(d);
        break;
      }
      case P.COMMAND.GET_AREA_DETAILS: {
        const d = Buffer.alloc(25);
        d[0] = args[0];
        if (args[0] === 1) {
          Buffer.from('HOUSE').copy(d, 1);
        }
        d.writeUInt16LE(15, 17);
        d.writeUInt16LE(15, 19);
        reply(d);
        break;
      }
      case P.COMMAND.GET_ZONE_STATE: {
        const [start, count] = args;
        const states = Buffer.alloc(count);
        for (let i = 0; i < count; i++) {
          states[i] = this.zoneState[start + i] || 0;
        }
        reply(states);
        break;
      }
      case P.COMMAND.GET_AREA_FLAGS: {
        const flags = Buffer.alloc(args[1]);
        const { state, partArm } = this.area;
        if (state === 5) {
          flags[P.AREA_FLAG.ALARM] = 1;
        } else if (state === 3) {
          flags[P.AREA_FLAG.ARMED] = 1;
          flags[P.AREA_FLAG.FULL_ARMED] = 1;
        } else if (state === 4) {
          flags[P.AREA_FLAG.ARMED] = 1;
          flags[P.AREA_FLAG.PART_ARMED] = 1;
          flags[P.AREA_FLAG.PART_ARM_1 + (partArm - 1)] = 1;
        }
        reply(flags);
        break;
      }
      case P.COMMAND.ARM_AREA: {
        const armType = args[0];
        ack();
        this.setArea(1);
        setTimeout(() => {
          if (armType === 0) {
            this.setArea(3);
          } else {
            this.send(logBody(206 + armType, 6, 0, 1)); // Remote Part Arm n
            this.setArea(4, armType);
            this.send(Buffer.from([P.MESSAGE.AREA, 1, 6])); // observed on a real panel
          }
        }, this.exitMs);
        break;
      }
      case P.COMMAND.DISARM_AREA:
        if (this.area.state === 5 && !this.wasReset) {
          reply(Buffer.from([P.NAK]));
          break;
        }
        this.wasReset = false;
        ack();
        this.setArea(0);
        break;
      case P.COMMAND.RESET_AREA:
        this.wasReset = true;
        ack();
        break;
      default:
        reply(Buffer.from([P.NAK]));
    }
  }
}

module.exports = { FakeConnectPanel, ZONES };

if (require.main === module) {
  const panel = new FakeConnectPanel({ exitMs: 3000 });
  panel.listen(Number(process.argv[2]) || 10001).then((port) => console.log(`fake Connect panel on 127.0.0.1:${port}`));
}

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { TexecomConnection } = require('../lib/connection');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Fake COM-IP: replies to each `\...\/` command via the supplied handler. */
async function startPanel(onCommand) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      for (const match of data.toString('latin1').matchAll(/\\([^/]*)\//g)) {
        received.push(match[1]);
        onCommand(match[1], socket);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    received,
    broadcast: (text) => sockets.forEach((s) => s.write(text)),
    close: () => {
      sockets.forEach((s) => s.destroy());
      server.close();
    },
  };
}

async function connect(port) {
  const conn = new TexecomConnection({ log: silentLog, host: '127.0.0.1', port });
  const connected = once(conn, 'connected');
  conn.start();
  await connected;
  return conn;
}

test('emits complete lines from fragmented TCP data', async () => {
  const panel = await startPanel(() => {});
  const conn = await connect(panel.port);
  const lines = [];
  conn.on('line', (l) => lines.push(l));

  panel.broadcast('"Z00');
  await new Promise((r) => setTimeout(r, 20));
  panel.broadcast('71\r\n"A00117\r\n');
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(lines, ['"Z0071', '"A00117']);
  conn.stop();
  panel.close();
});

test('runs a login + arm transaction and resolves on OK', async () => {
  const panel = await startPanel((_cmd, socket) => socket.write('OK\r\n'));
  const conn = await connect(panel.port);

  await conn.sendCommands(['W1234', 'A\x10']);
  assert.deepEqual(panel.received, ['W1234', 'A\x10']);

  // Give any stray timers a chance to fire: nothing further must be sent.
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(panel.received.length, 2);

  conn.stop();
  panel.close();
});

test('transactions never interleave', async () => {
  const panel = await startPanel((_cmd, socket) => setTimeout(() => socket.write('OK\r\n'), 30));
  const conn = await connect(panel.port);

  await Promise.all([
    conn.sendCommands(['W1234', 'A\x01']),
    conn.sendCommands(['W1234', 'D\x02']),
  ]);
  assert.deepEqual(panel.received, ['W1234', 'A\x01', 'W1234', 'D\x02']);

  conn.stop();
  panel.close();
});

test('rejects when not connected', async () => {
  const conn = new TexecomConnection({ log: silentLog, host: '127.0.0.1', port: 1 });
  await assert.rejects(conn.sendCommands(['W1234']), /Not connected/);
});

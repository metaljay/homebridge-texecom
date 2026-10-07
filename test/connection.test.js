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

test('logs out (Wintex 03 48 B4) after a UDL transaction and holds queries during the blackout', async () => {
  const raw = [];
  const panel = await startPanel((_cmd, socket) => socket.write('OK\r\n'));
  const conn = await connect(panel.port);
  // capture raw bytes the plugin writes
  const origWrite = conn.transport.write.bind(conn.transport);
  conn.transport.write = (data, cb) => {
    raw.push(Buffer.from(data));
    return origWrite(data, cb);
  };
  await conn.sendCommands(['W1234', 'A\x01']);
  assert.ok(raw.some((b) => b.equals(Buffer.from([0x03, 0x48, 0xb4]))), 'logout sent');
  assert.equal(conn.inBlackout, true);
  assert.equal(conn.sendQuery('ASTATUS'), false); // would only get a binary reply now
  conn.stop();
  panel.close();
});

/** Fake Crestron port that answers ASTATUS lines while `answering` is true. */
async function startStatusPanel() {
  const state = { answering: true, queries: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      for (const _match of data.toString('latin1').matchAll(/ASTATUS\r\n/g)) {
        void _match;
        state.queries++;
        if (state.answering) {
          socket.write('"NN\r\n');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.port = server.address().port;
  state.close = () => {
    sockets.forEach((s) => s.destroy());
    server.close();
  };
  return state;
}

test('polls ASTATUS while connected and stays connected while the panel answers', async () => {
  const panel = await startStatusPanel();
  const conn = new TexecomConnection({ log: silentLog, host: '127.0.0.1', port: panel.port, statusPollMs: 40 });
  let disconnected = false;
  conn.on('disconnected', () => {
    disconnected = true;
  });
  const replies = [];
  conn.on('line', (l) => replies.push(l));
  conn.start();
  await once(conn, 'connected');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(panel.queries >= 4, `expected several polls, got ${panel.queries}`);
  assert.ok(replies.every((l) => l === '"NN'));
  assert.equal(disconnected, false);
  conn.stop();
  panel.close();
});

test('reconnects when the panel stops answering (bridge up, panel silent)', { timeout: 5000 }, async () => {
  const panel = await startStatusPanel();
  panel.answering = false;
  const warnings = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m) };
  const conn = new TexecomConnection({ log, host: '127.0.0.1', port: panel.port, statusPollMs: 30 });
  conn.start();
  await once(conn, 'connected');
  await once(conn, 'disconnected');
  assert.ok(warnings.some((m) => /No reply from the panel/.test(m)));
  conn.stop();
  panel.close();
});

test('no ASTATUS poll is sent during a transaction or the post-logout blackout', async () => {
  const panel = await startStatusPanel();
  const conn = new TexecomConnection({ log: silentLog, host: '127.0.0.1', port: panel.port, statusPollMs: 20 });
  conn.start();
  await once(conn, 'connected');
  conn.blackoutUntil = Date.now() + 10000;
  const before = panel.queries;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(panel.queries, before);
  assert.equal(conn.connected, true, 'silence during a blackout must not force a reconnect');
  conn.stop();
  panel.close();
});

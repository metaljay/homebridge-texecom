'use strict';

/**
 * Replays a recorded panel session to a connecting plugin, preserving how
 * messages were grouped into TCP chunks.
 *
 *   node tools/replay-panel.js test/fixtures/real-session-2026-10-06.json [port] [msPerChunk]
 *
 * Commands from the plugin are acknowledged with OK, as the fake panel does.
 */

const fs = require('node:fs');
const net = require('node:net');

const [file, portArg, gapArg] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(file, 'utf8'));
const port = Number(portArg) || 10001;
const gap = Number(gapArg) || 150;

net.createServer((socket) => {
  console.log('client connected, replaying', session.chunks.length, 'chunks');
  socket.on('error', () => {});
  socket.on('data', (d) => {
    for (const m of d.toString('latin1').matchAll(/\\([^/]*)\//g)) {
      console.log('<-', JSON.stringify(m[1]));
      setTimeout(() => socket.write('OK\r\n'), 50);
    }
  });

  session.chunks.forEach(([, messages], i) => {
    setTimeout(() => {
      socket.write(messages.map((m) => `${m}\r\n`).join(''));
      if (i === session.chunks.length - 1) {
        console.log('replay complete');
      }
    }, 1000 + i * gap);
  });
}).listen(port, '127.0.0.1', () => console.log(`replay panel on 127.0.0.1:${port}`));

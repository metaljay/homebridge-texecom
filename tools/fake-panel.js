'use strict';

/**
 * Fake Texecom COM-IP panel for manual end-to-end testing without hardware.
 *
 *   node tools/fake-panel.js [port]
 *
 * Point a test Homebridge instance at 127.0.0.1:<port> (default 10001).
 * The panel acknowledges every command with OK after a short delay, reports
 * an arm made through the Crestron interface as user 25, and lets you type
 * raw panel messages on stdin (e.g. "Z0071" or "L001") to send them to every
 * connected client. Prefix a line with "+" to send it in the same TCP packet
 * as the next line, to exercise line framing.
 */

const net = require('node:net');
const readline = require('node:readline');

const port = Number(process.argv[2]) || 10001;
const ACK_DELAY_MS = 300;
const clients = new Set();

const server = net.createServer((socket) => {
  clients.add(socket);
  console.log(`client connected (${clients.size})`);
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`client disconnected (${clients.size})`);
  });
  socket.on('error', () => {});

  socket.on('data', (data) => {
    for (const match of data.toString('latin1').matchAll(/\\([^/]*)\//g)) {
      const command = match[1];
      const bytes = [...Buffer.from(command, 'latin1')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`<- ${JSON.stringify(command)}  [${bytes}]`);

      setTimeout(() => {
        socket.write('OK\r\n');
        // Report an arm/disarm the way the panel does once it has happened.
        const letter = command.charAt(0);
        if ('AYD'.includes(letter) && command.length > 1) {
          const mask = command.charCodeAt(1);
          for (let area = 1; area <= 8; area++) {
            if (mask & (1 << (area - 1))) {
              const event = letter === 'D' ? 'D' : 'A';
              socket.write(`"${event}${String(area).padStart(3, '0')}25\r\n`);
            }
          }
        }
      }, ACK_DELAY_MS);
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake panel listening on 127.0.0.1:${port}`);
  console.log('type a message such as Z0071 (zone 7 active) or L001 (area 1 alarm)');
});

let pending = '';
readline.createInterface({ input: process.stdin }).on('line', (input) => {
  const text = input.trim();
  if (!text) {
    return;
  }
  if (text.startsWith('+')) {
    pending += `"${text.slice(1)}\r\n`;
    return;
  }
  const payload = `${pending}"${text}\r\n`;
  pending = '';
  clients.forEach((c) => c.write(payload));
  console.log(`-> ${JSON.stringify(payload)}`);
});

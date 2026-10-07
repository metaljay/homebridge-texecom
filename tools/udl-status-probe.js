#!/usr/bin/env node
'use strict';

/**
 * Read-only UDL (Wintex protocol) probe: logs in, reads a few volatile-state
 * addresses and logs out. Never arms, disarms, presses keys or writes.
 *
 *   node tools/udl-status-probe.js <host> [port] --udl-from <homebridge config.json>
 *
 * Point it at a SmartCom/ComIP in normal mode (as Wintex does), not at the
 * Crestron port the plugin is using: a UDL session on the Crestron port holds
 * back its event feed for ~30 s.
 *
 * Only these frames are ever sent: Z (hello and login), R (volatile read, from
 * the fixed list below) and H (logout). Config reads (O) are deliberately not
 * used, because config memory includes user codes. The UDL code is read from
 * the Texecom platform in the given config.json and is never printed.
 *
 * Addresses are from shuckc/pytexalarm (protocol/wintex-protocol.md, Elite 24
 * V4.02) and ricol99/casa (src/things/alarmtexecom.js); this probe checks
 * whether they hold on other firmware.
 */

const fs = require('node:fs');
const net = require('node:net');

const READS = [
  { address: 0x003069, size: 0x06, what: 'real-time clock' },
  { address: 0x0017b6, size: 0x02, what: 'area state (pytexalarm: 03 ready, 02 alarm)' },
  { address: 0x0017c2, size: 0x04, what: 'armed flags (pytexalarm: 01.. full, ..01.. part)' },
  { address: 0x0017b2, size: 0x40, what: 'status block (casa: part arm 1/2/3 and full arm flags)' },
  { address: 0x001196, size: 0x22, what: 'keypad screen' },
];
const REPLY_TIMEOUT_MS = 8000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** [len][cmd][payload…][checksum], checksum makes the byte sum 0xFF. */
function frame(cmd, payload = []) {
  const bytes = [payload.length + 3, cmd, ...payload];
  const sum = bytes.reduce((a, b) => a + b, 0);
  return Buffer.from([...bytes, (0xff - sum) & 0xff]);
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function ascii(buf) {
  return [...buf].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
}

async function main() {
  const host = process.argv[2];
  const port = Number(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 10001);
  const udlFrom = arg('--udl-from');
  if (!host || !udlFrom) {
    console.log('usage: udl-status-probe.js <host> [port] --udl-from <config.json>');
    process.exit(2);
  }
  const platform = JSON.parse(fs.readFileSync(udlFrom, 'utf8')).platforms.find((p) => p.platform === 'Texecom');
  const udl = String(platform.udl).trim();
  console.log(`Using the UDL code from ${udlFrom} (${udl.length} digits)`);

  const sock = net.createConnection({ host, port });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  console.log(`Connected to ${host}:${port}`);

  let buffer = Buffer.alloc(0);
  let waiter = null;
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0 && buffer.length >= buffer[0]) {
      const len = buffer[0];
      if (len < 3) {
        console.log(`  unexpected bytes: ${hex(buffer)}`);
        buffer = Buffer.alloc(0);
        break;
      }
      const f = buffer.subarray(0, len);
      buffer = buffer.subarray(len);
      const ok = (f.reduce((a, b) => a + b, 0) & 0xff) === 0xff;
      if (!ok) {
        console.log(`  bad checksum: ${hex(f)}`);
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(f);
      } else {
        console.log(`  unsolicited: ${hex(f)}`);
      }
    }
  });

  const request = (buf, label) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiter = null;
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    waiter = (f) => {
      clearTimeout(timer);
      resolve(f);
    };
    console.log(`-> ${label}`);
    sock.write(buf);
  });

  let loggedIn = false;
  try {
    const hello = await request(frame(0x5a), 'Z hello');
    if (!hello) {
      console.log('   no reply: this port does not seem to accept UDL');
      return;
    }
    console.log(`<- ${hello.length} bytes, command ${hex(hello.subarray(1, 2))} (serial number not shown)`);

    const login = await request(frame(0x5a, [...Buffer.from(udl, 'latin1')]), 'Z login (UDL hidden)');
    if (!login) {
      console.log('   no reply to login');
      return;
    }
    if (login[1] === 0x06) {
      console.log(`<- ${hex(login)}  bare ACK = login rejected (wrong UDL?)`);
      return;
    }
    loggedIn = true;
    console.log(`<- ${hex(login)}  "${ascii(login.subarray(2, -1)).trim()}"`);

    for (const r of READS) {
      const addr = [(r.address >> 16) & 0xff, (r.address >> 8) & 0xff, r.address & 0xff];
      const reply = await request(frame(0x52, [...addr, r.size]), `R 0x${r.address.toString(16).padStart(6, '0')} x${r.size} (${r.what})`);
      if (!reply) {
        console.log('   no reply');
        continue;
      }
      if (reply[1] !== 0x57) {
        console.log(`<- ${hex(reply)}  (not a W reply)`);
        continue;
      }
      const data = reply.subarray(6, -1);
      for (let i = 0; i < data.length; i += 16) {
        const row = data.subarray(i, i + 16);
        const at = (r.address + i).toString(16).padStart(6, '0');
        console.log(`   ${at}: ${hex(row).padEnd(47)}  ${ascii(row)}`);
      }
    }
  } finally {
    if (loggedIn) {
      const bye = await request(frame(0x48), 'H logout');
      console.log(bye ? `<- ${hex(bye)}` : '   no reply to logout');
    }
    sock.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * Read-only test of the Texecom Connect client against a real panel
 * (SmartCom/ComIP in normal mode). Never arms, disarms or resets anything.
 *
 *   node tools/connect-probe.js <host> [port] --udl-from <homebridge config.json> [--listen <seconds>]
 *
 * Logs in, reads panel identification, clock, power, keypad text, area and
 * zone details and current zone/area states, then prints live events.
 * The UDL code is read from the Texecom platform in the given config.json
 * and is never printed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ConnectClient } = require(path.join(__dirname, '..', 'lib', 'connect', 'client'));
const P = require(path.join(__dirname, '..', 'lib', 'connect', 'protocol'));

const LOG_TYPES = {
  31: 'User Code', 32: 'Exit Started', 34: 'Entry Started', 37: 'Open/Close (Away Armed)', 38: 'Part Armed',
  41: 'Open After Alarm', 42: 'Remote Open/Close', 53: 'Download Start', 54: 'Download End', 78: 'Part Arm 1',
  85: 'Arm Failed', 113: 'Remote Command', 207: 'Remote Part Arm 1',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const t0 = Date.now();
const stamp = () => `${new Date().toTimeString().slice(0, 8)} (t=${((Date.now() - t0) / 1000).toFixed(1).padStart(6)})`;
const log = {
  info: (m) => console.log(`  ${stamp()} ${m}`),
  warn: (m) => console.log(`  ${stamp()} WARN ${m}`),
  error: (m) => console.log(`  ${stamp()} ERROR ${m}`),
  debug: () => {},
};

async function main() {
  const host = process.argv[2];
  const port = Number(process.argv[3]) || 10001;
  const udlFrom = arg('--udl-from');
  const listen = Number(arg('--listen', 120));
  if (!host || !udlFrom) {
    console.log('usage: connect-probe.js <host> [port] --udl-from <config.json> [--listen <seconds>]');
    process.exit(1);
  }
  const platform = JSON.parse(fs.readFileSync(udlFrom, 'utf8')).platforms.find((p) => p.platform === 'Texecom');
  const udl = String(platform.udl).trim();
  console.log(`Using the UDL code from ${udlFrom} (${udl.length} digits)`);

  const client = new ConnectClient({ log, host, port, udl });
  client.on('message', (m) => {
    if (m.kind === 'log') {
      const t = m.time;
      log.info(`LOG  ${LOG_TYPES[m.type] || `type ${m.type}`} group=${m.group} param=${m.parameter} areas=${m.areas} at ${String(t.hours).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}:${String(t.seconds).padStart(2, '0')}`);
    } else if (m.kind === 'zone') {
      log.info(`ZONE ${m.zone} ${m.state}${m.alarmed ? ' (alarmed)' : ''}${m.fault ? ' (fault)' : ''}`);
    } else if (m.kind === 'area') {
      log.info(`AREA ${m.area} ${m.state}`);
    } else {
      log.info(`${m.kind.toUpperCase()} ${JSON.stringify(m)}`);
    }
  });

  const ready = new Promise((resolve) => client.once('ready', resolve));
  client.start();
  await ready;

  const id = await client.panelIdentification();
  log.info(`panel: ${id.model} ${id.zones} zones, firmware ${id.firmware}`);
  log.info(`clock: ${JSON.stringify(await client.dateTime())}`);
  log.info(`power: ${JSON.stringify(await client.systemPower())}`);
  log.info(`keypad: ${JSON.stringify(await client.lcdDisplay())}`);
  const areaNumbers = Array.from({ length: P.AREAS_FOR_ZONES[id.zones] || 1 }, (_, i) => i + 1);
  for (const a of areaNumbers) {
    const d = await client.areaDetails(a);
    log.info(`area ${a}: ${d ? `"${d.name}" exit ${d.exitDelay}s entry ${d.entry1Delay}s` : 'n/a'}`);
  }
  const zoneStates = await client.zoneStates(id.zones);
  for (let z = 1; z <= id.zones; z++) {
    const d = await client.zoneDetails(z);
    if (d && d.type !== 0) {
      log.info(`zone ${z}: "${d.name}" type ${d.type}, areas ${d.areaBitmap}, now ${zoneStates[z] ? zoneStates[z].state : '?'}`);
    }
  }
  log.info(`area states: ${JSON.stringify(await client.areaStates(areaNumbers, id.zones))}`);
  log.info(`listening for events for ${listen}s (move around; nothing is armed by this script)`);
  await new Promise((r) => setTimeout(r, listen * 1000));
  client.stop();
  log.info('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

# Review notes for the maintainer

**For:** Chris Posthumus (maintainer of `homebridge-texecom-full`)
**From:** Jordan Fern ([metaljay/homebridge-texecom](https://github.com/metaljay/homebridge-texecom)), prepared with Claude Code
**Date:** 6 October 2026
**Compared against:** your `4.4.0-beta.0` branch at `674be7c` (*Add panel clock sync*, 4.4.0-beta.1 in the changelog)

---

## Summary

I forked `master` (4.3.0) and reviewed it against current Homebridge plugin practice. That produced a set of fixes and a restructured "v5" version of the plugin, which is in this repository.

Afterwards I found your `4.3.1-beta.x` and `4.4.0-beta.x` branches. They had already fixed many of the same problems, and in several places your fixes are better than mine, particularly the accessory UUID compatibility with 4.2.8 and 4.3.0. **I'm not asking you to merge the v5 rewrite.** That would discard your beta work and orphan every user's accessories.

This document lists:

1. what your beta already fixes, so you can skip those parts of the v5 code;
2. **the problems that are still present in `4.4.0-beta.1`**, with evidence and a small suggested patch against *your* code for each;
3. how the v5 version is structured, in case you ever want to adopt some or all of it.

Everything marked *Reproduced* was run against your beta branch using real Homebridge (1.11.4) and a fake COM-IP panel. The panel is included as [`tools/fake-panel.js`](../tools/fake-panel.js), so you can repeat the tests.

Items marked **Confirmed on real hardware** were observed on Jordan's live installation: your published `4.4.0-beta.1`, Homebridge 2.4.0, Node 24, Docker on a Raspberry Pi, and a COM-IP at `192.168.2.10:23`. The plugin's own `debug` log was the only instrumentation; no packet capture was used.

---

## 1. Already fixed in your beta (nothing to do)

| Problem in 4.3.0 | Fixed in your beta | v5 equivalent |
|---|---|---|
| First HomeKit arm/disarm ignored (`setByAlarm` never cleared) | 4.3.1-beta.0 (#26) | `lib/areaAccessory.js` |
| Accessories published as external accessories | 4.3.1-beta.0, plus the `external_accessories` opt-in for 4.3.0 installs | `lib/platform.js` |
| Accessories not cached, stale ones not removed | 4.3.1-beta.0 | `lib/platform.js` |
| Areas matched by position in the config, so a missing or reordered area crashes | 4.3.1-beta.0 | `lib/platform.js` |
| Retry timer not cleared after `OK`, so a second login is sent | 4.3.1-beta.0 | `lib/connection.js` |
| Area bitmask wrong for areas 5–8 | 4.3.1-beta.2 | `lib/protocol.js` |
| Area 8 bitmask sent as two bytes | 4.4.0-beta.1 | `lib/protocol.js` |
| `engines.homebridge` excluded 1.x | 4.3.1-beta.0 | `package.json` |
| Unused `crypto-js` | 4.3.1-beta.0 | `package.json` |

**Your beta does several things v5 does not. Anything merged from v5 should keep them:**

- **UUIDs compatible with 4.2.8 (`Texecom:<name>`) and 4.3.0.** v5 uses a new scheme, `homebridge-texecom-full:zone:7`, which would make every existing user re-pair and rebuild their automations. That part of v5 should **not** be adopted.
- **Configurable `remote_users` / `default_arm_state`** (#25). v5 has now adopted this with the same config keys and the same order of checks (remote user, then the HomeKit request, then the default). Before that, real-panel testing showed v5 reporting keypad arms as Night.
- **User numbers above 99.** v5 now parses them the same way as your regex.
- **Combined areas and panel clock sync.**

---

## 2. Still present in `4.4.0-beta.1`

### 2.0 Real-world impact: lost keypad disarms cause false alarms in HomeKit (*Confirmed on real hardware*)

This is the most serious finding, and it combines 2.1 with the zone-trigger behaviour described below. Jordan ran three keypad tests on `4.4.0-beta.1`: arm then disarm; arm, walk in, disarm during the entry delay; arm, walk in and let the alarm sound, then disarm. Afterwards he reported that **"the HomeKit notifications throughout that exercise were well off"**. The debug log shows why:

- The panel sends "user entered code" and "disarmed" a fraction of a second apart, so they often arrive in **one** TCP chunk: `"U0030\r\n"D0013\r\n`. Because of 2.1, the beta processed the `U` and **dropped the disarm, twice out of three times**.
- `areas_armed` therefore still contained area 1. For the rest of the session, every hallway or kitchen movement produced `Area 001 manual triggered`: **six false "alarm triggered" states in two minutes** while the panel was disarmed.
- HomeKit was left showing **Triggered** until Homebridge was restarted.

The whole session, with the original TCP chunking, is in [`test/fixtures/real-session-2026-10-06.json`](../test/fixtures/real-session-2026-10-06.json). `node tools/replay-panel.js test/fixtures/real-session-2026-10-06.json` replays it to any build. Replayed against both versions:

| | 4.4.0-beta.1 | v5 |
|---|---|---|
| Keypad disarms seen | 1 of 3 | 3 of 3 |
| False "triggered" states | 6 | 0 |
| Real alarm (`"L0010`) shown | yes | yes |
| Final HomeKit state | **Triggered** (panel was disarmed) | Disarmed |

`test/real-session.test.js` runs the same replay through v5 as an automated test.

**Zone-inferred alarms misfire on every normal homecoming, even with 2.1 fixed.** When an away-armed area has a zone go active, the beta marks the area as triggered (`manual triggered`). But walking in through the entry route *is* a zone going active while armed. The panel sends `"E0010` (entry delay), you disarm, and nothing is wrong. At 15:32:22 the beta would have raised a false alarm here if that zone message hadn't been lost in the same chunk as the `E`. The panel reports real alarms itself, and gets them right. In the third test Jordan came in through the hallway, which is on the entry route, so the panel sent `"E0010` (entry delay). He then walked into the kitchen, which isn't, so the panel sent `"L0010` (full alarm) at 15:33:02 and reported the kitchen zone a second later. Only the panel knows which zones are entry routes and which are immediate. The plugin can't, so any inference from zone activity will be wrong one way or the other. **Suggestion:** rely on `L`, and make zone inference opt-in for panels that don't send `L`. If it is kept, it should ignore activity between `E` and the following `D`/`L`. v5 does both (`trigger_from_zones`, default off). The trade-off of that guard: on a panel that *doesn't* send `L`, walking from an entry-route zone into an immediate zone during the entry delay wouldn't be shown. That's one more reason to rely on `L` wherever the panel provides it.

**Messages your panel sends that the plugin doesn't yet recognise** (all confirmed by Jordan's test sequence; user 3 is his code):

| Message | Meaning |
|---|---|
| `"U0030` | User 003 entered a code at a keypad |
| `"X0010` | Area 001 exit delay started |
| `"E0010` | Area 001 entry delay started |
| `"A0013` / `"D0013` | Area 001 armed / disarmed by user 3 (user number is variable width, as your regex already allows) |
| `"L0010` | Area 001 alarm |

`X` could drive HomeKit's "Arming…" display: set the target state while the current state stays disarmed. `E` could give an "entry delay" notification.


They're listed most severe first. Line numbers refer to `index.js` on `4.4.0-beta.0` at `674be7c`.

### 2.1 IP connection: messages lost when TCP packets contain more than one line (*Reproduced*)

**Where:** `setupConnection()`, lines 349–354. Each TCP `data` chunk goes straight to `processData()`, which trims it and parses only the start.

**Why it matters:** TCP has no message boundaries. When the panel sends events close together, several lines arrive in one chunk, and one line can also be split across two chunks. With a COM-IP:

- Every zone or area event after the first in a chunk is dropped.
- A chunk such as `"Z0071\r\nOK\r\n` fails the `trim() === 'OK'` check in `writeCommandAndWaitForOK`. The command times out and is resent.

Serial users aren't affected, because the serial path already goes through `ReadlineParser`.

**Reproduction:** the fake panel sent `"Z0071\r\n"Z0151\r\n` in a single write. On your beta, *Living Room* went active but *Front Door* stayed closed. On v5, both updated.

**Confirmed on real hardware (6 Oct 2026).** In about a minute of walking past sensors, **3 of 23 TCP chunks from the COM-IP carried more than one message**. Every message after the first in each chunk was dropped, which lost 5 zone events:

| Chunk (from `IP data received:` debug lines) | Processed | Lost |
|---|---|---|
| `"X0010` `"Z0051` `"Z0011` `"Z0050` | `"X0010` (logged as unknown) | Landing active, Hallway active, Landing clear |
| `"Z0011` `"Z0031` | Hallway active | Kitchen active |
| `"U0030` `"Z0010` | `"U0030` (logged as unknown) | Hallway clear, so Hallway showed motion until its next event |

This is the most user-visible issue in the list: motion automations and alerts silently miss events on IP installs.

**Suggested patch:** run the socket through the same `ReadlineParser` the serial path uses, but keep the raw stream for the clock reader. `serialport` v12 already exports `ReadlineParser`, so `@serialport/parser-readline` can be dropped as well.

```js
// setupConnection()
const { ReadlineParser } = require('serialport');

var connection = net.createConnection(platform.ip_port, platform.ip_address);
connection.setNoDelay(true);
connection.setKeepAlive(true, 30000);          // see 2.6

const lines = connection.pipe(new ReadlineParser({ delimiter: '\n' }));

connection.on('data', (data) => responseEmitter.emit('raw', data));   // clock reader
lines.on('data', (line) => {
    platform.log.debug(`IP data received: ${line}`);
    responseEmitter.emit('data', line);
    processData(line);
});
```

### 2.2 Commands from different sources interleave (*Reproduced*)

**Where:** `areaTargetSecurityStateSet()` (line 842) and `_syncPanelClock()` (line 466). Both call `writeCommandAndWaitForOK` independently, and every waiting call accepts the first `OK` from anyone.

**Why it matters:** if HomeKit arms two areas at once (a scene, or a combined area plus one of its members), or the clock sync runs while someone arms, the panel receives `W…, W…, A…, A…`. The first `OK` resolves *both* waiting promises, so each command's result can be credited to the other. If one command fails, the other can still be reported as successful.

**Confirmed on real hardware: the panel is slower than the 2-second timeout.** Arming area 1 from HomeKit on a real COM-IP gave:

```
15:23:07  Sending command 1 to area 001      (W<udl> written)
15:23:10  IP data received: OK               3 s after the login was written
15:23:12  IP data received: OK               reply to the arm command
```

The login's 2-second timer had already expired and resent it before the first `OK` arrived. So every arm on this installation probably sends a duplicate login, and an `OK` can arrive while a *different* command is waiting. "Probably" because the beta doesn't log retries, so this is inferred from the timing. That makes the mis-matching described above a realistic risk rather than a theoretical one. Suggest raising the timeout to around 5 s, and logging retries at debug level.

**Reproduction:** two areas were armed in one HomeKit write. Your beta sent `W0123, W0123, A\x01, A\x20`. v5 sent `W0123, A\x01, W0123, A\x20`. Your beta only succeeded because the fake panel acknowledges everything.

**Suggested patch:** a module-level promise chain, so each "login + command" sequence runs as a unit:

```js
let commandChain = Promise.resolve();
function exclusive(task) {
    const run = commandChain.then(task);
    commandChain = run.catch(() => {});   // keep the chain alive after a failure
    return run;
}

// areaTargetSecurityStateSet():
exclusive(() => writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
    .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command)))
    .then(() => { /* existing success handling */ })

// _syncPanelClock(): wrap the login + T? read, and separately the login + set.
```

### 2.3 Errors are not logged unless debug is on

**Where:** `util/logutil.js`.

- `error()` only prints when `isDebug` is true. Connection errors, out-of-range areas and unknown target states are therefore invisible in a normal log.
- The constructor's `this.log = log` replaces the class's own `log()` method, so the timestamp/prefix code never runs. `platform.log.log(...)` actually calls Homebridge's logger directly. It works, but by accident.
- `debug()` writes with `console.log`, outside Homebridge's logger, so it ignores child-bridge prefixes and log levels.

**Suggested patch:** replace `LogUtil` with a thin wrapper around the Homebridge logger. The plugin's own `debug` option can still promote debug lines to info.

```js
function createLogger(log, debugEnabled) {
    return {
        log:   (...a) => log.info(...a),   // keeps existing platform.log.log() calls working
        info:  (...a) => log.info(...a),
        warn:  (...a) => log.warn(...a),
        error: (...a) => log.error(...a),
        debug: debugEnabled ? (m, ...a) => log.info(`[debug] ${m}`, ...a)
                            : (...a) => log.debug(...a),
    };
}
```

### 2.4 An area without `area_type` becomes a motion sensor (*Reproduced*)

**Where:** `TexecomAccessory`, line 625: `config["zone_type"] || config["area_type"] || "motion"`.

**Why it matters:** the README's per-area table says `area_type` defaults to `"securitysystem"`. An area entry without it (the schema doesn't require it) is published as a **motion sensor**.

**Suggested patch:** set `kind` at the call site, which you already pass, and use it:

```js
this.zone_type = this.kind === "area" ? "securitysystem" : (config["zone_type"] || "motion");
```

### 2.5 Areas show "Disarmed" after every restart

**Where:** `setupServices()`, line 760: `changeAction(DISARMED)` runs on every start.

**Why it matters:** if Homebridge restarts while the house is armed, HomeKit shows disarmed until the next panel event, which could be hours away. "When disarmed" automations can also fire falsely. `areas_armed` (used for zone-triggered alarms) is lost too, so an intrusion right after a restart doesn't show as triggered.

**Suggested patch:** keep the last state in `hapAccessory.context`, which Homebridge saves in its accessory cache.

```js
const ctx = hapAccessory.context;
changeAction(ctx.lastState ?? Characteristic.SecuritySystemCurrentState.DISARMED);
// in changeAction():   ctx.lastState = newState; platform.api.updatePlatformAccessories([hapAccessory]);
// (and the same for the area's entry in areas_armed)
```

v5 does this in `lib/areaAccessory.js`. In testing, the restored state was reported correctly after a restart.

### 2.6 Connection resilience

- **Serial never reconnects.** If the USB adapter disconnects, or isn't present at boot, the plugin stays offline until Homebridge restarts. v5 reopens the port with exponential back-off (`lib/connection.js`).
- **TCP has no keep-alive.** COM-IP and NAT devices drop idle sockets silently, and without keep-alive the plugin may not notice. Add `connection.setKeepAlive(true, 30000)`.
- **Reconnect delay is a fixed 10 seconds,** which is fine but noisy during long outages. v5 starts at 5 seconds and doubles up to 60.
- **No `shutdown` handler.** Add `api.on('shutdown', …)` to close the socket or port and clear the reconnect timer, so Homebridge restarts cleanly.

### 2.7 Dwell timers can stack

**Where:** `changeHandler`, lines 790–791. A new dwell timer is started without clearing the previous one. With a zone that goes active, clear, active, clear quickly, the first timer can mark the zone clear while it is actually active.

```js
if (me.dwell_timer) clearTimeout(me.dwell_timer);
if (!newState && me.dwell_time > 0) { me.dwell_timer = setTimeout(...); } else { changeAction(newState); }
```

### 2.8 Dependencies

| Package | Issue | Suggestion |
|---|---|---|
| `string` | **High-severity advisory, no fix available** ([GHSA-g36h-6r4f-3mqp](https://github.com/advisories/GHSA-g36h-6r4f-3mqp), regex DoS). Range `>=3.3.3` is unbounded. Flagged by `npm audit` on your beta. | Replace with `startsWith` / `slice` / a regex, as you already do for area messages. |
| `zpad` | Unmaintained since 2022 | `String(n).padStart(3, '0')` |
| `debug` | Imported (line 1) but never used | Remove |
| `@serialport/parser-readline` | `serialport` v12 already exports `ReadlineParser` | Remove |
| `engines.node` `>=18.20.4` | Node 18 is end-of-life | `^20.18.0 \|\| ^22.10.0 \|\| ^24.0.0` (Homebridge's supported set) |

### 2.9 Config schema

- **`udl` is `"type": "integer"`,** so a UDL of `0123` is saved as `123` and the panel rejects the login. `minLength`/`maxLength` don't apply to integers. Suggest `"type": "string", "pattern": "^[0-9]{4,6}$"`, and `String(config.udl)` in code so existing numeric configs still work.
- **`headerDisplay` says "Official Texecom Homebridge plugin".** Texecom doesn't publish it, so this may cause trademark or verification problems.
- **Type mismatch:** `zone_number` and `area_number` are strings, but an area's `zones` are integers. The code copes, but the UI is inconsistent.

### 2.10 Smaller items

- `onSet` rejects with a plain `Error`. HAP-NodeJS turns that into a communication failure but logs a warning as if the plugin had crashed. Throwing `new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)` is the intended way to report it.
- Zone and area messages are handled inside the `data` event with no `try/catch`. Any unexpected exception, such as an odd message, would crash the whole Homebridge process. A `try/catch` around `processData` costs nothing.
- Accessory Information says Manufacturer "Homebridge". "Texecom" is more accurate. Changing it doesn't affect identity.

---

## 3. Proposals that need checking against real hardware

These are in v5 but are **not verified on a panel**. I'd ask you before relying on them.

- **Tamper reporting.** v5 sets HomeKit `StatusTampered` when a zone status digit is anything other than `0` or `1`. I believe `2` is tamper in the Crestron protocol, but haven't confirmed it.
- **Arm state shown immediately after `OK`.** Both your beta and v5 show the target state as soon as the panel acknowledges, rather than waiting for the arm event after the exit delay. This matches the old behaviour, so I've left it alone.

---

## 4. Suggested route

If any of section 2 is useful, the least disruptive way to bring it in is **one small pull request per item against your `4.4.0-beta` branch**, using the patches above, rather than merging the v5 restructure. Each one is easy to review and revert. I can prepare those branches if you'd like.

The v5 structure (section 5) is there as a reference if you ever want to split `index.js` into modules and add tests. The protocol and connection tests in `test/` would carry over with little change.

---

## 5. How the v5 version is organised

```
index.js                 Entry point: registers the platform, nothing else
lib/settings.js          PLUGIN_NAME / PLATFORM_NAME / defaults
lib/platform.js          Dynamic platform: cache restore, config validation, accessory
                         reconciliation, routing panel messages to accessories, shutdown
lib/connection.js        TCP or serial transport, line framing, reconnect with back-off,
                         TCP keep-alive, serialised command queue (sendCommands)
lib/protocol.js          Pure functions: parseLine(), LineSplitter, areaBitmask(),
                         encodeCommand(). No I/O, so fully unit-testable
lib/zoneAccessory.js     One zone → one HomeKit sensor, dwell timer, tamper
lib/areaAccessory.js     One area → HomeKit SecuritySystem, onSet → panel commands,
                         state persisted in accessory.context
test/                    node:test unit tests (protocol parsing, line framing, bitmask,
                         command queue against a local TCP server)
tools/fake-panel.js      Fake COM-IP panel for manual end-to-end testing
eslint.config.js         ESLint 9 flat config
```

**Data flow:** the transport produces bytes, `LineSplitter` turns them into lines, `connection` emits `'line'`, and `platform.handleLine()` calls `parseLine()`, then `ZoneAccessory.update()` or `AreaAccessory.handlePanelEvent()`, then `updateValue()`.

**Command flow:** HomeKit calls `onSet`. `AreaAccessory.setTargetState()` then calls `connection.sendCommands(['W<udl>', 'A<mask>'])`. That call joins the queue, writes each command and waits for `OK` or `ERROR` with a 2-second timeout and one retry. When it resolves, HomeKit gets the new state; when it rejects, HomeKit gets a `HapStatusError`.

**Adding a feature in this structure:**

- *New panel message:* add a case to `parseLine()` with a test, then handle it in `platform.handleLine()`.
- *New zone type:* add an entry to `ZONE_TYPES` in `lib/zoneAccessory.js` and to the `zone_type` list in `config.schema.json`.
- *New command (for example clock set):* call `connection.sendCommands([...])`. Queueing, retry and `OK` matching are handled for you. Binary payloads go through `encodeCommand()`, which uses latin1, so every byte is sent as one byte.

**Running the checks:**

```bash
npm install
npm run lint
npm test
node tools/fake-panel.js          # then point a test Homebridge at 127.0.0.1:10001
```

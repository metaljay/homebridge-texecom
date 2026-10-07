# Review of homebridge-texecom-full

**For:** Chris Posthumus, maintainer of `homebridge-texecom-full`
**From:** [metaljay/homebridge-texecom](https://github.com/metaljay/homebridge-texecom), prepared with Claude Code
**Reviewed:** release `4.4.0` (same code as `4.4.0-beta.1`). Line numbers refer to its `index.js`.

Everything here was tested on a real **Premier Elite 24 (firmware V6.05.03)** with Homebridge 2.4 on a Raspberry Pi. The panel has a SmartCom on Com Port 1 and a Crestron port (Com Port 3) bridged to the network by an ESP8266 serial server, so both protocols could be watched side by side. Items marked *Reproduced* were also run against 4.4.0 with a fake panel ([`tools/fake-panel.js`](../tools/fake-panel.js)), so you can repeat them.

## Contents

1. [Summary](#1-summary)
2. [Bugs in 4.4.0](#2-bugs-in-440)
3. [How the panel behaves](#3-how-the-panel-behaves)
4. [What the fork adds, and why](#4-what-the-fork-adds-and-why)
5. [Suggested route](#5-suggested-route)
6. [Testing done](#6-testing-done)
7. [Other projects and credits](#7-other-projects-and-credits)

---

## 1. Summary

### Most important findings

| # | Problem in 4.4.0 | Effect | Fix |
|---|---|---|---|
| 1 | Each TCP packet is parsed as one message ([2.1](#21-messages-lost-when-a-tcp-packet-holds-more-than-one)) | Keypad disarms lost (2 of 3 in a test), leading to **6 false "Triggered" alarms in 2 minutes** | Split the stream into lines |
| 2 | Alarms inferred from zone activity ([2.2](#22-zone-inferred-alarms-misfire-on-every-normal-entry)) | False alarm on every normal entry through the entry route | Use the panel's own alarm message (`"L`) |
| 3 | UDL login never logged out ([2.3](#23-every-command-from-homekit-blacks-out-the-panel-for-60-s)) | Every arm/disarm from HomeKit silences **all** panel events for ~60 s; a real alarm reached HomeKit 65 s late | Binary logout `03 48 B4` (cuts it to ~30 s) |
| 4 | 2 s command timeout; commands from different sources interleave ([2.4](#24-commands-interleave-and-the-timeout-is-too-short)) | Duplicate logins on every arm; `OK`s credited to the wrong command | A command queue and an 8 s login timeout |
| 5 | Areas reset to Disarmed on restart ([2.5](#25-areas-show-disarmed-after-every-restart)) | Wrong state, possibly for hours | Persist the state, and ask the panel (`ASTATUS`) on connect |
| 6 | Clock sync uses the machine's time zone ([2.12](#212-clock-sync-sets-the-wrong-time-when-homebridge-runs-on-utc)) | Homebridge in Docker runs on UTC, so in summer the panel is set an hour wrong | A configurable time zone; never shift by whole hours without one |
| 7 | `string` dependency ([2.10](#210-dependencies)) | High-severity advisory, no fix available | Remove it |

### What the fork adds

- **Texecom Connect support** ([4.1](#41-texecom-connect-support)): works with a SmartCom left in its normal mode, which is how most users own their hardware. Zones and areas are found automatically, arm modes are exact, and there's no blackout after HomeKit commands.
- **Crestron improvements** ([4.2](#42-crestron-improvements)): the exact part arm for Night/Home, a regular status check that catches missed events and dead links, and fixes for problems found on the real panel.
- **Choice of arm buttons in the Home app** ([4.3](#43-choosing-the-home-app-arm-buttons)), and a **settings page and README rewritten for end users** ([4.4](#44-settings-page-and-readme)).

**Suggested route:** small patches against your code for section 2, keeping your accessory identities; Connect as a self-contained addition. See [section 5](#5-suggested-route).

---

## 2. Bugs in 4.4.0

Most serious first.

### 2.1 Messages lost when a TCP packet holds more than one

*Reproduced, and confirmed on the real panel.*

**What happens.** `setupConnection()` (lines 349–354) passes each TCP `data` chunk to `processData()`, which parses only its start. TCP has no message boundaries, and the panel often sends events close together, so one chunk can hold several lines. Every line after the first is dropped. A chunk such as `"Z0071\r\nOK\r\n` also fails the `trim() === 'OK'` check, so the command times out and is resent. Serial users aren't affected: that path already uses `ReadlineParser`.

**Evidence.** In a minute of walking past sensors, 3 of 23 chunks held more than one message, losing 5 zone events. In a keypad test, "code entered" and "disarmed" (`"U0030` + `"D0013`) arrived together, and **2 of 3 disarms were lost**. The plugin still believed the area was armed, so every movement afterwards raised `Area 001 manual triggered`: **6 false alarms in 2 minutes**, with HomeKit left on Triggered. The session, with its original chunking, is in [`test/fixtures/real-session-2026-10-06.json`](../test/fixtures/real-session-2026-10-06.json), and [`tools/replay-panel.js`](../tools/replay-panel.js) replays it to any build:

| | 4.4.0 | Fork |
|---|---|---|
| Keypad disarms seen | 1 of 3 | 3 of 3 |
| False "Triggered" | 6 | 0 |
| Final HomeKit state | **Triggered** (panel disarmed) | Disarmed |

**Fix.** Run the socket through the same `ReadlineParser` as the serial path (`serialport` v12 exports it, so `@serialport/parser-readline` can go):

```js
const { ReadlineParser } = require('serialport');
const connection = net.createConnection(platform.ip_port, platform.ip_address);
connection.setNoDelay(true);
connection.setKeepAlive(true, 30000);
const lines = connection.pipe(new ReadlineParser({ delimiter: '\n' }));
connection.on('data', (data) => responseEmitter.emit('raw', data));   // clock reader
lines.on('data', (line) => { responseEmitter.emit('data', line); processData(line); });
```

After a UDL session the stream also carries binary frames with no line ending (see [2.3](#23-every-command-from-homekit-blacks-out-the-panel-for-60-s)). Drop any valid frame (`[len][type]…[checksum]`, byte sum `& 0xFF == 0xFF`) before splitting lines, or the next message is lost.

### 2.2 Zone-inferred alarms misfire on every normal entry

*Confirmed on the real panel.*

**What happens.** When a zone in an away-armed area goes active, the plugin marks the area Triggered. But walking in through the entry route is exactly that: a zone going active while armed. The panel starts the entry delay (`"E0010`) and you disarm. Only the panel knows which zones are entry routes, and it reports real alarms itself (`"L0010`), correctly. In the test, the hallway (entry route) gave `"E`, and walking on into the kitchen (immediate) gave `"L`.

**Fix.** Use `"L` for Triggered. Make zone inference opt-in for panels that don't send `L`, and ignore activity between `"E` and the following `"D`/`"L`. The fork does both (`trigger_from_zones`, off by default).

### 2.3 Every command from HomeKit blacks out the panel for ~60 s

*Confirmed on the real panel, with Texecom Connect (via the SmartCom) as an independent reference feed.*

**What happens.** Each command starts with `\W<udl>/`, which switches the Crestron port into a Wintex/UDL session. While that session is open the port sends **nothing**: no zone changes, no arm events, no alarms. Everything is held and released in one burst when the session times out, about 60 s after the last command. Nothing is lost, but in one test a **real alarm reached HomeKit 65 s late** and all motion sensors were frozen for 2½ minutes. The clock sync logs in too, so each sync causes the same blackout.

**Measured:**

| | Feed silent for |
|---|---|
| No logout (4.4.0) | ~60 s after the last command |
| Binary Wintex logout `03 48 B4` (answered `03 06 F6`) | ~30 s after the logout; a fixed panel timer that polling doesn't shorten |
| `\H/` (TexecomManager's logout) | Answered `ERROR` on this firmware; no effect |
| UDL session on a *different* port (e.g. Wintex via the SmartCom) | Not silent: the Crestron feed stays live |

**Fix.** Send `03 48 B4` straight after each command sequence. Before parsing lines, drop the binary frames the session sends (the ACK arrives glued to the next text line). In the plugin, on the real panel, this cut HomeKit's blind spot from ~68 s to ~39 s per command, with every held message processed. Also avoid unnecessary logins: `LSTATUS` shows the panel clock without one, so the clock sync only needs to log in when it actually corrects the time. Removing the blind spot entirely needs a path without a UDL session, which is what Texecom Connect gives ([4.1](#41-texecom-connect-support)).

### 2.4 Commands interleave, and the timeout is too short

*Reproduced; timing confirmed on the real panel.*

**What happens.** `areaTargetSecurityStateSet()` (line 842) and `_syncPanelClock()` (line 466) call `writeCommandAndWaitForOK` independently, and any waiting call accepts the first `OK`. Two arms at once (a scene, or a combined area plus a member) send `W…, W…, A…, A…`, and each result can be credited to the other. The panel also took **3–6 s** to answer a login, so the 2 s timer resends it every time. On this panel the login often isn't answered with `OK` at all, although the session opens.

**Fix.** Run each "login + command" sequence as one unit on a promise chain, and allow ~8 s for the login:

```js
let commandChain = Promise.resolve();
function exclusive(task) {
    const run = commandChain.then(task);
    commandChain = run.catch(() => {});
    return run;
}
exclusive(() => writeCommandAndWaitForOK(conn, `W${platform.udl}`)
    .then(() => writeCommandAndWaitForOK(conn, command)));
```

Don't treat a missing `OK` to the login as failure on its own; the command that follows tells you whether the session opened.

### 2.5 Areas show Disarmed after every restart

**What happens.** `setupServices()` (line 760) sets every area to Disarmed on start. If Homebridge restarts while the house is armed, HomeKit shows Disarmed until the next panel event, and "when disarmed" automations can fire.

**Fix.** Keep the last state in `hapAccessory.context` (saved in Homebridge's accessory cache), and send `ASTATUS` on connect: the panel answers `"YN` (one letter per area, Y = armed) without a login.

### 2.6 Errors aren't logged unless debug is on

`util/logutil.js`: `error()` only prints when debug is on, so connection errors and rejected commands are invisible. The constructor's `this.log = log` also replaces the class's own `log()`, and `debug()` writes with `console.log`, outside Homebridge's logger. **Fix:** a thin wrapper around the Homebridge logger, with the plugin's `debug` option promoting debug lines to info.

### 2.7 An area without `area_type` becomes a motion sensor

*Reproduced.* Line 625: `config["zone_type"] || config["area_type"] || "motion"`. The schema doesn't require `area_type`, and the README says it defaults to `securitysystem`. **Fix:** decide by kind: `this.kind === "area" ? "securitysystem" : (config["zone_type"] || "motion")`.

### 2.8 Connection resilience

- **Serial never reconnects** if the adapter disconnects or is missing at boot.
- **No TCP keep-alive**, so a silently dropped connection isn't noticed: `setKeepAlive(true, 30000)`.
- **No `shutdown` handler** to close the socket and clear timers.
- **A live TCP link doesn't prove the panel is answering.** A serial-to-network adapter can stay connected after its serial side fails. A periodic `ASTATUS` (the fork uses 60 s) catches that, and also corrects HomeKit after any missed event.

### 2.9 Dwell timers can stack

Lines 790–791 start a new dwell timer without clearing the previous one, so a zone toggling quickly can be marked clear while active. **Fix:** `clearTimeout` before starting a new one.

### 2.10 Dependencies

| Package | Issue | Suggestion |
|---|---|---|
| `string` | High-severity advisory with no fix ([GHSA-g36h-6r4f-3mqp](https://github.com/advisories/GHSA-g36h-6r4f-3mqp)); unbounded range `>=3.3.3` | Replace with `startsWith` / `slice` |
| `zpad` | Unmaintained | `String(n).padStart(3, '0')` |
| `debug` | Imported, never used | Remove |
| `@serialport/parser-readline` | `serialport` v12 exports `ReadlineParser` | Remove |
| `engines.node` `>=18.20.4` | Node 18 is end-of-life | `^20.18.0 \|\| ^22.10.0 \|\| ^24.0.0` |

### 2.11 Settings page

- **`udl` is an integer**, so `0123` is saved as `123` and the login fails. Make it a string (`"pattern": "^[0-9]{4,8}$"`) and use `String(config.udl)` so existing configs still work.
- **Numbers with both a minimum and a maximum render as sliders** in the Homebridge UI, so `time_sync_interval` (0–744) is a slider with no visible value. Drop the maximum, or set the layout type to `number`.
- **`headerDisplay` says "Official Texecom Homebridge plugin"**, but Texecom doesn't publish it.

### 2.12 Clock sync sets the wrong time when Homebridge runs on UTC

*Confirmed on the real panel (in the fork's Connect clock check, which worked the same way; fixed there).*

**What happens.** The clock sync compares the panel with `new Date()` in the machine's local time (lines 1107–1123) and sets the panel to it. The Homebridge Docker image runs on **UTC** unless `TZ` is set, while the panel shows local time. In UK summer time, the sync found the panel "3558 s ahead" and set it an hour back.

**Fix.** Add a `time_zone` setting (e.g. `Europe/London`) and compute the panel's wall-clock time in that zone (`Intl.DateTimeFormat` with `timeZone`). Without one, never apply a difference of about a whole number of hours: log a warning instead. The fork does both.

### 2.13 Smaller items

- **Messages not recognised:** the panel also sends `"U` (user code entered), `"X` (exit delay started), `"E` (entry delay) and `"L` (alarm); see [3.1](#31-crestron-messages). `"X` can drive the Home app's "Arming…".
- **User numbers:** this panel reports HomeKit arms as **user 29** and remote disarms as **user 0**. The `app_users` / `remote_users` defaults (25, 254) don't match, which supports keeping them configurable.
- `onSet` rejects with a plain `Error`; `throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)` is the intended way.
- No `try/catch` around `processData`, so one odd message can crash Homebridge.
- Manufacturer shows as "Homebridge"; "Texecom" is more accurate.

---

## 3. How the panel behaves

Confirmed on the V6.05.03 panel unless stated.

### 3.1 Crestron messages

| Message | Meaning |
|---|---|
| `"Z` + zone + `0` / `1` / `2` | Zone secure / active / tamper (`2` per TexecomManager) |
| `"U` + user | Code entered at a keypad |
| `"X` + area | Exit delay started |
| `"E` + area | Entry delay started |
| `"A` + area + user / `"D` + area + user | Armed / disarmed (user number is variable width) |
| `"L` + area | Alarm |
| `ASTATUS` → `"NN` | One letter per area, Y = armed. **No login needed** |
| `LSTATUS` → `"      HOME      08:11.42 Wed 07` | The keypad screen, including the clock; shows `* PART ARMED *` while part-armed. **No login needed** |

The panel doesn't say whether an arm was full or part: `LSTATUS` can tell, but not which part arm.

### 3.2 The UDL session on the Crestron port

- `\W<udl>/` opens a **binary Wintex/UDL session** (frames `[len][cmd][payload][checksum]`, byte sum `0xFF`; ACK `03 06 F6`, NAK `03 0F ED`). Text queries sent during it are answered with `03 0F ED`.
- The login is often **not** answered with `OK`, but the session opens. When it isn't, text commands that follow may be answered `ERROR` while binary ones work.
- **Binary commands work inside that session** (from [ricol99/casa](https://github.com/ricol99/casa) and [shuckc/pytexalarm](https://github.com/shuckc/pytexalarm); part arm and disarm confirmed here):

| Command | Frame (area 1) |
|---|---|
| Full arm | `04 41 00 BA` |
| Part arm *n* | `05 53 00 0n cs` (e.g. Part Arm 1: `05 53 00 01 A6`) |
| Disarm | `04 44 00 B7` |
| Logout | `03 48 B4` |

  The Crestron `\Y` command only ever reaches Part Arm 1; `S 00 0n` reaches 1, 2 or 3.
- **Keypad emulation (`KEY<digit>`) is ignored** on this firmware, with CR LF, LF or no line ending.
- **Memory addresses are firmware-specific.** The status addresses pytexalarm and casa read on V4.02 (clock `0x003069`, area state `0x0017B6`…) return zeros on V6.05.03, so a plugin shouldn't read state by address.
- An ACK isn't proof a command was carried out; take the result from the events and `ASTATUS` that follow.

### 3.3 Texecom Connect

- **When an alarm is reported, the panel deliberately drops the Connect session** to send its own alarm notification (the Texecom app's push still arrives). A client must reconnect and re-read the state. On a SmartCom shared with the app, the drop comes as `ATH0`/`ATZ`.
- The panel **never reports an alarm ending**, and an arm that fails in the exit delay sends no area event. Re-read the area flags periodically; the fork does it every 30 s, which also keeps the session alive (it drops after ~60 s idle).
- State reads can be answered with a **1-byte NAK** just after a burst of events. Treat it as "try again", never as data (as data, `0x15` reads as "zone 1 active" or "area in alarm").
- After "Part Armed 1" the panel sends an undocumented area state **6**, and a flag re-read straight after can still show the **exit flag**.
- Bulk area-flag reads work here (72 bytes); some older firmware refuses them, so fall back to one flag at a time.
- Wintex can connect through the same SmartCom while a Connect client is connected.
- A SmartCom **refuses a new session for about a minute** after the last one closed (a restart, or the drop at alarm time); meanwhile a login gets either a closed socket or 80-byte replies that aren't frames. Keep retrying; don't treat it as a wrong UDL.
- **Switching arm mode** (disarm, then arm) produces an area "disarmed" event **0.3 s** before the new exit delay. Passed straight to HomeKit, that shows (and may notify) Disarmed in between.
- **Zone alarms are logged twice**: once when they happen and once when reported (`communicated` set). Sometimes only the second arrives, after the disarm; the zone's state byte has its *alarmed* bit (0x10) set at once, which is the quicker way to name the zone.
- **ARM_FAILED (log type 85) carries the zone** that stopped the arm in `parameter`, one log per active zone (zones that see you at the end of the exit time; the panel sounds its "fail to set" warning).
- Area state **7** follows Part Arm 2 the way 6 follows Part Arm 1 ("settled").
- **Tampers that aren't zones** are log events with group 11 (tamper) and 12 (restored): type **60** *Panel Box Tamper* (the lid, the keypad shows "Panel Lid Tamper") and **62** *Auxiliary Tamper*. On this install every detector's tamper is on the shared auxiliary circuit, so the panel can't say which detector was opened, and zone tamper states never change. Names for all log types are in texecom-connect.
- **Mains failure**: *AC Fail* (type 47, group 9) arrives at once, but the restore was **never logged** (waited 14 minutes, twice). The power reading (command 25) shows it: on battery both currents read **0** and the voltage falls (13.0 → 12.2 V in 2 minutes); on mains ~300 mA at ~13.6 V. Reading it every keep-alive gives the restore within 30 s, and the right answer after a restart.
- **A total power loss resets the panel clock** (to 31 Oct 2023 on V6.05.03), so clock sync matters on reconnect, not only daily.
- The keypad text (command 13) shows alerts, e.g. "System Alerts!" or "Panel Lid Tamper", with the clock on the second line.

### 3.4 HomeKit

- HomeKit gives up on a set request after about **9 s**, so answer `onSet` quickly and apply the outcome when the panel confirms.
- iOS caches an alarm's `validValues` (the arm buttons) for an accessory it already knows; a change only shows on a new accessory.
- The security system service has optional **StatusTampered** and **StatusFault** characteristics; the fork sets them from the panel's tampers and faults (including mains, from the power reading), so the Home app shows them on the alarm.

---

## 4. What the fork adds, and why

### 4.1 Texecom Connect support

**Why:** most users own a **SmartCom**. With Crestron they must switch its COM port over, which loses the Texecom app and its notifications. Connect uses the SmartCom as it is.

| | Crestron | Connect |
|---|---|---|
| SmartCom | COM port switched to Crestron System | Left as it is |
| Zones and areas | Listed in the config | Read from the panel, with names |
| Arm mode in HomeKit | Guessed for keypad arms | Exact, from the panel |
| After a HomeKit command | ~30 s blackout (with logout) | None |
| Texecom app | Lost | Blocked while connected; alarm push still arrives |

`"protocol": "connect"`. It's self-contained, so it can be taken without the rest of the fork:

```
lib/connect/protocol.js   framing, CRC-8, commands, message decoding
lib/connect/client.js     session: login, events, one command in flight, sequence-matched
                          replies, retries, 30 s keep-alive, drop detection, reconnect
lib/connectPanel.js       discovery, full state read on (re)connect, part-arm tracking,
                          setMode() with reset-before-disarm and disarm-before-re-arm
lib/connect/NOTICE        credits: texecom-connect (Apache-2.0), texecom2mqtt (MIT)
```

Part Arm 1/2/3 map to Home app modes with `part_arm_1`…`part_arm_3` (default Night / Home / unused). The exit delay shows "Arming…". A mode switch never shows Disarmed in between, and the alarm shows **Tampered** and **Fault** (mains, battery, communication) from the panel (see 3.3).

### 4.2 Crestron improvements

- **All of section 2.**
- **Exact part arm:** `night_part_arm` / `home_part_arm` send the binary `S 00 0n` instead of `\Y`. Unset keeps `\Y`.
- **Status check every 60 s** (`ASTATUS`, `status_poll_interval`): corrects HomeKit after a missed event, and reconnects if the panel stops answering three times. A periodic "not armed" never clears Triggered, because the panel never reports an alarm ending.
- **"Arming…"** from `"X`; **tamper** from zone status `2`.
- **HomeKit answered at once**, outcome applied when the transaction ends (see 3.4).
- **Binary fallback:** a text command answered `ERROR` is resent as its binary equivalent (see 3.2).
- **Held events coalesced:** in the burst after a session, an arm followed by a disarm no longer flashes a stale "armed" state.

### 4.3 Choosing the Home app arm buttons

`homekit_modes` (e.g. `["away", "night"]`) offers only the buttons a panel uses. Many homes have just a full arm and one part arm, so otherwise Night and Home would do the same thing. Because iOS caches the buttons (3.4), a reduced set gives the alarm accessory its own identity.

### 4.4 Settings page and README

The settings page has four numbered sections, with plain-English help and a recommendation on every field. Fields that don't apply to the chosen protocol are hidden, and the problems in 2.11 are fixed. The [README](../README.md) is a step-by-step guide for SmartCom owners, with screenshots.

### 4.5 Code layout and tests

```
lib/platform.js        platform: config, accessories, routing panel messages
lib/connection.js      Crestron transport: line framing, reconnect, keep-alive, command
                       queue, logout, status check
lib/protocol.js        Crestron parsing and command encoding (pure, unit-tested)
lib/areaAccessory.js   area → HomeKit Security System
lib/zoneAccessory.js   zone → HomeKit sensor (dwell, tamper)
lib/connect/, lib/connectPanel.js   Texecom Connect
test/                  62 tests: parsing, framing, command queue, Connect client and
                       platform, and a replay of the real panel session through real HAP
tools/                 fake panels, session replay, probes used on the real panel
```

`npm install && npm run lint && npm test`. No panel needed.

---

## 5. Suggested route

1. **Keep your accessory identities.** The fork uses a new UUID scheme (`homebridge-texecom-full:zone:7`), so adopting its accessory code as-is would make every user set up their Home app again. Also keep your configurable users (#25), combined areas and clock sync.
2. **Take section 2 as small patches against your code**, most serious first: 2.1, 2.2, 2.3, 2.4, then the rest. Each is independent and easy to review. Separate branches can be prepared on request.
3. **Consider Connect** as a second protocol, from the self-contained files in 4.1.
4. The fork's structure and tests are there as a reference if you want them.

---

## 6. Testing done

| Test | Result |
|---|---|
| 4.4.0 vs the fork, fake panel and real-session replay | Bugs in section 2 reproduced on 4.4.0, fixed in the fork |
| Fork as the live plugin on the real panel (Crestron, Homebridge 2.4) | Running day to day |
| Crestron, HomeKit Night (binary Part Arm 1) held 20 s, then Off | Armed and disarmed, confirmed by the panel's own events |
| Crestron, binary part arm and disarm with a probe tool | Both carried out |
| Crestron, binary logout | Blackout ~60 s → ~30 s; HomeKit blind ~68 s → ~39 s per command |
| Connect, read-only (login, discovery, states, live events) | Correct |
| Connect, HomeKit Night then Off | Night in ~9 s (the panel's 8 s remote-arm settle), Off in under 1 s, no blackout |
| Keypad arm, entry delay and keypad disarm | Seen correctly |
| Homebridge 1.11 and 2.4 | Both |
| Keypad emulation, UDL memory reads | Don't work on V6.05.03 (see 3.2) |
| Connect (through a Home Assistant port of the same code, same panel): Away, Night, Part Arm 2, mode switches, keypad arms, failed arms, three alarms, panel lid and detector tampers, two mains failures, a full power-down | All as described in 3.3; the Home app via HomeKit Bridge showed Away / Night / Off and followed keypad arms |

Not yet exercised on the real panel with this plugin itself: the Tampered/Fault characteristics and the mode-switch fix (covered by tests against the fake panel).

---

## 7. Other projects and credits

| Project | Licence | Used for |
|---|---|---|
| [texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio) | MIT | Connect protocol details; reference feed in testing |
| [davidMbrooke/texecom-connect](https://github.com/davidMbrooke/texecom-connect) | Apache-2.0 | The original Connect reverse-engineering |
| [Sjoerdfc](https://github.com/Sjoerdfc/texecom-connect) / [southseaboy](https://github.com/southseaboy/texecom-connect) forks | Apache-2.0 | Idle-time state re-read; all 73 area flags; short-read fallback; "an ACK isn't proof" |
| [michaelmarconi/texecom_alarm](https://github.com/michaelmarconi/texecom_alarm) | MIT | NAK replies after event bursts; area states 6/7; drops at alarm time |
| [JumpMaster/TexecomManager](https://github.com/JumpMaster/TexecomManager) | | Crestron messages, `ASTATUS`/`LSTATUS`, tamper status |
| [shuckc/pytexalarm](https://github.com/shuckc/pytexalarm) / pialarm | MIT | Wintex/UDL framing, binary commands |
| [ricol99/casa](https://github.com/ricol99/casa) | MIT (package.json) | Binary arm/part-arm/disarm commands |
| [GoosieZA/esphome-texecom](https://github.com/GoosieZA/esphome-texecom) | MIT | UDL differences between Elite and International panels |
| [Prinsessen/openhab-texecom-bridge](https://github.com/Prinsessen/openhab-texecom-bridge) | MIT | Periodic `ASTATUS` with a watchdog |
| [dxnphillips/scouthut-alarmnotification](https://github.com/dxnphillips/scouthut-alarmnotification) | MIT | The "connected but panel silent" failure mode |
| [garethflowers/homebridge-texecom-connect](https://github.com/garethflowers/homebridge-texecom-connect) | MIT | Keypad-emulation arming (not accepted by this panel) |

The same protocol work is also available as a Home Assistant integration: [metaljay/ha-texecom](https://github.com/metaljay/ha-texecom).

Original plugin by Kieran Jones, maintained by Max Christian and Chris Posthumus. Protocol credits for the Connect code are in [lib/connect/NOTICE](../lib/connect/NOTICE).

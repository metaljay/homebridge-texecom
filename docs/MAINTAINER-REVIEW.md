# Review notes for the maintainer

**For:** Chris Posthumus (maintainer of `homebridge-texecom-full`)
**From:** [metaljay/homebridge-texecom](https://github.com/metaljay/homebridge-texecom), prepared with Claude Code
**Date:** 6 October 2026
**Compared against:** your `4.4.0-beta.0` branch at `674be7c` (*Add panel clock sync*, 4.4.0-beta.1 in the changelog)

---

## Summary

This is a review of `homebridge-texecom-full` against current Homebridge plugin practice, tested against your `4.4.0-beta.1` and on a live Premier Elite installation. It covers:

1. problems your beta already fixes, for reference;
2. **problems still present in `4.4.0-beta.1`**, with evidence and a small suggested patch against *your* code for each. The most serious, lost keypad disarms causing false alarms in HomeKit, is first;
3. a restructured reference version ("v5", in this branch) that implements all of the fixes with tests, in case you want to adopt some or all of it;
4. what other Texecom projects do differently, and what's worth copying (section 6).

**Biggest strategic point:** most users will connect through a **repurposed SmartCom**. That already works with this plugin when the SmartCom's COM port is switched to "Crestron System" (confirmed by the tester; your README asks about it), at the cost of the official app and easy Wintex access. Supporting the **Texecom Connect protocol** as well would let SmartCom owners keep the module in its normal mode, get much richer data, and avoid the post-command event blackout found in 2.0b. See 6.4.

**The suggested route for the existing Crestron code is small patches against your beta, not merging v5 wholesale.** v5 uses a different accessory UUID scheme, so adopting it as-is would orphan existing users' accessories (see section 1).

Everything marked *Reproduced* was run against your beta branch using real Homebridge (1.11.4) and a fake COM-IP panel. The panel is included as [`tools/fake-panel.js`](../tools/fake-panel.js), so you can repeat the tests.

Items marked **Confirmed on real hardware** were observed on a user's live installation: your published `4.4.0-beta.1`, Homebridge 2.4.0, Node 24, Docker on a Raspberry Pi, and a Premier Elite 24 (firmware V6.05.03). The panel's **Com Port 3 is set to "Crestron System"** and is bridged to the network by a **Wemos D1 (ESP8266) running ESP Easy Mega's "Communication - Serial Server" (ser2net)** on TCP port 23 (19200 8N1), not an official Texecom ComIP. Com Port 1 is a SmartCom. The bridge's **RX Receive Timeout is 200 ms**: it buffers serial bytes until the line has been quiet for 200 ms, then sends them as one TCP packet. That is why messages the panel sends close together (for example `"U0030` + `"D0013`) arrived in one chunk, and it adds up to ~200 ms latency per message. A ComIP may coalesce less often, but TCP never guarantees message boundaries, so the line-framing fix (2.1) applies to any IP connection. Users of serial-to-TCP bridges can lower that timeout (for example to ~20 ms) for faster updates once framing is handled. The plugin's own `debug` log was the only instrumentation; no packet capture was used.

---

## 1. Already fixed in your beta

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

**Things in your beta that should be kept whatever is adopted from v5:**

- **UUIDs compatible with 4.2.8 (`Texecom:<name>`) and 4.3.0.** v5 uses a new scheme, `homebridge-texecom-full:zone:7`, which would make every existing user re-pair and rebuild their automations. That part of v5 should **not** be adopted.
- **Configurable `remote_users` / `default_arm_state`** (#25). v5 uses the same config keys and the same order of checks (remote user, then the HomeKit request, then the default).
- **User numbers above 99.** v5 parses them the same way as your regex.
- **Combined areas and panel clock sync.**

---

## 2. Still present in `4.4.0-beta.1`

### 2.0 Real-world impact: lost keypad disarms cause false alarms in HomeKit (*Confirmed on real hardware*)

This is the most serious finding, and it combines 2.1 with the zone-trigger behaviour described below. The tester ran three keypad tests on `4.4.0-beta.1`: arm then disarm; arm, walk in, disarm during the entry delay; arm, walk in and let the alarm sound, then disarm. Afterwards they reported that **"the HomeKit notifications throughout that exercise were well off"**. The debug log shows why:

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

**Zone-inferred alarms misfire on every normal homecoming, even with 2.1 fixed.** When an away-armed area has a zone go active, the beta marks the area as triggered (`manual triggered`). But walking in through the entry route *is* a zone going active while armed. The panel sends `"E0010` (entry delay), you disarm, and nothing is wrong. At 15:32:22 the beta would have raised a false alarm here if that zone message hadn't been lost in the same chunk as the `E`. The panel reports real alarms itself, and gets them right. In the third test the tester came in through the hallway, which is on the entry route, so the panel sent `"E0010` (entry delay). He then walked into the kitchen, which isn't, so the panel sent `"L0010` (full alarm) at 15:33:02 and reported the kitchen zone a second later. Only the panel knows which zones are entry routes and which are immediate. The plugin can't, so any inference from zone activity will be wrong one way or the other. **Suggestion:** rely on `L`, and make zone inference opt-in for panels that don't send `L`. If it is kept, it should ignore activity between `E` and the following `D`/`L`. v5 does both (`trigger_from_zones`, default off). The trade-off of that guard: on a panel that *doesn't* send `L`, walking from an entry-route zone into an immediate zone during the entry delay wouldn't be shown. That's one more reason to rely on `L` wherever the panel provides it.

**Messages your panel sends that the plugin doesn't yet recognise** (all confirmed by the tester's test sequence; user 3 is their code):

| Message | Meaning |
|---|---|
| `"U0030` | User 003 entered a code at a keypad |
| `"X0010` | Area 001 exit delay started |
| `"E0010` | Area 001 entry delay started |
| `"A0013` / `"D0013` | Area 001 armed / disarmed by user 3 (user number is variable width, as your regex already allows) |
| `"L0010` | Area 001 alarm |

`X` could drive HomeKit's "Arming…" display: set the target state while the current state stays disarmed. `E` could give an "entry delay" notification.


They're listed most severe first. Line numbers refer to `index.js` on `4.4.0-beta.0` at `674be7c`.

### 2.0b After arming or disarming from HomeKit, the panel holds back all events for about 60 seconds (*Confirmed on real hardware*)

Found by running texecom2mqtt (Connect protocol, via a SmartCom) alongside the plugin (Crestron, via the COM-IP) on the same panel, so every event could be checked against an independent feed.

The plugin logs in with `\W<udl>/` before each command and never logs out. While that UDL session is open, **the panel sends nothing on the Crestron port**: no zone changes, no arm or disarm events, no alarms. When the session times out, about 60 seconds after the last command, everything held back arrives in one burst.

From the test on 6 Oct (UK time). Arms and disarms were made from the Home app; the kitchen is a Guard zone included in Part Arm 1:

| Time | HomeKit command | Connect feed (live) | Crestron feed (plugin) |
|---|---|---|---|
| 17:53:33 | Night → panel Part Arm 1 | In Exit, then Part Armed 1 | `OK`, `OK`, then **silence** |
| 17:54:13 | Off | Disarmed | `OK`, `OK` |
| 17:54:42 | Home → panel Part Arm 1 | In Exit, then Part Armed 1 | `OK`, `OK` |
| 17:55:05 | | **Kitchen in alarm, bell active** | (nothing) |
| 17:55:08 | Off | Disarmed | `OK`, `OK` |
| 17:53:33–17:56:08 | | 12 zone changes | **0 zone changes** |
| 17:56:08–17:56:17 | | | burst: `"X0010`, `"A00129`, `"D0010`, `"X0010`, `"A00129`, **`"L0010`**, `"D0010` and the held zone messages |

The alarm reached HomeKit **65 seconds late**, and every motion sensor was frozen for 2½ minutes. The same pattern explains an earlier unexplained burst at 15:24:20, which arrived 59 seconds after a test arm/disarm. The beta's clock sync also logs in, so each sync would cause the same 60-second blackout.

**Isolated with [`tools/crestron-logout-probe.py`](../tools/crestron-logout-probe.py)**, which logs in and tries to log out without arming anything, with texecom2mqtt as an independent feed:

| Time | Probe | Crestron feed | Connect feed |
|---|---|---|---|
| 18:02:51–18:03:02 | not logged in | 8 zone changes, live | same |
| 18:03:03 | `\W<udl>/` | **no reply; feed goes silent** | zone changes continue |
| 18:03:26 | `\H/` (TexecomManager's log-out) | **`ERROR`; still silent** | zone changes continue |
| 18:04:27 | | **burst of everything held**, 61 s after the last command | |

- **Any command over the Crestron port starts a ~60 s blackout, and each further command restarts it.** Even the rejected `\H/` did.
- **`\H/` doesn't end the session on this panel** (firmware V6.05.03), so TexecomManager's log-out doesn't apply here.
- **Events are delayed, not lost.** The burst contained everything, in order. With line framing fixed (2.1), the final state is right but up to a minute late.

**Options:**
1. **Arm and disarm with Crestron keypad emulation instead of the UDL.** TexecomManager sends virtual keypresses (`KEY<digit>`, `KEYY`, `KEYD`, `KEYR`) with a user code and reads the screen with `LSTATUS`, so no UDL session is opened. **Tested on the V6.05.03 panel with [`tools/crestron-keypad-probe.py`](../tools/crestron-keypad-probe.py): not accepted as-is.** A valid user code (it works on the physical keypad) was sent as `KEY<digit>` lines with TexecomManager's 500 ms spacing. There was no `"U` login message, and `LSTATUS` still showed the idle screen 3 s later. Whether a panel setting (for example a keypad slot for the Crestron port) enables it is still open.
2. **Mitigate:** after any command, mark zone states as possibly stale for 60 s, and when the burst arrives, process it in order (2.1). `ASTATUS` **can't** be used to confirm the result during the blackout (see below).

**Why it happens** ([`tools/crestron-astatus-during-login.py`](../tools/crestron-astatus-during-login.py)). After `\W<udl>/`, the port stops speaking text. `ASTATUS` and `LSTATUS` sent during the blackout were each answered with the binary frame `03 0F ED`. That is **Wintex framing** as documented in [pialarm's wintex-protocol.md](https://github.com/shuckc/pialarm/blob/master/protocol/wintex-protocol.md): a length byte, then a type, then the checksum `0xFF - sum` (`FF - 03 - 0F = ED`). So the UDL login switches the port into a Wintex/UDL session, and the 60 s is that session's idle timeout. Text queries don't extend it: the burst came 60.7 s after the login and 35 s after the last `ASTATUS`. Framed `\…/` commands do extend it, as the rejected `\H/` showed. The Wintex logout is message type `H`, which as a frame is `03 48 B4`.

**Binary logout: confirmed it halves the blackout** ([`tools/crestron-binary-logout-probe.py`](../tools/crestron-binary-logout-probe.py), two runs, no Wintex session open, sensors moving throughout):

| | Run 1 | Run 2 |
|---|---|---|
| Logout `03 48 B4` sent | 10 s after login | 2 s after login |
| Panel reply | `03 06 F6` (Wintex ACK) | `03 06 F6` |
| Text feed resumed (held events replayed in order) | **30.7 s** after logout | **30.9 s** after logout |

**Rule:** without a logout, the feed is silent until about 60 s after the last framed command. With the binary logout, it's silent until about 30 s after the logout. Nothing is lost either way.

**Recommended:** send `03 48 B4` straight after each command sequence (arm/disarm, and clock sync). That cuts the blackout from ~60 s to ~30 s for one byte-triple. Two things to handle:
- The ACK `03 06 F6` arrives on the same stream **without a line terminator**, so it gets glued to the front of the next text line (for example `\x03\x06\xf6"Z0011`). The line parser must drop a valid Wintex frame (`[len][type]…[checksum]`, where `sum & 0xFF == 0xFF`) before parsing text, or the next zone event is lost.
- Don't treat "no `OK` to `\W<udl>/`" as failure on its own. In the probes the login was never acknowledged with text `OK`, yet the session clearly opened (the binary replies and the blackout prove it). The plugin's arm commands did get `OK`s, so it's worth checking which command those `OK`s actually answer.
3. **Two modules:** send commands through a second module (for example a SmartCom using the Connect protocol) and keep the Crestron port for live events. Only suits installs that have both. **Supporting evidence:** a UDL session on a *different* port doesn't silence the Crestron port. During a 4-minute Wintex session through the SmartCom (17:44–17:48), the Crestron feed kept reporting zone changes live. Wintex's Online Keypad also armed and disarmed with a user code through that session, so remote keypresses are possible over UDL/Connect, just not over the Crestron port (see option 1).
4. In all cases, **avoid unnecessary logins.** The beta's clock sync logs in on a schedule, and each sync costs a 60 s blackout. `LSTATUS` already shows the panel time without logging in (6.2), which allows a drift check that only logs in when a correction is actually needed.

**Verified in the plugin on real hardware** ([`tools/hotfix-4.4.0-beta.1-v2.py`](../tools/hotfix-4.4.0-beta.1-v2.py) applied to your 4.4.0-beta.1: logout after each command plus the frame filter). Night then Off from the Home app, with sensors moving throughout and texecom2mqtt as the reference:

| | Night (arm) | Off (disarm) |
|---|---|---|
| Home app pressed | 19:37:57 | 19:39:04 |
| Panel state (Connect) | In Exit 19:38:05, Part Armed 1 19:38:15 | Disarmed 19:39:11 |
| Logout sent | 19:38:05 | 19:39:12 |
| Crestron feed resumes | **19:38:36** (+31 s) | **19:39:43** (+31 s) |
| Held messages | `"X0010`, `"A00129` + 4 zone changes, all processed | `"D0010` + 4 zone changes, all processed |
| HomeKit result | Night (via the HomeKit request, user 29) | Disarmed |

HomeKit is blind for **~39 s per command**, down from ~68 s, and nothing is lost. The ACK never reached the parser. The login took **6 s** to be acknowledged this time (3 s earlier in the day), so a command timeout of **~8 s** is safer than 5 s.

**The ~30 s after logout is a fixed panel timer; polling doesn't shorten it** ([`tools/crestron-post-logout-poll.py`](../tools/crestron-post-logout-poll.py)). After the logout ACK, `ASTATUS` was sent every 2 s. All 15 replies were the binary `03 0F ED` until **31 s after the logout**, when the held events and then a normal `"NN` came back. The panel's Wintex settings show no UDL or remote-session timer to adjust (only "Remote Arm Instant", option 58, which is why remote arms set after the 8 s exit settle time instead of the area's 15 s exit delay). Polling does give a precise **"back online" signal**: the first text reply. After a command, the plugin could poll quietly and confirm the true state with `ASTATUS` at that moment. Removing the blind spot entirely needs a command path that doesn't open a UDL session: keypad emulation (option 1 above) or a second module (option 3).

Also visible in the burst: the panel reports arms made through the Crestron interface as **user 29**, and remote disarms as **user 0**. Your `app_users` / `remote_users` settings exist for this, but the defaults (25/254) don't match this panel.

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

These are in v5 but are **not verified on a panel**, and are worth checking before relying on them.

- **Tamper reporting.** v5 sets HomeKit `StatusTampered` when a zone status digit is anything other than `0` or `1`. TexecomManager confirms `2` is tamper (section 6.1), but tamper hasn't been triggered on the test panel.
- **Arm state shown immediately after `OK`.** Both your beta and v5 show the target state as soon as the panel acknowledges, rather than waiting for the arm event after the exit delay. This matches the existing behaviour and is unchanged.

---

## 4. Suggested route

If any of section 2 is useful, the least disruptive way to bring it in is **one small pull request per item against your `4.4.0-beta` branch**, using the patches above, rather than merging the v5 restructure. Each one is easy to review and revert. Separate branches for each can be prepared on request.

The v5 structure (section 5) is there as a reference if you ever want to split `index.js` into modules and add tests. The protocol and connection tests in `test/` would carry over with little change.

---

## 5. How the v5 version is organised

```
index.js                 Entry point: registers the platform, nothing else
lib/settings.js          PLUGIN_NAME / PLATFORM_NAME / defaults
lib/platform.js          Dynamic platform: cache restore, config validation, accessory
                         reconciliation, routing panel messages to accessories, shutdown
lib/connection.js        TCP or serial transport, line framing, reconnect with back-off,
                         TCP keep-alive, serialised command queue (sendCommands), Wintex
                         logout after UDL commands, ASTATUS query on connect
lib/protocol.js          Pure functions: parseLine() (incl. U/X/E and the ASTATUS reply),
                         LineSplitter (drops Wintex binary frames), areaBitmask(),
                         encodeCommand(). No I/O, so fully unit-testable
lib/connect/, lib/connectPanel.js   Texecom Connect transport (section 7)
lib/zoneAccessory.js     One zone → one HomeKit sensor, dwell timer, tamper
lib/areaAccessory.js     One area → HomeKit SecuritySystem, onSet → panel commands,
                         state persisted in accessory.context
test/                    node:test unit tests (protocol parsing, line framing, bitmask,
                         command queue against a local TCP server, and a replay of the
                         real panel session through the platform with real HAP)
tools/fake-panel.js      Fake COM-IP panel for manual end-to-end testing
tools/replay-panel.js    Replays a recorded session (with original TCP chunking) to any build
tools/hotfix-4.4.0-beta.1.py
                         Stop-gap for installed 4.4.0-beta.1: line framing, 5 s timeout,
                         clears area zone lists (disables zone-inferred alarms)
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

---

## 6. Learning from other Texecom projects

Several other open-source projects talk to Texecom panels. Two use the same Crestron/Simple protocols as this plugin; others use the richer, binary **Texecom Connect** protocol. Reviewed:

- **[texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio)** (Daniel Chesterton): Connect protocol, MQTT and Home Assistant. Its source repository isn't public, so this review used the code bundled in the published Docker image (1.3.1).
- **[TexecomManager](https://github.com/JumpMaster/TexecomManager)** (JumpMaster): Crestron plus Simple Protocol over serial.
- **[pialarm](https://github.com/shuckc/pialarm/blob/master/protocol/readme.md)** (Chris Shucksmith): Simple Protocol traces, credited in this plugin's README.
- Also relevant, not reviewed in depth: [davidMbrooke/texecom-connect](https://github.com/davidMbrooke/texecom-connect) (the original Connect protocol reverse-engineering) and [garethflowers/homebridge-texecom-connect](https://github.com/garethflowers/homebridge-texecom-connect), an existing Homebridge plugin built on the Connect protocol.

### 6.1 Protocol details confirmed by other implementations

TexecomManager independently confirms the message meanings observed on the real panel in section 2.0, and adds a few:

| Message | Meaning | Source |
|---|---|---|
| `"Z` + zone + `0`/`1`/`2` | zone **healthy / active / tamper** | TexecomManager (also observed: 0 and 1) |
| `"U0` + user | user logged in with a PIN | TexecomManager, observed |
| `"T0` + user | user logged in with a **prox tag** | TexecomManager |
| `"X0`, `"E0`, `"L0` | exit delay / entry delay / intruder alarm | TexecomManager, observed |
| `ERROR` | command rejected | TexecomManager |

So **zone status `2` is tamper**, which removes the uncertainty in section 3: v5's `StatusTampered` mapping is right. The beta currently treats `2` as "not active" and ignores it.

### 6.2 Querying state instead of assuming it

All three projects **ask the panel for the current state** rather than waiting for the next event:

- **Crestron:** `ASTATUS` (sent as a line, `ASTATUS\r\n`) returns `"Y…` (armed) or `"N…` (disarmed), and `LSTATUS` returns the keypad screen text. TexecomManager uses these to confirm the result after arming or disarming.
- **Simple Protocol:** `\Z<first-1><count>/` returns the state of a range of zones, `\I/` the panel model and firmware, and `\H/` logs out.
- **Connect (texecom2mqtt):** after every connect it logs in, reads every zone's state and every area's flags (armed, part-armed level, in alarm), and only then subscribes to events. It re-reads area state after events that don't produce an area message: arm failed, auto-arm, end of installer programming.

**Confirmed on real hardware** (Premier Elite with two areas, COM-IP in Crestron mode, disarmed), using [`tools/crestron-status-probe.py`](../tools/crestron-status-probe.py):

```
ASTATUS  ->  "NN\r\n
LSTATUS  ->  "      HOME      17:29.48 Tue 06 \r\n
```

`ASTATUS` returns one letter per area (`N` = not armed). Both areas were disarmed, so the per-area reading still needs confirming with an area armed (expected `"YN`). No login was needed for either query. `LSTATUS` returns the keypad display exactly, including the panel clock, which gives a free clock-drift check without the UDL.

**Suggestion:** on connect and reconnect, send `ASTATUS` to set the true armed state. That replaces the "assume disarmed" start-up (2.5) properly, which is better than v5's cache: a cache can't know what changed while Homebridge was down. `ASTATUS` doesn't say *which* arm mode (full or part), so `default_arm_state` is still needed for that.

### 6.3 Patterns worth copying

| Pattern | texecom2mqtt | This plugin (beta) |
|---|---|---|
| Message framing | Buffers bytes and parses complete, length-prefixed, CRC-checked messages, looping when several arrive together | Parses each TCP chunk as one message (2.1) |
| One command in flight | Queue; next command only after the reply (or timeout) | Commands can interleave (2.2) |
| Reply matching | Sequence number per command; replies for unknown sequences are logged and ignored | Any `OK` resolves any waiting command (2.2) |
| Timeout / retries | 3.5 s × 5 attempts | 2 s × 2 (the test panel needed 3 s, 2.2) |
| Liveness | TCP keep-alive (10 s), socket idle timeout (60 s) → reconnect, plus an application poll every 30 s | No keep-alive; a silently dropped COM-IP isn't detected (2.6) |
| Disarm while in alarm | Sends **reset** first, then disarm | Disarm only |
| Change arm mode | Disarms, then arms in the new mode | Sends the new arm command directly |
| Start-up | Reads full state, then subscribes | Assumes disarmed (2.5) |

A periodic `ASTATUS` (confirmed to work, 6.2) would give this plugin the same application-level heartbeat and keep HomeKit's state honest.

### 6.4 Crestron vs Connect

The Connect protocol reports things Crestron can't: **which** part-arm (1/2/3) was used, explicit "in exit" and "in entry" states (HomeKit's "Arming…"), zone names and area membership straight from the panel, fault, masked and bypassed flags, power supply readings, and the full event log. It needs a Premier Elite on v4+ firmware with a ComIP, ComWifi or SmartCom, and like Crestron it takes over that connection (only one app per module).

**Most users will only have a SmartCom,** and the realistic path for most people is to **repurpose it**. Your README asks whether the plugin works through a SmartCom ("let us know if you get it working"). **It does:** the tester previously ran this plugin through their SmartCom with its COM port switched to "Crestron System", using the ComIP method from the README. The cost was losing the **official Texecom app**, and **Wintex through the SmartCom** became awkward. That's why the test system now has a separate ESP8266 bridge for Crestron and leaves the SmartCom in SmartCom mode. The README could say this explicitly. It's probably the most common setup, and everything in section 2 applies to it.

The alternative for SmartCom owners is **Connect protocol support**, which leaves the SmartCom in its normal mode. The trade-offs, as observed:

| | SmartCom in Crestron mode (this plugin today) | SmartCom in SmartCom mode, Connect protocol (texecom2mqtt-style) |
|---|---|---|
| Official Texecom app | lost | also blocked while connected (per texecom2mqtt docs) |
| Wintex via the SmartCom | awkward (tester's experience) | **worked alongside** texecom2mqtt on the test panel |
| Blind spot after HomeKit arm/disarm | ~60 s (~30 s with logout, 2.0b) | none expected (commands are acknowledged in-protocol) |
| Detail available | zone/area events only | zone names and types, part-arm level, entry/exit, last alarm zone, power, event log |
| Reliability seen | steady | stalled 1–2 min after alarms (6.5) | It also removes the UDL-session blackout (2.0b) entirely, because Connect arm/disarm commands are acknowledged in-protocol and don't silence the event feed. The trade-offs seen on the test panel: the Connect session stalled for 1–2 minutes after alarms (6.5), and Wintex was able to connect through the same SmartCom at the same time as texecom2mqtt. Existing Connect implementations to learn from: texecom2mqtt (reviewed above), davidMbrooke/texecom-connect, and garethflowers/homebridge-texecom-connect.

### 6.5 Side by side on the same panel

On 6 Oct texecom2mqtt (Connect, via the SmartCom) and the plugin (Crestron, via the COM-IP) ran together on the test panel, a Premier Elite 24 on firmware V6.05.03 with one area in use and five zones: Hallway as Entry/Exit 1, the rest Guard. Findings:

- **Zones:** identical on both feeds, normally within the same second, except during the post-login blackout in 2.0b.
- **Message mapping:** `"U` = User Code; `"X` = In Exit / Exit Started; `"A` = Armed ("Open/Close (Away Armed)"); `"L` = In Alarm + Bell Active; `"E` = In Entry; `"D` = Disarmed ("Open After Alarm (Alarm Abort)" after an alarm).
- **What Crestron can't tell you:** which zone caused an alarm (Connect: "last active zone: Kitchen"), which part arm was used (Connect: "Remote Part Arm 1"), and engineer activity (Wintex sessions show as Installer Programming and Download start/end; Crestron only shows `"U0000`, user 0).
- **HomeKit Night and Home both arm Part Arm 1.** The Crestron `Y` command can't reach Part Arm 2 or 3.
- **Connect isn't more reliable.** After each alarm and disarm, texecom2mqtt's commands timed out for 1–2 minutes. It reconnected repeatedly, twice reporting a corrupt response starting `0x41` (`A`), and missed a whole keypad arm and disarm. Crestron kept reporting throughout, apart from the blackout in 2.0b. **Explained:** the texecom-connect README notes that while a program is connected, the module can't send events to the Texecom apps "except for when an alarm occurs, in which case the connection to this program will be forcibly dropped by the panel". The drop is deliberate. It is how the alarm push notification gets out (and it did reach the tester's phone). A Connect client should treat it as expected: reconnect, then re-read the full state.
- Connect also reported an undocumented area state `6` straight after "Part Armed 1".
- **User numbers:** the panel's own event log (5 years of history read from Wintex) only contains users 0 (engineer), 1, 3 and 4. So `"A00129` ("user 29") is a pseudo-user for arms made through the UDL/Crestron interface, not a real user slot. Remote arms and disarms are logged as user 0. These values aren't standard across panels, which supports keeping `app_users` / `remote_users` configurable.
- **Wintex's saved event log** (`Customers/<name>.tlf`, under the Windows VirtualStore) is easy to read: 9-byte records of `[type][group][parameter][areas LE16][Unix time LE32]`, with types matching the Connect protocol's log event numbers. Event type **137** (parameters 100 and 102, group 9) appears during engineer programming and isn't in texecom2mqtt's list.

### Credits

Kieran Jones (original plugin and Crestron notes), Chris Shucksmith (Simple Protocol), David Brooke (Connect protocol), Daniel Chesterton (texecom2mqtt), JumpMaster (TexecomManager).

---

## 7. Texecom Connect support (implemented in this branch)

Because most users will repurpose a SmartCom (6.4), this branch adds a **Connect transport** alongside Crestron, selected with `"protocol": "connect"`. It's self-contained, so it can be lifted into your plugin independently of the rest of v5:

```
lib/connect/protocol.js   framing, CRC-8 (poly 0x85, init 0xFF), commands, message decoding
lib/connect/client.js     TCP session: 2 s pre-login wait, login, event subscription,
                          one command in flight, sequence-matched replies, 3.5 s x 5 retries,
                          keep-alive every 30 s (the panel drops idle sessions after ~60 s),
                          "+++" drop detection, reconnect with back-off
lib/connectPanel.js       discovery (zones, types, area membership, area names), full
                          state read on every (re)connect, part-arm tracking from log
                          events, re-reads after Arm Failed / Auto Open-Close / unknown
                          area state 6 / end of engineer programming, setMode() with
                          reset-before-disarm and disarm-before-re-arm
lib/connect/NOTICE        credits: texecom-connect (Apache-2.0, released with Texecom's
                          approval) and texecom2mqtt (MIT, Daniel Chesterton)
```

The platform maps Connect area states to HomeKit as follows. Full arm is Away. Part Arm 1/2/3 use `part_arm_1`…`part_arm_3` (defaults night / stay / unused, as texecom2mqtt). "In exit" sets the target, so the Home app shows "Arming…". "In alarm" is Triggered. Zones and areas are discovered from the panel when the config lists none, and the accessory identities are the same as in Crestron mode, so switching transports keeps HomeKit setups.

**Testing so far:**

| | Status |
|---|---|
| Unit tests (framing, CRC, decoding, client retries/drops) and end-to-end tests with real HAP against a fake panel modelled on the test system: discovery, live zones and tamper, Night = Part Arm 1, Away, mode change, alarm during a session drop, reset-then-disarm, custom part-arm mapping, refused commands | passing |
| Real panel, read-only (via SmartCom): login, panel ID, clock, power, keypad text, area/zone details, zone and area state reads, live zone events | **confirmed** |
| Real panel, plugin in Connect mode in a test Homebridge: discovered 5 zones and area HOUSE, correct current states in HomeKit | **confirmed** |
| Homebridge **2.4.0** (as on the test Pi) as well as 1.11: Connect against the fake panel (Arming… → Night → Disarmed, no warnings) and Crestron via the recorded real session (identical result, no warnings); accessory cache created under 1.x restored under 2.x | **confirmed** |
| Real panel, unattended soak in Connect mode under Homebridge 2.4 (keep-alive = zone/area state re-read every 30 s idle) | running overnight; first ~5 min run under 1.11 had 0 drops |
| Real panel: arm / disarm / reset over Connect | **not yet run**, pending a daytime test with the owner present ([`tools/connect-arm-test.sh`](../tools/connect-arm-test.sh), rehearsed against the fake panel) |

**Cross-check:** the arm/disarm/reset and state-read layouts taken from texecom2mqtt match an independent, Apache-2.0 implementation in [Sjoerdfc/texecom-connect](https://github.com/Sjoerdfc/texecom-connect) (still maintained in 2026). Its idle-time re-read of zone and area state is the model for the keep-alive here. It also catches events lost during the panel's alarm-reporting drop. Its author reports that `GET_ZONE_CHANGES` (36) is sometimes NAKed by newer firmware, after which the panel stops responding, so this implementation re-reads with `GET_ZONE_STATE` (2) instead.

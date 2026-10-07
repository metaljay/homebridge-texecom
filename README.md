[![npm version](https://badgen.net/npm/v/homebridge-texecom-full/latest)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm downloads](https://badgen.net/npm/dt/homebridge-texecom-full)](https://www.npmjs.com/package/homebridge-texecom-full)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

> ## About this fork
>
> This is a **review and demonstrator fork** of [homebridge-texecom-full](https://github.com/K1LL3R234/homebridge-texecom), offered to its maintainer to adopt as they see fit. It isn't published to npm.
>
> - **What was found and fixed, with evidence:** [docs/MAINTAINER-REVIEW.md](docs/MAINTAINER-REVIEW.md). Everything was tested on a real Premier Elite 24, and the fork runs as the live plugin on that system.
> - **New: Texecom Connect support** for a SmartCom or ComIP left in its normal mode: zones and areas read from the panel, exact arm modes, no delay after arming from the Home app.
> - **Crestron mode** keeps working, with the fixes from the review, an exact part arm for Night and Home, and a regular status check.
> - **A rewritten settings page** that explains every option (screenshots below).

# Homebridge Texecom

Shows a Texecom **Premier Elite** intruder alarm in the Apple Home app:

- **an alarm** you can arm (Away, Night, Home) and disarm, which shows when it's armed or going off;
- **a sensor for each zone** (motion, door/window contact, smoke or carbon monoxide), for automations and notifications.

Get notified when the alarm goes off, or only when you're away:

![example of notifications](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-notifications.jpg?raw=true)

Or turn the lights on when a detector sees movement:

![example of automation](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-automation.jpg?raw=true)

## What you need

1. A Texecom **Premier Elite** panel. The Texecom Connect option needs firmware v4 or later, which most panels have.
2. The panel's **UDL code**. Texecom panels come with **1234** and most keep it; if that doesn't work, your installer may have changed it. This isn't a keypad user code.
3. One way for Homebridge to reach the panel:
   - a Texecom **SmartCom** or **ComIP** on your network (the most common), or
   - a serial-to-network adapter on one of the panel's COM ports (for example an ESP8266 running ser2net), or
   - a USB-serial cable from the panel to the machine running Homebridge.

## Step 1: choose a protocol

Most people connect through their **SmartCom**: the small Texecom box next to the panel that the Texecom app uses. This plugin can talk to it in one of two ways, called **protocols**. This is the one decision you need to make; you pick it at the top of the plugin's settings.

| Protocol | **Texecom Connect** (recommended) | **Crestron** |
|---|---|---|
| What you do to the SmartCom | Nothing: leave it as it is | Switch its COM port to "Crestron System" in the panel's engineer menu ([how](#setting-up-the-panel)) |
| Texecom app | Can't connect while Homebridge is connected. Alarm notifications from the app still arrive | **Stops working**, including its notifications |
| Zones and areas | Found automatically, with their names | You type them in |
| Night / Home / Away in the Home app | Always the exact mode, however it was armed | Exact when armed from the Home app; arms from the keypad show as one mode you choose |
| "Arming…" while the exit timer runs | Yes, until the panel has finished arming | From the keypad, yes; from the Home app it shows armed as soon as the panel accepts the command |
| After arming or disarming from the Home app | No delay | Other updates are held back for about 30 seconds |
| Track record | New in this fork; tested on a real panel | The method this plugin has always used |

### Texecom Connect

**Pros**
- Nothing to change on the panel or the SmartCom, and no installer visit.
- Zones and areas are read from the panel, so there's almost nothing to type in.
- The Home app always shows the exact arm mode, and shows "Arming…" during the exit timer.
- Arm and disarm from the Home app take effect straight away, with no holding back of updates.
- Wintex can still connect through the same SmartCom.

**Cons and known limitations**
- The Texecom app can't connect while Homebridge is connected. Its alarm notifications still reach your phone.
- When the alarm goes off, the panel briefly drops the connection to send its own alarm notification. The plugin reconnects and catches up within seconds, but a disarm sent from the Home app in that moment may need repeating.
- Needs a Premier Elite on firmware v4 or later (most are).
- New: well tested on one real panel, but not yet on many.

### Crestron

**Pros**
- The plugin's original method, used by its existing users for years.
- A simple, steady connection; the panel keeps sending updates when the alarm goes off.

**Cons and known limitations**
- The Texecom app stops working, and with it the app's notifications, because the SmartCom is no longer working as a SmartCom. You'd rely on the Home app for notifications.
- Someone has to change the COM port in the panel's engineer menu (you need the engineer code, or your installer).
- You list your zones yourself, with their numbers.
- Arms made at the keypad or with a keyfob show as one mode you choose, because the panel doesn't say which mode it was.
- After you arm or disarm from the Home app, the panel holds back its other updates for about 30 seconds. Nothing is lost, but sensors update late during that time.

### Recommendation

- **You have a SmartCom and are happy to use the Home app instead of the Texecom app: choose Texecom Connect.** It's the least work and gives the best result.
- **You want to keep the Texecom app working as well:** neither option keeps it fully. Connect blocks the app while Homebridge is connected but keeps its alarm notifications; Crestron loses the app entirely. So Connect is still the better choice.
- **Already using this plugin with Crestron:** there's no need to change. The fixes in this fork apply to Crestron too.

<details>
<summary>Other ways to connect (need extra hardware)</summary>

If you want to keep the Texecom app fully working on its SmartCom, you can add a second connection on a spare COM port of the panel, set to "Crestron System", and use the **Crestron** protocol through it:

- a Texecom **ComIP** module;
- a serial-to-network adapter, e.g. an ESP8266 running ser2net (for the technically minded);
- a USB-serial cable from the panel to the machine running Homebridge.

</details>

## Step 2: fill in the settings

In the Homebridge UI, open **Plugins**, find **Homebridge Texecom** and choose **Settings**. Work down the page; each option explains itself, and section 4 can be left as it is.

### 1. Connection

<img src="docs/images/settings-1-connection.png" width="420" alt="Connection settings">

1. **How does Homebridge reach your panel?** The protocol you chose in step 1.
2. **IP address:** the SmartCom, ComIP or adapter's address. Find it in your router's list of connected devices, and reserve it there so it doesn't change.
3. **Port:** **10001** for a SmartCom or ComIP. For a serial-to-network adapter, the port you set on it (often 23).
4. **Serial port:** only for a USB-serial cable, e.g. `/dev/ttyUSB0`. Otherwise leave it blank.
5. **UDL code:** usually **1234** (see [What you need](#what-you-need)).

### 2. Zones and areas

<img src="docs/images/settings-2-zones-and-areas.png" width="420" alt="Zones and areas">

**Texecom Connect:** nothing to fill in. This section only shows a note, as zones and areas are read from the panel:

<img src="docs/images/settings-connect-2-zones-and-arm-modes.png" width="420" alt="Connect: zones read automatically, and part arm choices">

**Crestron:** add each zone you want in the Home app.

- **Name in the Home app**: e.g. "Front door".
- **Zone number**: as shown on your keypad or in Wintex (Zone 1, Zone 2…). Your installer's zone list or the panel's log will tell you which is which.
- **Shows as**: *Motion sensor* for movement detectors, *Contact sensor* for door and window contacts, or smoke / carbon monoxide.
- **Hold time**: motion detectors only report a moment of movement. **5000** (5 seconds) keeps the sensor showing "detected" long enough for automations; 0 is fine for door contacts.

Then add your **area**: most homes have one, **Area 1** (area A on the keypad), named however you like, e.g. "House".

### 3. Arm modes in the Home app

<img src="docs/images/settings-3-arm-modes.png" width="420" alt="Arm modes">

The Home app's alarm has an Off button and up to three arm buttons:

| Button | What it does on the panel |
|---|---|
| **Away** | Full arm |
| **Night** | A part arm: Crestron, the one you choose here (Part Arm 1 if blank); Connect, the part arm set to Night |
| **Home** | A part arm: Crestron, the one you choose here (Part Arm 1 if blank, so the same as Night); Connect, the part arm set to Home |

A **part arm** arms only some zones (for example downstairs only, while you're upstairs at night). Your installer sets up which zones each of Part Arm 1, 2 and 3 covers.

- **Buttons to show:** tick only the ones you use. **Most homes: Away and Night.** If you change this later, the alarm reappears in the Home app as a new accessory (the Home app remembers an alarm's buttons), so set its room and automations again.
- **Crestron, "Arms from the keypad or a keyfob show as":** the panel says "armed" without saying which mode, so pick how those arms appear. Away suits most homes.

### 4. Advanced (can be left as they are)

<img src="docs/images/settings-4-advanced.png" width="420" alt="Advanced settings">

- **Check the panel every (seconds)** (Crestron): 60. Corrects the Home app if a message was missed, and reconnects if the panel stops answering.
- **Keep the panel clock right** (Connect): 24 hours is a good choice; it puts the clock right after a power cut.
- **Keyfob users:** panel user numbers of keyfobs, if you use them; their arms show as Away.
- **Raise an alarm from zone activity:** leave off. The panel reports real alarms itself.
- **Detailed logging:** only when reporting a problem.

Click **Save** and restart Homebridge.

## Step 3: check it works

In the Homebridge log you should see the plugin connect, for example:

```
[Texecom] Connected to Texecom panel via 192.168.1.50:10001
```

or, for Texecom Connect, `Connect: logged in and subscribed to events` and your panel's model. In the Home app, the alarm and the zone sensors appear in the default room; move them to the right rooms. Walk past a detector and its sensor should show motion within a second or two.

**Coming from the published plugin (4.x)?** Your config keeps working, but the Home app sees the alarm and sensors as new accessories: remove any old ones left behind, then set rooms and automations again.

It's best to run this plugin as a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges), so a problem with the alarm connection can't affect your other accessories.

## Setting up the panel

**Texecom Connect:** nothing to do if the SmartCom or ComIP already works with the Texecom app. Its COM port stays set to "SmartCom" or "ComIP Module". If you've turned on **Encrypted Ports** in Wintex, turn it off for that port.

**Crestron:** set the COM port Homebridge uses to "Crestron System", at the keypad:

1. Enter the engineer code.
2. Scroll to "UDL/Digi Options", then press 8 for "Com Port Setup".
3. Scroll to the COM port, press "No" to edit, press 8 for "Crestron System", and "Yes" to save.
4. Check the UDL code under "UDL" while you're there.
5. Press "Menu" repeatedly to leave the engineer menu.

For a ComIP on that port: set it up and check it works first, then change the port to Crestron, so the panel has already given the ComIP its network settings. A SmartCom switched to Crestron works the same way, but the Texecom app can no longer use it.

## Good to know

- **Crestron: about 30 seconds after an arm or disarm from the Home app,** the panel holds back its other messages, then sends them all at once. Nothing is lost, but sensors update late during that time.
- **Texecom Connect: when the alarm goes off,** the panel briefly drops the connection to send its own alarm notification. The plugin reconnects and catches up automatically.
- **Only areas 1-8** can be armed from the Home app.
- **Tamper:** each zone sensor shows the Home app's *Tampered* status when the panel reports a tamper on it.

## Troubleshooting

| What you see | Try |
|---|---|
| "Connection error" or "Reconnecting" in the log | Check the IP address and port; check nothing else (another app or plugin) is already connected to the module |
| Sensors work but arming doesn't | Check the UDL code |
| "No reply from the panel" (Crestron) | The adapter is reachable but the panel isn't answering: check the COM port is set to Crestron System and the cable |
| The alarm shows the wrong mode after a keypad arm (Crestron) | Set "Arms from the keypad or a keyfob show as", or use Texecom Connect, which reports the exact mode |

## All settings (for editing config.json directly)

Crestron example:

```json
{
    "platform": "Texecom",
    "ip_address": "192.168.1.50",
    "ip_port": 10001,
    "udl": "1234",
    "zones": [
        { "name": "Front door", "zone_number": 1, "zone_type": "contact", "dwell": 0 },
        { "name": "Hallway", "zone_number": 2, "zone_type": "motion", "dwell": 5000 }
    ],
    "areas": [
        { "name": "House", "area_number": 1 }
    ],
    "homekit_modes": ["away", "night"],
    "night_part_arm": 1
}
```

Texecom Connect example (zones and areas are read from the panel):

```json
{
    "platform": "Texecom",
    "protocol": "connect",
    "ip_address": "192.168.1.50",
    "ip_port": 10001,
    "udl": "1234",
    "homekit_modes": ["away", "night"]
}
```

Keep the UDL code in quotes, so a code starting with 0 keeps it.

| Key | Default | Description |
| --- | --- | --- |
| `protocol` | `"crestron"` | `"crestron"` or `"connect"` |
| `ip_address` | | SmartCom, ComIP or adapter address |
| `ip_port` | `10001` | Its port |
| `serial_device` | | Crestron over a serial cable, e.g. `/dev/ttyUSB0` (instead of `ip_address`) |
| `baud_rate` | `19200` | Serial speed, with `serial_device` |
| `udl` | | UDL code, as a string. Needed to arm/disarm; always needed for Connect |
| `zones[]` | | `name`, `zone_number`, `zone_type` (`motion`, `contact`, `smoke`, `carbonmonoxide`), `dwell` (ms). Optional with Connect |
| `areas[]` | | `name`, `area_number`, `zones` (only with `trigger_from_zones`). Optional with Connect |
| `homekit_modes` | all | Buttons offered in the Home app: any of `away`, `night`, `stay` (Off always) |
| `night_part_arm` / `home_part_arm` | | Crestron, area 1: part arm (1-3) set by Night / Home. Unset = Part Arm 1 |
| `part_arm_1` / `part_arm_2` / `part_arm_3` | `"night"` / `"stay"` / `""` | Connect: Home app mode for each part arm (`night`, `stay`, `away`, or `""` for unused) |
| `default_arm_state` | `"away"` | Crestron: how a keypad or keyfob arm is shown (`away`, `night`, `stay`) |
| `remote_users` | `[]` | Crestron: keyfob user numbers, always shown as Away |
| `status_poll_interval` | `60` | Crestron: seconds between status checks; 0 = only after connecting |
| `time_sync_interval` | `0` | Connect: hours between panel clock checks; 0 = off |
| `trigger_from_zones` | `false` | Infer alarms from zone activity. Leave off |
| `debug` | `false` | Log every panel message |

## Development

```bash
npm install
npm run lint
npm test
```

The protocol parsing and the connection/command queue are covered by unit tests that run against fake panels, so no panel is needed. `tools/` has the probes and test scripts used on the real panel.

## Credits

Original plugin by Kieran Jones, maintained by Max Christian and Chris Posthumus. Texecom Connect support builds on [texecom-connect](https://github.com/davidMbrooke/texecom-connect) (Apache-2.0) and [texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio) (MIT); see [lib/connect/NOTICE](lib/connect/NOTICE). Other projects that informed this fork are credited in [the review](docs/MAINTAINER-REVIEW.md#credits).

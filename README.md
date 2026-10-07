[![npm version](https://badgen.net/npm/v/homebridge-texecom-full/latest)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm downloads](https://badgen.net/npm/dt/homebridge-texecom-full)](https://www.npmjs.com/package/homebridge-texecom-full)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

> **About this fork.** A review and demonstrator fork of [homebridge-texecom-full](https://github.com/K1LL3R234/homebridge-texecom), offered to its maintainer to adopt. It isn't published to npm. It adds **Texecom Connect** support (use your SmartCom as it is) and fixes for the existing Crestron mode, all tested on a real Premier Elite. Details and evidence: [docs/MAINTAINER-REVIEW.md](docs/MAINTAINER-REVIEW.md).

# Homebridge Texecom

Put your Texecom **Premier Elite** alarm in the Apple **Home** app, through the **SmartCom** you already have.

<img src="docs/images/how-it-connects.svg" width="760" alt="Home app, Homebridge with this plugin, SmartCom, Texecom panel">

## ✨ What you get

- 🛡️ **An alarm in the Home app**: arm Away or Night, disarm, and see when it's armed, arming or going off.
- 🚶 **A sensor for every zone**: motion detectors, door and window contacts, smoke and carbon monoxide.
- 🔔 **Notifications and automations**: get told when the alarm goes off, or turn the lights on when someone walks in.

<img src="https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-notifications.jpg?raw=true" width="380" alt="Example notification"> <img src="https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-automation.jpg?raw=true" width="380" alt="Example automation">

## 🧰 What you need

| | |
|---|---|
| 🏠 | A Texecom **Premier Elite** panel with a **SmartCom** (the box the Texecom app uses) |
| 🔢 | The panel's **UDL code**. Texecom's default is **1234**, and most panels keep it |
| 🖥️ | **Homebridge**, with its web page (the Homebridge UI) |

> ⚠️ While Homebridge is connected, the **Texecom app** can't connect to the SmartCom. The app's alarm notifications still reach your phone, and the Home app does everything the Texecom app does day to day.

## 🚀 Set it up

### 1️⃣ Find your SmartCom's address

Open your router's list of connected devices and find the SmartCom. Note its **IP address** (something like `192.168.1.50`), and reserve that address in the router so it never changes.

### 2️⃣ Install the plugin

In the Homebridge UI, go to **Plugins**, search for **Homebridge Texecom** and install it.

<details>
<summary>Trying this fork before its changes are published?</summary>

Open the Homebridge UI's **Terminal** and run:

```
npm install metaljay/homebridge-texecom#texecom-review
```

</details>

### 3️⃣ Fill in the settings

In **Plugins**, find **Homebridge Texecom** and open its **Settings**.

<img src="docs/images/settings-connect-1-connection.png" width="420" alt="Connection settings">

| Setting | What to choose |
|---|---|
| **How does Homebridge reach your panel?** | **Texecom Connect** |
| **IP address** | Your SmartCom's address from step 1 |
| **Port** | **10001** |
| **UDL code** | **1234**, unless your installer changed it |

<img src="docs/images/settings-connect-2-zones-and-arm-modes.png" width="420" alt="Zones and arm modes">

| Setting | What to choose |
|---|---|
| **Zones and areas** | Nothing: they're read from your panel, with their names |
| **Buttons to show in the Home app** | ✅ Away and ✅ Night suit most homes |
| **Part Arm 1 / 2 / 3 is** | Leave as they are: Part Arm 1 = Night, Part Arm 2 = Home |
| **Advanced → Keep the panel clock right** | **24** |

Click **Save**.

> 💡 A **part arm** arms only some of your zones, for example downstairs only while you're upstairs at night. Your installer chose which zones each part arm covers.

### 4️⃣ Restart and check

Restart Homebridge. Its **Logs** page should show:

```
[Texecom] Connect: logged in and subscribed to events
```

followed by your panel's model and a line for each zone.

### 5️⃣ Finish in the Home app

The alarm and a sensor for each zone appear in the Home app's default room.

- 🏷️ Move each one to the right room.
- 🔔 Turn on notifications for the alarm (and for any sensors you care about).
- ⚡ Add automations, for example lights on when the hallway sees movement.

That's it. 🎉

## 💡 Good to know

- 🚨 **When the alarm goes off**, the panel briefly drops the connection to send its own alarm notification. The plugin reconnects and catches up within seconds.
- 🧩 **Changing the arm buttons later** makes the alarm reappear in the Home app as a new accessory (the Home app remembers an alarm's buttons). Set its room and notifications again.
- 🔌 **Wintex** can still connect through the SmartCom while Homebridge is connected.
- 🧱 It's best to run this plugin as a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges), so a problem with the alarm connection can't affect your other accessories.

<details>
<summary><b>🛠️ Troubleshooting</b></summary>

| What you see | Try |
|---|---|
| "Connection error" or "Reconnecting" in the log | Check the IP address and that the port is 10001. Close the Texecom app, and check nothing else is connected to the SmartCom |
| "login rejected (check the UDL code)" | The UDL code is wrong. Try 1234; if that fails, ask your installer |
| The Home app still shows a button you unticked | The Home app remembers an alarm's buttons. Restart Homebridge; the alarm reappears as a new accessory |

</details>

<details>
<summary><b>⚙️ Editing config.json directly</b></summary>

Most people should use the settings page. To edit the config yourself, open **JSON Config** in the Homebridge UI and add this block inside the `"platforms": [ … ]` list, with a comma between it and the block before it. Don't add notes inside the config: Homebridge won't start if it isn't valid JSON.

```json
{
    "platform": "Texecom",
    "protocol": "connect",
    "ip_address": "192.168.1.50",
    "ip_port": 10001,
    "udl": "1234",
    "homekit_modes": ["away", "night"],
    "time_sync_interval": 24
}
```

| Setting | What to put |
|---|---|
| `ip_address` | Your SmartCom's address, from your router's device list |
| `ip_port` | `10001` |
| `udl` | Your UDL code, in quotes. Texecom's default is `"1234"` |
| `homekit_modes` | Buttons besides Off: any of `"away"`, `"night"`, `"stay"` (shown as Home) |
| `time_sync_interval` | Hours between panel clock checks: `24`, or `0` for off |
| `part_arm_1` / `part_arm_2` / `part_arm_3` | Which Home app mode each part arm is: `"night"`, `"stay"`, `"away"` or `""` (not used). Defaults: `"night"`, `"stay"`, `""` |
| `zones`, `areas` | Leave out: they're read from the panel |
| `debug` | `true` logs every message from the panel, for reporting problems |

</details>

<details>
<summary><b>🔁 Already using Crestron, or connecting another way?</b></summary>

This plugin started out with the **Crestron** protocol, and it still works. It's for you if:

- you already use this plugin with a COM port set to **Crestron System** (on a switched-over SmartCom, a ComIP, a serial-to-network adapter or a USB-serial cable), or
- you want to keep the Texecom app fully working on its SmartCom, and add a second connection to the panel on a spare COM port.

**How it differs from Texecom Connect:**

- The COM port must be set to **Crestron System** in the engineer menu. A SmartCom switched over no longer works with the Texecom app or its notifications.
- You list your zones and areas yourself.
- Arms from the keypad or a keyfob show as one mode you choose, because the panel doesn't say which mode it was.
- After an arm or disarm from the Home app, the panel holds back its other updates for about 30 seconds. Nothing is lost, but sensors update late.

**Set the COM port to Crestron**, at the keypad: enter the engineer code → "UDL/Digi Options" → press 8 for "Com Port Setup" → scroll to the port → "No" to edit → press 8 for "Crestron System" → "Yes" to save → "Menu" to leave. For a new ComIP, set it up and check it works before switching its port.

**Settings:** choose **Crestron**, enter the address and port (10001 for a SmartCom or ComIP; for an adapter, the port set on it, often 23) or a serial port, and the UDL code. Then add your zones and area, and choose your arm buttons:

<img src="docs/images/settings-1-connection.png" width="420" alt="Crestron connection settings">
<img src="docs/images/settings-2-zones-and-areas.png" width="420" alt="Crestron zones and areas">
<img src="docs/images/settings-3-arm-modes.png" width="420" alt="Crestron arm modes">

| Setting | What to choose |
|---|---|
| **Zones** | One per zone: a name, its zone number (as on the keypad or in Wintex), what it shows as (motion, contact, smoke, CO), and a hold time (5000 for motion, 0 for contacts) |
| **Areas** | Usually one: area **1** (area A on the keypad) |
| **Night arms / Home arms** | The part arm each button sets; blank = Part Arm 1 |
| **Arms from the keypad or a keyfob show as** | Away suits most homes |
| **Advanced → Check the panel every** | 60 seconds (corrects the Home app if a message was missed) |

In config.json:

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

Other Crestron settings: `serial_device` (e.g. `"/dev/ttyUSB0"`, instead of `ip_address`) with `baud_rate` (`19200`); `home_part_arm`; `default_arm_state` (`"away"`, `"night"` or `"stay"`); `remote_users` (keyfob user numbers, shown as Away); `status_poll_interval` (seconds, default `60`); `trigger_from_zones` (leave `false`).

</details>

## 👩‍💻 Development

```bash
npm install
npm run lint
npm test
```

The tests run against fake panels, so no panel is needed. `tools/` has the probes and test scripts used on the real panel.

## 🙏 Credits

Original plugin by Kieran Jones, maintained by Max Christian and Chris Posthumus. Texecom Connect support builds on [texecom-connect](https://github.com/davidMbrooke/texecom-connect) (Apache-2.0) and [texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio) (MIT); see [lib/connect/NOTICE](lib/connect/NOTICE). Other projects that informed this fork are credited in [the review](docs/MAINTAINER-REVIEW.md#credits).

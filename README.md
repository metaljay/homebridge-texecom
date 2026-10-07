[![npm version](https://badgen.net/npm/v/homebridge-texecom-full/latest)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm beta version](https://badgen.net/npm/v/homebridge-texecom-full/beta)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm downloads](https://badgen.net/npm/dt/homebridge-texecom-full)](https://www.npmjs.com/package/homebridge-texecom-full)
[![GitHub last commit](https://badgen.net/github/last-commit/K1LL3R234/homebridge-texecom)](https://github.com/K1LL3R234/homebridge-texecom)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
> ## About this fork
>
> This is a **review and demonstrator fork** of [homebridge-texecom-full](https://github.com/K1LL3R234/homebridge-texecom), offered to the maintainer to adopt as they see fit. It isn't published to npm.
>
> - **What was found and fixed:** [docs/MAINTAINER-REVIEW.md](docs/MAINTAINER-REVIEW.md). The findings were tested on a real Premier Elite panel, including lost keypad disarms causing false alarms in HomeKit, and a ~60 s event blackout after arming from HomeKit.
> - **New: Texecom Connect support** (`"protocol": "connect"`) for a SmartCom/ComIP left in its normal mode. It reads zones and areas from the panel automatically, reports exact arm modes, and has no delay after arming from HomeKit. See [Choosing a connection](#choosing-a-connection).
> - **Crestron mode** keeps working as before, with the fixes from the review.
> - Credits: original plugin by Kieran Jones, maintained by Max Christian and Chris Posthumus. Connect protocol work builds on [texecom-connect](https://github.com/davidMbrooke/texecom-connect) (Apache-2.0) and [texecom2mqtt](https://github.com/dchesterton/texecom2mqtt-hassio) (MIT). See [lib/connect/NOTICE](lib/connect/NOTICE).
>
> Arming and disarming over Connect is implemented and tested against a simulated panel, but hasn't yet been verified on real hardware.

# homebridge-texecom-full

A plugin for [Homebridge](https://github.com/homebridge/homebridge) that creates HomeKit motion, contact, smoke, or carbon monoxide sensors for alarm zones from a Texecom Premier intruder alarm via a serial connection or COM-IP module.

You can receive notifications, which can be set to work only when you're away from home:

![example of notifications](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-notifications.jpg?raw=true)

Another great use is to use the alarm's motion sensors to switch lights on automatically:

![example of automation](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-automation.jpg?raw=true)

You can also set automations to happen when you arm the alarm and when the alarm goes off.

**IMPORTANT** - To use this plugin you will require a Texecom alarm system and a PC-COM, COM-IP or USB-COM serial interface. If using the PC-COM or USB-COM, you must also have nothing already utilising COM1 on the alarm panel, or be able to move existing modules connected to COM1 to a different COM port on the alarm panel. The support for IP is new and is intended for use with the COM-IP -- we don't know if it works with the SmartCom, so let us know if you get it working.

## Upgrading from 4.x

Version 5 adds Texecom Connect support (see below) and moves zones and areas behind the Homebridge bridge (previously each one was published as a separate "external" accessory that had to be paired individually).

1. After upgrading, remove the old individually-paired Texecom accessories from the Home app.
2. Restart Homebridge. The zones and areas appear automatically as part of your bridge.
3. Re-assign rooms and recreate any automations that used the old accessories.

Your existing config keeps working. If your UDL code starts with a `0`, re-enter it as a quoted string (e.g. `"0123"`), because numbers drop leading zeros.

It's recommended to run this plugin as a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) so a panel connection problem can't affect your other accessories.

## Choosing a connection

| | Crestron (default) | Texecom Connect (`"protocol": "connect"`) |
|---|---|---|
| Hardware | Serial cable (PC-COM/USB-COM), a ComIP, a SmartCom with its COM port set to **Crestron System**, or a serial-to-IP bridge | A **SmartCom or ComIP left in its normal mode** (Premier Elite, firmware v4+) |
| Zones and areas | Listed in the config | **Read from the panel automatically** (or listed to override) |
| Arm modes in HomeKit | Guessed for keypad arms (`default_arm_state`) | **Exact**: Full = Away, Part Arm 1/2/3 mapped with `part_arm_1`…`part_arm_3` |
| "Arming…" during the exit delay | No | Yes |
| After arming/disarming from HomeKit | Panel events are held back for up to ~60 s | No delay |
| Official Texecom app | Lost if you repurpose the SmartCom | Can't use the module while the plugin is connected |

Connect example — this is all that's needed:

```json
{
    "platform": "Texecom",
    "protocol": "connect",
    "ip_address": "192.168.1.70",
    "ip_port": 10001,
    "udl": "1234"
}
```

In Wintex (or at the panel), the module's COM port must be set to its normal type ("SmartCom" / "ComIP Module") and **Encrypted Ports** must be off for it. The panel briefly drops the connection when it reports an alarm through the module; the plugin reconnects and re-reads the state automatically.

## Configuration

Texecom zones must be configured individually in the Homebridge config.json file with the appropriate zone number from Texecom. Configuring areas is optional, but is required if you want to see if the alarm if set or have automations or notifications when the alarm is armed, disarmed or triggered. You probably have many zones and only one area.

Example:

```json
"platforms": [
    {
        "platform": "Texecom",
        "serial_device": "/dev/ttyUSB0",
        "baud_rate": 19200,
        "udl": "1234",
        "zones": [
            {
                "name": "Living Room",
                "zone_number": 7,
                "zone_type": "motion",
                "dwell": 1000
            },
            {
                "name": "Front Door",
                "zone_number": 15,
                "zone_type": "contact",
                "dwell": 1000
            },
            {
                "name": "Back Yard",
                "zone_number": 19,
                "zone_type": "motion",
                "dwell": 1000
            }
        ],
        "areas": [
            {
                "name": "Inside",
                "area_number": 1,
                "area_type": "securitysystem",
                "zones":[7,15]
            },
            {
                "name": "Outside",
                "area_number": 2,
                "area_type": "securitysystem",
                "zones":[19]
            }
        ]
    }
]
```


### Global Configuration

For serial connections:

| Key | Default | Description |
| --- | --- | --- |
| `serial_device` | N/A | The serial device on which to connect to Texecom |
| `baud_rate` | N/A | The baud rate configured in Texecom (Usually 19200) |
| `zones` | N/A | The individual configuration for each zone in Texecom |

For IP connections:

| Key | Default | Description |
| --- | --- | --- |
| `ip_address` | N/A | The IP address of the COM-IP Texecom module |
| `ip_port` | 10001 | The TCP port of the COM-IP Texecom module |

For UDL

| Key | Default | Description |
| --- | --- | --- |
| `udl` | N/A | The panel's UDL code (as a string, e.g. `"1234"`). Required to arm/disarm from HomeKit; without it areas are read-only. |

### Per-zone Configuration

This plugin is a platform plugin so you must configure each zone from your Texecom intruder alarm into your config individually.

| Key | Default | Description |
| --- | --- | --- |
| `name` | N/A | The name of the sensor as it will appear in HomeKit. |
| `zone_number` | N/A | The zone number from Texecom (1–640) |
| `zone_type` | `"motion"` | The type of zone; motion, contact, smoke, or carbonmonoxide |
| `dwell` | 0 | How long (in milliseconds) a zone stays active after the panel reports it has cleared |

### Per-area Configuration

| Key | Default | Description |
| --- | --- | --- |
| `name` | N/A | The name of the area as it will appear in HomeKit, e.g. 'Texecom Alarm'. |
| `area_number` | N/A | The area number from Texecom, usually 1. Only areas 1–8 can be armed/disarmed from HomeKit. |
| `area_type` | `"securitysystem"` | The type of area; only securitysystem is supported. |
| `zones` | N/A | Zone numbers in this area. Only used with `trigger_from_zones`. |

### Other options

| Key | Default | Description |
| --- | --- | --- |
| `default_arm_state` | `"away"` | How an arm by a keypad user is shown in HomeKit (`away`, `night` or `stay`). The panel doesn't say whether an arm was full or part. |
| `remote_users` | [] | Panel user numbers for remotes/keyfobs; their arms are always shown as Away |
| `trigger_from_zones` | false | Mark an armed area as triggered when one of its zones goes active (outside the entry delay). Leave off unless your panel doesn't report alarms itself. |
| `protocol` | `"crestron"` | `"crestron"` or `"connect"` (see *Choosing a connection*) |
| `part_arm_1` / `part_arm_2` / `part_arm_3` | `"night"` / `"stay"` / `""` | Connect only: how each part arm is shown in HomeKit (`night`, `stay`, `away`, or `""` for unused). HomeKit Night/Home arm the first part arm mapped to that mode |
| `time_sync_interval` | 0 | Connect only: hours between panel clock checks; the clock is corrected if more than a minute out. 0 = off |
| `night_part_arm` / `home_part_arm` | not set | Crestron only, area 1: the part arm (1, 2 or 3) that HomeKit Night / Home sets, using the panel's binary UDL part-arm command. Not set = the Crestron `Y` command, which always sets Part Arm 1 |
| `homekit_modes` | all | Arm modes offered in the Home app: any of `away`, `night`, `stay` (Off is always offered). E.g. `["away", "night"]` hides Home when it would do the same as Night |
| `status_poll_interval` | 60 | Crestron only: seconds between `ASTATUS` checks. Corrects HomeKit after a missed arm/disarm, and reconnects if the panel stops answering for three checks in a row (e.g. the serial side of an IP bridge has failed). 0 = only after connecting |
| `debug` | false | Log every message received from the panel without enabling Homebridge-wide debug mode |

### Arm modes in the Home app

The Home app shows an Off button plus up to three arm modes. On the panel:

| Home app | Crestron | Connect |
| --- | --- | --- |
| Away | Full arm | Full arm |
| Night | `night_part_arm`, or Part Arm 1 if unset | The part arm mapped to `night` |
| Home | `home_part_arm`, or Part Arm 1 if unset (the same as Night) | The part arm mapped to `stay` |

Use `homekit_modes` to offer only the modes you use, e.g. `["away", "night"]`, so the Home app doesn't show two buttons that do the same thing. The Home app only reads an alarm's buttons when it first sees it, so changing `homekit_modes` makes the alarm appear as a new accessory: set its room and any automations again.

### Tamper reporting

Each zone sensor exposes HomeKit's *Tampered* status. A zone is reported as tampered when the panel sends a status other than secure (`0`) or active (`1`).

## Configuring Texecom

Ensure your intruder alarm is fully configured and operational, connect a USB-Com or PC-Com cable to COM1 on the panel PCB and then connect to the computer running Homebridge.

To configure your COM1 port for the Crestron protocol:

1. Enter your engineer code
2. Scroll until you find "UDL/Digi Options"
3. Press 8 to jump to "Com Port Setup"
4. Scroll to "Com Port 1"
5. Press "No" to edit the port
6. Press 8 to jump to "Crestron System"
7. Press "Yes" to confirm and save.
8. Scroll until you find UDL.
9. Press "Yes" to go into it.
10. Press "No" to edit and change it to desired UDL code.
11. Press "Yes" to confirm and save.

Press "Menu" repeatedly to exit the engineer menu.

**Make sure you program your UDL code in the panel too.**

If connecting to a COM-IP, set up the COM-IP as usual and ensure it is working. Then change the configuration for the port the COM-IP is connected to to Crestron as detailed above. This allows the panel to configure the IP address into the module, then changing to Crestron will allow the panel to input/output the correct commands.

## Future features

Alarm systems are complicated and have a lot of features, not all them are suitable for integrating to HomeKit but many of them can be integrated.

* **Panic buttons** - Investigate the possibility of integrating the medical, panic, and fire buttons into HomeKit as buttons/switches to manually trigger those alerts.


## Development

```bash
npm install
npm run lint
npm test
```

The protocol parsing (`lib/protocol.js`) and the connection/command queue (`lib/connection.js`) are covered by unit tests that run against a fake COM-IP server, so no panel is needed.
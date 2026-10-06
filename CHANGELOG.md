# Change log

This change log documents all release versions of homebridge-texecom

### 5.0.0

**Breaking:** accessories now appear behind the Homebridge bridge instead of being published as separate external accessories. Remove the old Texecom accessories from the Home app once, then restart Homebridge. See "Upgrading from 4.x" in the README.

- **FIX** - The first arm/disarm from HomeKit after any panel event was silently ignored (the `setByAlarm` flag was never cleared because `updateValue` doesn't trigger `onSet`)
- **FIX** - Areas 5–8 sent the wrong area bitmask when arming/disarming, and area 8 was sent as two bytes
- **FIX** - IP connections now split incoming data into lines, so messages split across or combined in TCP packets are no longer lost
- **FIX** - A command's timeout timer kept running after `OK` arrived and could resend the command; commands are now queued so login + arm sequences never interleave
- **FIX** - An area event for an area missing from the config (or configured out of order) could crash Homebridge
- **FIX** - Repeated zone clears could leave several dwell timers running
- **FIX** - Connection errors were only logged when debug was on
- **NEW** - Dynamic platform with accessory caching: rooms, names and automations survive restarts, and zones/areas removed from the config are cleaned up
- **NEW** - Area state (and away-armed status) is restored from cache on restart instead of always showing Disarmed
- **NEW** - Zones report HomeKit *Tampered* status
- **NEW** - Serial port reconnects automatically; TCP uses keep-alive and exponential back-off; connections close cleanly on Homebridge shutdown
- **NEW** - Failed arm/disarm attempts return a proper HomeKit error, so the Home app shows "No Response" instead of a false success
- **NEW** - Config schema: UDL is a string (keeps leading zeros), zone/area numbers are integers with limits, layout split into sections, removed "Official" wording
- **NEW** - Config validation with clear log messages for missing or duplicate zone/area numbers
- **FIX** - Keypad arms reported as Night: arm state now uses `remote_users` and `default_arm_state` (same keys and logic as upstream 4.3.1+)
- **FIX** - Zone-inferred alarms are off by default (`trigger_from_zones`), because they misfire on every normal entry; the panel's own alarm message is used instead. When enabled, they ignore the entry delay.
- **FIX** - Command timeout raised to 5 s: a real COM-IP took 3 s to acknowledge a login
- **NEW** - Recognises keypad (`U`), exit delay (`X`) and entry delay (`E`) messages from the panel
- **NEW** - Regression test replaying a real panel session (`test/fixtures/real-session-2026-10-06.json`)
- **NEW** - **Texecom Connect support** (`"protocol": "connect"`) for a SmartCom/ComIP left in its normal mode: automatic zone/area discovery, exact arm modes (part arms mapped with `part_arm_1`…`part_arm_3`), "Arming…" during the exit delay, no post-command event delay, reset-before-disarm after an alarm, and automatic recovery when the panel drops the session to report an alarm. Protocol code credits: texecom-connect (Apache-2.0) and texecom2mqtt (MIT) — see `lib/connect/NOTICE`
- **NEW** - Connect: `time_sync_interval` panel clock correction (same option as upstream 4.4), without the Crestron post-login blackout
- **TWEAK** - Supports Homebridge `^1.8.0 || ^2.0.0` and Node `^20.18.0 || ^22.10.0 || ^24.0.0`
- **TWEAK** - Code split into `lib/` modules; uses the Homebridge logger directly
- **TWEAK** - Removed the unmaintained `string` and `zpad` packages and the unused `debug`, `crypto-js` and `@serialport/parser-readline` packages; `serialport` upgraded to v13
- **TWEAK** - Added ESLint and unit tests (`npm run lint`, `npm test`)

### 4.3.0 (2026-05-23)

- **FIX** - Homebridge v2 compatibility: updated to new platform API with `didFinishLaunching` and `configureAccessory`
- **FIX** - Replaced deprecated `on('set', callback)` characteristic handler with `onSet` returning a Promise
- **FIX** - UUID collision between zones and areas sharing the same zone number
- **FIX** - All alarm-driven state updates now use `updateValue` instead of `setValue` to prevent feedback loops
- **FIX** - SerialPort v12 compatibility: `baudRate` (camelCase) and `@serialport/parser-readline` pipe parser
- **FIX** - Removed erroneous `registerAccessory` call alongside `registerPlatform`

### 4.2.8 (2025-7-28)

- **TWEAK** - Data conversion issue (Typo)
- **NEWS** - We are verified!!

### 4.2.7 (2025-7-28)

- **FIX** - Connection issue
- **NEWS** - We are verified!!

### 4.2.6 (2025-07-25)

- **FIX** - Fixed issues for Verification.

### 4.2.6-beta.2 (2025-01-22)

- **FIX** - Removed carbondioxide

### 4.2.6-beta.0 (2025-01-21)

- **TWEAK** - House keeping.
- **FIX** - Added carbonmonoxide and dioxide to config.schema.

### 4.2.5 (2025-01-03)

- **TWEAK** - Added the version for serial port to work on new node.js

### 4.2.5-beta.1 (2024-12-17)

- **TWEAK** - Added the version for serial port to work on new node.js

### 4.2.3 (2024-10-09)

- **TWEAK** - Trying to get verified by homebridge

### 4.2.2-beta2 (2024-10-09)

- **TWEAK** - Can not install in certain cases. Added post script to check if python is installed.
- **TEST** - Tested on Homebridge V2

### 4.2.2-beta1 (2024-09-14)

- **TWEAK** - Area triggering reduced to Away Arm only
            - Not triggering when in Home and evening arm

### 4.2.1 (2024-09-14)

- **FEATURE** - Added arm and disarm for each area
              - Added zones to each area to be able to trigger an alarm.

### 1.0.3 (2017-01-28)

- **FIX** - Zone matching did not work at all in previous release.
- **FEATURE** - A dwell time is now configureable for each zone before activation is cleared.
- **FIX** - Breaks added to zone searching for added performance.

### 1.0.2 (2017-01-24)

- **TWEAK** - Zone matching made much more efficient for added improvement.

### 1.0.1 (2017-01-21)

- **FIX** - Dependencies for serialport were incorrect which prevented NPM installation.

### 1.0.0 (2017-01-21)

- **FEATURE** - Initial release.
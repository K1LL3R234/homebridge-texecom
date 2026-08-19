# Change log

This change log documents all release versions of homebridge-texecom

### 4.3.1-beta.2 (2026-08-19)

- **FIX** - Arming or disarming areas 5 to 8 addressed the wrong areas. The area bitmask was being run through `parseInt(..., 16)` a second time, so area 5 asked the panel for areas 2, 3 and 5, area 6 for 2, 5 and 6, area 7 for 3, 6 and 7, and area 8 sent a value too large to fit the byte. Areas 1 to 4 were unaffected, their masks survive the round trip. Present since 4.2.8.
- **FIX** - An area number outside the 1 to 8 the panel can address is now reported rather than quietly sending a null byte.

### 4.3.1-beta.1 (2026-08-19)

- **FIX** - The arm/disarm command is retried once, as the login already was. Panels have been seen to ignore the first write and answer only the resend, which silently lost the command.
- **FIX** - An area and a zone carrying the same number were given the same serial number, so a panel with, say, zone 1 and area 1 published several accessories that were identical as far as HomeKit was concerned. Area serial numbers are now namespaced, zone serial numbers are unchanged. Present since 4.2.8.

### 4.3.1-beta.0 (2026-08-18)

- **FIX** - Accessories are bridged again instead of being published as external accessories. 4.3.0 required every zone and area to be added to the Home app by hand, this restores the behaviour of 4.2.8 and earlier.
- **FIX** - Accessory UUIDs now match the scheme used up to 4.2.8, so upgrading from 4.2.8 keeps existing accessories along with their rooms, names and automations.
- **FIX** - Accessories are held in the Homebridge accessory cache and reused across restarts, and accessories removed from the config are unregistered.
- **FIX** - The first arm or disarm from a HomeKit button is no longer ignored (#26). The flag used to suppress echoes from the panel was never being cleared once alarm driven updates moved to `updateValue`.
- **FIX** - A full arm no longer changes to Night in the Home app a minute later (#25). The user numbers that decide how an arm is reported are configurable via `remote_users`, `app_users` and `default_arm_state` instead of being fixed in code, and an arm started from HomeKit now reports the state that was actually asked for.
- **FIX** - User numbers over 99 are no longer truncated when reading area messages from the panel.
- **FIX** - Areas are matched by area number rather than by their position in the config.
- **FIX** - The retry timer was never cleared once a command succeeded, so every arm or disarm sent a second UDL login to the panel two seconds later.
- **TWEAK** - `engines.homebridge` widened back to `^1.6.0 || ^2.0.0`, 4.3.0 refused to run on Homebridge 1.x.
- **TWEAK** - Removed the unused `crypto-js` dependency.

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
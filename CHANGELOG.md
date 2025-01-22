# Change log

This change log documents all release versions of homebridge-texecom

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

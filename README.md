[![npm version](https://badgen.net/npm/v/homebridge-texecom-full/latest)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm beta version](https://badgen.net/npm/v/homebridge-texecom-full/beta)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm downloads](https://badgen.net/npm/dt/homebridge-texecom-full)](https://www.npmjs.com/package/homebridge-texecom-full)
[![GitHub last commit](https://badgen.net/github/last-commit/K1LL3R234/homebridge-texecom)](https://github.com/K1LL3R234/homebridge-texecom)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
# homebridge-texecom-full

A plugin for [Homebridge](https://github.com/nfarina/homebridge) that creates HomeKit motion, contact, smoke, or carbon monoxide sensors for alarm zones from a Texecom Premier intruder alarm via a serial connection or COM-IP module.

You can receive notifications, which can be set to work only when you're away from home:

![example of notifications](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-notifications.jpg?raw=true)

Another great use is to use the alarm's motion sensors to switch lights on automatically:

![example of automation](https://github.com/K1LL3R234/homebridge-texecom/blob/master/images/example-automation.jpg?raw=true)

You can also set automations to happen when you arm the alarm and when the alarm goes off.

**IMPORTANT** - To use this plugin you will require a Texecom alarm system and a PC-COM, COM-IP or USB-COM serial interface. If using the PC-COM or USB-COM, you must also have nothing already utilising COM1 on the alarm panel, or be able to move existing modules connected to COM1 to a different COM port on the alarm panel. The support for IP is new and is intended for use with the COM-IP -- we don't know if it works with the SmartCom, so let us know if you get it working.

## Configuration

Texecom zones must be configured individually in the Homebridge config.json file with the appropriate zone number from Texecom. Configuring areas is optional, but is required if you want to see if the alarm if set or have automations or notifications when the alarm is armed, disarmed or triggered. You probably have many zones and only one area.

Example:

```json
"platforms": [
    {
        "platform": "Texecom",
        "serial_device": "/dev/ttyUSB0",
        "baud_rate": 19200,
        "udl":1234,
        "zones": [
            {
                "name": "Living Room",
                "zone_number": "7",
                "zone_type": "motion",
                "dwell": 1000
            },
            {
                "name": "Front Door",
                "zone_number": "15",
                "zone_type": "contact",
                "dwell": 1000
            },
            {
                "name": "Back Yard",
                "zone_number": "19",
                "zone_type": "motion",
                "dwell": 1000
            }
        ],
        "areas": [
            {
                "name": "Inside",
                "area_number": "1",
                "area_type": "securitysystem",
                "dwell": 0,
                "zones":[7,15]
            },
            {
                "name": "Outside",
                "area_number": "2",
                "area_type": "securitysystem",
                "dwell": 0,
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
| `udl` | 1234 | The UDL code on the panel to be able to arm and disarm alarm |

For arm state reporting

When an area is armed the panel reports the area and the user number, but not whether it was a full arm or a part arm. These settings say how to read that.

| Key | Default | Description |
| --- | --- | --- |
| `remote_users` | `[]` | User numbers that arm using a remote or keyfob, e.g. `[17]`. An arm by one of these users is always reported to HomeKit as Away. |
| `app_users` | `[]` | User numbers the panel reports when an area is armed from this plugin, e.g. `[25, 254]`. |
| `default_arm_state` | `"away"` | What to report for an arm by any other user, at a keypad for example. One of `away`, `night` or `stay`. |

When the arm was started from HomeKit the plugin already knows what was asked for and reports that, whatever the user number. These settings only come into play for an arm that started somewhere else.

### Panel Clock

The panel keeps its own clock, and nothing corrects it once it drifts apart from an engineer at the keypad. This checks it against the clock on the machine running Homebridge and sets it when the two have come apart.

| Key | Default | Description |
| --- | --- | --- |
| `time_sync_interval` | 0 | How often to check the panel clock, in hours. `1` checks every hour, `24` once a day, `744` once every 31 days, and anything in between works. `0` turns it off and leaves the panel clock alone. |

```json
"time_sync_interval": 24
```

It is off unless you set it. A UDL is needed, the same one arming uses, because the panel asks to be logged into before it will give up its clock or take a new time.

The panel is checked shortly after Homebridge connects to it as well as on the interval, so a panel that lost its clock in a power cut is put right without waiting for the next check. A difference of a minute is left alone: the panel only counts whole minutes, so a check landing either side of a minute boundary can look a minute out when it is really in step. Anything beyond that is set. The panel carries a two digit year, so it is read as being in this century.

Once a day is plenty for a panel that keeps reasonable time. Checking every hour is there for a panel that drifts badly, and costs two short commands each time.

### Upgrading from 4.3.0

**Only relevant if you ran 4.3.0.** Skip this if you came from 4.2.8 or earlier, or are installing fresh.

4.3.0 published every zone and area as a standalone accessory that had to be added to the Home app by hand. From 4.3.1 they are bridged again, which is how it worked up to 4.2.8 and means they appear on their own.

The catch is that HomeKit treats a standalone accessory and a bridged one as different accessories, so any scene, button or automation built on the ones 4.3.0 published stops working when they move back onto the bridge. Nothing the plugin does can carry that across.

If you set all that up under 4.3.0 and would rather keep it:

```json
"external_accessories": true
```

That republishes them exactly as 4.3.0 did, with the same identities, so everything keeps working untouched. The trade-off is that they stay outside the bridge, so a zone added later still has to be paired by hand.

Leaving it off, or leaving it out entirely, gives bridged accessories.
### Combined Areas

A combined area is a single accessory that arms or disarms several areas at once. The panel addresses areas as a bitmask, so all of them are armed with one command rather than several in a row.

```json
"area_groups": [
    {
        "name": "Everything",
        "areas": [1, 2, 3, 4, 5],
        "dwell": 0
    },
    {
        "name": "House and Garage",
        "areas": [1, 2],
        "dwell": 0
    }
]
```

| Key | Default | Description |
| --- | --- | --- |
| `name` | N/A | The name of the combined area as it will appear in HomeKit |
| `areas` | N/A | The area numbers to arm and disarm together. The panel supports areas 1 to 8 |
| `dwell` | 0 | The amount of time in ms before a cleared state is applied |

The areas can also still be listed under `areas` and keep their own accessories, and an area may belong to more than one combined area.

A combined area shows as armed only once every one of its areas is armed, so it never reports the house as set while part of it is still open. Until they are all armed HomeKit shows it arming. An alarm in any one of its areas shows through immediately.

### Per-zone Configuration

This plugin is a platform plugin so you must configure each zone from your Texecom intruder alarm into your config individually.

| Key | Default | Description |
| --- | --- | --- |
| `name` | N/A | The name of the area as it will appear in HomeKit, e.g. 'Texecom Alarm'. |
| `zone_number` | N/A | The zone number from Texecom |
| `zone_type` | `"motion"` | The type of zone; motion, contact, smoke, or carbonmonoxide |
| `dwell` | 0 | The amount of time in ms that a zone stays active after zone activation is cleared by Texecom |

### Per-area Configuration

| Key | Default | Description |
| --- | --- | --- |
| `name` | N/A | The name of the sensor as it will appear in HomeKit. |
| `area_number` | N/A | The area number from Texecom, usually 1. |
| `area_type` | `"securitysystem"` | The type of area; only securitysystem is supported. |
| `dwell` | 0 |  |
| `zones` | N/A | Add all the zone numbers to the area to be able to trigger alarm and the corresponding area |

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
10. Press "No" to edit and change it to disired UDL code.
11. Press "Yes" to confirm and save.

Press "Menu" repeatedly to exit the engineer menu.

**Make sure you program your UDL code in the panel too.**

If connecting to a COM-IP, set up the COM-IP as usual and ensure it is working. Then change the configuration for the port the COM-IP is connected to to Crestron as detailed above. This allows the panel to configure the IP address into the module, then changing to Crestron will allow the panel to input/output the correct commands.

## Future features

Alarm systems are complicated and have a lot of features, not all them are suitable for integrating to HomeKit but many of them can be integrated.

* **Panic buttons** - Investigate the possibility of integrating the medical, panic, and fire buttons into HomeKit as buttons/switches to manually trigger those alerts.


## Config Schema

If someone can make the config.schema.json interface pretty and improve on it it will be appreciated.
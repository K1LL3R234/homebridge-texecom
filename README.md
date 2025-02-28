[![npm version](https://badgen.net/npm/v/homebridge-texecom-full/latest)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm beta version](https://badgen.net/npm/v/homebridge-texecom-full/beta)](https://www.npmjs.com/package/homebridge-texecom-full)
[![npm downloads](https://badgen.net/npm/dt/homebridge-texecom-full)](https://www.npmjs.com/package/homebridge-texecom-full)
[![GitHub last commit](https://badgen.net/github/last-commit/K1LL3R234/homebridge-texecom)](https://github.com/K1LL3R234/homebridge-texecom)
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
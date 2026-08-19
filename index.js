var debug = require("debug")("TexecomAccessory");
var zpad = require("zpad");
var S = require('string');
var crypto = require("crypto");
var net = require('net');

const EventEmitter = require('events');
class ResponseEmitter extends EventEmitter { }
const responseEmitter = new ResponseEmitter();

const LogUtil = require('./util/logutil');

// Must match the "name" in package.json and the platform name registered below,
// both are used to register accessories against the Homebridge accessory cache.
const PLUGIN_NAME = "homebridge-texecom-full";
const PLATFORM_NAME = "Texecom";

var areas_armed = [];

// ─── Homebridge entry point ─────────────────────────────────────────────────
module.exports = (api) => {
    api.registerPlatform(PLATFORM_NAME, TexecomPlatform);
};

// ─── Platform ────────────────────────────────────────────────────────────────
class TexecomPlatform {
    constructor(log, config, api) {
        this.log = new LogUtil(config.debug, config.name, log);
        this.api = api;
        this.hap = api.hap;

        this.serial_device = config["serial_device"];
        this.baud_rate = config["baud_rate"];
        this.zones = config["zones"] || [];
        this.areas = config["areas"] || [];
        this.ip_address = config["ip_address"];
        this.ip_port = config["ip_port"];
        this.udl = config["udl"];

        // Which panel user numbers mean what when the panel reports an area as
        // armed. The panel does not say whether that was a full or a part arm,
        // so the user number is the only hint we get.
        this.remote_users = parseUserList(config["remote_users"]);
        this.app_users = parseUserList(config["app_users"]);
        this.default_arm_state = String(config["default_arm_state"] || "away").toLowerCase();

        // Accessories restored from the Homebridge cache, keyed by UUID.
        this.cachedAccessories = new Map();

        this.api.on('didFinishLaunching', () => {
            this._setupAccessories();
        });
    }

    // Called once for every accessory Homebridge has cached for this platform,
    // before didFinishLaunching. Hold on to them so they are reused rather than
    // recreated, which is what keeps them in place in the Home app.
    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
        this.cachedAccessories.set(accessory.UUID, accessory);
    }

    _setupAccessories() {
        const platform = this;
        const { hap, api } = this;

        const zoneAccessories = this.zones.map(z => new TexecomAccessory(this.log, z, hap));
        const areaAccessories = this.areas.map(a => new TexecomAccessory(this.log, a, hap));
        const zoneCount = zoneAccessories.length;
        const areaCount = areaAccessories.length;

        const activeUUIDs = new Set();

        // Accessories are published through the Homebridge bridge, so they turn
        // up in the Home app on their own.
        //
        // The UUID deliberately reproduces the scheme Homebridge used for the
        // static platform in 4.2.8 and earlier - uuid.generate(platform name +
        // ":" + accessory name) - so that an accessory upgraded from an older
        // release keeps its identity, and with it its room, its name and any
        // automations it takes part in.
        const attachAccessory = (acc) => {
            const uuid = hap.uuid.generate(`${PLATFORM_NAME}:${acc.name}`);

            if (activeUUIDs.has(uuid)) {
                platform.log.error(`Duplicate accessory name "${acc.name}" in config, names must be unique. Skipping.`);
                return;
            }
            activeUUIDs.add(uuid);

            let hapAccessory = platform.cachedAccessories.get(uuid);
            const isNew = !hapAccessory;

            if (isNew) {
                platform.log.log(`Adding accessory ${acc.name}`);
                hapAccessory = new api.platformAccessory(acc.name, uuid);
            }

            acc.setupServices(hapAccessory, platform);

            if (isNew) {
                api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [hapAccessory]);
            } else {
                api.updatePlatformAccessories([hapAccessory]);
            }

            platform.cachedAccessories.set(uuid, hapAccessory);
        };

        zoneAccessories.forEach(attachAccessory);
        areaAccessories.forEach(attachAccessory);

        // Anything cached that is no longer in the config has to go, otherwise
        // it lingers in the Home app as an unresponsive accessory.
        const stale = [...platform.cachedAccessories.entries()].filter(([uuid]) => !activeUUIDs.has(uuid));
        if (stale.length > 0) {
            stale.forEach(([uuid, accessory]) => {
                platform.log.log(`Removing accessory ${accessory.displayName}, no longer in config`);
                platform.cachedAccessories.delete(uuid);
            });
            api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(([, accessory]) => accessory));
        }

        const findArea = (area_number) => areaAccessories.find(a => Number(a.zone_number) === Number(area_number));

        // ── Data processing ──────────────────────────────────────────────────
        function processData(raw) {
            const data = String(raw).trim();
            if (!data) {
                return;
            }

            if (S(data).startsWith('"Z')) {
                var zone_data = Number(S(S(data).between('Z')).left(4).s);
                var updated_zone = Number(S(S(data).between('Z')).left(3).s);
                var zone_active = S(zone_data).endsWith('1');

                platform.log.debug(`Zone update received for zone ${updated_zone} active: ${zone_active}`);

                for (var i = 0; i < zoneCount; i++) {
                    if (zoneAccessories[i].zone_number == updated_zone) {
                        platform.log.debug(`Zone match found, updating zone status in HomeKit to ${zone_active}`);
                        zoneAccessories[i].changeHandler(zone_active);

                        if (zone_active) {
                            for (var a = 0; a < areaCount; a++) {
                                try {
                                    areaAccessories[a].zones.forEach(zone => {
                                        if (zone == zpad(updated_zone, 3) && is_armed(areaAccessories[a].zone_number)) {
                                            var stateValue = hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
                                            platform.log.log(`Area ${areaAccessories[a].zone_number} manual triggered`);
                                            areaAccessories[a].changeHandler(stateValue);
                                        }
                                    });
                                } catch (e) {
                                    console.debug(`Error processing zones for area ${a}: Please add zones under area.`);
                                }
                            }
                        }
                        break;
                    }
                }

            } else if (S(data).startsWith('"A') || S(data).startsWith('"D') || S(data).startsWith('"L')) {
                const Characteristic = hap.Characteristic;

                // "Saaauu - S is the status letter, aaa the area, uu the user.
                // The user number is not fixed width, a panel with more than 99
                // users reports three digits, so take every digit that is there
                // rather than a fixed slice.
                const parsed = /^"([ADL])(\d{3})(\d*)/.exec(data);
                if (!parsed) {
                    platform.log.debug(`Malformed area message from Texecom: ${data}`);
                    return;
                }

                const status = parsed[1];
                const updated_area = Number(parsed[2]);
                const user = parsed[3];
                const area = findArea(updated_area);
                var stateValue;

                switch (status) {
                    case "L":
                        stateValue = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
                        platform.log.log(`Area ${updated_area} triggered`);
                        break;

                    case "D":
                        stateValue = Characteristic.SecuritySystemCurrentState.DISARMED;
                        platform.log.log(`Area ${updated_area} disarmed by User ${user}`);
                        areas_armed = areas_armed.filter(v => v !== zpad(updated_area, 3));
                        // The area is disarmed, so whatever we last asked the
                        // panel for no longer tells us anything about it.
                        if (area) {
                            area.pending_target_state = null;
                        }
                        break;

                    case "A":
                        stateValue = resolveArmedState(platform, area, user, updated_area);
                        if (stateValue == null) {
                            return;
                        }

                        if (stateValue == Characteristic.SecuritySystemCurrentState.AWAY_ARM) {
                            const idx = areas_armed.findIndex(v => v === null || v === undefined);
                            if (idx !== -1) {
                                areas_armed[idx] = zpad(updated_area, 3);
                            } else {
                                areas_armed.push(zpad(updated_area, 3));
                            }
                        }
                        break;

                    default:
                        platform.log.log(`Unknown status letter ${status}`);
                        return;
                }

                if (area) {
                    platform.log.debug(`Area match found, updating area status in HomeKit to ${stateValue}`);
                    area.changeHandler(stateValue, user);
                }

            } else {
                platform.log.debug(`Unknown string from Texecom: ${S(data)}`);
            }
        }

        // ── IP connection with auto-reconnect ────────────────────────────────
        function setupConnection() {
            platform.log.log('Attempting connection to Texecom...');

            var connection = net.createConnection(platform.ip_port, platform.ip_address);
            connection.setNoDelay(true);

            connection.on('connect', () => platform.log.log('Connected via IP'));

            connection.on('data', function (data) {
                platform.log.debug(`IP data received: ${data}`);
                responseEmitter.emit('data', data);
                processData(data);
            });

            connection.on('error', (err) => {
                platform.log.error('IP connection error:', err.message);
            });

            connection.on('close', () => {
                platform.log.error('IP connection closed. Reconnecting in 10s...');
                setTimeout(() => setupConnection(), 10000);
            });

            connection.on('end', () => platform.log.log('IP connection ended'));

            platform.texecomConnection = connection;
        }

        // ── Connect via serial or IP ─────────────────────────────────────────
        if (this.serial_device) {
            // serialport v12: baudRate (camelCase) + separate ReadlineParser
            const { SerialPort } = require('serialport');
            const { ReadlineParser } = require('@serialport/parser-readline');

            const sp = new SerialPort({ path: this.serial_device, baudRate: this.baud_rate });
            const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));

            sp.on("open", () => platform.log.log("Serial port opened"));
            sp.on("error", (err) => platform.log.error("Serial port error:", err.message));

            parser.on('data', function (data) {
                platform.log.debug(`Serial data received: ${data}`);
                responseEmitter.emit('data', data);
                processData(data);
            });

            platform.texecomConnection = sp;

        } else if (this.ip_address) {
            setupConnection();

        } else {
            this.log.log("Must set either serial_device or ip_address in configuration.");
        }
    }
}

// ─── Working out what "armed" means ──────────────────────────────────────────
// The panel reports an area as armed without saying whether that was a full arm
// or a part arm, so the state shown in HomeKit is worked out from, in order:
//
//   1. the user number, if it has been configured as a remote/keyfob
//   2. the state we asked the panel for, if this arm came from HomeKit
//   3. the configured default for every other user, e.g. a keypad arm
//
// Returns a SecuritySystemCurrentState, or null if it cannot be worked out.
function resolveArmedState(platform, area, user, updated_area) {
    const Characteristic = platform.hap.Characteristic;
    const user_number = normaliseUser(user);

    if (platform.remote_users.includes(user_number)) {
        platform.log.log(`Area ${updated_area} armed (away) by remote User ${user}`);
        return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }

    const pending = area ? area.pending_target_state : null;

    if (pending != null) {
        const stateValue = targetToCurrentState(Characteristic, pending);
        if (stateValue == null) {
            platform.log.error(`Unknown target state: ${pending}`);
            return null;
        }
        platform.log.log(`Area ${updated_area} armed by User ${user}, using the state requested from HomeKit (${stateValue})`);
        return stateValue;
    }

    if (platform.app_users.includes(user_number)) {
        platform.log.debug(`User ${user} is configured as an app user but nothing was requested from HomeKit, falling back to the default arm state`);
    }

    switch (platform.default_arm_state) {
        case "night":
            platform.log.log(`Area ${updated_area} armed (night) by User ${user}`);
            return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        case "stay":
        case "home":
            platform.log.log(`Area ${updated_area} armed (home) by User ${user}`);
            return Characteristic.SecuritySystemCurrentState.STAY_ARM;
        default:
            platform.log.log(`Area ${updated_area} armed (away) by User ${user}`);
            return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
}

function targetToCurrentState(Characteristic, targetState) {
    switch (targetState) {
        case Characteristic.SecuritySystemTargetState.AWAY_ARM:
            return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
        case Characteristic.SecuritySystemTargetState.STAY_ARM:
            return Characteristic.SecuritySystemCurrentState.STAY_ARM;
        case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
            return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        case Characteristic.SecuritySystemTargetState.DISARM:
            return Characteristic.SecuritySystemCurrentState.DISARMED;
        default:
            return null;
    }
}

function currentToTargetState(Characteristic, currentState) {
    switch (currentState) {
        case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
            return Characteristic.SecuritySystemTargetState.NIGHT_ARM;
        case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
            return Characteristic.SecuritySystemTargetState.AWAY_ARM;
        case Characteristic.SecuritySystemCurrentState.STAY_ARM:
            return Characteristic.SecuritySystemTargetState.STAY_ARM;
        case Characteristic.SecuritySystemCurrentState.DISARMED:
            return Characteristic.SecuritySystemTargetState.DISARM;
        default:
            return null; // alarm triggered has no corresponding target state
    }
}

function parseUserList(value) {
    if (value === null || value === undefined || value === "") {
        return [];
    }
    const values = Array.isArray(value) ? value : String(value).split(",");
    return values.map(normaliseUser).filter(v => v !== null);
}

// User numbers are compared as numbers so that 17, "17" and "017" all match.
function normaliseUser(value) {
    if (value === null || value === undefined || String(value).trim() === "") {
        return null;
    }
    const user_number = Number(String(value).trim());
    return Number.isNaN(user_number) ? null : user_number;
}

// ─── Accessory ───────────────────────────────────────────────────────────────
function TexecomAccessory(log, config, hap) {
    this.log = log;
    this.hap = hap;

    this.zone_number = zpad(config["zone_number"] || config["area_number"], 3);
    this.name = config["name"];
    this.zone_type = config["zone_type"] || config["area_type"] || "motion";
    this.dwell_time = config["dwell"] || 0;
    this.dwell_timer = null;

    // Replaced with the real handler once the accessory has been published.
    this.changeHandler = function () { };

    // The state last requested from HomeKit and accepted by the panel, cleared
    // when the area is disarmed. Null means the panel was armed by something
    // other than us, so we have nothing to go on.
    this.pending_target_state = null;

    try {
        if (Array.isArray(config["zones"])) {
            this.zones = config["zones"].map(zone => zpad(zone, 3));
        } else {
            this.zones = zpad(config["zones"], 3);
        }
    } catch (e) { /* no zones */ }

    if (config["sn"]) {
        this.sn = config["sn"];
    } else {
        // An area and a zone can carry the same number, which used to give
        // them the same serial number. Only the area side is namespaced so
        // that zone serial numbers stay as they have always been.
        const shasum = crypto.createHash('sha1');
        shasum.update(this.zone_type === "securitysystem" ? `area:${this.zone_number}` : this.zone_number);
        this.sn = shasum.digest('base64');
        log.log(`Computed SN: ${this.sn}`);
    }
}

TexecomAccessory.prototype = {

    // Builds the services on a bridged platform accessory. A cached accessory
    // keeps the services it already has, they are only added when missing, so
    // that restarting Homebridge does not disturb the accessory in HomeKit.
    setupServices: function (hapAccessory, platform) {
        const { Service, Characteristic } = this.hap;
        const me = this;

        this._platform = platform;

        hapAccessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
            .setCharacteristic(Characteristic.Model, `Texecom ${this.zone_type === "securitysystem" ? "Area" : "Zone"}`)
            .setCharacteristic(Characteristic.SerialNumber, this.sn);

        var ServiceType, changeAction;

        switch (this.zone_type) {
            case "contact":
                ServiceType = Service.ContactSensor;
                break;
            case "smoke":
                ServiceType = Service.SmokeSensor;
                break;
            case "carbonmonoxide":
                ServiceType = Service.CarbonMonoxideSensor;
                break;
            case "securitysystem":
                ServiceType = Service.SecuritySystem;
                break;
            default: // motion (and fallback)
                ServiceType = Service.MotionSensor;
                break;
        }

        // Drop anything left over from a zone_type that has since been changed.
        hapAccessory.services
            .filter(s => s.UUID !== Service.AccessoryInformation.UUID && s.UUID !== ServiceType.UUID)
            .forEach(s => {
                me.log.debug(`Removing stale service from ${me.name}`);
                hapAccessory.removeService(s);
            });

        const service = hapAccessory.getService(ServiceType) || hapAccessory.addService(ServiceType, this.name);

        switch (this.zone_type) {
            case "contact":
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.ContactSensorState)
                        .updateValue(newState
                            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                            : Characteristic.ContactSensorState.CONTACT_DETECTED);
                };
                break;

            case "smoke":
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.SmokeDetected)
                        .updateValue(newState
                            ? Characteristic.SmokeDetected.SMOKE_DETECTED
                            : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
                };
                break;

            case "carbonmonoxide":
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.CarbonMonoxideDetected)
                        .updateValue(newState
                            ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
                            : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
                };
                break;

            case "securitysystem":
                changeAction = function (newState) {
                    const targetState = currentToTargetState(Characteristic, newState);

                    // updateValue, never setValue: setValue would fire the set
                    // handler below and send the state straight back to the
                    // panel as though the user had asked for it.
                    if (targetState != null) {
                        service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(targetState);
                    }
                    service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(newState);
                    me.log.debug(`Set target state ${targetState} and current state ${newState}`);
                };

                // Safe default on startup
                changeAction(Characteristic.SecuritySystemCurrentState.DISARMED);

                var area = this;

                service.getCharacteristic(Characteristic.SecuritySystemTargetState)
                    .onSet(function (value) {
                        return new Promise((resolve, reject) => {
                            // platform reference is injected above
                            const platform = me._platform;
                            if (platform && platform.udl != null) {
                                areaTargetSecurityStateSet(platform, area, service, value,
                                    (err) => err ? reject(err) : resolve());
                            } else {
                                me.log.debug("No UDL configured. Add UDL to enable arm/disarm from HomeKit.");
                                reject(new Error("No UDL configured"));
                            }
                        });
                    });
                break;

            default: // motion (and fallback)
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.MotionDetected).updateValue(newState);
                };
                break;
        }

        this.changeHandler = function (status, user) {
            const newState = status;
            me.log.debug(`Dwell = ${me.dwell_time}`);
            if (!newState && me.dwell_time > 0) {
                me.dwell_timer = setTimeout(() => changeAction(newState), me.dwell_time);
            } else {
                if (me.dwell_timer) clearTimeout(me.dwell_timer);
                changeAction(newState);
            }

            if (!user) {
                me.log.debug(`Changing state with changeHandler to ${newState}`);
            } else {
                me.log.debug(`Changing state with changeHandler to ${newState} by User ${user}`);
            }
        };

        return service;
    }
};

// ─── Arm/disarm command ───────────────────────────────────────────────────────
function areaTargetSecurityStateSet(platform, accessory, service, value, callback) {
    const { Characteristic } = platform.hap;

    const hexMapping = {
        '1': 0x01, '2': 0x02, '3': 0x04, '4': 0x08,
        '5': 0x10, '6': 0x20, '7': 0x40, '8': 0x80
    };

    var area_number = String.fromCharCode(parseInt(hexMapping[parseInt(accessory.zone_number, 10)], 16));

    var command;
    switch (value) {
        case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        case Characteristic.SecuritySystemTargetState.STAY_ARM:
            command = `Y${area_number}`; break;
        case Characteristic.SecuritySystemTargetState.AWAY_ARM:
            command = `A${area_number}`; break;
        case Characteristic.SecuritySystemTargetState.DISARM:
            command = `D${area_number}`; break;
        default:
            platform.log.debug(`Unknown target state: ${value}`);
            callback(new Error("Unknown target state"));
            return;
    }

    platform.log.debug(`Sending command ${value} to area ${accessory.zone_number}`);

    // Both the login and the command itself get a retry. Panels have been seen
    // to ignore the first write and answer the resend, so a command sent only
    // once can be swallowed. Arming an already armed area is a no-op, so a
    // duplicate is harmless.
    writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
        .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command))
        .then(() => {
            // OK response from alarm is only indication that the target state has been reached
            const currentState = targetToCurrentState(Characteristic, value);
            if (currentState == null) {
                platform.log.debug(`Unknown target alarm state ${value}`);
                callback(new Error("Unknown target state"));
                return;
            }
            platform.log.debug(`Area ${accessory.zone_number} → state ${currentState}`);
            service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(currentState);

            // Remember what was asked for. The panel reports the area as armed
            // once the exit delay has run, without saying how it was armed, and
            // this is what stops that report being taken for a part arm.
            accessory.pending_target_state = (value === Characteristic.SecuritySystemTargetState.DISARM) ? null : value;
            callback();
        })
        .catch(err => {
            platform.log.debug(`Command error: ${err}`);
            callback(err);
        });
}

// ─── Command writer ───────────────────────────────────────────────────────────
function writeCommandAndWaitForOK(connection, command, retryCount = 1) {
    return new Promise((resolve, reject) => {
        function settle(fn, arg) {
            clearTimeout(timer);
            responseEmitter.removeListener('data', handleData);
            fn(arg);
        }

        function handleData(data) {
            if (data.toString().trim() === 'OK') {
                settle(resolve);
            }
        }

        responseEmitter.on('data', handleData);

        // Cleared as soon as the panel answers. Left running, it sends a
        // command the panel has already acknowledged a second time.
        const timer = setTimeout(() => {
            responseEmitter.removeListener('data', handleData);
            if (retryCount > 0) {
                writeCommandAndWaitForOK(connection, command, retryCount - 1)
                    .then(resolve).catch(reject);
            } else {
                reject(new Error("Timeout after retries"));
            }
        }, 2000);

        connection.write(`\\${command}/`, function (err) {
            if (err) {
                settle(reject, err);
            }
        });
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function is_armed(area_number) {
    return areas_armed.some(v => v === area_number);
}

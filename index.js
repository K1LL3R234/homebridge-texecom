var debug = require("debug")("TexecomAccessory");
var serialport = require("serialport");
var zpad = require("zpad");
var S = require('string');
var crypto = require("crypto");
var net = require('net');

const EventEmitter = require('events');
class ResponseEmitter extends EventEmitter { }
const responseEmitter = new ResponseEmitter();

const LogUtil = require('./util/logutil');

var areas_armed = [];
var setByAlarm = false;

// ─── Homebridge v2 entry point ──────────────────────────────────────────────
module.exports = (api) => {
    api.registerPlatform("Texecom", TexecomPlatform);
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

        this.api.on('didFinishLaunching', () => {
            this._setupAccessories();
        });
    }

    // Required by v2 — called for each cached accessory; we don't cache, so no-op
    configureAccessory(accessory) { }

    _setupAccessories() {
        const platform = this;
        const { hap, api } = this;

        const zoneAccessories = this.zones.map(z => new TexecomAccessory(this.log, z, hap));
        const areaAccessories = this.areas.map(a => new TexecomAccessory(this.log, a, hap));
        const zoneCount = zoneAccessories.length;
        const areaCount = areaAccessories.length;

        // Publish all accessories as external accessories (no cache needed)
        // UUID is namespaced with type prefix to prevent collisions between a zone
        // and an area that share the same zone_number / SN.
        const publishAccessory = (acc, typePrefix) => {
            acc._platform = platform; // inject platform ref for onSet handler
            const uuid = hap.uuid.generate(`${typePrefix}:${acc.sn}`);
            const hapAcc = new api.platformAccessory(acc.name, uuid);

            const [, mainSvc] = acc.getServices();

            // Populate the built-in AccessoryInformation service
            hapAcc.getService(hap.Service.AccessoryInformation)
                .setCharacteristic(hap.Characteristic.Manufacturer, "Homebridge")
                .setCharacteristic(hap.Characteristic.Model, `Texecom ${typePrefix === "area" ? "Area" : "Zone"}`)
                .setCharacteristic(hap.Characteristic.SerialNumber, acc.sn);

            hapAcc.addService(mainSvc);
            api.publishExternalAccessories("homebridge-texecom-full", [hapAcc]);
        };

        zoneAccessories.forEach(acc => publishAccessory(acc, "zone"));
        areaAccessories.forEach(acc => publishAccessory(acc, "area"));

        // ── Data processing ──────────────────────────────────────────────────
        function processData(data) {
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
                                            setByAlarm = true;
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
                var updated_area = Number(S(S(data).substring(2, 5)));
                var status = S(data).substring(1, 2);
                var user = S(data).substring(5, 7);
                var stateValue;
                const armedByUser = user;

                switch (String(status)) {
                    case "L":
                        stateValue = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
                        platform.log.log(`Area ${updated_area} triggered`);
                        break;

                    case "D":
                        stateValue = Characteristic.SecuritySystemCurrentState.DISARMED;
                        platform.log.log(`Area ${updated_area} disarmed by User ${user}`);
                        areas_armed = areas_armed.filter(v => v !== zpad(updated_area, 3));
                        break;

                    case "A":
                        if (user == "17") {
                            stateValue = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
                            platform.log.log(`Area ${updated_area} armed (away) by User ${user}`);
                        } else if (user == "25" || user == "254") {
                            const targetState = areaAccessories[updated_area - 1].target_State;
                            switch (targetState) {
                                case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.AWAY_ARM; break;
                                case Characteristic.SecuritySystemTargetState.STAY_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.STAY_ARM; break;
                                case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.NIGHT_ARM; break;
                                case Characteristic.SecuritySystemTargetState.DISARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.DISARMED; break;
                                default:
                                    platform.log.error(`Unknown target state: ${targetState}`);
                                    return;
                            }
                            platform.log.log(`User ${user}: Target state ${targetState} → stateValue ${stateValue}`);
                        } else {
                            stateValue = Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
                            platform.log.log(`Area ${updated_area} armed (night) by User ${user}`);
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

                for (var i = 0; i < areaCount; i++) {
                    if (areaAccessories[i].zone_number == updated_area) {
                        platform.log.debug(`Area match found, updating area status in HomeKit to ${stateValue}`);
                        setByAlarm = true;
                        areaAccessories[i].changeHandler(stateValue, armedByUser);
                        break;
                    }
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

// ─── Accessory ───────────────────────────────────────────────────────────────
function TexecomAccessory(log, config, hap) {
    this.log = log;
    this.hap = hap;

    this.zone_number = zpad(config["zone_number"] || config["area_number"], 3);
    this.name = config["name"];
    this.zone_type = config["zone_type"] || config["area_type"] || "motion";
    this.dwell_time = config["dwell"] || 0;
    this.dwell_timer = null;

    if (config["area_type"] == "securitysystem") {
        this.target_State = hap.Characteristic.SecuritySystemTargetState.DISARM;
    }

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
        const shasum = crypto.createHash('sha1');
        shasum.update(this.zone_number);
        this.sn = shasum.digest('base64');
        log.log(`Computed SN: ${this.sn}`);
    }
}

TexecomAccessory.prototype = {

    getServices: function () {
        const { Service, Characteristic } = this.hap;
        const me = this;

        var service, changeAction;

        // informationService is returned but the platform populates the
        // built-in one on the platformAccessory; this keeps the shape identical
        var informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
            .setCharacteristic(Characteristic.Model, `Texecom ${this.zone_type === "securitysystem" ? "Area" : "Zone"}`)
            .setCharacteristic(Characteristic.SerialNumber, this.sn);

        switch (this.zone_type) {
            case "contact":
                service = new Service.ContactSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.ContactSensorState)
                        .updateValue(newState
                            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                            : Characteristic.ContactSensorState.CONTACT_DETECTED);
                };
                break;

            case "smoke":
                service = new Service.SmokeSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.SmokeDetected)
                        .updateValue(newState
                            ? Characteristic.SmokeDetected.SMOKE_DETECTED
                            : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
                };
                break;

            case "carbonmonoxide":
                service = new Service.CarbonMonoxideSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.CarbonMonoxideDetected)
                        .updateValue(newState
                            ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
                            : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
                };
                break;

            case "securitysystem":
                service = new Service.SecuritySystem();

                changeAction = function (newState) {
                    var targetState;
                    switch (newState) {
                        case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.NIGHT_ARM; break;
                        case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.AWAY_ARM; break;
                        case Characteristic.SecuritySystemCurrentState.STAY_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.STAY_ARM; break;
                        case Characteristic.SecuritySystemCurrentState.DISARMED:
                            targetState = Characteristic.SecuritySystemTargetState.DISARM; break;
                        default:
                            targetState = null; break;
                    }
                    if (targetState != null) {
                        service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(targetState);
                    }
                    service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(newState);
                    me.log.debug(`Set target state ${targetState} and current state ${newState}`);
                };

                // Safe default on startup
                changeAction(Characteristic.SecuritySystemCurrentState.DISARMED);

                var area = this;

                // v2: onSet returns a Promise; deprecated on('set', cb) removed
                service.getCharacteristic(Characteristic.SecuritySystemTargetState)
                    .onSet(function (value) {
                        return new Promise((resolve, reject) => {
                            if (setByAlarm) {
                                me.log.debug(`Ignoring set — state change came from alarm itself.`);
                                setByAlarm = false;
                                resolve();
                                return;
                            }
                            // platform reference is injected after construction
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
                service = new Service.MotionSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.MotionDetected).updateValue(newState);
                };
                break;
        }

        this.changeHandler = function (status) {
            const newState = status;
            me.log.debug(`Dwell = ${me.dwell_time}`);
            if (!newState && me.dwell_time > 0) {
                me.dwell_timer = setTimeout(() => changeAction(newState), me.dwell_time);
            } else {
                if (me.dwell_timer) clearTimeout(me.dwell_timer);
                changeAction(newState);
            }
        };

        return [informationService, service];
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

    writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
        .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command, 0))
        .then(() => {
            var currentState;
            switch (value) {
                case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.NIGHT_ARM; break;
                case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.AWAY_ARM; break;
                case Characteristic.SecuritySystemTargetState.STAY_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM; break;
                case Characteristic.SecuritySystemTargetState.DISARM:
                    currentState = Characteristic.SecuritySystemCurrentState.DISARMED; break;
                default:
                    platform.log.debug(`Unknown target alarm state ${value}`);
                    callback(new Error("Unknown target state"));
                    return;
            }
            platform.log.debug(`Area ${accessory.zone_number} → state ${currentState}`);
            service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(currentState);
            accessory.target_State = currentState;
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
        function handleData(data) {
            if (data.toString().trim() === 'OK') {
                responseEmitter.removeListener('data', handleData);
                resolve();
            }
        }

        responseEmitter.on('data', handleData);

        connection.write(`\\${command}/`, function (err) {
            if (err) {
                responseEmitter.removeListener('data', handleData);
                reject(err);
            }
        });

        setTimeout(() => {
            responseEmitter.removeListener('data', handleData);
            if (retryCount > 0) {
                writeCommandAndWaitForOK(connection, command, retryCount - 1)
                    .then(resolve).catch(reject);
            } else {
                reject(new Error("Timeout after retries"));
            }
        }, 2000);
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function is_armed(area_number) {
    return areas_armed.some(v => v === area_number);
}
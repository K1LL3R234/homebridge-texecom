var Service;
var Characteristic;
var Accessory;
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

var areas_armed = [];  // Creates an empty array, which can later grow dynamically


var setByAlarm = false;


module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory("homebridge-texecom-full", "Texecom", TexecomAccessory);
    homebridge.registerPlatform("homebridge-texecom-full", "Texecom", TexecomPlatform);
}

function TexecomPlatform(log, config) {
    this.log = new LogUtil(
        config.debug,
        config.name,
        log
    );

    this.serial_device = config["serial_device"];
    this.baud_rate = config["baud_rate"];
    this.zones = config["zones"] || [];
    this.areas = config["areas"] || [];
    this.ip_address = config["ip_address"];
    this.ip_port = config["ip_port"];
    this.udl = config["udl"];
}

TexecomPlatform.prototype = {

    accessories: function (callback) {
        var zoneAccessories = [];
        for (var i = 0; i < this.zones.length; i++) {
            var zone = new TexecomAccessory(this.log, this.zones[i]);
            zoneAccessories.push(zone);
        }
        var zoneCount = zoneAccessories.length;


        var areaAccessories = [];
        for (var i = 0; i < this.areas.length; i++) {
            var area = new TexecomAccessory(this.log, this.areas[i]);
            areaAccessories.push(area);
        }
        var areaCount = areaAccessories.length;

        callback(zoneAccessories.concat(areaAccessories));

        platform = this;

        function processData(data) {
            // Received data is a zone update
            if (S(data).startsWith('"Z')) {
                // Extract the data from the serial line received
                var zone_data = Number(S(S(data).between('Z')).left(4).s);
                // Extract the zone number that is being updated
                var updated_zone = Number(S(S(data).between('Z')).left(3).s);
                // Is the zone active?
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

                                            // Set the security system state to "ALARM_TRIGGERED"
                                            stateValue = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
                                            platform.log.log(`Area ${areaAccessories[a].zone_number} manual triggered`);

                                            // Log the state change
                                            platform.log.debug(`Area match found, updating area status in HomeKit to ${stateValue}`);
                                            setByAlarm = true;
                                            areaAccessories[a].changeHandler(stateValue);

                                        }
                                    });
                                }
                                catch (e) {
                                    console.debug(`Error processing zones for area ${a} Please add zones under area.`);
                                }
                            }
                        }
                        break;
                    }
                }
            }
            else if (S(data).startsWith('"A') || S(data).startsWith('"D') || S(data).startsWith('"L')) {

                // Extract the area number that is being updated
                var updated_area = Number(S(S(data).substring(2, 5)));
                var status = S(data).substring(1, 2);
                var user = S(data).substring(5, 7);
                var stateValue;

                let armedByUser = user;

                switch (String(status)) {
                    case "L":
                        stateValue = Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
                        platform.log.log(`Area ${updated_area} triggered`);
                        break;
                    case "D":
                        stateValue = Characteristic.SecuritySystemCurrentState.DISARMED;
                        platform.log.log(`Area ${updated_area} disarmed by User ${user}`);
                        areas_armed = areas_armed.filter(value => value !== zpad(updated_area, 3));
                        break;
                    case "A":
                        //user is for my setup
                        //my user 17 is full armed (remote)
                        //my user on app is 254
                        //all the rest is night armed

                        if (user == "17") {
                            stateValue = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
                            platform.log.log(`Area ${updated_area} armed (away) by User ${user}`);
                        }
                        else if (user == "25" || user == "254") {
                            // Read the target state
                            const targetState = areaAccessories[updated_area - 1].target_State;

                            // Map the targetState to the corresponding current state value
                            switch (targetState) {
                                case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
                                    break;
                                case Characteristic.SecuritySystemTargetState.STAY_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.STAY_ARM;
                                    break;
                                case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
                                    break;
                                case Characteristic.SecuritySystemTargetState.DISARM:
                                    stateValue = Characteristic.SecuritySystemCurrentState.DISARMED;
                                    break;
                                default:
                                    platform.log.error(`Unknown target state: ${targetState}`);
                                    return;
                            }

                            platform.log.log(`User ${user}: Target state is ${targetState}, updated stateValue is ${stateValue}`);

                        }
                        else {
                            stateValue = Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
                            platform.log.log(`Area ${updated_area} armed (night) by User ${user}`);
                        }

                        if (stateValue == Characteristic.SecuritySystemCurrentState.AWAY_ARM) {
                            // Find the index of the first null or undefined value
                            const index = areas_armed.findIndex(value => value === null || value === undefined);

                            if (index !== -1) {
                                // Replace the value at that index
                                areas_armed[index] = zpad(updated_area, 3);
                            } else {
                                // If no open slot, append to the end
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

        if (this.serial_device) {
            var SerialPort = serialport.SerialPort;

            serialPort = new SerialPort(this.serial_device, {
                baudrate: this.baud_rate,
                parser: serialport.parsers.readline("\n")
            });

            serialPort.on("open", function () {
                platform.log.log("Serial port opened");
                serialPort.on('data', function (data) {
                    platform.log.debug(`Serial data received: ${data}`);
                    responseEmitter.emit('data', data);
                    processData(data);
                });
            });
            this.texecomConnection = serialPort;
        } else if (this.ip_address) {
            try {
                connection = net.createConnection(platform.ip_port, platform.ip_address, function () {
                    platform.log.log('Connected via IP');
                });
            } catch (err) {
                platform.log.error(err);
            }
            connection.setNoDelay(true);

            connection.on('data', function (data) {
                platform.log.debug(`IP data received: ${data}`);
                responseEmitter.emit('data', data);
                processData(data);
            });
            connection.on('end', function () {
                platform.log.log('IP connection ended');
            });

            connection.on('close', function () {
                platform.log.log('IP connection closed');
                try {
                    connection = net.createConnection(platform.ip_port, platform.ip_address, function () {
                        platform.log.log('Re-connected after loss of connection');
                    });
                } catch (err) {
                    platform.log.error(err);
                }
            });
            this.texecomConnection = connection;
        } else {
            this.log.log("Must set either serial_device or ip_address in configuration.");
        }
    }
}

function TexecomAccessory(log, config) {
    this.log = log;

    this.zone_number = zpad(config["zone_number"] || config["area_number"], 3);
    this.name = config["name"];
    this.zone_type = config["zone_type"] || config["area_type"] || "motion";
    this.dwell_time = config["dwell"] || 0;

    if (config["area_type"] == "securitysystem") {
        this.target_State = Characteristic.SecuritySystemTargetState.DISARM;
    }
    try {
        if (Array.isArray(config["zones"])) {
            // If it's an array, apply zpad to each element
            this.zones = config["zones"].map(zone => zpad(zone, 3));
        } else {
            // Otherwise, treat it as a single value
            this.zones = zpad(config["zones"], 3);
        }
    } catch (e) {
        //log.error('Error processing zones: ', e);
    }

    if (config["sn"]) {
        this.sn = config["sn"];
    } else {
        var shasum = crypto.createHash('sha1');
        shasum.update(this.zone_number/* || this.area_number*/);

        this.sn = shasum.digest('base64');
        log.log(`Computed SN: ${this.sn}`);
    }
}

TexecomAccessory.prototype = {

    getServices: function () {

        const me = this;

        var service, changeAction;

        var informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
            .setCharacteristic(Characteristic.Model, `Texecom ${(this.accessoryType === "zone" ? "Zone" : "Area")}`)
            .setCharacteristic(Characteristic.SerialNumber, this.sn);


        switch (this.zone_type) {
            case "contact":
                service = new Service.ContactSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.ContactSensorState)
                        .setValue(newState ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED);
                };
                break;
            case "motion":
                service = new Service.MotionSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.MotionDetected)
                        .setValue(newState);
                };
                break;
            case "smoke":
                service = new Service.SmokeSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.SmokeDetected)
                        .setValue(newState ? Characteristic.ContactSensorState.SMOKE_DETECTED : Characteristic.ContactSensorState.SMOKE_NOT_DETECTED);
                };
                break;
            case "carbonmonoxide":
                service = new Service.CarbonMonoxideSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.CarbonMonoxideDetected)
                        .setValue(newState ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
                };
                break;

            case "securitysystem":
                service = new Service.SecuritySystem();

                changeAction = function (newState, user = "unknown") {
                    var targetState;
                    switch (newState) {
                        case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.NIGHT_ARM;
                            break;
                        case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.AWAY_ARM;
                            break;
                        case Characteristic.SecuritySystemCurrentState.STAY_ARM:
                            targetState = Characteristic.SecuritySystemTargetState.STAY_ARM;
                            break;
                        case Characteristic.SecuritySystemCurrentState.DISARMED:
                            targetState = Characteristic.SecuritySystemTargetState.DISARM;
                            break;
                        default:
                            targetState = null; // alarm triggered has no corresponding target state
                            break;
                    }
                    service.getCharacteristic(Characteristic.SecuritySystemCurrentState).setValue(newState);

                    if (targetState != null) {
                        service.getCharacteristic(Characteristic.SecuritySystemTargetState).setValue(targetState);
                        service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(targetState);
                    }
                    service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(newState);
                    me.log.debug(`Set target state ${targetState} and current state ${newState} in response to notification from alarm`);
                };

                // we don't know the alarm's state at startup, safer to assume disarmed:
                changeAction(Characteristic.SecuritySystemCurrentState.DISARMED);
                var area = this;

                service.getCharacteristic(Characteristic.SecuritySystemTargetState)
                    .on('set', function (value, callback) {
                        if (setByAlarm) {
                            platform.log.debug(`Not sending command to alarm for change to state ${value} because the state change appears to have come from the alarm itself.`);
                            setByAlarm = false;
                            return;
                        }
                        if (platform.udl != null) {
                            areaTargetSecurityStateSet(platform, area, service, value, callback);
                        } else {
                            platform.log.debug("No UDL configured. Add your UDL to enable arm/disarm from HomeKit.");
                            callback(new Error("No UDL configured"));
                        }
                    });
                break;


            default:
                service = new Service.MotionSensor();
                changeAction = function (newState) {
                    service.getCharacteristic(Characteristic.MotionDetected)
                        .setValue(newState);
                };
                break;
        }

        this.changeHandler = function (status, user = "unknown") {
            var newState = status;
            platform.log.debug(`Dwell = ${this.dwell_time}`);

            if (!newState && this.dwell_time > 0) {
                this.dwell_timer = setTimeout(function () { changeAction(newState); }.bind(this), this.dwell_time);
            } else {
                if (this.dwell_timer) {
                    clearTimeout(this.dwell_timer);
                }
                changeAction(newState);
            }

            if (user == "unknown") {
                platform.log.debug(`Changing state with changeHandler to ${newState}`);
            }
            else {
                platform.log.debug(`Changing state with changeHandler to ${newState} by User ${user}`);
            }

        }.bind(this);

        return [informationService, service];
    }
};

function areaTargetSecurityStateSet(platform, accessory, service, value, callback) {

    const hexMapping = {
        '1': 0x01,
        '2': 0x02,
        '3': 0x04,
        '4': 0x08,
        '5': 0x10,
        '6': 0x20,
        '7': 0x40,
        '8': 0x80
    };

    var area_number = String.fromCharCode(parseInt(hexMapping[parseInt(accessory.zone_number, 10)], 16));


    var command;
    switch (value) {
        case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
        case Characteristic.SecuritySystemTargetState.STAY_ARM:
            command = `Y${area_number}`;  // Home
            break;
        case Characteristic.SecuritySystemTargetState.AWAY_ARM:
            command = `A${area_number}`; // Away arm
            break;
        case Characteristic.SecuritySystemTargetState.DISARM:
            command = `D${area_number}`; // Disarm
            break;
        default:
            this.log.debug(`Unknown target state: ${value}`);
            callback(new Error("Unknown target state"));
            return;
    }

    platform.log.debug(`Sending arm/disarm command ${value} to area ${accessory.zone_number}`);




    writeCommandAndWaitForOK(platform.texecomConnection, `W${platform.udl}`)
        .then(() => writeCommandAndWaitForOK(platform.texecomConnection, command, 0))
        .then(() => {
            // OK response from alarm is only indication that the target state has been reached
            var currentState;
            switch (value) {
                case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
                    break;
                case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
                    break;
                case Characteristic.SecuritySystemTargetState.STAY_ARM:
                    currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
                    break;
                case Characteristic.SecuritySystemTargetState.DISARM:
                    currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
                    break;
                default:
                    platform.log.debug(`Unknown target alarm state ${value}`);
                    callback(new Error("Unknown target state"));
                    return;
            }
            platform.log.debug(`Setting current status of area ${accessory.zone_number} to ${currentState} because alarm responded OK`);
            service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
                .updateValue(currentState);
            accessory.target_State = currentState;
            callback();
        })
        .catch((err) => {
            platform.log.debug(`Callback with error ${err}`);
            callback(err); // Handle errors
        });
}

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
                platform.log.debug(`Error writing to connection: ${err}`);
                reject(err);
            } else {
                platform.log.debug(`Command sent: ${command}`);
            }
        });

        setTimeout(() => {
            responseEmitter.removeListener('data', handleData);
            if (retryCount > 0) {
                platform.log.debug(`Retrying command due to timeout, retries left: ${retryCount}`);
                writeCommandAndWaitForOK(connection, command, retryCount - 1).then(resolve).catch(reject);
            } else {
                reject(new Error("Timeout after retries"));
            }
        }, 2000);
    });
}

function is_armed(area_number) {
    let isAreaArmed = areas_armed.some(value => value === area_number);

    return isAreaArmed;
}
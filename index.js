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

        // 4.3.0 published every accessory outside the bridge, which meant
        // pairing each one by hand in the Home app. They are bridged again by
        // default. An install that adopted 4.3.0 and built scenes, buttons or
        // automations on those accessories can turn this on to keep them:
        // HomeKit cannot carry that work across from a standalone accessory
        // to a bridged one, whatever we do at this end.
        this.external_accessories = config["external_accessories"] === true;

        // Combined areas: one accessory that arms or disarms several areas
        // at once. The panel takes them all in a single command.
        this.area_groups = config["area_groups"] || [];

        // Which panel user numbers mean what when the panel reports an area as
        // armed. The panel does not say whether that was a full or a part arm,
        // so the user number is the only hint we get.
        this.remote_users = parseUserList(config["remote_users"]);
        this.app_users = parseUserList(config["app_users"]);
        this.default_arm_state = String(config["default_arm_state"] || "away").toLowerCase();

        // How often to check the panel clock against this machine's, in hours.
        // 0 leaves the panel clock alone.
        this.time_sync_interval = parseSyncInterval(config["time_sync_interval"]);

        // Accessories restored from the Homebridge cache, keyed by UUID.
        this.cachedAccessories = new Map();

        this.api.on('didFinishLaunching', () => {
            this._setupAccessories();
        });
    }

    // Called once for every accessory Homebridge has cached for this platform,
    // before didFinishLaunching. Hold on to them so they are reused rather than
    // recreated, which is what keeps them in place in the Home app.
    findAreaAccessory(area_number) {
        return (this._areaAccessories || []).find(a => Number(a.zone_number) === Number(area_number));
    }

    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
        this.cachedAccessories.set(accessory.UUID, accessory);
    }

    _setupAccessories() {
        const platform = this;
        const { hap, api } = this;

        const zoneAccessories = this.zones.map(z => new TexecomAccessory(this.log, z, hap, "zone"));
        const areaAccessories = this.areas.map(a => new TexecomAccessory(this.log, a, hap, "area"));
        const groupAccessories = this.area_groups.map(g => new TexecomAccessory(this.log, g, hap, "group"));
        const zoneCount = zoneAccessories.length;
        const areaCount = areaAccessories.length;

        this._areaAccessories = areaAccessories;

        // The last state we heard for each area, whether or not that area has
        // an accessory of its own. Combined areas are worked out from this.
        const areaStates = new Map();

        // A combined area counts as armed only when every one of its areas is
        // armed, so it never claims to be set while part of it is open. An
        // alarm in any one of them shows through regardless.
        function refreshGroups() {
            const Characteristic = hap.Characteristic;

            groupAccessories.forEach(group => {
                const states = group.area_numbers.map(n => areaStates.get(n));

                if (states.some(s => s === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED)) {
                    group.changeHandler(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
                    return;
                }

                const armed = states.filter(s => s !== undefined && s !== Characteristic.SecuritySystemCurrentState.DISARMED);
                if (states.length === 0 || armed.length !== states.length) {
                    group.changeHandler(Characteristic.SecuritySystemCurrentState.DISARMED);
                    return;
                }

                // Everything is armed. Use what was asked for from HomeKit if we
                // know it, then a state the areas agree on, otherwise call it away.
                var stateValue;
                if (group.pending_target_state != null) {
                    stateValue = targetToCurrentState(Characteristic, group.pending_target_state);
                } else if (armed.every(s => s === armed[0])) {
                    stateValue = armed[0];
                } else {
                    stateValue = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
                }
                group.changeHandler(stateValue);
            });
        }

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

        // Reproduces 4.3.0 exactly: the same UUID, from the same serial number,
        // so Homebridge gives the accessory back the pairing it already had and
        // the Home app carries on as though nothing happened. A combined area
        // is new in 4.4.0, so it has no 4.3.0 identity to preserve, but it is
        // published the same way so the whole install stays off the bridge.
        const publishExternal = (acc, typePrefix) => {
            const uuid = hap.uuid.generate(`${typePrefix}:${acc.legacy_sn}`);
            const hapAccessory = new api.platformAccessory(acc.name, uuid);

            acc.setupServices(hapAccessory, platform, acc.legacy_sn);

            platform.log.debug(`Publishing ${acc.name} as an external accessory`);
            api.publishExternalAccessories(PLUGIN_NAME, [hapAccessory]);
        };

        if (this.external_accessories) {
            platform.log.log("Publishing external accessories, as 4.3.0 did. Each one is paired separately in the Home app.");

            zoneAccessories.forEach(acc => publishExternal(acc, "zone"));
            areaAccessories.forEach(acc => publishExternal(acc, "area"));
            groupAccessories.forEach(acc => publishExternal(acc, "group"));

            // Nothing is on the bridge in this mode, so anything left in the
            // cache from a bridged run is no longer being served by us and
            // would sit in the Home app not responding.
            const bridged = [...platform.cachedAccessories.values()];
            if (bridged.length > 0) {
                platform.log.log(`Removing ${bridged.length} bridged accessories, this install publishes external accessories instead`);
                api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, bridged);
                platform.cachedAccessories.clear();
            }

        } else {
            zoneAccessories.forEach(attachAccessory);
            areaAccessories.forEach(attachAccessory);
            groupAccessories.forEach(attachAccessory);

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
                                            areaStates.set(Number(areaAccessories[a].zone_number), stateValue);
                                            refreshGroups();
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
                        groupAccessories.forEach(g => {
                            if (g.area_numbers.includes(updated_area)) {
                                g.pending_target_state = null;
                            }
                        });
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

                areaStates.set(updated_area, stateValue);
                refreshGroups();

            } else {
                platform.log.debug(`Unknown string from Texecom: ${S(data)}`);
            }
        }

        // ── IP connection with auto-reconnect ────────────────────────────────
        function setupConnection() {
            platform.log.log('Attempting connection to Texecom...');

            var connection = net.createConnection(platform.ip_port, platform.ip_address);
            connection.setNoDelay(true);

            connection.on('connect', () => {
                platform.log.log('Connected via IP');
                platform._panelConnected();
            });

            connection.on('data', function (data) {
                platform.log.debug(`IP data received: ${data}`);
                responseEmitter.emit('raw', data);
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

            sp.on("open", () => {
                platform.log.log("Serial port opened");
                platform._panelConnected();
            });
            sp.on("error", (err) => platform.log.error("Serial port error:", err.message));

            // The parser splits on 0x0A, which the panel clock reply can carry
            // inside it - the 10th of a month, or ten minutes past. Reading the
            // clock works off the bytes as they arrive instead.
            sp.on('data', (data) => responseEmitter.emit('raw', data));

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

        this._startClockSync();
    }

    // ── Panel clock ──────────────────────────────────────────────────────────
    _startClockSync() {
        if (this.time_sync_interval <= 0) {
            this.log.debug("Panel clock sync is off");
            return;
        }

        if (this.udl == null) {
            this.log.log("Panel clock sync needs a UDL. Add one to the config, or set the sync interval to 0 to turn it off.");
            this.time_sync_interval = 0;
            return;
        }

        this.log.log(`Checking the panel clock every ${describeInterval(this.time_sync_interval)}`);

        // The next check is timed from the end of the last one rather than by a
        // repeating interval, so a check that is slow to answer cannot have the
        // next one land on top of it.
        const period = this.time_sync_interval * 60 * 60 * 1000;
        const again = () => scheduleAfter(period, () => this._syncPanelClock().then(again));
        again();
    }

    // The panel is checked shortly after the connection comes up as well as on
    // the interval, so a panel that lost its clock in a power cut is put right
    // without waiting for the next check. A dropped IP connection reconnects, so
    // this can run again; the pending check is replaced rather than stacked up.
    _panelConnected() {
        if (this.time_sync_interval <= 0) {
            return;
        }

        if (this._clock_sync_pending) {
            clearTimeout(this._clock_sync_pending);
        }

        this._clock_sync_pending = setTimeout(() => this._syncPanelClock(), 5000);
        if (this._clock_sync_pending.unref) {
            this._clock_sync_pending.unref();
        }
    }

    _syncPanelClock() {
        const platform = this;

        if (this._clock_sync_running) {
            this.log.debug("Panel clock check still running, skipping this one");
            return Promise.resolve();
        }

        const connection = this.texecomConnection;
        if (!connection) {
            this.log.debug("Not connected to the panel, skipping the clock check");
            return Promise.resolve();
        }

        this._clock_sync_running = true;

        return writeCommandAndWaitForOK(connection, `W${this.udl}`)
            .then(() => readPanelTime(connection))
            .then(panel => {
                const now = new Date();
                const drift = clockDriftMinutes(panel, now);

                platform._clock_sync_failing = false;

                if (Math.abs(drift) <= CLOCK_TOLERANCE_MINUTES) {
                    platform.log.debug(`Panel clock reads ${formatPanelTime(panel)}, in step`);
                    return;
                }

                if (shouldDeferClockSet(now)) {
                    platform.log.debug(`Panel clock is ${describeDrift(drift)}, waiting a minute to set it: 47 minutes past would put a framing character inside the command`);
                    scheduleAfter(61000, () => platform._syncPanelClock());
                    return;
                }

                platform.log.log(`Panel clock reads ${formatPanelTime(panel)}, ${describeDrift(drift)}. Setting it to ${formatPanelTime(localPanelTime(now))}`);

                // Logging in again rather than leaning on the session opened for
                // the read, which is what the panel asks for and costs one
                // command at most once an interval.
                return writeCommandAndWaitForOK(connection, `W${platform.udl}`)
                    .then(() => writeCommandAndWaitForOK(connection, panelTimeCommand(now)))
                    .then(() => platform.log.log("Panel clock set"));
            })
            .catch(err => {
                // Said once when it starts going wrong rather than on every
                // pass, so a panel that cannot be reached does not fill the log
                // with the same line for as long as it is left running.
                if (platform._clock_sync_failing) {
                    platform.log.debug(`Panel clock check failed: ${err.message}`);
                } else {
                    platform._clock_sync_failing = true;
                    platform.log.log(`Panel clock check failed: ${err.message}. Further failures are only logged with debug on.`);
                }
            })
            .then(() => {
                platform._clock_sync_running = false;
            });
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
const MODELS = { zone: "Zone", area: "Area", group: "Combined Area" };

function TexecomAccessory(log, config, hap, kind) {
    this.log = log;
    this.hap = hap;
    this.kind = kind || "zone";

    this.name = config["name"];
    this.dwell_time = config["dwell"] || 0;
    this.dwell_timer = null;

    if (this.kind === "group") {
        // A combined area is addressed as several area numbers at once.
        this.area_numbers = (config["areas"] || []).map(Number).filter(n => !Number.isNaN(n));
        this.zone_number = this.area_numbers.join("+");
        this.zone_type = "securitysystem";
    } else {
        this.zone_number = zpad(config["zone_number"] || config["area_number"], 3);
        this.zone_type = config["zone_type"] || config["area_type"] || "motion";
        this.area_numbers = this.zone_type === "securitysystem" ? [Number(this.zone_number)] : [];
    }

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

    // What 4.3.0 computed, kept so that an install carried over from 4.3.0
    // can be handed back the very same accessory identities. 4.3.0 hashed the
    // number on its own, without separating areas from zones.
    if (config["sn"]) {
        this.legacy_sn = config["sn"];
    } else {
        const legacy = crypto.createHash('sha1');
        legacy.update(this.zone_number);
        this.legacy_sn = legacy.digest('base64');
    }

    if (config["sn"]) {
        this.sn = config["sn"];
    } else {
        // An area and a zone can carry the same number, which used to give
        // them the same serial number. Only the area side is namespaced so
        // that zone serial numbers stay as they have always been.
        const shasum = crypto.createHash('sha1');
        shasum.update(this.kind === "group" ? `group:${this.zone_number}`
            : this.zone_type === "securitysystem" ? `area:${this.zone_number}` : this.zone_number);
        this.sn = shasum.digest('base64');
        log.log(`Computed SN: ${this.sn}`);
    }
}

TexecomAccessory.prototype = {

    // Builds the services on a bridged platform accessory. A cached accessory
    // keeps the services it already has, they are only added when missing, so
    // that restarting Homebridge does not disturb the accessory in HomeKit.
    setupServices: function (hapAccessory, platform, serialNumber) {
        const { Service, Characteristic } = this.hap;
        const me = this;

        this._platform = platform;

        hapAccessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
            .setCharacteristic(Characteristic.Model, `Texecom ${MODELS[this.kind] || "Zone"}`)
            .setCharacteristic(Characteristic.SerialNumber, serialNumber || this.sn);

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

    const mask = areaMask(accessory.area_numbers);
    if (mask === null) {
        platform.log.error(`Area ${accessory.zone_number} is out of range, the panel only addresses areas 1 to 8`);
        callback(new Error("Area out of range"));
        return;
    }

    var area_number = String.fromCharCode(mask);

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

            // A combined area waits for each of its areas to report in, so HomeKit
            // shows it arming until they all are. Updating it here instead would
            // make it flick between armed and disarmed as they come in one by one.
            if (accessory.kind !== "group") {
                service.getCharacteristic(Characteristic.SecuritySystemCurrentState).updateValue(currentState);
            }

            // Remember what was asked for. The panel reports the area as armed
            // once the exit delay has run, without saying how it was armed, and
            // this is what stops that report being taken for a part arm.
            const pending = (value === Characteristic.SecuritySystemTargetState.DISARM) ? null : value;
            accessory.pending_target_state = pending;

            // A combined area asked on behalf of several areas, so their own
            // accessories need to know too, otherwise they fall back to the
            // configured default when the panel reports them armed.
            accessory.area_numbers.forEach(n => {
                const member = platform.findAreaAccessory(n);
                if (member && member !== accessory) {
                    member.pending_target_state = pending;
                }
            });
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

        connection.write(frameCommand(command), function (err) {
            if (err) {
                settle(reject, err);
            }
        });
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// The panel addresses areas as a bitmask in a single byte, area 1 being the
// low bit, so several areas can be armed or disarmed with one command.
// Returns null if any area is outside the 1 to 8 the byte can carry.
function areaMask(area_numbers) {
    var mask = 0;
    for (const value of area_numbers) {
        const area = Number(value);
        if (!Number.isInteger(area) || area < 1 || area > 8) {
            return null;
        }
        mask |= 1 << (area - 1);
    }
    return mask === 0 ? null : mask;
}

function is_armed(area_number) {
    return areas_armed.some(v => v === area_number);
}

function toBuffer(data) {
    return Buffer.isBuffer(data) ? data : Buffer.from(String(data), "latin1");
}

// Wraps a command in the \ and / the panel expects. Commands are written as
// latin1 so that a byte the command carries goes out as that one byte: the area
// bitmask and the date and time are numbers rather than text, and the default
// encoding would send anything from 128 up as two bytes.
function frameCommand(command) {
    return Buffer.concat([Buffer.from("\\", "latin1"), toBuffer(command), Buffer.from("/", "latin1")]);
}

// ─── Panel clock ──────────────────────────────────────────────────────────────
// The panel keeps its own clock and drifts, and nothing corrects it apart from
// an engineer at the keypad. When time_sync_interval is set the plugin reads the
// panel clock on that interval and writes the current time back when the two
// have come apart. Both commands need a UDL login first, exactly as arming does.
//
//   read : \T?/            → B1..B5 0x0D 0x0A, or ERROR 0x0D 0x0A
//   set  : \T B1..B5/      → OK 0x0D 0x0A, or ERROR 0x0D 0x0A
//
// B1..B5 are day, month, two digit year, hours and minutes, sent as raw bytes
// rather than as text.

// The panel clock only counts whole minutes, so a read that lands either side of
// a minute boundary can look a minute out when it is in step. Anything beyond
// that is real drift.
const CLOCK_TOLERANCE_MINUTES = 1;

// The longest an interval can be, in hours: 31 days.
const MAX_SYNC_INTERVAL_HOURS = 744;

// A timer cannot be given a delay beyond this, roughly 24.8 days. Anything
// larger wraps round and fires immediately, so a longer wait is walked down in
// steps rather than asked for in one go.
const MAX_TIMER_MS = 2147483647;

// Hours, 0 (or anything unusable) turns the sync off, capped at 31 days.
function parseSyncInterval(value) {
    if (value === null || value === undefined || value === "") {
        return 0;
    }
    const hours = Math.round(Number(value));
    if (!Number.isFinite(hours) || hours <= 0) {
        return 0;
    }
    return Math.min(hours, MAX_SYNC_INTERVAL_HOURS);
}

function describeInterval(hours) {
    if (hours >= 24 && hours % 24 === 0) {
        const days = hours / 24;
        return `${days} day${days === 1 ? "" : "s"}`;
    }
    return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// setTimeout with a delay a timer can actually hold, however long the wait.
function scheduleAfter(delayMs, run) {
    const step = Math.min(delayMs, MAX_TIMER_MS);
    const timer = setTimeout(() => {
        const remaining = delayMs - step;
        if (remaining > 0) {
            scheduleAfter(remaining, run);
        } else {
            run();
        }
    }, step);

    if (timer.unref) {
        timer.unref();
    }
    return timer;
}

// Reads the panel clock. The reply is seven raw bytes, and the panel can report
// a zone or area at any moment, so the answer is picked out of whatever arrived
// rather than assumed to be the next thing on the wire.
function readPanelTime(connection, retryCount = 1) {
    return new Promise((resolve, reject) => {
        var buffer = Buffer.alloc(0);

        function settle(fn, arg) {
            clearTimeout(timer);
            responseEmitter.removeListener('raw', handleRaw);
            fn(arg);
        }

        function handleRaw(data) {
            buffer = Buffer.concat([buffer, toBuffer(data)]);

            // Only the tail can hold the reply, the rest is panel chatter that
            // arrived while we were waiting.
            if (buffer.length > 64) {
                buffer = buffer.subarray(buffer.length - 64);
            }

            if (buffer.includes("ERROR")) {
                settle(reject, new Error("the panel refused the request, check the UDL"));
                return;
            }

            const reply = findPanelTimeReply(buffer);
            if (reply) {
                settle(resolve, reply);
            }
        }

        responseEmitter.on('raw', handleRaw);

        const timer = setTimeout(() => {
            responseEmitter.removeListener('raw', handleRaw);
            if (retryCount > 0) {
                readPanelTime(connection, retryCount - 1).then(resolve).catch(reject);
            } else {
                reject(new Error("timed out reading the panel clock"));
            }
        }, 2000);

        connection.write(frameCommand("T?"), function (err) {
            if (err) {
                settle(reject, err);
            }
        });
    });
}

// Finds the seven byte reply in the bytes read back. The terminator on its own
// is not enough to go on: a day of the 13th and a month of October are 0x0D and
// 0x0A, so a reply can carry what looks like a terminator inside it. Every field
// is range checked as well, which is also what keeps a zone or area message from
// being mistaken for a time - those are text, and no printable character is a
// month between 1 and 12.
function findPanelTimeReply(buffer) {
    for (var i = 0; i + 7 <= buffer.length; i++) {
        if (buffer[i + 5] !== 0x0D || buffer[i + 6] !== 0x0A) {
            continue;
        }

        const reply = {
            day: buffer[i],
            month: buffer[i + 1],
            year: buffer[i + 2],
            hours: buffer[i + 3],
            minutes: buffer[i + 4]
        };

        if (isPlausiblePanelTime(reply)) {
            return reply;
        }
    }
    return null;
}

function isPlausiblePanelTime(time) {
    return time.day >= 1 && time.day <= 31
        && time.month >= 1 && time.month <= 12
        && time.year <= 99
        && time.hours <= 23
        && time.minutes <= 59;
}

// The panel carries a two digit year, so it is read against the century we are
// in. A panel that has lost its clock altogether reads as wildly out and is set.
function panelTimeToDate(time, now) {
    const century = Math.floor(now.getFullYear() / 100) * 100;
    return new Date(century + time.year, time.month - 1, time.day, time.hours, time.minutes, 0, 0);
}

function localPanelTime(now) {
    return {
        day: now.getDate(),
        month: now.getMonth() + 1,
        year: now.getFullYear() % 100,
        hours: now.getHours(),
        minutes: now.getMinutes()
    };
}

// How far the panel is ahead of us, in whole minutes. Negative means behind.
function clockDriftMinutes(time, now) {
    const panel = panelTimeToDate(time, now);
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
    return Math.round((panel.getTime() - local.getTime()) / 60000);
}

function formatPanelTime(time) {
    return `${zpad(time.day, 2)}/${zpad(time.month, 2)}/${zpad(time.year, 2)} ${zpad(time.hours, 2)}:${zpad(time.minutes, 2)}`;
}

function describeDrift(minutes) {
    const ahead = minutes > 0;
    const size = Math.abs(minutes);
    const amount = size < 120 ? `${size} minute${size === 1 ? "" : "s"}`
        : size < 2880 ? `${Math.round(size / 60)} hours`
            : `${Math.round(size / 1440)} days`;
    return `${amount} ${ahead ? "ahead" : "behind"}`;
}

// Day, month, two digit year, hours and minutes as raw bytes, all of which are
// below 0x80 so they survive being written out.
function panelTimeCommand(now) {
    const time = localPanelTime(now);
    return Buffer.from([0x54, time.day, time.month, time.year, time.hours, time.minutes]);
}

// 0x2F is the / that closes a command and 0x5C the \ that opens one, so a time
// carrying either puts a framing character inside the command. A panel that
// counts the five bytes it is expecting reads that correctly, one that scans for
// the / instead would cut the command short, and there is no way to tell which
// from here. Of the five, only the minutes can land on one - 47 minutes past -
// and a minute's wait clears it. The year can too, in 2047 and 2092, and waiting
// cannot help with that, so the command goes as it is.
function shouldDeferClockSet(now) {
    return localPanelTime(now).minutes === 0x2F;
}

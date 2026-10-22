// A thin layer over the Homebridge logger, which already stamps the time and
// the platform name on every line. Errors and warnings are always shown, debug
// lines only when the plugin's own debug option is on, in which case they are
// written as ordinary lines so they show without running Homebridge in debug.
class LogUtil {
    constructor(isDebug = false, prefix = '', log) {
        this.isDebug = isDebug;
        this.prefix = prefix;
        this.hbLog = log;
    }

    log(...args) {
        this.hbLog.info(...args);
    }

    warn(...args) {
        this.hbLog.warn(...args);
    }

    error(...args) {
        this.hbLog.error(...args);
    }

    debug(...args) {
        if (this.isDebug) {
            this.hbLog.info(...args);
        } else {
            this.hbLog.debug(...args);
        }
    }
}

module.exports = LogUtil;

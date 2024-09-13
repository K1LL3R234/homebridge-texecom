class LogUtil {
    constructor(isDebug = false,prefix='',log) {
        this.log=log;
        this.isDebug = isDebug;
        this.prefix = prefix;
    }

    getCurrentTimestamp() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0'); // Month is 0-based
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        
        return `[${year}/${month}/${day}, ${hours}:${minutes}:${seconds}]`;
    }

    log(...args) {
        console.log(this.getCurrentTimestamp(), `[${this.prefix}]`, ...args);
    }

    debug(...args) {
        if (this.isDebug) {
            console.log(this.getCurrentTimestamp(), `[${this.prefix}[DEBUG]]`, ...args);
        }
    }

    error(...args) {
        if (this.isDebug) {
            console.log(this.getCurrentTimestamp(), `[${this.prefix}[ERROR]]`, ...args);
        }
    }
}

module.exports = LogUtil;

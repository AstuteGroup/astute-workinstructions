/**
 * Shared Logger
 *
 * Usage:
 *   const logger = require('../shared/logger');                    // default (no prefix)
 *   const logger = require('../shared/logger').createLogger('VQ'); // prefixed
 */

function timestamp() {
  return new Date().toISOString();
}

function createLogger(prefix = '') {
  const pfx = prefix ? `[${prefix}] ` : '';
  return {
    info: (...args) => console.log(`[${timestamp()}] ${pfx}INFO:`, ...args),
    warn: (...args) => console.warn(`[${timestamp()}] ${pfx}WARN:`, ...args),
    error: (...args) => console.error(`[${timestamp()}] ${pfx}ERROR:`, ...args),
    debug: (...args) => {
      if (process.env.VERBOSE === '1' || process.env.DEBUG === '1') {
        console.log(`[${timestamp()}] ${pfx}DEBUG:`, ...args);
      }
    }
  };
}

// Default instance (backward compatible)
const defaultLogger = createLogger();
defaultLogger.createLogger = createLogger;

module.exports = defaultLogger;

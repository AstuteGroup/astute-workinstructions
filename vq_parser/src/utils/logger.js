function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info: (...args) => console.log(`[${timestamp()}] INFO:`, ...args),
  warn: (...args) => console.warn(`[${timestamp()}] WARN:`, ...args),
  error: (...args) => console.error(`[${timestamp()}] ERROR:`, ...args),
  debug: (...args) => {
    if (process.env.VERBOSE === '1' || process.env.DEBUG === '1') {
      console.log(`[${timestamp()}] DEBUG:`, ...args);
    }
  }
};

module.exports = logger;

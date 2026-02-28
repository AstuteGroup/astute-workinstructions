const { execFile } = require('child_process');
const path = require('path');
const logger = require('./logger');

const HIMALAYA_BIN = process.env.HIMALAYA_BIN || path.join(process.env.HOME, 'bin', 'himalaya');
const TIMEOUT = 30000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

function runHimalaya(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['--output', 'json', ...args];
    logger.debug('himalaya', fullArgs.join(' '));

    execFile(HIMALAYA_BIN, fullArgs, {
      timeout: TIMEOUT,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env }
    }, (error, stdout, stderr) => {
      if (error) {
        logger.error('himalaya error:', error.message);
        if (stderr) logger.debug('himalaya stderr:', stderr);
        return reject(new Error(`himalaya failed: ${error.message}`));
      }
      try {
        // himalaya json output may have ANSI codes in stderr, stdout should be clean JSON
        const cleaned = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!cleaned) return resolve(null);
        const parsed = JSON.parse(cleaned);
        resolve(parsed);
      } catch (e) {
        // Some commands return plain text
        resolve(stdout.trim());
      }
    });
  });
}

module.exports = { runHimalaya };

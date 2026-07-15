#!/usr/bin/env node

/**
 * Quick launcher for all daily briefs
 *
 * Usage from anywhere: node ~/workspace/run-briefs.js
 */

const { execSync } = require('child_process');
const path = require('path');

const scriptPath = path.join(__dirname, 'scripts/run-all-daily-briefs.js');

try {
  execSync(`node "${scriptPath}"`, { stdio: 'inherit' });
} catch (error) {
  process.exit(1);
}

#!/usr/bin/env node
/**
 * nc-control.js — Toggle NetComponents listing controls
 *
 * Usage:
 *   node nc-control.js                  # Show current status
 *   node nc-control.js exclusions off   # Clear exclusions (full inventory to NC)
 *   node nc-control.js exclusions on    # Restore exclusions from backup
 *   node nc-control.js pause            # Pause NC listing
 *   node nc-control.js resume           # Resume NC listing
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.join(process.env.HOME, 'workspace');
const EXCLUSIONS_FILE = path.join(WORKSPACE, '.sourcing-exclusions.json');
const EXCLUSIONS_BACKUP = path.join(WORKSPACE, '.sourcing-exclusions.backup.json');
const NC_PAUSE_FILE = path.join(WORKSPACE, '.nc-listing-paused');
const AGENT_PAUSE_FILE = path.join(WORKSPACE, '.cron-agents-paused');

function loadExclusions() {
  try {
    return JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf-8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

function loadBackup() {
  try {
    return JSON.parse(fs.readFileSync(EXCLUSIONS_BACKUP, 'utf-8'));
  } catch {
    return null;
  }
}

function saveExclusions(data) {
  data.updated = new Date().toISOString();
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function saveBackup(data) {
  fs.writeFileSync(EXCLUSIONS_BACKUP, JSON.stringify(data, null, 2) + '\n');
}

function status() {
  const exclusions = loadExclusions();
  const backup = loadBackup();
  const ncPaused = fs.existsSync(NC_PAUSE_FILE);
  const agentPaused = fs.existsSync(AGENT_PAUSE_FILE);

  console.log('\n=== NetComponents Control Status ===\n');

  // Exclusions
  const activeCount = exclusions.entries?.length || 0;
  const backupCount = backup?.entries?.length || 0;

  if (activeCount > 0) {
    const batches = [...new Set(exclusions.entries.map(e => e.batch))];
    console.log(`Exclusions:    ON (${activeCount} MPNs hidden from NC)`);
    console.log(`               Batches: ${batches.join(', ')}`);
  } else {
    console.log(`Exclusions:    OFF (full inventory goes to NC)`);
    if (backupCount > 0) {
      console.log(`               Backup available: ${backupCount} MPNs`);
    }
  }

  // NC Listing
  console.log(`NC Listing:    ${ncPaused ? 'PAUSED' : 'ACTIVE'}`);

  // Active Sourcing
  console.log(`Active Srcing: ${agentPaused ? 'PAUSED' : 'ACTIVE'}`);

  console.log('\nCommands:');
  console.log('  node nc-control.js exclusions off   # Full inventory to NC');
  console.log('  node nc-control.js exclusions on    # Restore exclusions');
  console.log('  node nc-control.js pause            # Pause NC listing');
  console.log('  node nc-control.js resume           # Resume NC listing\n');
}

function exclusionsOff() {
  const current = loadExclusions();
  if (current.entries?.length > 0) {
    saveBackup(current);
    console.log(`Backed up ${current.entries.length} exclusions`);
  }
  saveExclusions({ version: 1, entries: [] });
  console.log('Exclusions cleared — full inventory will go to NC');
}

function exclusionsOn() {
  const backup = loadBackup();
  if (!backup || !backup.entries?.length) {
    console.log('No backup found — nothing to restore');
    return;
  }
  saveExclusions(backup);
  console.log(`Restored ${backup.entries.length} exclusions from backup`);
}

function pause() {
  fs.writeFileSync(NC_PAUSE_FILE, `Paused ${new Date().toISOString()}\n`);
  console.log('NC listing paused');
}

function resume() {
  if (fs.existsSync(NC_PAUSE_FILE)) {
    fs.unlinkSync(NC_PAUSE_FILE);
    console.log('NC listing resumed');
  } else {
    console.log('NC listing was not paused');
  }
}

// Main
const [,, cmd, arg] = process.argv;

if (!cmd) {
  status();
} else if (cmd === 'exclusions' && arg === 'off') {
  exclusionsOff();
} else if (cmd === 'exclusions' && arg === 'on') {
  exclusionsOn();
} else if (cmd === 'pause') {
  pause();
} else if (cmd === 'resume') {
  resume();
} else if (cmd === 'status') {
  status();
} else {
  console.log('Unknown command. Run without arguments for help.');
}

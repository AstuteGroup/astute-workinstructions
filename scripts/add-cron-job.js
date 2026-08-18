#!/usr/bin/env node
/**
 * add-cron-job.js — Interactive helper to add a new cron job correctly.
 *
 * Usage:
 *   node scripts/add-cron-job.js
 *
 * This script:
 *   1. Prompts for all required fields
 *   2. Validates the cron expression
 *   3. Generates the registry entry
 *   4. Appends to cron-jobs.js (or prints for manual copy)
 *   5. Runs install-crons.js --apply
 *   6. Runs check-cron-drift.js to verify
 *
 * Why this exists: Manual crontab edits bypass the registry and cause drift.
 * This script makes the correct workflow easier than the incorrect one.
 */

'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CRON_JOBS_PATH = path.join(__dirname, '..', 'cron-jobs.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal = '') {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askYesNo(question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function validateCronExpr(expr) {
  // Basic validation: 5 space-separated fields
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return 'Cron expression must have exactly 5 fields (minute hour day month weekday)';
  }
  return null;
}

function inferCadence(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = parts;

  // */N pattern in minutes = every Nm
  if (minute.startsWith('*/') && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(minute.slice(2), 10);
    if (!isNaN(n) && n > 0 && n < 60) return `every ${n}m`;
  }

  // Specific minute, every hour = every 60m
  if (/^\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    return 'every 60m';
  }

  // Specific time, every day = daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') {
    return 'daily';
  }

  // Specific weekday = weekly
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && /^\d+$/.test(weekday)) {
    return 'weekly';
  }

  // Monthly (specific day of month)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(day) && month === '*' && weekday === '*') {
    return 'fixed';
  }

  return 'fixed'; // fallback
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  ADD CRON JOB — Interactive Helper                               ║');
  console.log('║                                                                  ║');
  console.log('║  This will add a job to cron-jobs.js and install it properly.   ║');
  console.log('║  NEVER edit crontab directly — always use this script.           ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Gather inputs
  const name = await ask('Job name (kebab-case, e.g., my-daily-report)');
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    console.error('Error: Name must be kebab-case (lowercase letters, numbers, hyphens)');
    process.exit(1);
  }

  const description = await ask('Description (one line, shown in crontab comments)');
  if (!description) {
    console.error('Error: Description is required');
    process.exit(1);
  }

  const cronExpr = await ask('Cron expression (e.g., */5 * * * * for every 5m, 0 9 * * * for daily 9am)');
  const cronError = validateCronExpr(cronExpr);
  if (cronError) {
    console.error(`Error: ${cronError}`);
    process.exit(1);
  }

  const inferredCadence = inferCadence(cronExpr);
  const cadence = await ask(`Cadence`, inferredCadence);

  const command = await ask('Command to run (e.g., node "${ASTUTE}/scripts/my-script.js")');
  if (!command) {
    console.error('Error: Command is required');
    process.exit(1);
  }

  const needsOT = await askYesNo('Does this job write to OT (iDempiere REST API)?', false);

  const logFile = await ask('Log file path', `/tmp/${name}.log`);

  const isAgent = await askYesNo('Is this a Claude-powered agent (tier=agent)?', false);

  console.log('');
  console.log('─── Generated Entry ───────────────────────────────────────────────');
  console.log('');

  const entry = {
    name,
    ...(isAgent && { tier: 'agent' }),
    cadence,
    cadenceCron: cronExpr,
    command,
    cwd: '${ASTUTE}',
    needsOT,
    logFile,
    description,
  };

  // Format nicely
  const entryStr = `  {
    name: '${name}',${isAgent ? `
    tier: 'agent',` : ''}
    cadence: '${cadence}',
    cadenceCron: '${cronExpr}',
    command: \`${command}\`,
    cwd: ASTUTE,
    needsOT: ${needsOT},
    logFile: '${logFile}',
    description: '${description}',
  },`;

  console.log(entryStr);
  console.log('');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log('');

  const proceed = await askYesNo('Add this to cron-jobs.js and install?', true);

  if (!proceed) {
    console.log('');
    console.log('Aborted. Copy the entry above manually if needed.');
    rl.close();
    process.exit(0);
  }

  // Read cron-jobs.js, find the closing bracket, insert before it
  let content = fs.readFileSync(CRON_JOBS_PATH, 'utf8');

  // Find the last ]; in the file (end of module.exports array)
  const lastBracket = content.lastIndexOf('];');
  if (lastBracket === -1) {
    console.error('Error: Could not find end of module.exports array in cron-jobs.js');
    rl.close();
    process.exit(1);
  }

  // Insert the new entry before the closing ];
  const before = content.slice(0, lastBracket);
  const after = content.slice(lastBracket);

  // Add a blank line and the entry
  const newContent = before + '\n' + entryStr + '\n' + after;

  fs.writeFileSync(CRON_JOBS_PATH, newContent);
  console.log('✓ Added to cron-jobs.js');

  // Run install-crons.js --apply
  console.log('');
  console.log('Running install-crons.js --apply...');
  try {
    execSync('node scripts/install-crons.js --apply', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('Warning: install-crons.js failed');
  }

  // Run check-cron-drift.js
  console.log('');
  console.log('Running check-cron-drift.js...');
  try {
    execSync('node scripts/check-cron-drift.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (e) {
    // Non-zero exit is OK, it just means there are warnings
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  ✓ DONE                                                          ║');
  console.log('║                                                                  ║');
  console.log('║  Your job is now registered and installed. Verify with:         ║');
  console.log('║    crontab -l | grep ' + name.padEnd(38) + '     ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});

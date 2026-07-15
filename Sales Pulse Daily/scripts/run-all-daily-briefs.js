#!/usr/bin/env node

/**
 * Run All Daily Briefs
 *
 * Convenience wrapper to run all three daily briefs in sequence:
 * 1. VP Daily Brief → Josh, Melissa, Aran
 * 2. USA Daily Brief → Jeff, Melissa
 * 3. Mexico Daily Brief → Joel, Melissa
 *
 * Usage: node run-all-daily-briefs.js
 */

const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS = [
  { name: 'VP Daily Brief', script: 'email-vp-daily-brief.js' },
  { name: 'USA Daily Brief', script: 'email-usa-daily-brief.js' },
  { name: 'Mexico Daily Brief', script: 'email-mexico-daily-brief.js' }
];

async function main() {
  console.log('Starting all daily briefs...\n');

  const results = [];

  for (const { name, script } of SCRIPTS) {
    console.log(`▶ Running ${name}...`);
    const scriptPath = path.join(__dirname, script);

    try {
      execSync(`node "${scriptPath}"`, {
        stdio: 'inherit',
        cwd: __dirname
      });
      console.log(`✓ ${name} completed successfully\n`);
      results.push({ name, success: true });
    } catch (error) {
      console.error(`✗ ${name} failed:`, error.message, '\n');
      results.push({ name, success: false, error: error.message });
    }
  }

  // Summary
  console.log('═'.repeat(60));
  console.log('SUMMARY:');
  console.log('═'.repeat(60));

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  results.forEach(({ name, success, error }) => {
    if (success) {
      console.log(`✓ ${name}`);
    } else {
      console.log(`✗ ${name} - ${error}`);
    }
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`Total: ${succeeded} succeeded, ${failed} failed`);
  console.log('═'.repeat(60));

  // Exit with error code if any failed
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

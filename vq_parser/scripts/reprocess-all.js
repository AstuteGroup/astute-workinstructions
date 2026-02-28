#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const idsFile = process.argv[2] || '/tmp/reprocess-ids.txt';
const ids = fs.readFileSync(idsFile, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && /^\d+$/.test(l));

console.log(`Reprocessing ${ids.length} emails...`);

let success = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  try {
    const result = execSync(`node ${path.join(__dirname, '..', 'src', 'index.js')} reprocess ${id}`, {
      encoding: 'utf8',
      timeout: 60000
    });
    if (result.includes('CSV written') || result.includes('Output:')) {
      success++;
    } else {
      failed++;
    }
  } catch (err) {
    failed++;
  }

  if ((i + 1) % 25 === 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTime = elapsed / (i + 1);
    console.log(`Progress: ${i + 1}/${ids.length} (${success} success, ${failed} failed) - Avg: ${avgTime.toFixed(2)}s/email`);
  }
}

const totalTime = (Date.now() - startTime) / 1000;
console.log(`\nCompleted: ${success} success, ${failed} failed`);
console.log(`Total time: ${totalTime.toFixed(1)}s (${(totalTime / ids.length).toFixed(2)}s/email avg)`);

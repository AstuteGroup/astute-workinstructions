#!/usr/bin/env node
/**
 * Outbox manifest — lists every file currently staged in ~/workspace/outbox/<source>/
 * for desktop pickup. Output is JSON on stdout. Called via SSH from the desktop's
 * pull-from-astute.ps1 daily sync.
 *
 * Shape:
 *   {
 *     "captured_at": "2026-05-18T14:30:00.000Z",
 *     "server": "analytics_user@44.222.126.129",
 *     "outbox_root": "/home/analytics_user/workspace/outbox",
 *     "sources": {
 *       "heilind": {
 *         "files": [
 *           { "name": "...csv",       "size": 7081,  "modified": "2026-05-18T14:17:38Z" },
 *           { "name": "...meta.json", "size": 58725, "modified": "2026-05-18T14:17:38Z" }
 *         ]
 *       }
 *     }
 *   }
 *
 * Files within each source are sorted newest-first so the desktop can pick the
 * latest run at the top of the list without re-sorting.
 *
 * Errors → exit code 1 + JSON error envelope on stdout (so desktop side can
 * still parse and report cleanly).
 */

const fs = require('fs');
const path = require('path');

const OUTBOX = '/home/analytics_user/workspace/outbox';

function entriesFor(sourceDir) {
  const files = [];
  for (const name of fs.readdirSync(sourceDir)) {
    const full = path.join(sourceDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    files.push({
      name,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
  // Newest first.
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return files;
}

function main() {
  const manifest = {
    captured_at: new Date().toISOString(),
    server: 'analytics_user@44.222.126.129',
    outbox_root: OUTBOX,
    sources: {},
  };

  if (!fs.existsSync(OUTBOX)) {
    process.stdout.write(JSON.stringify(manifest, null, 2));
    return;
  }

  for (const name of fs.readdirSync(OUTBOX)) {
    const sub = path.join(OUTBOX, name);
    let stat;
    try { stat = fs.statSync(sub); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    manifest.sources[name] = { files: entriesFor(sub) };
  }

  process.stdout.write(JSON.stringify(manifest, null, 2));
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({
    error: e.message,
    captured_at: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
}

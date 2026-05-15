#!/usr/bin/env node
/**
 * Recycle messages from a workflow's needs-review folder back to its source
 * folder so the next cron tick re-processes them with the current prompt/code.
 *
 * Standard process: ANY time the workflow's logic is refined (prompt updated,
 * helper added, prefix map extended, writer contract loosened, etc.), run this
 * to give bounced messages another shot. Per session memory's
 * [[feedback_exhaust_signals_pattern_generalizes]] — "try harder before
 * bouncing" generalizes; "retry after we've learned more" is its mirror.
 *
 * USAGE:
 *   node shared/recycle-needs-review.js --workflow <name> [--dry-run] [--uids <csv>]
 *
 *   --workflow <name>   one of the workflow modules under shared/workflow-actions/
 *                       (e.g., stockrfq, stockrfq-cq, rfq-loading)
 *   --dry-run           list what would move; do not move
 *   --uids 123,456      restrict to a specific set of UIDs (default: all)
 *
 * Folder mapping is read from the workflow module:
 *   - source folder  = workflow.sourceFolder (default: 'INBOX')
 *   - needs-review folder = workflow.actions.needs_review.folder
 *   - inbox account  = workflow.inbox
 *
 * The script marks moved messages \\Unseen so the next `list` picks them up.
 */

'use strict';

require('dotenv').config({ path: require('path').join(require('os').homedir(), 'workspace/.env') });
const { ImapFlow } = require('imapflow');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const WORKFLOW = flag('--workflow');
const DRY = args.includes('--dry-run');
const UID_FILTER = flag('--uids');
const uidFilter = UID_FILTER ? new Set(UID_FILTER.split(',').map(s => s.trim()).filter(Boolean)) : null;

if (!WORKFLOW) {
  console.error('usage: node shared/recycle-needs-review.js --workflow <name> [--dry-run] [--uids <csv>]');
  process.exit(2);
}

const workflowPath = path.join(__dirname, 'workflow-actions', WORKFLOW + '.js');
let workflow;
try { workflow = require(workflowPath); }
catch (e) { console.error(`FATAL: could not load workflow module ${workflowPath}: ${e.message}`); process.exit(2); }

const SOURCE = workflow.sourceFolder || 'INBOX';
const NEEDS_REVIEW = workflow.actions && workflow.actions.needs_review && workflow.actions.needs_review.folder;
if (!NEEDS_REVIEW) {
  console.error(`FATAL: workflow '${WORKFLOW}' has no actions.needs_review.folder defined`);
  process.exit(2);
}
const INBOX = workflow.inbox;
const PASS = process.env.WORKMAIL_PASS;
if (!PASS) { console.error('FATAL: WORKMAIL_PASS not set'); process.exit(1); }

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: INBOX, pass: PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(NEEDS_REVIEW);
    let moved = 0, skipped = 0;
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      console.log(`workflow=${WORKFLOW}  ${NEEDS_REVIEW} -> ${SOURCE}  (${uids.length} messages)`);
      if (uids.length === 0) { console.log('Nothing to recycle.'); return; }

      // Fetch envelopes so the operator can see what's being moved
      const candidates = [];
      for await (const msg of client.fetch(uids, { envelope: true, flags: true }, { uid: true })) {
        const subj = (msg.envelope && msg.envelope.subject) || '(no subject)';
        const uidStr = String(msg.uid);
        if (uidFilter && !uidFilter.has(uidStr)) continue;
        candidates.push({ uid: msg.uid, subject: subj });
        console.log(`  ${DRY ? '[DRY] ' : ''}uid=${msg.uid}  "${subj}"`);
      }
      if (uidFilter) console.log(`  (--uids filter: ${candidates.length} of ${uids.length} match)`);

      if (DRY) { console.log(`Would move ${candidates.length}. No changes made.`); return; }

      // Move + mark \\Unseen (move preserves flags; for our case the originating
      // bounce path doesn't set \\Seen, but be defensive in case some agent path does)
      for (const c of candidates) {
        try {
          await client.messageFlagsRemove(String(c.uid), ['\\Seen'], { uid: true });
        } catch (e) { /* not seen, fine */ }
        await client.messageMove(String(c.uid), SOURCE, { uid: true });
        moved++;
      }
      console.log(`Moved ${moved} message(s) to ${SOURCE}. Next cron tick will re-process.`);
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

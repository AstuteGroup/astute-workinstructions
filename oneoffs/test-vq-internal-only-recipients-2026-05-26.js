/**
 * test-vq-internal-only-recipients-2026-05-26.js
 *
 * Verifies the internal-only recipient policy for VQ clarification/escalation
 * emails (operator directive 2026-05-26, triggered by UID 8684 where the
 * split-recipient design hid the forwarder's copy from the operator).
 *
 * Asserts, across the escalation handlers:
 *   1. Internal forwarder + buyer (the UID 8684 shape): ONE email to
 *      operator + internal forwarder + buyer; no external party; no split.
 *   2. External broker sender: broker is NOT a recipient; operator + buyer get
 *      ONE email whose body says the external sender was not emailed.
 *   3. No usable sender: operator-only.
 *
 * Run: node oneoffs/test-vq-internal-only-recipients-2026-05-26.js
 */
'use strict';

const assert = require('assert');
const breadcrumbs = require('../shared/breadcrumbs');
breadcrumbs.write = () => {}; // stub — don't pollute the breadcrumb log under test

const vq = require('../shared/workflow-actions/vq-loading');

const JAKE = 'jake.harris@astutegroup.com';
const INBOX = 'vq@orangetsunami.com';
const IVY = 'ivy.song@astutegroup.com';       // support / forwarder (internal)
const MOLLY_ID = 1011012;                       // Molly Huang — buyer (resolves to internal email)
const STEPH_ID = 1009138;                       // Stephanie Hill — buyer
const BROKER = 'sales@randombroker.com';        // external

function makeCtx({ currentFrom, currentCc }) {
  const sent = [];
  return {
    ctx: {
      jakeEmail: JAKE,
      inbox: INBOX,
      currentFrom: currentFrom || null,
      currentCc: currentCc || '',
      dryRun: false,
      anchorMessageId: null, // skip sidecar disk write
      uid: 999999,
      workflow: 'vq-loading',
      notifier: {
        sendEmail: async (to, subject, body /*, opts */) => {
          sent.push({ to, subject, body });
          return true;
        },
      },
    },
    sent,
  };
}

function recipientsOf(sent) {
  // All addresses across all emails actually sent.
  return sent.flatMap(e => e.to.split(',').map(s => s.trim().toLowerCase()));
}

(async () => {
  let pass = 0;

  // ── Scenario 1: internal forwarder (Ivy) + buyer (Molly) — the UID 8684 shape
  {
    const { ctx, sent } = makeCtx({ currentFrom: IVY, currentCc: `${MOLLY_ID === 1011012 ? 'molly.huang@astutegroup.com' : ''}` });
    await vq.actions.need_info_vendor.handler(
      { missing: ['qty'], subject: 'ADI Shortage Quotation', buyerId: MOLLY_ID, outerFrom: IVY },
      ctx
    );
    assert.strictEqual(sent.length, 1, 'S1: exactly ONE email (no split)');
    const rcpts = recipientsOf(sent);
    assert.ok(rcpts.includes(JAKE), 'S1: operator included');
    assert.ok(rcpts.includes(IVY), 'S1: internal forwarder included');
    assert.ok(rcpts.includes('molly.huang@astutegroup.com'), 'S1: buyer included');
    assert.ok(!rcpts.some(r => !r.endsWith('@astutegroup.com')), 'S1: every recipient is internal');
    console.log('✓ S1 internal forwarder + buyer →', sent[0].to);
    pass++;
  }

  // ── Scenario 2: external broker sender + internal buyer
  {
    const { ctx, sent } = makeCtx({ currentFrom: BROKER, currentCc: '' });
    await vq.actions.needs_vendor.handler(
      { vendorName: 'Nordisk', subject: 'Quote', buyerId: STEPH_ID, outerFrom: BROKER },
      ctx
    );
    assert.strictEqual(sent.length, 1, 'S2: exactly ONE email');
    const rcpts = recipientsOf(sent);
    assert.ok(!rcpts.includes(BROKER), 'S2: external broker NOT a recipient');
    assert.ok(rcpts.includes(JAKE), 'S2: operator included');
    assert.ok(rcpts.some(r => r.endsWith('@astutegroup.com') && r !== JAKE), 'S2: buyer (internal) included');
    assert.ok(/not.{0,3}emailed|not<\/b> emailed/i.test(sent[0].body), 'S2: body notes external sender not emailed');
    assert.ok(sent[0].body.includes(BROKER), 'S2: body names the external sender for manual loop-in');
    console.log('✓ S2 external broker not emailed →', sent[0].to);
    pass++;
  }

  // ── Scenario 3: no usable sender → operator only
  {
    const { ctx, sent } = makeCtx({ currentFrom: '', currentCc: '' });
    await vq.actions.needs_review.handler(
      { reason: 'verifier/extractor mismatch', subject: 'Weird quote' },
      ctx
    );
    assert.strictEqual(sent.length, 1, 'S3: exactly ONE email');
    assert.strictEqual(sent[0].to, JAKE, 'S3: operator-only');
    console.log('✓ S3 no sender → operator only →', sent[0].to);
    pass++;
  }

  console.log(`\nALL ${pass}/3 internal-only recipient scenarios passed.`);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });

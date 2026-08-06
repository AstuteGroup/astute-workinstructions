# Unified Email Tracking & Reply Handling

**Status:** Phase 3 Implemented (2026-08-06)
**Created:** 2026-07-31
**Problem:** `needs_review` notifications across all workflows don't write sidecars, so operator replies go nowhere. Additionally, UIDs are per-inbox and per-folder, making email references painful.

---

## Part 1: Fix `needs_review` Reply Handling

### Problem

Every workflow has a `needs_review` action that:
1. Sends an email asking operator for help
2. Moves email to NeedsReview folder
3. **Does NOT write a sidecar**

When the operator replies, the system can't connect the reply to the original email.

### Affected Workflows (8 total)

| Workflow | Inbox | Line |
|----------|-------|------|
| rfq-loading | rfqloading@ | ~379 |
| vq-loading | vq@ | TBD |
| excess | excess@ | TBD |
| broker-offers | brokeroffers@ | ~480 |
| stockrfq | stockRFQ@ | ~515 |
| stockrfq-cq | stockRFQ@ | ~395 |
| tracking-loading | tracking@ | ~538 |
| lam-kitting | lamkitting@ | TBD |

Also affected: `needs_partner` in excess and broker-offers (same pattern).

### Solution

Modify all `needs_review` (and `needs_partner`) actions to:

1. **Write a sidecar** with the extracted state before escalating
2. **Set `keepsPending: true`** on the action definition
3. **Store what blocked processing** so agent can retry with operator input

### Implementation: `action_needs_review` Template

```javascript
async function action_needs_review(payload, ctx) {
  const { reason, details, subject, from, investigation_summary, extracted } = payload;

  // === NEW: Write sidecar so replies can be stitched ===
  const sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
    original_message_id: ctx.anchorMessageId,
    original_uid: ctx.uid,
    original_subject: subject,
    escalation_type: 'needs_review',
    escalation_reason: reason,
    extracted: extracted || {},           // What we managed to extract
    blocking_issue: reason,               // Why we couldn't proceed
    investigation_summary: investigation_summary || null,
    retry_count: (ctx.pendingSidecar?.retry_count || 0) + 1,
  });
  // === END NEW ===

  // ... existing notification email code ...

  // Include sidecar reference in breadcrumb
  breadcrumbs.write({
    cog: `${ctx.workflow}-agent`,
    event: 'escalated-needs_review',
    uid: ctx.uid,
    messageId: ctx.currentMessageId,      // NEW: track for lookup
    anchorMessageId: ctx.anchorMessageId, // NEW: thread anchor
    reason,
    sidecar_key: sidecarRecord?.key || null,
    // ... existing fields ...
  });

  return {
    notified: envelope.to,
    sidecar_written: true,
    sidecar_key: sidecarRecord?.key,
  };
}
```

### Action Definition Change

```javascript
needs_review: {
  folder: 'NeedsReview',
  requires: ['reason'],
  keepsPending: true,    // <-- ADD THIS
  handler: action_needs_review,
},
```

### Agent Prompt Update

Add to each workflow's agent prompt:

```
## Handling needs_review Replies

When you receive an email with `pending_state` containing `escalation_type: 'needs_review'`:

1. Read the `blocking_issue` to understand what stopped processing
2. Check if the operator's reply resolves the issue (e.g., "Use Search Key 1010187")
3. Merge the resolution with `pending_state.extracted`
4. Continue processing (route to load_rfq/load_vq/etc.)

If the reply doesn't resolve the issue, route to needs_review again with updated context.
```

---

## Part 2: Unified Email Tracking IDs

### Problem

- UIDs are per-inbox AND per-folder (UID 317 in INBOX != UID 317 in NeedsReview)
- When emails move folders, they get new UIDs
- Operators reference "UID 317" but we can't find it without knowing inbox + folder
- No single place to look up "what is this email and where is it now"

### Solution: Tracking ID Registry

Create a centralized tracking ID that:
1. Is assigned when email first enters the system
2. Never changes regardless of folder moves
3. Encodes the inbox for immediate context
4. Maps to Message-ID (the true stable identifier)

### Tracking ID Format

```
{inbox-prefix}-{sequence}

Examples:
  RFQ-00317      → rfqloading@ inbox, sequence 317
  VQ-01542       → vq@ inbox, sequence 1542
  STK-15099      → stockRFQ@ inbox, sequence 15099
  EXC-00089      → excess@ inbox, sequence 89
  TRK-00044      → tracking@ inbox, sequence 44
  BRK-00201      → brokeroffers@ inbox, sequence 201
  LAM-00076      → lamkitting@ inbox, sequence 76
```

### Inbox Prefix Registry

```javascript
// shared/tracking-id.js
const INBOX_PREFIXES = {
  'rfqloading@orangetsunami.com': 'RFQ',
  'vq@orangetsunami.com': 'VQ',
  'stockRFQ@orangetsunami.com': 'STK',
  'excess@orangetsunami.com': 'EXC',
  'tracking@orangetsunami.com': 'TRK',
  'brokeroffers@orangetsunami.com': 'BRK',
  'lamkitting@orangetsunami.com': 'LAM',
};
```

### Tracking Registry File

```
~/.email-tracking-registry.jsonl
```

Each line:
```json
{"trackingId":"RFQ-00317","inbox":"rfqloading@orangetsunami.com","messageId":"<abc123@host>","uid":317,"subject":"new rfq 1234","from":"justin@...","receivedAt":"2026-07-29T12:00:00Z","currentFolder":"NeedsReview","status":"pending_review","lastUpdated":"2026-07-29T12:44:00Z"}
```

### API

```javascript
// shared/tracking-id.js

const { assignTrackingId, lookupByTrackingId, lookupByMessageId, updateStatus } = require('./tracking-id');

// Assign ID when email first processed
const trackingId = assignTrackingId({
  inbox: 'rfqloading@orangetsunami.com',
  uid: 317,
  messageId: '<abc123@host>',
  subject: 'new rfq 1234',
  from: 'justin@...',
});
// Returns: 'RFQ-00317'

// Lookup by tracking ID
const record = lookupByTrackingId('RFQ-00317');
// Returns: { trackingId, inbox, messageId, uid, subject, currentFolder, status, ... }

// Lookup by Message-ID (for reply stitching)
const record = lookupByMessageId('<abc123@host>');

// Update when email moves or status changes
updateStatus('RFQ-00317', {
  currentFolder: 'Processed',
  status: 'loaded',
  rfqSearchKey: '1138500',
});
```

### Integration Points

1. **`email-workflow-poller.js` `cmdRead`**: Assign tracking ID on first read, include in JSON output
2. **`cmdRoute`**: Update tracking registry with new folder + status
3. **Notification emails**: Include tracking ID instead of (or alongside) UID
4. **Breadcrumbs**: Include tracking ID for audit trail
5. **CLI lookup**: `node scripts/lookup-email.js RFQ-00317`

### Notification Email Change

Before:
```
Subject: new rfq 1234
From: (unknown)
UID: 317
```

After:
```
Subject: new rfq 1234
From: (unknown)
Tracking ID: RFQ-00317
```

### CLI Lookup Tool

```bash
# scripts/lookup-email.js

$ node scripts/lookup-email.js RFQ-00317

Tracking ID:   RFQ-00317
Inbox:         rfqloading@orangetsunami.com
Message-ID:    <abc123@host>
Original UID:  317
Subject:       new rfq 1234
From:          justin.oberhofer@astutegroup.com
Received:      2026-07-29 12:00 CT
Current Folder: NeedsReview
Status:        pending_review
Last Updated:  2026-07-29 12:44 CT

Related:
  - Reply RFQ-00317-R1 (UID 323) - "Re: RFQ Loading — needs review..."
```

---

## Part 3: Reply Threading

### Problem

Replies get their own UIDs and aren't obviously connected to the original.

### Solution

When a reply arrives:
1. Check References/In-Reply-To headers
2. Look up parent in tracking registry by Message-ID
3. Assign tracking ID as `{parent}-R{n}` (e.g., `RFQ-00317-R1`)
4. Link in registry

```json
{"trackingId":"RFQ-00317-R1","parentTrackingId":"RFQ-00317","inbox":"rfqloading@orangetsunami.com","messageId":"<def456@host>","uid":323,"subject":"Re: RFQ Loading — needs review...","from":"justin@...","receivedAt":"2026-07-29T17:54:33Z","status":"unprocessed"}
```

---

## Implementation Order

### Phase 1: Fix needs_review (Immediate)
1. Add sidecar writes to all `action_needs_review` handlers
2. Add `keepsPending: true` to all `needs_review` action definitions
3. Update agent prompts to handle needs_review replies
4. Test with the stuck RFQ-1234 case

### Phase 2: Tracking ID Registry ✅ DONE (2026-08-05)
1. ✅ Create `shared/tracking-id.js` with assign/lookup/update
2. ✅ Create `~/.email-tracking-registry.jsonl`
3. ✅ Integrate into `email-workflow-poller.js` (cmdRead assigns, cmdRoute updates)
4. ✅ Create `scripts/lookup-email.js` CLI

### Phase 3: Update Notifications ✅ DONE (2026-08-06)
1. ✅ Replace UID references with Tracking ID in notification emails
2. ✅ Update breadcrumb writes to include tracking ID
3. Backfill existing sidecars with tracking IDs (optional — skipped)

### Phase 4: Reply Threading
1. Add parent lookup on reply detection
2. Assign child tracking IDs
3. Link in registry

---

## Files to Modify

### Phase 1
- `shared/workflow-actions/rfq-loading.js` - action_needs_review + action definition
- `shared/workflow-actions/vq-loading.js` - same
- `shared/workflow-actions/excess.js` - action_needs_review + action_needs_partner
- `shared/workflow-actions/broker-offers.js` - same
- `shared/workflow-actions/stockrfq.js` - action_needs_review
- `shared/workflow-actions/stockrfq-cq.js` - same
- `shared/workflow-actions/tracking-loading.js` - same
- `shared/workflow-actions/lam-kitting.js` - same
- Agent prompt files for each workflow

### Phase 2
- NEW: `shared/tracking-id.js`
- `shared/email-workflow-poller.js` - integrate tracking ID
- NEW: `scripts/lookup-email.js`

### Phase 3
- All `action_needs_review` handlers - update email template
- `shared/breadcrumbs.js` - add trackingId field

---

## Test Plan

### Phase 1 Test
1. Clear UID 323's SEEN flag in rfqloading@ INBOX
2. Re-read UID 317 from NeedsReview (need to find its new UID there)
3. Verify sidecar exists after routing
4. Simulate reply processing - verify pending_state attached
5. Verify agent can complete RFQ load with customer 1008254

### Phase 2 Test
1. Process a new email through rfq-loading
2. Verify tracking ID assigned (e.g., RFQ-00325)
3. Run `lookup-email.js RFQ-00325`
4. Verify registry entry created
5. Route email, verify registry updated with new folder

---

## Open Questions

1. **Sequence reset?** Should tracking IDs be globally sequential or reset per inbox? (Recommend: per-inbox, simpler)

2. **Historical backfill?** Should we backfill tracking IDs for emails already in breadcrumbs? (Recommend: no, forward-only)

3. **Reply depth limit?** Should we limit reply threading depth? (Recommend: 3 levels max, then flatten)

4. **Registry pruning?** How long to retain tracking records? (Recommend: 90 days, then archive)

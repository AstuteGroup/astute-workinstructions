# Handoff: New Manufacturer Screening CLI Update

**Date:** 2026-08-04
**From:** Justin Oberhofer
**To:** analytics_user
**Priority:** Ready when convenient

---

## Summary

The New Manufacturer Screening workflow is complete, tested, and running on cron. It scrapes `bizops@orangetsunami.com` for MFR requests, runs fuzzy matching + website verification, and emails results for approval.

**Blocking issue:** The writeback CLI needs two new subcommands (`mfr` and `mfr-alias`) before the workflow can create manufacturers in OT. Until then, approved MFRs trigger a manual creation request email.

---

## What Works Now

1. ✅ Scrapes bizops inbox for "New MFR Request" emails
2. ✅ Parses MFR name + URL + alias from email body (handles multi-line format)
3. ✅ Fuzzy matches against OT manufacturer database with **company suffix normalization**
   - "DMG Spa" = "DMG S.p.A" (EXACT match)
   - Handles: Spa/S.p.A, Inc/Incorporated, Ltd/Limited, GmbH, Corp, LLC, etc.
4. ✅ Verifies website is a manufacturer (not distributor) via Playwright
5. ✅ Emails results to reviewer with:
   - Top 3 matches over 30% in table format
   - Requester and CC recipients (clickable mailto: links)
   - Website verification status
6. ✅ Processes "add" / "skip" replies (moves to Processed folder)
7. ✅ Cron jobs installed (every 30 minutes)
8. ❌ **Creates MFR in OT** ← needs CLI update (currently sends manual request email)

---

## Cron Jobs (Already Installed)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `mfr-screening-requests` | `*/30 * * * *` | Scrape bizops@ for new MFR requests |
| `mfr-screening-replies` | `15,45 * * * *` | Process add/skip replies |

---

## What You Need To Do

### 1. Create `shared/mfr-writer.js`

```javascript
// /home/analytics_user/workspace/astute-workinstructions/shared/mfr-writer.js
const { apiPost, apiPatch } = require('./api-client');

/**
 * Create a new manufacturer in OT.
 */
async function writeMfr(opts) {
  const { name, url, alias } = opts;

  if (!name) {
    throw new Error('MFR name is required');
  }

  const payload = {
    Name: name,
    IsActive: true,
  };

  if (url) payload.URL = url;
  if (alias) payload.Description = alias;

  const result = await apiPost('chuboe_mfr', payload);

  return {
    mfrId: result.id,
    code: result.SearchKey || result.Value,
    name: result.Name,
    url: result.URL,
    alias: result.Description,
    created: true,
  };
}

/**
 * Update manufacturer description with M code.
 */
async function updateMfrAlias(opts) {
  const { mfrId, mCode } = opts;

  if (!mfrId || !mCode) {
    throw new Error('mfrId and mCode are required');
  }

  const result = await apiPatch('chuboe_mfr', mfrId, {
    Description: mCode,
  });

  return {
    mfrId,
    description: mCode,
    updated: true,
  };
}

module.exports = { writeMfr, updateMfrAlias };
```

### 2. Add subcommands to `/opt/writeback/cli.js`

Find the `SUBCOMMANDS` object and add:

```javascript
  mfr: {
    required: ['opts'],
    handler: async (payload) => {
      const { writeMfr } = require('/home/analytics_user/workspace/astute-workinstructions/shared/mfr-writer');
      return writeMfr(payload.opts);
    },
  },

  'mfr-alias': {
    required: ['opts'],
    handler: async (payload) => {
      const { updateMfrAlias } = require('/home/analytics_user/workspace/astute-workinstructions/shared/mfr-writer');
      return updateMfrAlias(payload.opts);
    },
  },
```

### 3. Test the subcommands

```bash
# Test mfr (create manufacturer):
echo '{"opts":{"name":"TEST_MFR_DELETE_ME","url":"https://example.com"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr

# Expected: {"ok":true,"result":{"mfrId":...,"code":"MFR...","name":"TEST_MFR_DELETE_ME","created":true}}

# Test mfr-alias (update description with M code):
echo '{"opts":{"mfrId":<ID_FROM_ABOVE>,"mCode":"M99999"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr-alias

# Expected: {"ok":true,"result":{"mfrId":...,"description":"M99999","updated":true}}
```

### 4. Clean up test record

Delete `TEST_MFR_DELETE_ME` from OT after testing.

---

## Workflow Files

| File | Purpose |
|------|---------|
| `mfr-reply-handler.py` | Main workflow: scrapes inbox, processes replies |
| `mfr-batch-check.py` | Fuzzy matching + email generation |
| `mfr-fuzzy-check.js` | Playwright website verification |
| `fuzzy_mfr_match.js` | OT database lookup |
| `new-mfr-screening.md` | Full workflow documentation |

---

## After CLI Update

The workflow will be fully operational. On "add" replies:
1. Creates MFR in OT automatically
2. Sends email asking for M code
3. On M code reply, updates MFR description

Until then, "add" replies send a manual creation request email.

---

## Testing Commands

```bash
# Manually run the request scraper
python3 /home/justin.oberhofer/workspace/astute-workinstructions/tsk-new-mfr-screening/mfr-reply-handler.py --requests --mailbox bizops

# Manually run the reply handler
python3 /home/justin.oberhofer/workspace/astute-workinstructions/tsk-new-mfr-screening/mfr-reply-handler.py --mailbox bizops

# Check pending M code assignments
python3 /home/justin.oberhofer/workspace/astute-workinstructions/tsk-new-mfr-screening/mfr-reply-handler.py --pending

# Clear processed message IDs (for re-testing)
python3 /home/justin.oberhofer/workspace/astute-workinstructions/tsk-new-mfr-screening/mfr-reply-handler.py --clear-processed
```

---

## Questions?

Ping Justin or check `tsk-new-mfr-screening/new-mfr-screening.md` for full documentation.

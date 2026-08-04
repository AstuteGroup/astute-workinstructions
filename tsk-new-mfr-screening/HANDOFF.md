# Handoff: New Manufacturer Screening CLI Update

**Date:** 2026-08-04
**From:** Justin Oberhofer
**To:** analytics_user
**Priority:** Ready when convenient

---

## Summary

The New Manufacturer Screening workflow is complete and tested. It scrapes `bizops@orangetsunami.com` for MFR requests, runs fuzzy matching + website verification, and emails results for approval.

**Blocking issue:** The writeback CLI needs two new subcommands (`mfr` and `mfr-alias`) before the workflow can create manufacturers in OT.

---

## What Works Now

1. ✅ Scrapes bizops inbox for "New MFR Request" emails
2. ✅ Parses MFR name + URL from email body
3. ✅ Fuzzy matches against OT manufacturer database
4. ✅ Verifies website is a manufacturer (not distributor) via Playwright
5. ✅ Emails clean results to reviewer
6. ✅ Processes "add" / "skip" replies
7. ❌ **Creates MFR in OT** ← needs CLI update

---

## What You Need To Do

### 1. Add subcommands to `/opt/writeback/cli.js`

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

### 2. Test the subcommands

```bash
# Test mfr (create manufacturer):
echo '{"opts":{"name":"TEST_MFR_DELETE_ME","url":"https://example.com"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr

# Expected: {"ok":true,"result":{"mfrId":...,"code":"MFR...","name":"TEST_MFR_DELETE_ME","created":true}}

# Test mfr-alias (update description with M code):
echo '{"opts":{"mfrId":1021234,"mCode":"M99999"}}' \
  | sudo -n -u analytics_user /opt/writeback/cli mfr-alias

# Expected: {"ok":true,"result":{"mfrId":1021234,"description":"M99999","updated":true}}
```

### 3. Clean up test record

Delete `TEST_MFR_DELETE_ME` from OT after testing.

---

## Files Already Updated

| File | Purpose |
|------|---------|
| `shared/mfr-writer.js` | Writer module with `writeMfr()` and `updateMfrAlias()` |
| `shared/writeback-proxy-client.js` | Dispatch entries for both functions |
| `wi-new-manufacturer-screening/` | Full workflow scripts |

---

## After CLI Update

The workflow will be fully operational:

```bash
# Scrape bizops and send results to Justin
python3 mfr-reply-handler.py --requests --mailbox bizops

# Process Justin's add/skip replies
python3 mfr-reply-handler.py --mailbox bizops
```

Can be scheduled via cron for automation.

---

## Questions?

Ping Justin or check `wi-new-manufacturer-screening/README.md` for full documentation.

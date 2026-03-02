# User Verification Checklist - Before Phase 2

## ⛔ PLEASE REVIEW BEFORE APPROVING PHASE 2

Phase 1 is complete. Before proceeding with the fresh batch run, please verify:

---

## 1. Email Folder Verification

### Check Email Counts
```bash
node vq-parser/scripts/count-inbox.js
```

**Expected output:**
```
INBOX: 277 emails       ✅
Processed: 0 emails     ✅
NeedsReview: 0 emails   ✅
```

### Manual Email Review

Please manually check your VQ email account:

1. **Open INBOX folder** - Should contain 277 emails
2. **Check for completeness** - Verify no emails are missing
3. **Check Processed folder** - Should be empty
4. **Check NeedsReview folder** - Should be empty

**Questions to verify:**
- [ ] Do you see approximately 277 emails in INBOX?
- [ ] Are the Processed and NeedsReview folders empty?
- [ ] Does the email list look complete (no obvious gaps)?

---

## 2. Archive Verification

### Check Archive Exists
```bash
ls -la vq-parser/output/archive-session-20260302/
```

**Expected files:**
```
uploads/          - 14 CSV files
data/            - 3 JSON files
MANIFEST.md      - Archive documentation
README.txt       - Archive summary
needs-review.json - Failed parses from previous session
```

### Review Archive Documentation

Read the archive manifest:
```bash
cat vq-parser/output/archive-session-20260302/MANIFEST.md
```

**Questions to verify:**
- [ ] Does the archive exist?
- [ ] Does the MANIFEST explain what's archived and why?
- [ ] Are you comfortable that the old data is preserved?

---

## 3. Parser Improvements Preserved

### Check Parser Code
```bash
cat vq-parser/src/parser/regex-parser.js | grep -A 5 "MPN with colon"
```

**Should see:**
- MPN with colon prefix pattern (`:MPN`)
- @ symbol price pattern
- Quantity without space pattern
- Fixed quantity patterns
- Image filename filtering

**Questions to verify:**
- [ ] Are the 5 regex improvements still in the code?
- [ ] Are the new scripts present (categorize-failures.js, etc.)?

---

## 4. Tracking Data Reset

### Check Processed IDs
```bash
cat vq-parser/data/processed-ids.json
```

**Expected output:**
```json
{"processed":[]}
```

### Check Caches Preserved
```bash
ls -la vq-parser/data/*.json
```

**Expected files:**
```
processed-ids.json   - Empty ✅
vendor-cache.json    - Present (preserved) ✅
mfr-cache.json       - Present (preserved) ✅
```

**Questions to verify:**
- [ ] Is processed-ids.json empty?
- [ ] Are vendor-cache.json and mfr-cache.json still present?

---

## 5. Git Status

### Check Commits
```bash
git -C vq-parser log --oneline -5
```

**Should see:**
- Latest commit: "Phase 1 complete: Archive and reset for clean batch run"
- Previous commit: "Document session: Parser improvements + manual extraction workflow"

**Questions to verify:**
- [ ] Are the Phase 1 scripts committed?
- [ ] Is the session documentation committed?

---

## 6. Ready for Phase 2?

If all checks pass, you're ready to approve Phase 2.

### What Phase 2 Will Do

**Automatic actions (no intervention needed):**
1. Parse all 277 emails in INBOX with improved parser
2. Move successful parses to Processed folder
3. Create individual VQ_*.csv files
4. Consolidate all CSVs into VQ_UPLOAD
5. Generate statistics report

**Your involvement needed:**
- Review any [PARTIAL] or [HIGH_COST] flags
- Approve or modify the consolidated upload

**Estimated time:** 5-10 minutes

---

## Approval Decision

### ✅ Approve Phase 2 if:
- All email counts match expected (277 in INBOX)
- Archive is documented and preserved
- Parser improvements are present
- Tracking data is reset correctly

### ❌ Hold Phase 2 if:
- Email counts don't match
- Concerned about lost emails
- Want to review archive contents first
- Need to check something manually

---

## How to Approve Phase 2

Simply tell Claude:

> "Phase 2 approved - proceed with fresh batch run"

Or if you have concerns:

> "Hold - I need to check [specific concern]"

---

## Support

If you have any questions or concerns, stop here and ask before proceeding.

**Common concerns:**
- "What if emails were lost?" - Check archive and INBOX manually
- "Can I recover the old data?" - Yes, it's in archive-session-20260302/
- "Will this delete anything?" - No, Phase 2 only reads emails and creates CSVs
- "Can I stop mid-way?" - Yes, you can stop at any time

---

**Current Status:** ⏸️ PAUSED - Awaiting your approval

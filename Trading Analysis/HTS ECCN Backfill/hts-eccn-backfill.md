# HTS / ECCN Backfill Workflow

Backfills HTS (US Harmonized Tariff Schedule) and ECCN (Export Control Classification Number) onto `chuboe_vq_line` rows from franchise distributor APIs (DigiKey + Mouser). RFQ-scoped, idempotent, safe to re-run.

**Why:** HTS/ECCN are required for compliance, customs filing, and customer requirements. They are properties of the part itself (not the seller), so a single API lookup populates every VQ row with that MPN/MFR — across vendors, including brokers who couldn't have told us themselves.

**First production run:** 2026-04-08, RFQ 1132040 (LAM EPG), 140 VQ lines, 123 patched, 0 errors.

---

## Quick Start

```bash
# Dry run — show what would change, no writes
node "Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.js" --rfq <search_key> --dry-run

# Live run on full RFQ
node "Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.js" --rfq <search_key>

# Limit for testing
node "Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.js" --rfq <search_key> --limit 5 --dry-run
```

---

## End-to-End Workflow

### Step 1: Identify scope

Run a quick scope check before kicking off the backfill:

```sql
SELECT
  vl.chuboe_rfq_id,
  COUNT(*) AS total_vq_lines,
  COUNT(*) FILTER (WHERE vl.chuboe_hts IS NULL) AS missing_hts,
  COUNT(*) FILTER (WHERE vl.chuboe_eccn IS NULL) AS missing_eccn,
  COUNT(DISTINCT (vl.chuboe_mpn_clean, vl.chuboe_mfr_id)) AS distinct_mpn_mfr
FROM adempiere.chuboe_vq_line vl
JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = vl.chuboe_rfq_id
WHERE r.value = '<search_key>'
  AND vl.isactive = 'Y'
GROUP BY vl.chuboe_rfq_id;
```

The `distinct_mpn_mfr` count is what drives API call volume — each is one DigiKey + one Mouser call (in parallel). At ~1.5–2s per tuple, expect ~3–4 minutes per 100 distinct parts.

### Step 2: Dry run (do not skip)

Always dry-run first against the full RFQ before going live:

```bash
node "Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.js" --rfq <search_key> --dry-run
```

Inspect the output:
- **Resolution Summary** — how many tuples got resolved HTS/ECCN, how many had disagreements, how many had no data
- **Sample of proposed PATCHes** — first 10 rows with the values that would be written
- **Resolution log + disagreement log** — JSON files in `logs/`

If anything looks off (high disagreement rate, unexpected NULL counts, malformed values), stop and investigate before live.

### Step 3: Live run

```bash
node "Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.js" --rfq <search_key>
```

Outputs:
- Real-time progress (`N/130 processed`)
- PATCH summary at the end (`patched`, `skipped`, `validation failed`, `errors`)
- Audit log files in `logs/`

### Step 4: Verify

```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE chuboe_hts IS NOT NULL) AS has_hts,
  COUNT(*) FILTER (WHERE chuboe_eccn IS NOT NULL) AS has_eccn
FROM adempiere.chuboe_vq_line
WHERE chuboe_rfq_id = <internal_id> AND isactive = 'Y';
```

Compare to the pre-run scope query — the deltas should match the patched count.

### Step 5: Review disagreements

Open the disagreement log file (`logs/{timestamp}-disagreement-log.json`). Each entry shows:
```json
{
  "kind": "hts",
  "mpn": "CXE480D5",
  "mfrText": "Sensata",
  "digikey": "8536.41.0030",
  "mouser": "8536490080"
}
```

These are deferred to manual resolution at purchase time — not auto-resolved because a wrong HTS/ECCN can have compliance consequences. If you have a definitive answer, use the iDempiere UI to set the value manually, OR re-run the backfill (it will skip the populated rows and still leave the disagreement-blank rows alone).

---

## Resolution Rules

**Source priority: DigiKey > Mouser.** Arrow's standard search API does not return classification data (a separate compliance endpoint is required); TTI / Waldom inconsistent.

| Field | If only one source returns | If both return and agree | If both return and disagree |
|-------|---------------------------|--------------------------|-----------------------------|
| HTS | Use it as-is | Use DigiKey's value (dotted format is canonical HS) | Leave NULL, log to disagreement file |
| ECCN | Use it as-is | Use first source's value (case-insensitive match) | Leave NULL, log to disagreement file |

**HTS comparison strips non-digits.** `8542.33.0001` and `8542330001` are recognized as the same code.

**Idempotency:** `record-updater` is called with `skipIfNotNull: ['Chuboe_HTS', 'Chuboe_ECCN']`. Re-running the backfill will never overwrite values that were manually corrected between runs. Each field is gated independently — a row with a populated HTS but null ECCN gets only the ECCN patched.

**Application scope:** Resolved values are applied to ALL `chuboe_vq_line` rows on the RFQ that match the (mpn_clean, mfr_text) tuple — regardless of vendor. HTS/ECCN belong to the part, not the seller, so a broker quote gains classification data even though the broker couldn't have told us.

---

## Audit Files (in `logs/`)

| File | Contents |
|------|----------|
| `{timestamp}-resolution-log.json` | Every (mpn, mfr) tuple with sources, resolved values, and source attribution |
| `{timestamp}-disagreement-log.json` | Cases where DigiKey and Mouser disagreed (only written if any) |
| `hts-eccn-backfill-{timestamp}-patch-log.json` | record-updater audit: every successful PATCH with before/after |
| `hts-eccn-backfill-{timestamp}-skip-log.json` | record-updater audit: rows where the value was already populated |
| `hts-eccn-backfill-{timestamp}-error-log.json` | record-updater audit: validation failures and PUT errors (only written if any) |

---

## Known Gaps

- **Arrow doesn't return HTS/ECCN** in its standard search API. Coverage on Arrow-only parts is 0%. To improve, integrate Arrow's separate compliance endpoint (not yet done — additional API call per part, rate-limit considerations).
- **TTI / Waldom return is inconsistent.** Sometimes populated, often not. Not currently in the source priority — would add coverage for passive-heavy RFQs but at the cost of more disagreements.
- **No backfill of newly-loaded VQs.** This script only runs on demand against an RFQ. Going forward, `vq-writer.js` should populate HTS/ECCN at *write time* from the same franchise API data — that work is on the sourcing roadmap (W2 steady-state).
- **No HTS validation regex.** ECCN has a loose format check before PATCH; HTS does not (HTS codes are too varied). The audit log captures every value written.

---

## Module Dependencies

| Module | Purpose |
|--------|---------|
| `shared/franchise-api.js` | Calls DigiKey + Mouser via `searchAllDistributors`, surfaces `vqHts` / `vqEccn` |
| `shared/record-updater.js` | Idempotent batch PATCH with skipIfNotNull, validation, audit logs |
| `shared/api-client.js` | iDempiere REST API plumbing (`apiPut`) |
| `Trading Analysis/RFQ Sourcing/franchise_check/digikey.js` | Extracts `Classifications.HtsusCode` / `ExportControlClassNumber` |
| `Trading Analysis/RFQ Sourcing/franchise_check/mouser.js` | Extracts `ProductCompliance` array (USHTS + ECCN) |

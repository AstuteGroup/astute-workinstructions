# Currency Conversion CLI Handoff

**Date:** 2026-08-04
**From:** justin.oberhofer
**To:** analytics_user

---

## Summary

The currency conversion workflow is complete except for one step that requires analytics_user access: adding the `currency-rates` subcommand to `/opt/writeback/cli.js`.

---

## What's Done

- [x] Email poller (`currency-poller.py`) - polls bizops@ every 30m
- [x] Excel processor (`currency-processor.js`) - extracts rates from xlsx
- [x] CSV generation - 21 currency pairs for iDempiere import
- [x] Reply handling - detects "add" replies
- [x] Currency rate writer (`shared/currency-rate-writer.js`) - POSTs to C_Conversion_Rate
- [x] Writeback proxy client updated with `writeCurrencyRates` entry
- [x] Cron job installed (`currency-conversion-poller`)
- [x] Confirmation/error email replies

---

## What You Need To Do

### Step 1: Install the CLI subcommand

```bash
# Preview first
node /home/justin.oberhofer/workspace/astute-workinstructions/scripts/add-currency-rates-to-cli.js

# Then apply
node /home/justin.oberhofer/workspace/astute-workinstructions/scripts/add-currency-rates-to-cli.js --apply
```

This will:
1. Add `currency-rates` subcommand to `/opt/writeback/cli.js`
2. Copy `currency-rate-writer.js` to `/opt/writeback/`
3. Create a backup at `/opt/writeback/cli.js.bak`

### Step 2: Test the CLI

```bash
echo '{"opts":{"rates":[{"from":"EUR","to":"USD","rate":1.14}],"validFrom":"2026-08-04","validTo":"2026-09-03","dryRun":true}}' | /opt/writeback/cli currency-rates
```

Expected output: JSON with `dryRun: true` results.

### Step 3: Process the pending "add" reply

Justin has already replied "add" to an August 2026 currency email. Process it:

```bash
# As analytics_user, or via sudo:
python3 /home/justin.oberhofer/workspace/astute-workinstructions/tsk-currency-conversion-upload/currency-poller.py --replies-only
```

This will:
1. Detect the "add" reply
2. Push 21 currency pairs to C_Conversion_Rate (Aug 4 - Sep 3)
3. Send confirmation email to Justin

---

## Verification

After completing the steps above:

```bash
# Check rates were loaded
psql -c "SELECT c_currency_id, c_currency_id_to, multiplyrate, validfrom
         FROM adempiere.c_conversion_rate
         WHERE validfrom = '2026-08-04'
         ORDER BY c_currency_id"
```

Should show 21 rows for August 2026.

---

## Files Reference

| File | Location |
|------|----------|
| Installer script | `scripts/add-currency-rates-to-cli.js` |
| Email poller | `tsk-currency-conversion-upload/currency-poller.py` |
| Excel processor | `tsk-currency-conversion-upload/currency-processor.js` |
| Rate writer | `shared/currency-rate-writer.js` |
| Workflow docs | `tsk-currency-conversion-upload/currency-conversion-upload.md` |

---

## Questions?

Contact justin.oberhofer@astutegroup.com

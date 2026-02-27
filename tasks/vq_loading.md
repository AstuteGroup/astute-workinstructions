# VQ Loading Task

Process supplier quote emails into the VQ Mass Upload Template for import into OT.

---

## Automated Parser (Primary Method)

The `vq-parser` tool processes supplier quote emails directly from the VQ inbox via Himalaya CLI.

### Location

```
~/workspace/vq-parser/
```

### Commands

```bash
# Process new emails from inbox
node ~/workspace/vq-parser/src/index.js fetch

# Dry run (parse without generating CSV)
node ~/workspace/vq-parser/src/index.js fetch --dry-run --verbose

# Process specific email
node ~/workspace/vq-parser/src/index.js reprocess <email_id> --verbose

# Test connection
node ~/workspace/vq-parser/src/index.js test-connection
```

### Output

CSVs written to `~/workspace/vq-parser/output/`:
```
VQ_{RFQ#}_{Sender}_{Timestamp}.csv
```

---

## Extraction Sources (Priority Order)

1. **Attachments** - PDF (pdf.js-extract), Excel/CSV (xlsx)
2. **Email Body** - Text tables and key-value patterns
3. **Hyperlinks** - Quote portal URLs fetched via Playwright

---

## RFQ Resolution Logic

RFQ numbers are resolved by looking up MPNs in the database (supplier reference numbers in emails are their internal IDs, not ours).

**Resolution Strategy:**

1. **Exact MPN Match** - Query `chuboe_rfq_line_mpn` for quoted MPN
2. **NetComponents Format** - Extract original RFQ MPN from email body (the MPN we requested)
3. **Fuzzy Match** - Progressively trim characters from quoted MPN to find partial match
4. **Subject Line** - Try extracting MPN from email subject

**Database Query:**
```sql
SELECT rl.chuboe_rfq_id, rlm.mpn
FROM adempiere.chuboe_rfq_line_mpn rlm
JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
WHERE UPPER(REPLACE(rlm.mpn, '-', '')) = $normalizedMPN
ORDER BY rl.created DESC
LIMIT 1;
```

---

## MPN Mismatch Handling

When quoted MPN differs from RFQ MPN:
- Use **quoted MPN** in `chuboe_mpn` (what supplier is offering)
- Add note: `Quoted MPN: ABC123-TR (RFQ MPN: ABC123)`

---

## Partial Data Flags

Missing price or quantity triggers a flag for manual review:

| Missing | Vendor Notes |
|---------|--------------|
| Price | `[PARTIAL - needs: price]` |
| Quantity | `[PARTIAL - needs: qty]` |
| Both | `[PARTIAL - needs: price, qty]` |

---

## Field Mappings

| Template Column | Description | Valid Values |
|-----------------|-------------|--------------|
| `chuboe_rfq_id` | RFQ Search Key | Numeric ID from system |
| `chuboe_buyer_id` | Buyer name | e.g., "Jake Harris" |
| `c_bpartner_id` | Business Partner Search Key | From OT lookup |
| `ad_user_id` | Contact name | Supplier contact |
| `chuboe_mpn` | Manufacturer Part Number | Exact MPN |
| `chuboe_mfr_text` | Manufacturer name | e.g., "Texas Instruments" |
| `qty` | Quoted Quantity | Numeric |
| `cost` | Unit Price | Decimal (e.g., 0.320) |
| `c_currency_id` | Currency | ISO codes: `USD`, `EUR`, `GBP`, `CNY` |
| `chuboe_date_code` | Date Code | e.g., "2024+", "06" |
| `chuboe_moq` | Minimum Order Quantity | Numeric |
| `chuboe_spq` | Standard Pack Quantity | Numeric |
| `chuboe_packaging_id` | Packaging type | `AMMO`, `BOX`, `BULK`, `CUT TAPE`, `F-REEL`, `F-TRAY`, `F-TUBE`, `OTHER`, `REEL`, `TRAY` |
| `chuboe_lead_time` | Lead Time | e.g., "Stock", "2-3 weeks" |
| `c_country_id` | Country of Origin | 2-letter ISO: `US`, `CN`, `TW`, `MY`, `JP` |
| `chuboe_rohs` | RoHS Compliant | `Y`, `N`, or empty |
| `chuboe_note_public` | Vendor Notes | Free text |

---

## Manual Fallback (When Parser Fails)

1. **Retrieve quote** from `vq@orangetsunami.com` inbox
2. **Identify supplier** from email sender/signature
3. **Look up supplier** in OT Business Partner window, note Search Key
4. **Open template**: `Trading Analysis/VQ Mass Upload Template.csv`
5. **Map fields** per table above
6. **Save as**: `VQ {RFQ#} {DATE}.csv`
7. **Upload** via OT VQ Mass Upload function

---

## Tips

- Currency must be ISO code (`USD`, not `$`)
- Packaging must match exactly from valid list
- COO must be 2-letter ISO country code
- Double-check MPN formatting (spaces, dashes, suffixes)

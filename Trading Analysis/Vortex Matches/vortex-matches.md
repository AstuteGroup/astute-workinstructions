# Vortex Matches

Inbox-driven automation that matches customer RFQs against VQs, market offers, and stock — and emails the result back to the requestor.

## How it works

1. **Anyone with an internal email** (`@astutegroup.com` or `@orangetsunami.com`) can email **`vortex@orangetsunami.com`** with an RFQ number in the subject or body. External senders are rejected with a notification to Jake.
2. Every 20 minutes, **`vortex-poller.js`** wakes up, connects to that inbox, and processes any UNSEEN messages.
3. For each message it:
   - Extracts the **RFQ number** (7-digit) from subject or body. Prefers `RFQ ####### ` patterns; falls back to any standalone 7-digit number.
   - Runs the match logic against `bi_market_offer_line_v` + `bi_vendor_quote_line_v`.
   - Sends a result email **from `vortex@orangetsunami.com`** with:
     - **Direct emails:** To = sender, Cc = Jake + any Cc from inbound
     - **Forwarded emails:** To = Jake, Cc = original sender + original Cc list
     - **Body:** HTML summary table (line counts per bucket)
     - **Attachments:** the xlsx files described below
   - Marks the source message Seen so it won't be reprocessed.
4. On any failure (RFQ not found, no number in subject/body, DB error) it emails **the sender + Jake** with the error and still marks Seen — so the broken message doesn't loop forever.

> **Forwarding mode:** If you forward an email to vortex@, the poller parses the inner From/Cc headers and includes internal recipients only. External addresses (customers, vendors) are filtered out — results never leave the company.
>
> **Domain restrictions:** Only `@astutegroup.com` and `@orangetsunami.com` addresses can send requests or receive results.

## Files

| File | Purpose |
|---|---|
| `vortex-matches.js` | Library + CLI. Exports `runVortexForRFQ(rfqNumber)` returning `{ summary, attachments[] }` in memory. CLI is for testing only — prints summary, sends nothing, writes nothing. |
| `vortex-poller.js` | Inbox poller. Run on a 20-minute schedule (cron / Claude scheduled trigger). |
| `Samples/` | Reference xlsx files from prior runs (kept for column-format reference only). |

> **No `output/` folder.** As of 2026-04-08 all results are emailed directly. Files are never written to disk.

## Output workbooks

Each run generates **Stock + No Prices**, plus either **Good Prices** or **All Prices** depending on whether customer targets exist. Workbooks are built in memory and attached to the result email.

| Filename | Contents | Generated when |
|---|---|---|
| `{RFQ}_Stock.xlsx` | Astute inventory matches (`offer_type LIKE 'Stock - *'`). Always separated because we control this inventory. Price left blank when $0. | Stock matches exist |
| `{RFQ}_Good Prices.xlsx` | Priced offers ≤ **20% above customer target**. `% Under Target` in column B for quick sorting. | Customer provided targets |
| `{RFQ}_All Prices.xlsx` | All priced offers as a general reference for buyers/sellers. | Customer did NOT provide targets |
| `{RFQ}_No Prices.xlsx` | Supply matches WITHOUT pricing — excess partners, franchise, brokers, occasional VQs. Buyer-pursuit leads. | No-price matches exist |

## Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Time window (VQs/MOs) | 90 days | Rolling from request date — fresh market data |
| Time window (Stock) | No limit | Astute stock always shows if active |
| Good Prices threshold | ≤20% above target | Filters offers more than 20% above customer target |
| Poll interval | 20 minutes | Set in scheduler (cron / Claude scheduled trigger) |

## Data processing

### RFQ line deduplication
RFQ lines with identical `MPN + Qty + Target + Customer Part Number` are deduped before matching. Prevents inflated output when source data has duplicate lines.

### MO Type column
- **Market Offers** → Shows offer type (Broker Stock Offer, Customer Excess, Stock - Austin Warehouse, etc.)
- **VQs** → Blank (MO Type = Market Offer Type, not applicable to verified quotes)

## Columns by file type

### Good Prices (20 columns)
```
RFQ Number, % Under Target, RFQ Created, RFQ Customer, RFQ MPN, RFQ Qty, RFQ Target,
Customer Part Number, Type, MO Type, Supplier MPN, Supplier/Excess Partner, Qty,
Supplier Price, lead_time, Date Code, Created Date, Days Btw MO/VQ & RFQ, % of Demand, Opp Amount
```

### All Prices (18 columns)
Same as Good Prices but without:
- `% Under Target` — no target to compare against
- `RFQ Target` — will be empty/0

### No Prices (17 columns)
Same as Good Prices but without:
- `% Under Target` — can't calculate without price
- `Supplier Price` — obviously no price
- `Opp Amount` — can't calculate without price

### Stock (18 columns)
Same as Good Prices but without:
- `Type` — always "MO" for stock

Special handling:
- `lead_time` defaults to **"STOCK"** if blank
- `Supplier Price` left blank when $0

## Data sources

- `bi_vendor_quote_line_v` — Vendor quotes (VQs)
- `bi_market_offer_line_v` — Market offers (excess, franchise, broker, stock)
- `chuboe_rfq` / `chuboe_rfq_line_mpn` — Customer RFQs with target prices

> **View definitions, underlying table structures, and join patterns:** See [`shared/data-model.md`](../../shared/data-model.md).

## Operating the poller

### Manual / testing
```bash
# Test the match logic against a known RFQ — no email sent, no files written
node vortex-matches.js 1130895

# Run the poller once against the live inbox (sends real email!)
node vortex-poller.js

# Same, but parse + run vortex without sending mail or marking Seen
node vortex-poller.js --dry-run

# Process a single message by UID
node vortex-poller.js --uid 42
```

### Scheduled (every 20 minutes)
The poller runs unattended via the user crontab on this box (same pattern as `inventory_cleanup.js` and `lam-kitting-runner.js`). To install:

```bash
crontab -l > /tmp/cron.bak
(crontab -l; echo '*/20 * * * * /usr/bin/node "/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Vortex Matches/vortex-poller.js" >> /tmp/vortex-poller.log 2>&1') | crontab -
crontab -l    # verify
```

To inspect / remove later: `crontab -l` and `crontab -e`. Logs are at `/tmp/vortex-poller.log`.

## Credentials

All WorkMail credentials live in **`~/workspace/.env`** (centralized). The poller reads:
- `WORKMAIL_PASS` — shared password across `vq`, `excess`, `stockrfq`, `vortex` mailboxes
- `IMAP_HOST` / `IMAP_PORT` / `SMTP_HOST` / `SMTP_PORT` — defaults are AWS WorkMail us-east-1

The shared module `shared/email-fetcher.js` exposes `vortex` as an account in its `ACCOUNT_MAP`.

## Status

**Implemented & tested** — refactored 2026-04-08 from manual `node vortex-matches.js <rfq>` (file output) to inbox-driven (email output).

**Blocked on:** `vortex@orangetsunami.com` mailbox provisioning in AWS WorkMail. Once provisioned with the shared OT password, no code changes needed — the poller will start working immediately.

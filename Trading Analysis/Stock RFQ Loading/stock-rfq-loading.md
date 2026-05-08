# Stock RFQ Loading Workflow

> **Architecture migration, 2026-05-08**: this workflow is migrating from the static `stock-rfq-runner` daemon (with the failed `claude -p` cron lineage) to the **agent pattern** defined in [`email-workflow-architecture.md`](../../email-workflow-architecture.md). The "Agent operating instructions" section below is the new contract. The legacy daemon will be deleted once the `/schedule` routine is verified.

Process customer + broker RFQ emails received at `stockRFQ@orangetsunami.com` into `chuboe_rfq` records (header + lines + line_mpn) in OT.

---

## Agent operating instructions (read first)

### Your goal

Your job is to **load each RFQ to OT under the correct customer BP**, capturing the demand signal even when the customer can't be cleanly resolved (fall back to Unqualified Broker). The decision tree below codifies the patterns we've seen most often, but the tree may have gaps and broker emails arrive in unpredictable shapes.

When the tree's prescribed steps don't fit:
- **Use judgment.** If a customer is named in the subject, body prose, or attachment filename — even when not in any `From:` line — try to resolve them by name before falling back to Unqualified Broker.
- **Don't let an incomplete tree override evidence in the email.** Steps below are descriptive, not exhaustive.
- **Unqualified Broker is the right fallback only when you've genuinely exhausted resolution.** It's a default for unclear senders, not the fallback for "the tree didn't have a step for what I'm seeing."
- **`needs_review` is a last resort.** Use it only when MPNs are ambiguous, write-back fails, or the body genuinely has no parseable signal.

### Before any escalation, sanity-check yourself

Before you fall back to Unqualified Broker or call `needs_review`, re-read the email and ask:
- Is the customer named in the **subject**? (e.g., `FW: <Company> RFQ`, `<Company> shortage list`)
- Is the customer named in the **body prose** outside the `From:` lines? (e.g., `Customer: <Company>`, `Quoting for <Company>`, `<Company> needs`)
- Is the customer named in an **attachment filename**? (e.g., `Microsemi_RFQ_2026-04.xlsx`)
- Did I dismiss **plain-prose line listings** (MPN + qty mentions in narrative) because they weren't a structured table?

If yes to any of these, try the obvious thing — `resolvePartner({ companyName: '<name>', partnerType: 'customer' })` or extract the prose lines — before settling for the fallback.

### CLI primitives

This is the contract the `/schedule` routine reads each tick. Per [`email-workflow-architecture.md`](../../email-workflow-architecture.md), the agent uses the four CLI primitives:

```
node shared/email-workflow-poller.js list                       --workflow stockrfq
node shared/email-workflow-poller.js read <uid>                 --workflow stockrfq
node shared/email-workflow-poller.js download-attachments <uid> --workflow stockrfq
node shared/email-workflow-poller.js route <uid> <action> --workflow stockrfq --payload <json|file>
```

### Per-message decision tree

For each unseen message, the agent picks **one** routing action. Order of checks:

1. **Not an RFQ** → `not_rfq`
   - Subject is a PO / order confirmation / shipping notification (`PO 12345`, `COV12345`, `SO12345`, `tracking`, `shipped`, `invoice`, `payment`, `remittance`)
   - Subject is a follow-up (`following up`, `checking in`)
   - Subject is OOO / auto-reply / undeliverable / bounce / read-receipt / newsletter / unsubscribe
   - Subject is news/marketing (no MPNs in body, just headlines or promo language)
   - Body has zero extractable MPN+qty pairs

2. **Customer resolution** — try in order, first match wins. Use `shared/partner-lookup.js` `resolvePartner({email, companyName, partnerType: 'customer'})` (the `'customer'` filter + the IsEmployee filter inside the resolver are the fix for the 2026-05-07 wrong-BP incident — do not weaken).
   - **Direct send:** outer From is not `@astutegroup.com` → use that address as the lookup key.
   - **Forwarded send (`FW:` / `Fwd:`):** parse `From:` lines in the body. Walk all of them and pick the first **non-`@astutegroup.com`** sender (skip employees who forwarded the email to us). For NetComponents-style envelopes (`From: Real Sender [real@addr] <messagesend@netcomponents.com>`), use the bracketed address.
   - **Match found** → use `result.c_bpartner_id` (integer) as `bpartnerId`. Record `result.name` for the description if helpful.
   - **No match** → fall back to **Unqualified Broker** (`bpartnerId: 1006505`, search key `1008499`). Capture the customer name + email and pass them as `customerName` in the payload — the handler prepends them to each line's description so the broker is discoverable in OT. **This is the default behavior, not an error.** Every RFQ with a part number is signal worth capturing.

3. **Line extraction:**
   - Run `download-attachments` if `has_attachment` is true. xlsx > csv > pdf preferred.
   - For xlsx/csv: walk the first ~10 header rows looking for an MPN column. Header synonyms: mpn / part number / mfr part / aml / p/n. Other columns: qty, mfr, cpc, target price, date code, notes.
   - If no attachment yields lines, parse the body. Inline MPN+qty tables, prose lists ("we need 5k of X, 2k of Y"), NetComponents-formatted RFQ blocks all count.
   - Quantity normalization: strip `pcs`/`ea`/`units`; expand `5k` → `5000`. If a line has an MPN but no quantity, set qty = 0 (still load it as demand signal).
   - **Filter junk MPNs:** reject lines whose "MPN" cell is a URL fragment (`<HTTPS://...>`, `^WWW.`, anchor-tag fragments).
   - If 0 valid lines → `needs_review` with reason `"no parseable lines"`.

4. **MFR resolution (per line):** Use `shared/mfr-lookup.js` `lookupMfr(mfrText)` to get canonical name + chuboe_mfr_id. If unresolved, leave both blank — the server will accept and the MFR Reconciler cron will fill the FK overnight.

5. **Write to OT** → `load_rfq` with payload `{ bpartnerId, type: 'Stock', lines, customerName? }`. The handler calls `writeRFQ()` which writes the header, lines, and `chuboe_rfq_line_mpn` AVL sub-rows.

### Routing actions (full payload reference)

| Action | Required payload | Folder | Side effect |
|---|---|---|---|
| `load_rfq` | `{ bpartnerId, lines[] }` (also `type, description, salesrepId, userId, sourceUid, customerName`) | `Processed` | `writeRFQ()` to OT + `loaded` breadcrumb |
| `needs_review` | `{ reason }` (also `subject, outerFrom, details`) | `NeedsReview` | Email Jake diagnostics + `needs-review` breadcrumb |
| `not_rfq` | `{ reason }` | `NotRFQ` | Silent move + `not-rfq` breadcrumb |

### Line shape for `load_rfq.lines[]`

```json
{
  "mpn": "ADS7953SDBT",       // required
  "qty": 5000,                 // required (use 0 if not stated)
  "mfrText": "Texas Instruments",  // optional, canonical name from lookupMfr
  "mfrId": 1000123,                // optional, FK from lookupMfr
  "targetPrice": 2.45,             // optional
  "dateCode": null,                // optional
  "cpc": "ADS7953SDBT"             // optional; default to MPN if no distinct customer code
}
```

### Constants

- **Unqualified Broker fallback:** `bpartnerId: 1006505` (search_key `1008499`)
- **Default salesrep / userId:** `1000004` (Jake)
- **Default RFQ type:** `'Stock'`

These live in `shared/workflow-actions/stockrfq.js` `module.exports.constants` and should not be hardcoded by the agent — pull from the module if scripting around it.

### Schedule

The expected pattern is a **`/schedule` routine** that runs every 30 minutes. Recommended prompt for the routine:

```
Process all unseen messages in the stockRFQ@orangetsunami.com inbox.

1. Read Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md section
   "Agent operating instructions" before starting (the .md is the source of
   truth — do not work from prior-session memory).
2. Run `node shared/email-workflow-poller.js list --workflow stockrfq` to
   see unseen envelopes.
3. For each envelope, follow the per-message decision tree in section
   "Per-message decision tree" and dispatch via `route` with the right
   action + payload.
4. Default to falling back to Unqualified Broker (bpartnerId 1006505) when
   a customer can't be confidently resolved — this is correct behavior, not
   an error. Use needs_review only for true ambiguity (e.g., MPNs present
   but unparseable) or write-back failure.
5. If any single message hits a transient error, log it and continue with
   the next message. Do not abort the batch. Email Jake a one-line summary
   at the end if any errored.
6. If the inbox has 0 unseen messages, exit silently.
```

On-demand invocation (operator asks "process stockrfq inbox") works identically — the agent should follow the same per-message decision tree.

### Key shared modules (tools the agent calls in-session)

- `shared/partner-lookup.js` — `resolvePartner({email, companyName, partnerType: 'customer'})`. The IsEmployee filter is built in (committed 2026-05-07 — do not bypass).
- `shared/mfr-lookup.js` — `lookupMfr(mfrText)` returns `{ canonical, id }`.
- `shared/data-model.md` — schema reference for `chuboe_rfq` chain. Read before constructing the `lines[]` payload.
- `shared/api-writeback.md` § RFQ — REST payload structure for `writeRFQ` (the handler does this; the agent supplies the line shape).

---

## Why we process everything

Every RFQ with a part number represents **activity around that part** — someone in the market wants it. Even broker blasts get loaded under Unqualified Broker (1006505) so the trading team has visibility into demand. **Not in the system ≠ junk.** The trading team decides whether to quote — that's a business decision, not a data-capture decision. Our job is to make sure the part activity is recorded.

The only true skip is emails with zero extractable part data (orders, shipping notifications, marketing, newsletters, follow-ups).

---

## Skip / Flag Rules (summary)

| Condition | Action |
|---|---|
| Any email with MPN + quantity | **`load_rfq`** — even broker blasts. Use `bpartnerId: 1006505` (Unqualified Broker) if customer not in DB |
| Order / shipping / follow-up / newsletter / OOO | **`not_rfq`** |
| MPNs present but ambiguous (no qty, signature-only, write-back failed) | **`needs_review`** |

---

## Cadence

Every 30 minutes via `/schedule`. Steady inflow, not high volume — most ticks process 0–5 emails. The agent can also be invoked on demand when the operator asks ("process stockrfq inbox now").

---

## Future: tighter customer matching

The current fall-back-to-Unqualified-Broker behavior is permissive by design. If we want a tighter conversation with the trading team about ambiguous senders, the agent can add a `needs_partner` action (mirroring customer-excess) — but the daemon never had this, so we're holding it out until a real ambiguity case demands it.

---

## Related

- [Customer Excess Analysis](../Customer%20Excess%20Analysis/customer-excess-analysis.md) — sister workflow on the same agent pattern
- [Email-Driven Workflow Architecture](../../email-workflow-architecture.md) — top-level pattern doc
- MFR Aliases: `../Customer Excess Analysis/Market Offer Loading/mfr-aliases.json` (shared)

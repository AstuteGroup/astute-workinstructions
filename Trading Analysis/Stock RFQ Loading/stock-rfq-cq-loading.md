# Stock RFQ CQ Loading Workflow (`stockrfq-cq-agent`)

> **Status:** Spec / not yet built. Sister workflow to `stock-rfq-loading.md`. Both run against `stockRFQ@orangetsunami.com`; this one consumes the `OutboundPending` folder created by the 2026-05-11 hot-patch.

Process operator outbound replies (quotes / follow-up questions to brokers) into `chuboe_cq_line` rows attached to the originating RFQ in OT.

---

## Why this exists

Every message reaching `stockRFQ@` arrives via the `rfq@astutegroup.com` auto-forward rule. That same rule forwards **both** broker-sent RFQs **and** operator replies (when an operator CC's `rfq@`). The `stockrfq-agent` now routes operator replies to `OutboundPending` (per the 2026-05-11 patch); this workflow consumes that folder and writes the corresponding CQ rows.

Closes the loop:
- **inbound** (broker → us, processed by `stockrfq-agent`) → `chuboe_rfq` row
- **outbound** (us → broker, processed by `stockrfq-cq-agent`) → `chuboe_cq_line` row attached to the same RFQ

---

## Agent operating instructions

### Your goal

For each unseen message in `OutboundPending`:
1. Parse one or more quote lines (MPN + qty + price [+ LT, date code, packaging notes]).
2. Match each line to the originating `chuboe_rfq_line` in OT.
3. Write one `chuboe_cq_line` per quoted line via `shared/cq-writer.js`.
4. Be idempotent — multiple operator follow-ups on the same thread (revised price, additional info) must NOT produce duplicate CQ rows.

### Idempotency contract

**Dedup key:** `(chuboe_rfq_line_id, chuboe_mpn_clean, priceentered, qty)`.

`shared/cq-writer.js` already passes `naturalKeyFields: ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN', 'C_BPartner_ID', 'PriceEntered']` to `apiPost`, so re-running the same write is a no-op at the writer level. The agent must still:
- Read existing CQs on the resolved RFQ line BEFORE writing, to avoid asking the writer to "create" a row that the agent already wrote in a prior tick.
- If a CQ already exists with the same `(mpn, qty, price)` → log "already-written" and skip; do NOT write a second.
- If a CQ exists with the same `(mpn, qty)` but a DIFFERENT price (revised quote scenario) → flag for review (do not auto-supersede; the operator may want to see both bids, or the new quote may be a typo).

### CLI primitives

Same shape as the inbound workflow — `shared/email-workflow-poller.js` handles all four primitives:

```
node shared/email-workflow-poller.js list                       --workflow stockrfq-cq
node shared/email-workflow-poller.js read <uid>                 --workflow stockrfq-cq
node shared/email-workflow-poller.js download-attachments <uid> --workflow stockrfq-cq
node shared/email-workflow-poller.js route <uid> <action> --workflow stockrfq-cq --payload <json|file>
```

The workflow module (`shared/workflow-actions/stockrfq-cq.js`) tells the poller to read from `OutboundPending` instead of `INBOX`.

### Per-message decision tree

For each unseen message in `OutboundPending`, the agent picks **one** routing action. Order of checks:

1. **No parseable quote content** → `skip`
   - Body contains no MPN, OR no `$`/`USD`/price indicator, OR is an inquiry-only message ("what's your target price?", "do you have stock?", "please advise") with no operator quote.
   - Move to `CQ-Skipped` folder. Log breadcrumb. No further action.

2. **Quote content present** → extract per-line `{ mpn, qty, price, dateCode, leadTime, packaging, notes }`.
   - Parse the operator's reply body (the inner-most `From: <operator>` quoted block) for inline MPN+price tables, prose ("we have 50,505 in PH at $0.077 each"), or attached xlsx/pdf quote forms.
   - Quantity normalization: same as inbound — strip `pcs`/`ea`, expand `5k` → `5000`, etc.
   - **Skip the original broker RFQ content** further down in the quoted chain — that's the inbound side's job, not ours.

3. **Thread-match to source RFQ.** Priority order:
   - **(a) `In-Reply-To` / `References` header → breadcrumb lookup.** If the auto-forward preserves these headers (verify in smoke test), look up the original message UID in `shared/data/breadcrumbs/stockrfq-agent.ndjson` (or `.offer-pipeline/breadcrumbs.jsonl`) → `chuboe_rfq_id`. Fastest, most reliable when it works.
   - **(b) Quoted-subject text match.** The body's deepest quoted block contains the original RFQ subject (e.g., `Subject: PMV450ENEAR 50505 pcs` from `bruce@aismartho.com`). Search `chuboe_rfq.description` or `chuboe_rfq_line.description` for a match against that subject string, restricted to recent (`created >= now() - 7 days`) and MPN matching.
   - **(c) MPN + qty + customer-domain fuzzy.** Last resort: pull the original sender's email domain (from the deepest quoted `From:` line, the broker's address), resolve to a `c_bpartner_id`, and find recent RFQs (`created >= now() - 30 days`) with matching MPN + qty under that BP.
   - **(d) MPN + qty + recent window.** If no customer can be resolved, find recent active RFQs with matching MPN + qty across all customers; if exactly one, use it. If multiple, → `needs_review`.

4. **Price-fishing flag inheritance (match-found case only).** Query the matched RFQ's description for the `[PRICE CHECK?]` tag (set at inbound load time by `shared/price-check-heuristic.js`). If present, set `priceCheck: true` on the `add_cq` payload — the handler prepends a one-line `notePrivate` to each CQ row so the trader sees the inherited context. **The CQ agent does NOT re-run the heuristic** — the flag is computed once at RFQ creation; the CQ side is read-only on this.

5. **Dispatch action based on match result:**
   - **Match found** → `add_cq` with `{ rfqSearchKey, lines[], priceCheck? }`.
   - **No match AND quote has full content (mpn+qty+price+LT)** → `add_cq_with_rfq` with `{ bpartnerId (resolved or Unqualified Broker), lines[], originalSenderEmail, originalCompanyName }`. Writes the RFQ via `writeRFQ()` first (so the demand signal isn't lost — this captures the case where the inbound RFQ never came through), then the CQ via `writeCQ()` against the just-written RFQ.
   - **Match ambiguous (2+ candidate RFQs)** → `needs_review` with the candidate list.
   - **Match found BUT existing CQ already covers (mpn, qty, price)** → `skip` with reason `already-written: cq <id>`.
   - **Match found BUT existing CQ has same (mpn, qty) at a DIFFERENT price** → `needs_review` — operator may have revised the quote; do not auto-supersede.

### Routing actions

| Action | Required payload | Folder | Side effect |
|---|---|---|---|
| `add_cq` | `{ rfqSearchKey, lines[] }` (also `bpartnerId` if RFQ header BP needs override) | `CQ-Processed` | `writeCQ()` / `writeCQBatch()` to OT + `cq-loaded` breadcrumb |
| `add_cq_with_rfq` | `{ bpartnerId, lines[], originalSenderEmail?, originalCompanyName? }` | `CQ-Processed` | `writeRFQ()` then `writeCQ()` against the new RFQ + `cq-loaded-with-rfq` breadcrumb |
| `skip` | `{ reason }` | `CQ-Skipped` | Silent move + `cq-skip` breadcrumb |
| `needs_review` | `{ reason }` (also `subject, candidates?, details?`) | `CQ-NeedsReview` | Email Jake diagnostics + `cq-needs-review` breadcrumb |

### Line shape for `add_cq.lines[]`

```json
{
  "mpn": "PMV450ENEAR",       // required
  "qty": 50505,                // required (must be > 0; if operator quoted ambiguous qty, → needs_review)
  "price": 0.077,              // required (the operator's quoted resale, USD)
  "leadTime": "STOCK",         // required — STOCK / a week / 14 days / etc. cq-writer rejects missing leadTime
  "mfrText": "NEXPERIA",       // optional
  "dateCode": "24+",           // optional
  "packaging": "Reel",         // optional
  "rohs": "Y",                 // optional
  "coo": "PH",                 // optional (operator phrasing — "Philippines" → "PH" / cq-writer normalizes)
  "notePublic": "Phil stock",  // optional
  "cpc": "PMV450ENEAR"         // optional; default to MPN if no distinct customer code
}
```

Mandatory fields per `shared/cq-writer.js` `MANDATORY_FIELDS`: `mpn, mfrText, qty, resale, leadTime`. **Note:** the writer uses `resale` (not `price`) — the workflow handler should rename `price → resale` before calling `writeCQ()`. Or change cq-writer's contract; either way the agent's payload above uses the more natural `price` and the handler maps it.

### Constants

- **Inbox:** `stockRFQ@orangetsunami.com` (same as inbound)
- **Folder:** `OutboundPending` (created 2026-05-11)
- **Folders the handler creates if missing:** `CQ-Processed`, `CQ-Skipped`, `CQ-NeedsReview`
- **Default salesrep / userId:** `1000004` (Jake)
- **Default currency:** USD (100)
- **Unqualified Broker fallback:** `1006505` (only used by `add_cq_with_rfq`; never the customer on a `add_cq` where the source RFQ already exists)

### Schedule

The expected pattern is a **`/schedule` routine** that runs every 30 minutes, **offset from `stockrfq-agent` to prevent same-tick contention** on the IMAP connection. Recommended cron: `*/30 * * * *` at `:15` and `:45` (vs `:00` and `:30` for the inbound agent).

Alternative (per the 2026-05-11 deferred-work entry, option a): **single combined agent prompt** that runs inbound stockrfq first, then outbound CQ matching in one tick. Defer until both halves are individually stable; revisit when same-cycle contention becomes a real problem.

### Key shared modules

- `shared/cq-writer.js` — `writeCQ(rfqSearchKey, line)` / `writeCQBatch(rfqSearchKey, lines[])`. Already exists; resolves RFQ → line via CPC → MPN → clean-MPN.
- `shared/rfq-writer.js` — `writeRFQ()` for the `add_cq_with_rfq` path.
- `shared/partner-lookup.js` — `resolvePartner({ email, companyName, partnerType: 'customer' })`. Used to resolve the broker domain in the quoted block to a `c_bpartner_id` for the `add_cq_with_rfq` fallback.
- `shared/mfr-lookup.js` — `lookupMfr(mfrText)` for MFR resolution; cq-writer already calls this internally.
- `shared/email-workflow-poller.js` — same CLI primitives as inbound.
- `shared/breadcrumbs.js` — `write()` for event logging.

---

## Open questions / pre-build smoke tests

1. **Does `In-Reply-To` / `References` survive the auto-forward?** Hot path (a) in thread-matching depends on this. Test: read the full RFC822 source of UID 1739 (currently in `OutboundPending`, the PMV450ENEAR Edgar reply) and check for these headers. If absent, drop path (a) and rely on (b)–(d).
2. **Are there cases where the quoted-block subject is malformed / missing?** Specifically, very deep reply chains (Re: Re: Re: ...) or attachment-only quotes may not have a clean parseable subject. Need to walk through ~10 real `OutboundPending` samples before locking the parser.
3. **Multi-MPN replies:** does Edgar ever quote multiple parts in a single email? If yes, parse line-by-line. If no, simplify to single-line-per-message.
4. **Quote format variation by operator:** Edgar's pattern is `"<qty> pcs in <warehouse>. <price> USD each."` — is this uniform across the team (Ben Thompson, etc.) or does each operator have a different style? Sample 10 outbound replies from each known operator address before locking the parser.
5. **What about "we don't have stock" replies?** Inquiry-only or "no stock" responses have no quote content but ARE legitimate operator activity. Currently the spec routes them to `CQ-Skipped`; should we instead write a CQ with `R_Status_ID = no-stock-resolution` to record the loss? Tradeoff: more data vs noise.

---

## Future considerations

- **Combined inbound+outbound agent** (deferred-work option a): once both sides are stable, evaluate merging into one agent that processes `INBOX` then `OutboundPending` in priority order each tick. Eliminates cron coordination, simpler operator mental model.
- **Same-cycle handoff:** when a broker RFQ + operator reply land in the same 30-min window, the inbound agent must process first so the outbound agent has an RFQ to match against. With separate offset crons (`:00` inbound, `:15` outbound), this is naturally satisfied for most cases. Edge: operator replies within 15 min of original RFQ arrival → may need a `defer-and-retry` path (leave message unread for one more tick).
- **Reverse linkage:** after writing a CQ via this workflow, the source RFQ could be flagged in OT to indicate "we have an active quote out" — informs the operator UI. Out of scope for v1.

---

## Related

- [Stock RFQ Loading (inbound sibling)](./stock-rfq-loading.md) — same inbox, INBOX folder, `stockrfq-agent` cog
- [Email-Driven Workflow Architecture](../../email-workflow-architecture.md) — top-level pattern doc
- [CQ Writer module](../../shared/cq-writer.js) — `writeCQ` / `writeCQBatch` API
- Deferred-work entry: `~/workspace/deferred-work.md` § "Outbound stock-RFQ quotes → CQs in OT" (2026-05-11)

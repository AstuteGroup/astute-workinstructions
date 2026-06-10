# Broker/Franchise Market Offer Loading Workflow

> **Created:** 2026-06-10. **Status:** PLANNED (awaiting inbox setup)

**Purpose:** Load market offers from external brokers and franchise distributors into OT. These are NOT customer excess — they are offers from external suppliers (brokers, franchises) that we may want to purchase from or use for market intelligence.

---

## Architecture

This workflow follows the **agent pattern** defined in [`email-workflow-architecture.md`](../../email-workflow-architecture.md). It mirrors the [Customer Excess workflow](../Customer%20Excess%20Analysis/customer-excess-analysis.md) structure with key differences:

| Aspect | Customer Excess | Broker Offers |
|--------|-----------------|---------------|
| Source | Customers selling their excess | External brokers/franchises offering stock |
| Offer Types | 1000000 (Customer Excess), 1000003 (Customer Lead Time Buy) | 1000001 (Broker Stock), 1000002 (Franchise Offers), 1000004 (Franchise Stock) |
| Downstream Analysis | Yes (intent classification, scoring, reactive/spec-buy routing) | **No** — data capture only |
| Large Offer Gate | Yes (500+ lines pauses for approval) | **No** — no analysis to gate |
| Notifications | Internal only | **Internal only** — never notify external senders |

---

## Agent Operating Instructions

### Your Goal

**Load each broker/franchise offer to OT under the correct BP, with the correct offer type.** The decision tree below is the recommended order. When the tree doesn't fit, use judgment before escalating.

### CLI Primitives

```
node shared/email-workflow-poller.js list                     --workflow broker-offers
node shared/email-workflow-poller.js read <uid>               --workflow broker-offers
node shared/email-workflow-poller.js download-attachments <uid> --workflow broker-offers
node shared/email-workflow-poller.js route <uid> <action> --workflow broker-offers --payload <json|file>
```

### Per-Message Decision Tree

For each unseen message, decide **one** routing action. Order of checks:

#### 1. Junk / automation noise → `not_offer`
- Subject matches OOO / auto-reply / undeliverable / bounce / read-receipt / newsletter
- Body contains SMTP bounce headers (`Reporting-MTA:`, `Final-Recipient:`, `Diagnostic-Code:`)
- Effectively empty body AND no parseable attachment

#### 2. Partner Resolution — try in order, first match wins:
- **Subject hint** (highest priority): `MO_<NNNNN>`, `Search Key <NNNNN>`, `[#<NNNNN>]` → use that BP search key directly
- **Body hint:** `BP: <NNNNN>`, `Partner: <NNNNN>`, `Vendor: <NNNNN>`
- **Forward chain:** parse all `From:` lines in the body; prefer the deepest sender whose email is NOT `@astutegroup.com`. Resolve via `partner-lookup.js` 4-tier resolver (exact email → email domain → domain hint → name match). All tiers exclude `IsEmployee='Y'` BPs.
- **External direct send:** outer From is not `@astutegroup.com` → resolve via partner-lookup directly.
- **Company-name fallback:** scan subject and body for a clearly-named company and call `resolvePartner({ companyName: '<name>', partnerType: 'vendor' })`.
- If still no match → `needs_partner` or `clarify_partner` (if lines extracted)

#### 3. Line Extraction — try in order:
- Run `download-attachments` if `has_attachment` is true. Prefer xlsx > csv > pdf.
- For xlsx/csv: walk first ~10 header rows looking for an MPN column. Header synonyms: mpn / part number / mfr part / aml / p/n. Other columns: qty, price, mfr, dateCode, description, cpc.
- For pdf: use Read tool; extract tabular content if confidence is high.
- If no attachment yields lines, try HTML body (Outlook inline tables) and plaintext body (tab/pipe-delimited).
- **Plain-prose lists** count too — bodies with qty/mfr/mpn on consecutive lines are valid offers.
- **Filter junk MPNs:** reject lines whose "MPN" cell is a URL fragment, footer/signature noise.
- If 0 valid lines → `needs_review` with payload `{ reason: "no parseable lines", ... }`

#### 4. Offer Type Determination

Agent determines type based on sender/content signals:

| Signal | → Offer Type |
|--------|-------------|
| Body hint `Type: Broker` | **Broker Stock Offer** (1000001) |
| Body hint `Type: Franchise` or `Type: Franchise Offers` | **Franchise Offers** (1000002) |
| Body hint `Type: Franchise Stock` | **Franchise Stock Offers** (1000004) |
| Sender domain matches known franchise distributor (Arrow, Avnet, Digi-Key, Mouser, Future, etc.) | **Franchise Offers** (1000002) or **Franchise Stock** (1000004) |
| Subject/body contains "liquidation", "excess", "lot", "closeout" | **Broker Stock Offer** (1000001) |
| Subject/body contains "franchise", "authorized", "stock offer" | **Franchise Stock Offers** (1000004) |
| Default unknown broker | **Broker Stock Offer** (1000001) |

#### 5. Cross-Forward Dedup Check (preempts write):
```sql
SELECT value, chuboe_offer_id FROM adempiere.chuboe_offer
WHERE isactive='Y'
  AND c_bpartner_id = <resolved BP>
  AND chuboe_offer_type_id = <resolved type>
  AND created >= NOW() - INTERVAL '6 hours'
  AND (count active lines on this offer) = <extracted line count>
  AND EXISTS (line with chuboe_mpn = <sorted first MPN>)
  AND EXISTS (line with chuboe_mpn = <sorted last MPN>)
LIMIT 1
```
If matched → `dup_skip` with payload `{ existingSearchKey: <prior offer search key> }`

#### 6. Write to OT → `load_offer`
Payload: `{ bpartnerId, offerType, lines, partnerName, originalSender, originalCc, originalSubject }`

The handler calls `writeOffer()` and sends confirmation to **internal Astute parties only**.

---

## Routing Actions

| Action | Required Payload | Folder | Side Effect |
|--------|------------------|--------|-------------|
| `load_offer` | `{ bpartnerId, offerType, lines[] }` | `Processed` | `writeOffer()` to OT + confirmation to internal parties |
| `needs_partner` | `{ subject, outerFrom, hints }` | `NeedsPartner` | Email Jake with PARTNER reply prompt |
| `clarify_partner` | `{ subject, extracted, hints }` | `NeedInfo` | Email Jake; sidecar persists extraction; `keepsPending: true` |
| `needs_review` | `{ reason, subject, outerFrom }` | `NeedsReview` | Email Jake diagnostics |
| `not_offer` | `{ reason }` | `NotOffer` | Silent move + breadcrumb |
| `dup_skip` | `{ existingSearchKey }` | `Processed` | Silent move + breadcrumb |
| `drop_pending` | `{ reason }` | `NotOffer` | Operator discarded pending escalation |

---

## Offer Types Reference

| ID | Name | When to Use |
|----|------|-------------|
| 1000001 | Broker Stock Offer | Default for unknown brokers, liquidations, broker excess |
| 1000002 | Franchise Offers | Distributor excess, authorized distributor stock |
| 1000004 | Franchise Stock Offers | Franchise inventory listings, authorized stock offers |

---

## Notification Policy

**CRITICAL:** All notifications go to Jake Harris (`jake.harris@Astutegroup.com`) and any internal Astute CC'd parties. **NEVER send notifications to external brokers/franchises.**

- `clarify_partner` → emails Jake only (Reply-To: `brokeroffers@` for sidecar round-trip)
- `needs_partner` → emails Jake only
- `needs_review` → emails Jake only
- `load_offer` confirmation → emails internal forwarder + internal CCs + Jake; **excludes external sender**

---

## Schedule

**Cadence:** Every 30 minutes (once inbox is set up and cron is installed)

**Recommended routine prompt:**
```
Process all unseen messages in the brokeroffers@orangetsunami.com inbox.

1. Read Trading Analysis/Broker Offers/broker-offers.md section "Agent Operating
   Instructions" before starting (the .md is the source of truth).
2. Run `node shared/email-workflow-poller.js list --workflow broker-offers`
3. For each envelope, follow the per-message decision tree and dispatch via
   `route` with the right action + payload.
4. If any single message hits a transient error, log and continue with the
   next message. Email Jake a summary if any errored.
5. If 0 unseen messages, exit silently.
```

---

## Key Shared Modules

- `shared/partner-lookup.js` — `resolvePartner({email, companyName, partnerType})` for vendor matching
- `shared/data-model.md` — schema reference for `chuboe_offer` chain
- `shared/offer-writeback.js` — `writeOffer()` for OT writes

---

## Setup Checklist

- [ ] **Inbox created:** `brokeroffers@orangetsunami.com`
- [ ] **IMAP folders created:** `Processed`, `NeedsPartner`, `NeedInfo`, `NeedsReview`, `NotOffer`
- [ ] **Cron entry installed:** `broker-offers-agent` in `cron-jobs.js`
- [ ] **Registry updated:** `broker-offers` entry in `shared/workflow-registry.js`
- [ ] **CLAUDE.md updated:** Add workflow to Available Workflows list

---

## Related

- [Customer Excess Analysis](../Customer%20Excess%20Analysis/customer-excess-analysis.md) — sister workflow for customer-side offers
- [`email-workflow-architecture.md`](../../email-workflow-architecture.md) — pattern definition
- [`shared/workflow-actions/broker-offers.js`](../../shared/workflow-actions/broker-offers.js) — handler module

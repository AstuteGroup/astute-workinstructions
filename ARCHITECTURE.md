# Architecture: Workflows, Cogs & Intersections

How workflows connect to shared modules ("cogs") and each other. **Read this before building anything new.**

---

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INBOUND EMAIL PIPELINES                       │
│                   (same pattern, different direction)                 │
│                                                                      │
│   ┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐   │
│   │  VQ Loading   │   │ Market Offer     │   │ Stock RFQ        │   │
│   │  (supplier    │   │ Uploading        │   │ Loading          │   │
│   │   quotes)     │   │ (excess inv)     │   │ (customer RFQs)  │   │
│   └──────┬───────┘   └───────┬──────────┘   └───────┬──────────┘   │
│          │                   │                       │              │
│          └───────────────────┼───────────────────────┘              │
│                              │                                      │
│                    SHARED OPERATIONS:                                │
│                    • Email fetch (Himalaya)                          │
│                    • Read & categorize                               │
│                    • Extract line items                              │
│                    • Partner matching ──→ partner-lookup.js          │
│                    • MFR matching ─────→ mfr-lookup.js              │
│                    • CSV generation ───→ csv-utils.js               │
│                    • Email routing (move to folders)                 │
│                    • Notification (send to Jake)                     │
│                    • Commit & push                                   │
│                                                                      │
│          ONLY DIFFERENCE: template format + data direction           │
│          (VQ template vs Offer template vs RFQ template)             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                  Data flows INTO the system
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SYSTEM (iDempiere DB)                         │
│                                                                      │
│   RFQs ──── VQs ──── CQs ──── SOs ──── Market Offers ──── Stock    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                  Data flows OUT for analysis
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MARKET INTELLIGENCE                             │
│              (same data sources, different lens)                      │
│                                                                      │
│   ┌──────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│   │  Suggested   │  │  Quick   │  │  Vortex  │  │ Market Offer │  │
│   │  Resale      │  │  Quote   │  │  Matches │  │ Analysis     │  │
│   └──────┬───────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│          │               │              │               │          │
│          └───────────────┼──────────────┼───────────────┘          │
│                          │              │                          │
│                 SHARED OPERATIONS:                                  │
│                 • VQ history ──────────→ market-data.js             │
│                 • Sales history ───────→ market-data.js             │
│                 • Market offers ───────→ market-data.js             │
│                 • RFQ demand ──────────→ market-data.js             │
│                 • Franchise pricing ───→ franchise-api.js           │
│                 • MPN matching ────────→ market-data.js             │
│                                                                      │
│          ONLY DIFFERENCE: pricing logic + output format              │
│          (resale vs quote vs match ranking)                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SCREENING / SOURCING                             │
│                                                                      │
│   ┌──────────────────┐          ┌──────────────────┐               │
│   │ Franchise        │ ────────→│ RFQ Sourcing     │               │
│   │ Screening        │ skip/    │ (NetComponents)  │               │
│   │                  │ proceed  │                  │               │
│   └──────┬───────────┘          └──────────────────┘               │
│          │                                                          │
│          └──→ franchise-api.js (7 distributor APIs)                 │
│                                                                      │
│   Screening feeds INTO sourcing (skip low-value parts)              │
│   Sourcing generates VQs that feed BACK into VQ Loading             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Operation × Workflow Matrix

Each row is an operation. Each column is a workflow. ✓ = uses it. **Bold** = cog exists.

| Operation | VQ Loading | Mkt Offer Upload | Stock RFQ | Suggested Resale | Quick Quote | Vortex | Mkt Offer Analysis | Franchise Screen | Inventory Cleanup |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Email fetch** (Himalaya) | ✓ | ✓ | ✓ | | | | | | |
| Email read & categorize | ✓ | ✓ | ✓ | | | | | | |
| Extract line items | ✓ | ✓ | ✓ | | | | | | |
| Two-agent validation | ✓ | | ✓ | | | | | | |
| **Partner matching** | ✓ | ✓ | ✓ | | | | | | |
| **MFR matching** | ✓ | ✓ | ✓ | | | | | | |
| **MPN cleaning/matching** | | | | ✓ | ✓ | ✓ | ✓ | | |
| **Franchise API check** | | | ✓ | ✓ | (planned) | | | ✓ | |
| **VQ history query** | | | | ✓ | ✓ | ✓ | | | |
| **Sales history query** | | | | ✓ | ✓ | | | | |
| **Market offer query** | | | | ✓ | | ✓ | ✓ | | |
| **RFQ demand query** | | | | ✓ | | ✓ | ✓ | | |
| Price synthesis | | | | ✓ | ✓ | | | | |
| Match + rank | | | | | | ✓ | ✓ | | |
| Screening decision | | | | | | | | ✓ | |
| **CSV generation** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **VQ capture** (API → VQ file) | | | ✓ | ✓ | | | | ✓ | |
| Email move/route | ✓ | ✓ | ✓ | | | | | | |
| Email notification | ✓ | ✓ | ✓ | | | | | | |
| **Commit & push** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |

---

## Current Cogs vs. Gaps

### Exists (5 cogs)

| Cog | File | Consumers |
|-----|------|-----------|
| **franchise-api** | `shared/franchise-api.js` | Stock RFQ, Suggested Resale, Franchise Screen, (Quick Quote planned) |
| **market-data** | `shared/market-data.js` | Suggested Resale, (Quick Quote, Vortex, Mkt Offer Analysis planned) |
| **mfr-lookup** | `shared/mfr-lookup.js` | VQ Loading, Mkt Offer Upload, Stock RFQ |
| **partner-lookup** | `shared/partner-lookup.js` | VQ Loading, Mkt Offer Upload, Stock RFQ |
| **csv-utils** | `shared/csv-utils.js` | All workflows |

### Gaps (operations repeated across workflows but NOT shared yet)

| Gap | Where It's Duplicated | Potential Cog |
|-----|-----------------------|---------------|
| **Email ingestion** | VQ Loading (vq-parser), Market Offer (extract-market-offers.js), Stock RFQ (manual) all do: Himalaya fetch → read → categorize → extract → route | `shared/email-processor.js` — generic email pipeline: fetch, read, categorize, extract structured data, route |
| **Email notification** | Market Offer has `send-offer-email.js`, Stock RFQ needs one, VQ Loading needs one | `shared/send-notification.js` — send file to recipient with standard subject/body |
| **Line item extraction** | Each workflow extracts MPN + Qty + Price + MFR from different email formats. Core parsing logic is similar. | Could share extraction patterns/helpers, but email formats vary enough that full sharing is hard |
| **Commit & push** | Every workflow does `git add → commit → push` at the end | `shared/git-utils.js` — `commitAndPush(files, message)` |
| **VQ capture from APIs** | franchise-api.js produces VQ lines, but the actual VQ Mass Upload Template formatting isn't shared | `shared/vq-template.js` — format any VQ data (API, extraction) into VQ Mass Upload Template |
| **Price synthesis** | Suggested Resale and Quick Quote both determine a resale price from market data. Different rules but same inputs. | `shared/pricing-engine.js` — pluggable pricing strategies using market-data.js output |

---

## Workflow Interaction Map

Workflows don't just use cogs — they feed into each other:

```
                    ┌─────────────────────┐
                    │   Customer emails    │
                    │   (stockRFQ inbox)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Stock RFQ Loading   │──→ RFQ lines in system
                    └──────────┬──────────┘
                               │ triggers
              ┌────────────────┼────────────────┐
              │                │                │
   ┌──────────▼──────┐  ┌─────▼──────┐  ┌──────▼──────────┐
   │ Franchise Screen │  │ Suggested  │  │ Market Offer    │
   │ (is it worth     │  │ Resale     │  │ Analysis        │
   │  sourcing?)      │  │ (what to   │  │ (do we have     │
   │                  │  │  quote?)   │  │  matching stock?)│
   └────────┬─────────┘  └────────────┘  └─────────────────┘
            │ proceed
   ┌────────▼─────────┐
   │ RFQ Sourcing     │──→ RFQs sent to suppliers
   │ (NetComponents)  │
   └────────┬─────────┘
            │ suppliers respond
   ┌────────▼─────────┐
   │ VQ Loading       │──→ VQ lines in system
   └────────┬─────────┘
            │ VQs enable
   ┌────────▼─────────┐
   │ Quick Quote      │──→ CQ proposal
   └────────┬─────────┘
            │ quote wins
   ┌────────▼─────────┐
   │ Sales Order      │──→ Revenue
   └──────────────────┘
```

**Meanwhile, in parallel:**

```
   ┌──────────────────┐
   │ Supplier emails   │──→ Market Offer Uploading ──→ Offers in system
   │ (excess inbox)    │                                    │
   └──────────────────┘                                     │
                                                            ▼
   ┌──────────────────┐                              ┌─────────────┐
   │ Inventory exports │──→ Inventory Cleanup ──→     │ Vortex      │
   │ (Infor)          │                               │ Matches     │
   └──────────────────┘                               │ (match all  │
                                                      │  supply to  │
   ┌──────────────────┐                               │  demand)    │
   │ BOM data         │──→ BOM Monitoring ──→         │             │
   └──────────────────┘                               └─────────────┘
```

---

## Architectural Principles

1. **Cogs are stateless and workflow-agnostic.** A cog provides data or performs an operation. It never knows which workflow called it.

2. **Workflows own the business logic.** The pricing rules, skip/proceed decisions, template formats — these are workflow-specific. Cogs provide the data; workflows decide what to do with it.

3. **If 2+ workflows do the same thing, extract a cog.** Don't wait for 3. The second duplication is the signal.

4. **API data = confirmed → capture as VQ.** Scraped data = reference only. This distinction lives in `franchise-api.js`, not in the workflow.

5. **The system is the source of truth.** DB data (VQs, sales, offers, RFQs) trumps memory, context, or assumptions. Always query, never guess.

---

## Shared Cogs — Full API Reference

See `shared/README.md` for usage examples and detailed documentation.

---

## External Dependencies

| System | Access | Used By |
|--------|--------|---------|
| iDempiere (PostgreSQL) | Read-only via `psql` | market-data.js, partner-lookup.js, mfr-lookup.js |
| DigiKey API | OAuth2 | franchise-api.js |
| Arrow API | API key | franchise-api.js |
| Rutronik API | API key | franchise-api.js |
| Future Electronics API | License key | franchise-api.js |
| Newark/Farnell API | API key | franchise-api.js |
| TTI API | API key | franchise-api.js |
| Master Electronics API | API key | franchise-api.js |
| Himalaya (IMAP) | Email accounts (stockrfq, excess) | Inbound email workflows |
| FindChips (scraped) | Browser automation | Franchise Screening (availability only) |
| GitHub | Push access | All output files |

---

*Last updated: 2026-03-19*

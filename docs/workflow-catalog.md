# Workflow Catalog

Complete list of available workflows with descriptions. This is the canonical source for the workflow list displayed in the session greeting.

---

## Trading Analysis Workflows

| # | Workflow | Description | Documentation |
|---|----------|-------------|---------------|
| 1 | **Franchise Screening** | Screen RFQs against FindChips to filter low-value parts before broker sourcing | `Trading Analysis/RFQ Sourcing/franchise_check/franchise-screening.md` |
| 2 | **RFQ Sourcing** | Submit RFQs to NetComponents suppliers | `Trading Analysis/RFQ Sourcing/netcomponents/rfq-sourcing-netcomponents.md` |
| 3 | **VQ Loading** | Process supplier quote emails into VQ records. Type 2 bulk summaries → OT REST API; Type 1 single-vendor → vq-parser | `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md` |
| 4 | **RFQ Loading** | AI-assisted extraction and loading of RFQs from customer emails/documents | `Trading Analysis/RFQ Loading/rfq-loading.md` |
| 5 | **Market Offer Matching** | Match new RFQs against customer excess and stock offers | `Trading Analysis/Market Offer Matching for RFQs/market-offer-matching.md` |
| 6 | **Quick Quote** | Generate baseline quotes from recent VQs (0-30 days) with margin/GP/rebate pricing logic | `Trading Analysis/Quick Quote/quick-quote.md` |
| 7 | **Seller Quoting Activity** | VQ→CQ→SO funnel analysis by seller (snapshot + 6-month trend) | *(inline workflow)* |
| 8 | **Order/Shipment Tracking** | Look up tracking by COV, SO, MPN, customer PO, or salesperson | `Trading Analysis/saved-queries/order-shipment-tracking.md` |
| 9 | **Inventory File Cleanup** | Process Infor inventory exports into Chuboe format for iDempiere import | `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` |
| 10 | **Vortex Matches** | Surface VQs/offers under customer targets, stock matches, and market intelligence | `Trading Analysis/Vortex Matches/vortex-matches.md` |
| 11 | **Customer Excess Analysis** | Universal offer pipeline: 30-min inbox poll → writeOffer → type-router. Operator digest 3×/day | `Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md` |
| 12 | **BOM Monitoring** | Track BOM risk, commodity analysis, and excess matches | `Trading Analysis/BOM Monitoring/` |
| 13 | **Stock RFQ Loading** | Process customer RFQ emails into ERP-ready CSV for import | `Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md` |
| 14 | **LAM 3PL** | W111/W115 LAM 3PL operations: weekly reorder alerts + franchise sourcing + customer offer refresh | `Trading Analysis/LAM 3PL/lam-3pl.md` |
| 15 | **HTS / ECCN Backfill** | RFQ-scoped HTS + ECCN backfill onto chuboe_vq_line via DigiKey + Mouser APIs | `Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.md` |
| 16 | **MFR Reconciler** | Daily cron that backfills `Chuboe_MFR_ID` on rows where text is set but FK is null | `Trading Analysis/MFR Reconciler/mfr-reconciler.md` |
| 17 | **CRMA Form Filling** | Fill the customer-RMA xlsx from an OT SO# when buyer forwards a blank form | `Trading Analysis/CRMA Form/crma-form.md` |
| 18 | **Leah's BOS Report** | Weekly open-order report with past-due Δ decomposition + BOS↔ISE matrix alignment | `Trading Analysis/Leah's BOS Report/leahs-bos-report.md` |
| 19 | **AMAT RFQ Management** | Pull RFQ data from Applied Materials' Supplier Collaboration Vault 2.0. **PAUSED** | `Trading Analysis/AMAT RFQ Management/amat-rfq-management.md` |
| 20 | **Price Intelligence** | Per-MPN price-trend dashboard overlaying VQ quotes, market offers, and customer targets | `Trading Analysis/Price Intelligence Dashboard/price-intelligence.md` |
| 21 | **CalcuQuote Comparison** | Side-by-side analysis of CalcuQuote Costed BOM vs API-enrichment. Read-only | `Trading Analysis/CalcuQuote vs Claude API Comparison/calcuquote-vs-claude-api-comparison.md` |
| 22 | **Distributor Scrape Loading** | Desktop scrapes → JSON envelopes → server-side watcher → VQ/pricing writes | `Trading Analysis/Distributor Scrape Loading/distributor-scrape-loading.md` |
| 23 | **Sourcing Recap** | Per-RFQ best-option sourcing summary. Subject keyword "BEST" + RFQ# → Sourcing Recap | `Trading Analysis/Sourcing Recap/sourcing-recap.md` |
| 24 | **Tracking Loading** | Process forwarded supplier shipping confirmations into OT PO tracking fields | `Trading Analysis/Tracking Loading/tracking-loading.md` |
| 25 | **Broker/Franchise Offers** | Load market offers from external brokers and franchise distributors into OT | `Trading Analysis/Broker Offers/broker-offers.md` |

---

## Sales & Reporting Workflows

| # | Workflow | Description | Documentation |
|---|----------|-------------|---------------|
| 26 | **VP Daily Brief** | Strategic 1-page daily snapshot for VP Sales showing yesterday's global sales activity | `Sales Pulse Daily/docs/vp-daily-brief-workflow.md` |
| 27 | **USA Daily Brief** | Daily snapshot for USA Regional Manager (Jeff Wallace) showing USA team performance with individual sales rep breakdown | `Sales Pulse Daily/docs/usa-daily-brief-workflow.md` |

---

## Workflow Trigger Patterns

Some workflows have specific trigger patterns:

| Workflow | Trigger |
|----------|---------|
| Price Intelligence | "price intelligence on \<MPN\>", "price trend for \<MPN\>", "part trend analysis on \<MPN\>" |
| CalcuQuote Comparison | Operator forwards Costed BOM email saying "do not load, compare against system" |
| Sourcing Recap | Email to vortex@ with subject containing "BEST" + 7-digit RFQ# |
| Tracking Loading | Forward FedEx/UPS/DHL emails to tracking@orangetsunami.com |
| Broker/Franchise Offers | Email to brokeroffers@orangetsunami.com |

---

## Inboxes

| Inbox | Workflows |
|-------|-----------|
| `vortex@orangetsunami.com` | Vortex Matches, Sourcing Recap (routed by subject) |
| `tracking@orangetsunami.com` | Tracking Loading |
| `brokeroffers@orangetsunami.com` | Broker/Franchise Market Offers |
| `excess@orangetsunami.com` | Customer Excess Analysis, Inventory File Cleanup |
| `stockRFQ@orangetsunami.com` | Stock RFQ Loading, CRMA Form Filling |

# Distributor Catalog Cross-Reference

**Pattern**: A Tier-2/Tier-3 franchise distributor (e.g., ATGBICS, HTC Korea, TAEJIN) emails Astute their drop-in / cross-reference catalog — their own MPN paired with the mainstream-MFR MPN they replace. Astute's question is always "how often did our customers ask for these mainstream MPNs in the last 12 months, and which customers / sellers / segments matter?"

This folder holds the reusable scripts. **Outputs live in `~/workspace/<distributor>-xref/`**, not in the repo.

## Precedent runs

| Date | Distributor | Working dir | Notes |
|---|---|---|---|
| 2026-05-13 | ATGBICS | `~/workspace/atgbics-xref/` | Optics-heavy. Finisar Coherent dominated. |
| 2026-05-15 | HTC Korea (TAEJIN) | `~/workspace/htc-korea-xref/` | Analog/logic jellybean. TI / ON Semi / ST dominated. JCI subset split out at operator's request. |

## End-to-End Workflow

### Step 1 — Block the email from the excess loader (DO NOT SKIP)

The catalog email lands in `excess@orangetsunami.com`. The offer-poller will try to load it as a market offer at the next 30-minute tick. Block first:

```bash
node ~/workspace/astute-workinstructions/shared/email-workflow-poller.js list --workflow excess
# Note the UID of the catalog email
node ~/workspace/astute-workinstructions/shared/email-workflow-poller.js route <UID> not_offer --workflow excess --payload '{"reason":"manual catalog cross-reference exercise - not for offer loading"}'
```

This moves the message to the `NotOffer` IMAP folder and writes a breadcrumb. The poller will no longer see it.

### Step 2 — Pull attachments from the moved message

`pull-attachments.js` reads from the `NotOffer` folder by subject substring and saves all attachments. Edit the `TARGET_SUBJECT` constant for the run, then:

```bash
mkdir -p ~/workspace/<distributor>-xref/attachments
node ~/workspace/htc-korea-xref/pull-attachments.js
```

### Step 3 — Parse the catalog xlsx(es)

Distributors don't agree on column headers. HTC Korea used `Part Number | Target PKG | Manufacturer | TAEJIN P/N | PKG | PIN-To-PIN | Major Difference | Target Device`. ATGBICS used `competitor_mpn | atgbics_mpn | vendor | category | description`. Normalize the per-distributor xlsx into a unified schema:

```
competitor_mpn      mainstream MFR's MPN (the join key against RFQ history)
distributor_mpn     third party's replacement MPN
vendor              brand being replaced (TI / ADI / ST / etc., normalized)
match_grade         Drop In Replacement / Conditional P2P / Functional Match (quality signal)
target_pkg          asked package
distributor_pkg     what the distributor offers
source_file
```

`parse-catalog.js` is the HTC version — adapt the column detection regex for new distributors. Output: `<distributor>_catalog.csv`.

### Step 4 — Run the 12mo RFQ cross-reference

`build-xref.js` shells out to `psql` (peer auth — the `pg` npm client doesn't auth without a password). Two query passes:
1. **Competitor-MPN match** — UPPER + strip-whitespace match `lm.chuboe_mpn_clean` against the mainstream-MFR MPNs in the catalog. This is the meaningful signal.
2. **Distributor-MPN direct match** — the catalog's own MPN against asked MPNs. Usually small; means someone already knows the distributor.

Date filter: `r.created >= NOW() - INTERVAL '12 months'`. Joins: `chuboe_rfq_line_mpn → chuboe_rfq → c_bpartner → c_bp_group + ad_user (salesrep) + chuboe_rfq_type`.

Outputs (mirroring the ATGBICS shape):

| File | Contents |
|---|---|
| `<dist>_summary.csv` | customer × bp_group × seller × rfq_type roll-up |
| `<dist>_by_competitor_brand.csv` | per mainstream MFR |
| `<dist>_by_brand.csv` | per distributor MPN (direct hits — usually rare) |
| `<dist>_by_mpn.csv` | per asked MPN |
| `<dist>_detail.csv` | per-hit detail |
| `<dist>_rfq_detail.csv` | RFQ × competitor brand |
| `<dist>_rfq_by_customer_seller_type.csv` | customer × seller × type roll-up |
| `<DIST>_RFQ_Cross_Reference_12mo.xlsx` | workbook combining all of the above |

### Step 5 — Customer split (when asked)

If the operator wants a specific customer in its own file (e.g., "JCI separated" for HTC), filter `hits` by `customer_name.includes('<key>')` and rebuild the same workbook with `_<CUSTNAME>` suffix. Both files share the same aggregation logic so totals match. See `buildOutputs()` in `build-xref.js`.

**The customer-specific workbook gets a `By CPC` tab** (passed via `makeWorkbook(set, label, { includeCpc: true })`). The full cross-customer workbook does NOT — CPCs are per-customer codes so the rollup is only meaningful per customer.

**Why the CPC tab matters:** customers send AVL alternates against a single CPC (e.g., JCI's CPC `0246563` lists 5 different MFR P/Ns — LM317T variants from TI + ON Semi — but it's ONE customer ask). MPN-level rollups multiply that by the AVL count; the CPC tab collapses it back. On HTC/JCI: 508 MPN-level hits → 107 CPC-level asks (~4.7× compression).

### Step 6 — Email the deliverable

`send-results.js` sends the workbooks to the operator with an HTML body containing the headline brand table and any customer-split summary. Defaults to `jake.harris@astutegroup.com` (per memory: do not send to the harness userEmail). Adapt the inline HTML for each new distributor.

## Scripts in this folder

- `parse-catalog.js` — HTC-shape xlsx parser (Part Number / Manufacturer / TAEJIN P/N / Pin-To-Pin). Adapt for new column conventions.
- `build-xref.js` — DB query + roll-up + workbook generator. Shape is stable across distributors; the catalog input is what varies.
- `pull-attachments.js` — IMAP grab from `NotOffer` folder by subject substring. Run after Step 1.
- `send-results.js` — Email sender. Update the inline HTML per run.

## Related memory

- `distributor_catalog_xref_pattern.md` (memory file) — the canonical reference for "block first, then xref" sequencing and the empirical signal seen across runs.

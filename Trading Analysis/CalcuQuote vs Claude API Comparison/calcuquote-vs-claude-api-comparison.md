# CalcuQuote (Ltd) vs Claude API (Inc) Comparison

Side-by-side analysis framework for comparing a CalcuQuote-generated Costed BOM
(emailed from the UK / Astute Electronics Limited entity) against the Claude
API enrichment data already written into the system for the same RFQ.

The framework answers four business questions:

1. **AVL Coverage %** — Which side has more of the customer's accepted MPNs?
2. **Apples-to-apples pricing** — Where both sides quoted the same MPN, who was cheaper, controlling for qty break and stock-vs-LT class?
3. **Supplier-level profile** — At each shared distributor (Mouser, DK, TTI, etc.), whose contract pricing is better?
4. **Coverage gaps** — Which channels does each side have that the other doesn't (Inc-only Verical/Master/Rutronik US, Ltd-only MyArrow/Avnet EMEA family)?

This was first built and validated on RFQ 1132586 (Johnson Controls) — full session in [`MEMORY.md`](../../../../../home/analytics_user/.claude/projects/-home-analytics-user-workspace/memory/MEMORY.md) and the inline session log of 2026-05-13.

---

## When to run

**Trigger:** Operator forwards a CalcuQuote BOM email (typically subject containing the RFQ number) to `vq@orangetsunami.com` and explicitly says **do NOT load** — they want a comparative analysis only.

**Setup the data side relies on:**
- The RFQ is already loaded on the Inc side with its API-enrichment mirror RFQ created (search keys like `<orig>` and `<orig + N>` with description `"API Enrichment Mirror of <orig> — DO NOT QUOTE"`). Look up both via `chuboe_rfq.value`.
- VQs from API enrichment + any manual loads (TI direct, Coilcraft, etc.) sit on the original + mirror.

---

## Inputs

1. **RFQ search key** (e.g. `1132586`) — the customer-facing RFQ number. Look up `chuboe_rfq_id` via `WHERE value = '<key>'`.
2. **Mirror RFQ search key** (optional) — look up via description `ILIKE '%Mirror of <key>%'` to find the API-enrichment-only mirror. Include its VQs on the Inc side along with the original.
3. **VQ inbox email subject pattern** — regex/substring matching the Ltd-forwarded email. Default looks for the RFQ number plus `Johnson Controls` / `BOM` / `RFQ`.
4. **Operator confirms manual-load channels** — typically TI MFR direct + Coilcraft for the API-only comparison. Ltd's CalcuQuote doesn't reach MFR-direct, so excluding these gives apples-to-apples reach. Update the constant in the script if a different RFQ has different manual channels.

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step in order. Do not skip.**

### Step 1: Look up both RFQ IDs

```sql
SELECT chuboe_rfq_id, value, LEFT(description,120) AS description,
       chuboe_vq_count, chuboe_rfq_line_count
FROM adempiere.chuboe_rfq
WHERE isactive='Y'
  AND (description ILIKE '%<rfq>%' OR value ILIKE '<rfq>%')
ORDER BY created DESC;
```

You should find two RFQs:
- The original (matches the customer's RFQ number on `value`)
- The mirror (description contains "API Enrichment Mirror of <rfq>")

If no mirror exists, the analysis runs on only the original — but you'll have less Inc-side coverage to compare against.

### Step 2: Fetch the email + attachment from the VQ inbox

```bash
node ~/workspace/astute-workinstructions/Trading\ Analysis/CalcuQuote\ vs\ Claude\ API\ Comparison/scripts/fetch-calcuquote-email.js \
  --subject-pattern "<RFQ number or keyword>"
```

This downloads the BOM xlsx to `~/workspace/scratch/cq-rfq-<rfq>/`. The CalcuQuote attachment filename is typically
`Consolidated Costed BOM - Original Currency_Astute Electronics Limited USD_<job>_GBP.xlsx`.

### Step 3: Parse the Costed BOM

```bash
node "Trading Analysis/CalcuQuote vs Claude API Comparison/scripts/parse-bom.js" \
  "<scratch_dir>/Consolidated Costed BOM ... .xlsx" \
  <scratch_dir>
```

Produces `<scratch_dir>/quotes.json` — list of `{selectedMpn, supplier, totalQty, rfqUnit, leadTimeNotes, ...}` for every row that has BOTH a Selected MPN AND a Supplier (real quote rows; skips unpriced AVL alternates).

The CalcuQuote xlsx has a single sheet `CostedBom` with the data layout:
- Row 0: blank
- Row 1: `COSTED BILL OF MATERIAL`
- Row 2: `Assembly Number  <job> / Id <id>`
- Row 3: column headers
- Row 4+: data rows

**Key columns:**

| Column | Meaning |
|---|---|
| Description | RFQ line description |
| ALL MPN | Every MPN in the AVL for this line (one row per AVL alternate) |
| Mfgr / MPN | The RFQ-supplied MFR + MPN for this AVL slot |
| Selected Mfgr / Selected MPN | The MPN CalcuQuote actually chose to quote (may equal ALL MPN, may be a substitution) |
| Supplier / Supplier SKU | The distributor channel that returned this quote |
| Total Qty / Total Demand | Quantity priced at — typically equals demand qty |
| Quoted Currency / Quoted Unit | Price in original currency (often GBP from UK Astute) |
| RFQ Currency / RFQ Unit | Price converted to RFQ's reporting currency (USD) — use this for comparison |
| Mfg Lead Time / Lead Time Notes | "In Stock." for stock buys, "Can finish 0 assemblies. Short X items with Y days lead time." for LT bids |

Only rows where both `Selected MPN` AND `Supplier` are populated represent a real quote. Rows with empty Selected MPN are alternates CalcuQuote didn't price.

### Step 4–5: Pull Inc-side system VQs + RFQ-line data

Convenience wrapper:

```bash
bash "Trading Analysis/CalcuQuote vs Claude API Comparison/scripts/dump-rfq-data.sh" \
  <orig_chuboe_id> [mirror_chuboe_id] <scratch_dir>
```

Produces `system-vqs.csv` and `rfq-lines.csv` in the scratch dir.

Underlying SQL (run directly if you want to inspect):

```sql
SELECT
  v.chuboe_rfq_id,
  v.chuboe_vq_line_id        AS vq_id,
  v.chuboe_mpn               AS mpn,
  v.chuboe_mfr_text          AS mfr_text,
  bp.name                    AS vendor_name,
  bp.value                   AS vendor_key,
  v.qty, v.cost,
  v.chuboe_lead_time         AS lead_time,
  v.chuboe_date_code         AS date_code,
  v.chuboe_traceability_id   AS traceability_id,
  v.created::date            AS created_date,
  v.chuboe_rfq_line_id       AS rfq_line_id
FROM adempiere.chuboe_vq_line v
LEFT JOIN adempiere.c_bpartner bp ON v.c_bpartner_id = bp.c_bpartner_id
WHERE v.chuboe_rfq_id IN (<orig_id>, <mirror_id>)
  AND v.isactive='Y'
ORDER BY v.chuboe_rfq_id, v.chuboe_mpn, bp.name
```

Inc has multiple breaks per (MPN, vendor): a stock break (small qty, often empty lead-time) and a LT break (large qty, sometimes with "X Week(s)" in lead-time). The framework picks the qty-matched break (closest to and ideally ≥ Ltd's demand qty) for the comparison.

### Step 5 (alt): Pull RFQ-line + accepted MPN data directly

```sql
SELECT l.chuboe_rfq_line_id AS line_id,
       l.chuboe_cpc AS cpc,
       l.chuboe_mpn AS line_primary_mpn,
       l.description AS line_desc,
       l.qty AS line_qty,
       lm.chuboe_mpn AS accepted_mpn
FROM adempiere.chuboe_rfq_line l
LEFT JOIN adempiere.chuboe_rfq_line_mpn lm
  ON l.chuboe_rfq_line_id = lm.chuboe_rfq_line_id AND lm.isactive='Y'
WHERE l.chuboe_rfq_id = <orig_id>
  AND l.isactive='Y'
ORDER BY l.chuboe_rfq_line_id
```

Used for:
- **On-AVL classification** — is each Ltd-quoted MPN actually on the customer's accepted MPN list?
- **CPC labeling** — which Customer Part Code maps to each line
- **Line-coverage view** — for each of the N lines, did Inc / Ltd / both / neither return a quote?

### Step 6: Run the comparison script

```bash
node "Trading Analysis/CalcuQuote vs Claude API Comparison/scripts/compare-cq-vs-api.js" \
  --rfq <rfq_search_key> \
  --label "<JohnsonControls|customer-name>" \
  [--email-to <addr>] \
  [--manual-channels "TI (MFR direct),Coilcraft (MFR)"] \
  [--no-email]
```

Reads `quotes.json`, `system-vqs.csv`, `rfq-lines.csv` from the scratch dir and emits the 10-tab xlsx + emails it.

This script:
1. Reads the parsed BOM + dumped VQs + RFQ-line data
2. Runs all the head-to-head logic (qty match, stock-vs-LT classification, apples flag, on-AVL flag)
3. Emits a 10-tab xlsx (see Output Schema below)
4. Emails it from `stockRFQ@orangetsunami.com` to the specified recipient

### Step 7: Review with operator

The framework produces structured output but the read-out is conversational. Surface in this order:

1. **AVL Coverage %** — line-level + MPN-level, with manual TI/Coilcraft excluded
2. **Apples-to-apples spend / savings** (clean apples bucket, on-AVL only)
3. **Per-supplier profile** — Mouser/Future/DK/TTI/Sager/Samtec head-to-head
4. **MFR pricing trends with Coverage vs True Pricing split**
5. **Coverage gaps** — Inc-only and Ltd-only channels

---

## Output Schema — xlsx tabs

| Tab | Contents |
|---|---|
| **Summary** | Headline counts, dollar figures, color key |
| **Head-to-Head** | Per-MPN comparison; filter by `Apples Flag = APPLES*` + `Bucket Tag = CLEAN_APPLES` for clean rows |
| **Same-Supplier H2H** | Only rows where both sides quoted the SAME distributor on the same MPN |
| **Supplier Profile** | Per-shared-supplier rollup: wins, median Δ%, $$ savings, net cheaper side |
| **Supplier Reach** | Every channel each side reached; flags Inc-only vs Ltd-only vs BOTH; manual loads tagged |
| **AVL Coverage** | RFQ-line coverage % + accepted-MPN coverage % with API-only / all-VQs split |
| **MFR Pricing Trends** | Per-MFR wins split into PRICING wins vs COVERAGE wins; "True pricing edge" column |
| **SameSup × MFR** | Per (MFR × shared supplier) pair: who wins |
| **Side Vendor Profile** | Which Inc vendors win the most for Inc; which Ltd vendors win the most for Ltd |
| **Inc-only** | MPNs Inc surfaced that Ltd didn't, with CPC + on-AVL flag |
| **Ltd-only** | MPNs Ltd surfaced that Inc didn't; off-AVL sub-classified (PACKAGING / QUAL_VARIANT / CROSS_REF / DIFFERENT_MFR) |

---

## Critical Definitions

These were learned the hard way on RFQ 1132586 and should not be re-derived per session:

### Inc side
- **All VQs** = every row on `chuboe_vq_line` for the RFQ + mirror
- **API-only Inc** = excludes manual-load channels. Default exclude list: TI MFR direct, Coilcraft. Add to `INC_MANUAL_CHANNELS` constant in the script if a new RFQ has additional manual loads.
- **Qty-matched Inc quote** = for a given MPN/vendor, the row with smallest qty that's ≥ Ltd qty × 0.95. Falls back to vendor's largest-qty row (and tags STRETCH) if no row reaches Ltd qty.

### Ltd side (CalcuQuote)
- **Stock** quote = Lead Time Notes contains "In Stock"
- **LT** quote = Lead Time Notes contains "X days lead time" or "Short N items with Y days"
- Both stock + LT quotes are typically at the *demand* qty — CalcuQuote prices at volume regardless of stock status

### Bucket tags (Head-to-Head tab)
- **CLEAN_APPLES** — qty matched (VOLUME) AND class matched (Stock-vs-Stock or LT-vs-LT or empty-Inc-LT-at-volume-qty counts as LT)
- **ORANGES** — Ltd STOCK with Inc explicit-LT bid (or vice versa). Class mismatch.
- **STRETCH** — Inc qty < Ltd qty × 0.95. Qty mismatch (Inc only has small-break stock snapshots).
- **INC_ONLY** / **LTD_ONLY** — only one side has any quote

### Apples Flag rules (the "is this comparison valid" gate)

| Ltd class | Inc class | Inc tag | Verdict |
|---|---|---|---|
| LT | LT | VOLUME | APPLES (LT vs LT) |
| LT | STOCK? (empty) | VOLUME | APPLES (treat empty-LT at volume qty as LT — Inc writer often leaves leadTime blank on volume bids) |
| STOCK | STOCK | VOLUME | APPLES (Stock vs Stock) |
| STOCK | STOCK? (empty) | VOLUME | APPLES (Stock vs Stock) |
| STOCK | LT | * | **ORANGES** — Ltd has stock-on-hand, Inc has multi-week LT |
| LT | STOCK at STRETCH | * | **ORANGES** — Inc only has small stock break, no volume bid |

### Win type rules (MFR Pricing Trends tab)

- **TRUE_PRICING win** — winner has the cheapest quote AND the winning supplier exists on the loser's side too (loser just had a higher price at the same supplier)
- **COVERAGE win** — winner has the cheapest quote because the winning supplier doesn't exist on the loser's side at all (loser couldn't reach this supplier)

Most apparent "Inc dominates X MFR" wins are coverage wins via Inc-only channels (Verical, Master, Rutronik US, TI direct). The Supplier Profile tab (same-supplier head-to-head) is the only TRUE pricing signal.

### MFR canonicalization

Always use `canonicalMfr` from `shared/mfr-equivalence.js`. The library collapses ONSEMI/ON SEMICONDUCTOR, KYOCERA AVX/KYOCERA AVX COMPONENTS, VISHAY/VISHAY SEMICONDUCTORS/VISHAY SPRAGUE, MURATA/MURATA ELECTRONICS, TDK/TDK ELECTRONICS, etc., plus walks acquisition chains (Linear → ADI, Atmel → Microchip, Fairchild → Onsemi, etc.).

### Supplier normalization

Region-preserving — distinct channels are KEPT distinct:
- **Arrow** has three channels: MyArrow (US contract portal, Ltd-only), Arrow Americas (US catalog, Ltd-only), Arrow Electronics (generic sys API, Inc-only)
- **Avnet** has four: generic + Abacus / EBV / Silica (all EMEA, all Ltd-only)
- **Rutronik** has two: EMEA parent (Ltd-only) + Rutronik Inc. US arm (Inc-only)

Same-company name variants collapsed: Mouser, Digi-Key, TTI/TTI Inc, Future/Future Electronics Corp, Newark/Newark in One, Farnell/Farnell Element 14, Samtec/Samtec Inc, Sager/Sager-v3004, Rochester variants.

---

## Common Caveats (read before sending the report)

- **Off-AVL spend reported separately**. The Ltd-only "$129M demand exposure" is mostly off-AVL substitutions ($117M), not actionable spend. Only the on-AVL portion ($12.4M) is the real coverage gap.
- **TI/Coilcraft manual loads should be excluded from API-vs-API comparisons.** Operator confirmed these were entered manually. CalcuQuote can't reach MFR-direct either.
- **Future shows ~9% Ltd advantage at the supplier level** — check whether this is genuinely a UK contract difference vs an FX-driven artifact of GBP→USD conversion in CalcuQuote.
- **Samtec is 8-for-8 ties at the supplier level** — MFR list pricing is identical both sides. Any Inc "win" on Samtec at the MFR level is a coverage win (Ltd's BOM didn't return Samtec direct on that MPN), not a pricing win.
- **The xlsx is read-only analysis.** Nothing is loaded to OT. The Ltd BOM email is NOT processed by the standard VQ workflow — operator explicitly says "do not load" when they want this analysis.

---

## Validation

Built and verified on **RFQ 1132586 / Johnson Controls** (2026-05-13).
- Original: chuboe_rfq_id 1142001 (search key 1132586), 480 lines, 4,670 VQs
- Mirror: chuboe_rfq_id 1142008 (search key 1132593, description "API Enrichment Mirror of 1132586 — DO NOT QUOTE"), 478 lines, 3,680 VQs
- Ltd BOM: 776 unique MPNs across 19 distributor channels
- Result: Inc API beats Ltd at MPN level (+164 MPNs, +11pp) but ties at line level (220 vs 218). 191 lines (39.8%) uncovered by either side.

Output xlsx: `~/workspace/scratch/jc-rfq-1132586/JC-RFQ-1132586-Inc-vs-Ltd-v3-2026-05-13.xlsx`

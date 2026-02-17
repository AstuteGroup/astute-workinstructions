# Market Offer Analysis for RFQs

## Overview
Match new RFQs against Customer Excess inventory to identify fulfillment opportunities. Output is a tiered CSV with estimated values and validation flags.

## Tracking
- **Last RFQ processed:** 1130062
- **Next run starts from:** 1130063
- **File naming:** `Excess_Match_MM-DD_RFQ_[start]-[end].csv`

## Criteria

### Data Sources
- **RFQs:** `adempiere.chuboe_rfq` + `chuboe_rfq_line_mpn`
- **Customer Excess:** `adempiere.chuboe_offer` where `chuboe_offer_type_id = 1000000`
- **VQ Pricing:** `adempiere.chuboe_vq_line` (for validation, not tiering)

### Filters
| Filter | Value |
|--------|-------|
| Excess lookback | 90 days |
| Minimum opportunity value | $500 |
| Offer type | Customer Excess only (type_id = 1000000) |

### Exclusions
1. **PPV Self-matches:** Remove when RFQ type is "PPV" AND customer = excess partner (customer validating pricing on their own excess)
2. **Duplicate partner offers:** Keep only most recent offer per partner+MPN, UNLESS quantities differ >50% (indicates different locations)

## Tiering Logic

| Tier | Criteria |
|------|----------|
| TIER_1 | Est. value >= $5,000 AND coverage >= 50% |
| TIER_2 | Est. value >= $1,000 |
| TIER_3 | Est. value < $1,000 OR flagged issues |

**Note:** VQ data validates pricing but is NOT a tier requirement.

## Value Calculation
```
est_opportunity_value = offer_qty * valuation_price

valuation_price = COALESCE(
    excess_price (if > 0),
    rfq_target_price (if > 0),
    avg_vq_cost (from 180-day VQs)
)
```

## Output Columns
```
opportunity_tier, tier_reasoning, rfq_search_key, rfq_date, rfq_type, customer_name,
rfq_mpn, rfq_qty, rfq_target_price, excess_offer_key, excess_date, excess_partner,
excess_mpn, excess_qty, excess_price, date_code, lead_time, qty_coverage_pct,
total_excess_sources, total_available_qty, combined_coverage_pct, vq_count,
avg_vq_cost, min_vq_cost, max_vq_cost, latest_vq_date, rfq_count_90d,
total_rfq_qty_90d, est_opportunity_value, match_type, flag_low_single_source_coverage,
flag_datecode_risk, flag_no_pricing, flag_self_match
```

## Flags
| Flag | Condition |
|------|-----------|
| flag_low_single_source_coverage | Coverage < 20% |
| flag_no_pricing | No price available (excess, target, or VQ) |
| flag_self_match | Customer = excess partner (non-PPV only shown) |
| flag_datecode_risk | (Reserved for aged date codes) |

## Running the Workflow
1. User selects "Market Offer Analysis" (option 2)
2. Query starts from last RFQ processed + 1
3. Match against 90-day Customer Excess
4. Apply deduplication and exclusions
5. Calculate values and assign tiers
6. Export to CSV in this folder
7. Commit and push to git
8. Update "Last RFQ processed" above

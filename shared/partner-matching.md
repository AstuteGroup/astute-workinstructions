# Partner Matching — Canonical Reference

**Module:** `shared/partner-lookup.js`
**Used by:** VQ Loading, Market Offer Uploading, Stock RFQ Loading

Changes to matching logic should be made in `partner-lookup.js`. All workflows reference this single module.

---

## How It Works

Resolves business partners (vendors or customers) from email addresses and company names against the iDempiere database. Returns `{ search_key, name, c_bpartner_id, matched, tier, tierName }`.

### Usage

```javascript
const { resolvePartner } = require('../shared/partner-lookup.js');

// For vendor matching (VQ Loading)
const vendor = resolvePartner({
  email: 'sales@velocityelec.com',
  companyName: 'Velocity Electronics',  // from email signature
  partnerType: 'vendor'
});

// For customer matching (Stock RFQ Loading)
const customer = resolvePartner({
  email: 'bliss@hongdaelectronicsco.com.cn',
  companyName: 'Hongda Electronics Co.',
  partnerType: 'any'  // or 'customer'
});

if (customer.matched) {
  console.log(customer.search_key);  // '1007848'
  console.log(customer.tierName);    // 'domain_hint'
} else {
  // Use fallback (e.g., Unqualified Broker 1008499)
}
```

---

## Matching Tiers (executed in order)

| Tier | Name | Method | When It Helps |
|------|------|--------|---------------|
| 1 | `exact_email` | Exact match on `ad_user.email` | Contact's exact email is registered |
| 1.5 | `email_domain` | Any `ad_user.email` at same domain | Different person at same company |
| 2 | `domain_hint` | Extract company name from domain → search `c_bpartner.name` | Company registered under a different email domain (e.g., Hongda: DB has outlook.com, email from hongdaelectronicsco.com.cn) |
| 3 | `name_match` | Company name from email body/signature → search `c_bpartner.name` | Generic email domains (163.com, gmail.com) where domain gives no company info |

### Tier 1: Exact Email Match
- Matches `LOWER(ad_user.email) = LOWER(sender_email)`
- Handles `USE XXXXX` redirect patterns (follows the reference)
- Filters: active user, active BP

### Tier 1.5: Domain-Based Email Match
- Matches any `ad_user.email` at the same `@domain.com`
- Skipped for generic domains (gmail, outlook, 163.com, etc.)
- Handles `USE XXXXX` redirects

### Tier 2: Domain Hint Matching
- Extracts company name hints from the email domain
- Example: `bliss@hongdaelectronicsco.com.cn` → hints: `hongdaelectronicsco`, `hongdaelectronics`, `hongda`
- Strips common prefixes (`sales-`, `info-`, `rfq-`, etc.)
- Iteratively strips common suffixes (`electronics`, `tech`, `co`, `ltd`, etc.)
- **Primary hints** (from domain segment directly): uses `LIKE '%hint%'` (contains)
- **Derived hints** (from suffix stripping): uses `LIKE 'hint%'` (starts-with only)
- **Consistency check**: derived hint matches are verified against the primary hint to prevent false positives

### Tier 3: Name-Based Fuzzy Match
- Uses company name extracted from the email body/signature
- Requires the caller to provide `companyName` parameter
- Searches `c_bpartner.name ILIKE '%companyName%'`
- Prefers exact name matches over partial matches

---

## Generic Domains (Skipped at Tiers 1.5 and 2)

These domains are shared by many companies and give no company info:

`gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`, `aol.com`, `163.com`, `vip.163.com`, `126.com`, `qq.com`, `sina.com`, `sohu.com`, `foxmail.com`, `aliyun.com`, `protonmail.com`, `icloud.com`, `live.com`

For these, matching falls through to tier 3 (name from email body).

---

## Partner Type Filtering

| `partnerType` | SQL Filter | Use Case |
|---------------|-----------|----------|
| `'vendor'` | `AND bp.isvendor = 'Y'` | VQ Loading |
| `'customer'` | `AND bp.iscustomer = 'Y'` | Customer-specific lookups |
| `'any'` | (no filter) | Stock RFQ Loading, Market Offer Uploading |

---

## Workflow-Specific Fallbacks

| Workflow | When `matched = false` |
|----------|----------------------|
| **VQ Loading** | Flag as `NEEDS-VENDOR`, move email to NeedsVendor folder |
| **Market Offer Uploading** | Flag as `NEEDS-PARTNER`, exclude from ERP-ready output |
| **Stock RFQ Loading** | Use `1008499` (Unqualified Broker), put company name in Description |

---

## Adding to Generic Domains

If you encounter a new shared email provider that causes false positive domain matches, add it to the `GENERIC_DOMAINS` set in `partner-lookup.js`.

---

## False Positive Prevention

**Problem:** Derived hints like `victory` (from `victorytech`) can match unrelated companies like "Victory Telecom".

**Solution:** After a derived hint matches, verify that the matched company name is consistent with the primary (unstripped) hint. If `victorytech` doesn't appear in "Victory Telecom" (and vice versa), the match is rejected.

This allows legitimate matches like `hongda` (from `hongdaelectronicsco`) → "Hongda electronics co., ltd" (passes because `hongdaelectronicsco` is consistent with the matched name).

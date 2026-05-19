# Distributor Scrape Loading

**Status:** New workflow, draft 2026-05-15.

**What this is:** general-purpose infrastructure for moving structured data from operator-attended browser sessions on Windows into iDempiere via JSON envelopes shipped over scp. The contract is intentionally domain-agnostic — it knows about envelopes, folders, atomic publish, and per-source mappers; it does NOT know about sourcing, RFQs, or VQs specifically.

**Current consumers:**
- **RFQ Sourcing → franchise-data channel #3.** Desktop scraping of franchise distributors that lack APIs (or rate-limit them harshly) — Heilind, possibly Newark/Future/Avnet for non-API tiers. Envelopes carry an `rfqSearchKey` and the watcher writes VQs against the corresponding RFQ lines. See [sourcing-roadmap.md § A2](../RFQ%20Sourcing/sourcing-roadmap.md) for the sourcing-side framing.

**Future consumers** plug in by adding a new folder under `~/workspace/inbox/<source>/` plus an optional `mappers/<source>.js` for raw-export pass-through (envelope pattern C). Examples we'd plausibly want eventually: market-intel scrapes of broker sites, customer-portal RFQ pulls, datasheet/parameter scraping for spec-buy analysis. The contract stays unchanged for those — they're just additional `<source>` subfolders.

Picks up scrape result JSON envelopes from `~/workspace/inbox/` (dropped via scp by a Claude Code instance running on Windows next to operator's browser sessions), validates them, and loads VQ lines into iDempiere via the REST API.

This is the consumer side of the [desktop scraper contract](desktop-scraper-contract.md). Read that doc first for the envelope shape — this workflow validates against it.

---

# Why a New Workflow

Existing pricing/VQ data paths into iDempiere:

| Path | Trigger | Loader |
|---|---|---|
| Franchise APIs (DigiKey/Mouser/Arrow/etc. official APIs) | `enrich-poller.js` on RFQ creation | `shared/vq-writer.js` |
| Heilind via Claude Bridge | Manual / on-demand | `bridge/site-adapters/heilind.js` → `writeVQFromAPI` |
| Vendor email quotes (bulk summary) | Inbox poll | `shared/load-bulk-summary.js` |
| Vendor email quotes (Type 1 single-vendor) | `vq-parser` CLI | CSV mass-upload |
| **Distributor browser scraping (this workflow)** | **File-drop into `~/workspace/inbox/`** | **`inbox-watcher.js` → `writeVQBatch`** |

This workflow covers the gap where a distributor has no API (or rate-limits it harshly) but does have a browseable web catalog with customer pricing visible to a logged-in operator.

---

# End-to-End Workflow

## Step 1 — Operator triggers a scrape on the local Windows Claude instance
Operator says e.g. `lookup MPNs for RFQ 1131217 using mouser, arrow, future`. The local instance reads its CLAUDE.md, confirms scope, then drives Playwright/Chrome to scrape each MPN against each distributor. **Output:** a JSON envelope shaped per `desktop-scraper-contract.md`.

## Step 2 — Local instance ships the envelope via scp
The local instance writes the envelope to `~/workspace/inbox/<source>/scrape-<rfqSearchKey>-<UTC-ts>.json.partial` on this server, then SSH-renames it to `.json` to atomically publish. **Output:** a complete `.json` file in the inbox under the source's subfolder.

Two server-side scp requirements (verified 2026-05-15, see `desktop-scraper-contract.md` for detail):
- `scp -O` is required (SFTP subsystem does not start; modern scp defaults to SFTP and fails).
- Remote paths must be absolute (`/home/analytics_user/workspace/inbox/<source>/`) or `~/`-prefixed (`~/workspace/inbox/<source>/`). The server auto-`cd`s into `~/workspace/` at login, so a bare relative `workspace/...` resolves to `~/workspace/workspace/...`.

## Step 3 — Server watcher picks it up
`inbox-watcher.js` (this directory) walks `~/workspace/inbox/` recursively every 30 s (excluding `done/` and `failed/` subtrees), picking up any `scrape-*.json` file. On finding one:

1. Reads and parses the envelope. Schema-validates `version`, `type`, `items[].searchedMpn`, `items[].franchiseResults.distributors[]`.
2. **Do not skip:** writes a `.processing` marker so a parallel run doesn't double-pick.
3. If `rfqSearchKey` is set: calls `writeVQBatch(rfqSearchKey, items)` from `shared/vq-writer.js`. The two-pass loader resolves MPNs (exact → fuzzy) and writes VQs to `chuboe_vq_line` via the iDempiere REST API.
4. If `rfqSearchKey` is absent: calls `writePricingResult()` from `shared/api-result-writer.js` per distributor result for market-intel capture. No VQs written.
5. **Do not skip:** moves the input to `~/workspace/inbox/done/<YYYY-MM-DD>/<source>/<filename>` AND writes a `<filename>.result.json` sidecar containing the `{ written, flagged, failed, needsReview, summary }` block from the writer. The `<source>/` subdir is preserved so audit trails keep distributor attribution.
6. On parse/validation/write failure: moves the input to `~/workspace/inbox/failed/<source>/<filename>` and writes a `<filename>.error.json` with the error reason. Emails the operator immediately.

**Output:** VQ lines in `chuboe_vq_line` (or `chuboe_pricing_api_result` rows if no RFQ context), plus a result sidecar.

## Step 4 — Operator notification
On successful load: rolled into the 11/16/20 UTC digest (`~/workspace/.scrape-load-rollup.json`).
On error: immediate anomaly email per the standard cadence in `astute-workinstructions/CLAUDE.md` § Reporting cadence.

The email summarizes:
- Envelope filename + RFQ search key
- Counts: written / flagged / failed / needsReview / skipped
- For flagged rows: reason (`BP_NOT_FOUND`, `MFR_NO_MATCH`, `MFR_LOW_CONFIDENCE`, `MPN_CROSS_REF`, `MISSING_MANDATORY`, `API_WRITE_ERROR`, `RESTRICTED_MFR`, `NO_RFQ_LINE`) + first 10 examples
- For `needsReview` rows (pass-2 fuzzy matches when `pass2Auto: false`): a list the operator can review before re-shipping with `pass2Auto: true` in `defaults`

---

# Envelope Schema (Authoritative)

See `desktop-scraper-contract.md` for the operator-facing definition. The watcher recognizes two envelope `type`s, corresponding to the adapter patterns documented there.

## Type 1 — `"distributor_scrape"` (patterns A and B: canonical envelope)

Used when the desktop adapter has already parsed the scrape into the canonical `franchiseResults` shape. Pattern A (per-MPN) and Pattern B (bulk BOM with desktop-side parsing) both emit this. The server cannot tell A from B and doesn't need to.

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | number | yes | Must be `1`. Higher versions are rejected until the schema is bumped here. |
| `type` | string | yes | Must equal `"distributor_scrape"`. |
| `createdAt` | ISO-8601 string | yes | Used in load logs only. |
| `operator` | string | yes | Username for audit trail. |
| `source` | string | yes | `windows-scraper@<hostname>` or similar. |
| `rfqSearchKey` | string | no | If present, VQ-load mode. If absent, pricing-intel-only mode. |
| `defaults.buyerId` | number | no | Passed through to `writeVQBatch` opts. |
| `defaults.applyRestrictedMfrGate` | boolean | no | Default `false`. Set `true` to enforce the franchise-restricted MFR gate. |
| `items[]` | array | yes | Min length 1. |
| `items[].searchedMpn` | string | yes | The MPN the operator searched. NOT the distributor's variant. |
| `items[].cpc` | string | no | CPC for line resolution fallback. |
| `items[].rfqQty` | number | no | Defaults to RFQ line qty server-side. |
| `items[].rfqMfrText` | string | no | Drives MFR cross-ref. |
| `items[].franchiseResults.distributors[]` | array | yes | Per-distributor scrape result. |
| `items[].franchiseResults.distributors[].distributor` | string | yes | Slug from the distributor table in `desktop-scraper-contract.md`. |
| `items[].franchiseResults.distributors[].found` | boolean | yes | If `false`, the result is recorded as "not carried" and skipped for VQ writing. |
| (other distributor fields) | various | conditional | See `desktop-scraper-contract.md`. The watcher passes them through to `extractStockAndLtRows`. |

## Type 2 — `"distributor_scrape_bulk"` (pattern C: raw export + meta sidecar)

Used when the BOM-tool export is messy/vendor-specific and desktop-side parsing would be brittle. The desktop ships the raw export file alongside a meta JSON sidecar. The watcher routes the pair to `mappers/<source>.js` (see Architecture Intent below), which parses the raw export into canonical shape before calling `writeVQBatch`.

**Two files arrive together** in `inbox/<source>/`:

1. `scrape-<key>-<ts>.<ext>` — the raw export, untouched (e.g. `scrape-1131217-20260518T080000Z.xlsx`)
2. `scrape-<key>-<ts>.meta.json` — the sidecar that tells the watcher what the export is and what context to attach

The watcher picks up the `.meta.json` (the `.<ext>` file is a side payload, not a trigger). Both must be present before the meta is processed; if the meta arrives first, the watcher waits one tick. If the export still isn't there, the meta is moved to `failed/` with `BULK_EXPORT_MISSING`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | number | yes | Must be `1`. |
| `type` | string | yes | Must equal `"distributor_scrape_bulk"`. |
| `createdAt` | ISO-8601 string | yes | Audit trail. |
| `operator` | string | yes | Username. |
| `source` | string | yes | `windows-scraper@<hostname>`. |
| `rfqSearchKey` | string | no | Same semantics as Type 1. |
| `defaults` | object | no | Same shape as Type 1. |
| `exportFile` | string | yes | Filename (not path) of the sibling raw export. Must exist in the same folder. |
| `expectFormat` | string | yes | `"<source>-bom-export-<ext>"` (e.g. `"heilind-bom-export-xlsx"`) — the mapper key. |
| `items[]` | array | yes | One entry per MPN that was uploaded to the BOM tool. Carries the demand-side context the mapper needs to re-join after parsing. |
| `items[].id` | string | yes | Opaque ID echoed by the mapper when matching the export back to the request. |
| `items[].searchedMpn` | string | yes | What the desktop adapter sent to the BOM tool. |
| `items[].cpc` | string | no | CPC fallback. |
| `items[].rfqQty` | number | no | Same as Type 1. |
| `items[].rfqMfrText` | string | no | Same as Type 1. |
| `items[].context.chuboeRfqLineMpnId` | number | no | RFQ-line-MPN FK if the producer pinned this scrape to a specific demand row. |

Schema violations (either type) move the file(s) to `failed/` with a precise reason.

---

# Operating the Watcher

## Run modes

**Static cron** (default):
```bash
# Installed in cron-jobs.js — runs every minute, sentinel-gated to 30s polling
*/1 * * * * /usr/bin/node ~/workspace/astute-workinstructions/scripts/cron-runner.js --job=scrape-inbox-watcher
```

**Manual / debugging**:
```bash
# One-shot: process whatever's in the inbox right now, then exit
node "Trading Analysis/Distributor Scrape Loading/inbox-watcher.js"

# Dry-run: parse + validate envelopes, log what WOULD be written, don't call the API
node "Trading Analysis/Distributor Scrape Loading/inbox-watcher.js" --dry-run

# Process a specific file (e.g. after a manual fix)
node "Trading Analysis/Distributor Scrape Loading/inbox-watcher.js" --file=scrape-1131217-20260515T153042Z.json
```

## Resilience checklist (filled in)

```
Scheduling new activity: scrape-inbox-watcher
Resilience checklist:
  • Cadence:           every 1 min
  • Registered in:     ~/workspace/astute-workinstructions/cron-jobs.js
  • Cron schedule:     */1 * * * *
  • OT-write?:         yes — needsOT: true (writes VQ lines via REST API)
  • Catch-up on miss?: yes — pending files stay in ~/workspace/inbox/ until processed
  • Idempotent?:       confirmed — each file processed exactly once; `.processing` marker prevents
                       double-pick within a tick; once moved to `done/`, the file name can't
                       reappear without a new timestamp from the local side. VQ writer also has
                       its own natural-key idempotency guard (Chuboe_RFQ_Line_ID, Chuboe_MPN,
                       C_BPartner_ID, Cost) per shared/vq-writer.js#NATURAL_KEY_FIELDS, so even
                       a duplicate envelope won't double-write VQs.
  • Visibility:        result.json sidecars + 11/16/20 UTC digest + immediate error email
```

---

# Failure Modes + Recovery

| Failure | Where it lands | Recovery |
|---|---|---|
| Bad JSON syntax | `failed/<name>.json` + `.error.json` | Operator re-scrapes locally. The bad envelope is preserved for diff. |
| Schema validation fails | `failed/` + `.error.json` with field path | Operator fixes the local adapter and re-ships. |
| `rfqSearchKey` doesn't exist in iDempiere | `failed/` + `.error.json` (`RFQ_NOT_FOUND`) | Operator confirms the RFQ exists. Common cause: typo on local side. |
| MPN not in RFQ lines (pass 1 and 2) | Loaded as much as it could; `needsReview` listed in the result sidecar | Operator inspects the sidecar; if the MPNs really should land, re-ship with `defaults.pass2Auto: true`. |
| BP not found | Flagged in result sidecar (`BP_NOT_FOUND`) | Operator adds the BP to iDempiere or corrects the `bpValue` in the local adapter. |
| iDempiere REST API down | Watcher retries up to 3× with exponential backoff. After that, the file stays in `inbox/` and the next tick retries. No `failed/` move. | Wait for OT to come back. Drift check will surface it after 2× cadence. |
| Watcher crashed mid-file | `.processing` marker stale | On next start the watcher detects stale `.processing` (>5 min old), removes it, and re-picks. |

---

# Storage Rule — Everything Goes Back to the Same Place

**Every source — API, scrape, vendor email, EDI feed, anything future — writes results to the SAME standard storage paths.** The infrastructure that's specific to scraping (transport, mappers, pacing) stays in this folder. The data lands in:

| Outcome | Standard storage | Writer |
|---|---|---|
| Priced (envelope cache) | `chuboe_pricing_api_result` with `source: 'heilind-scrape'` (or `'<slug>-scrape'`) | `shared/api-result-writer.js#writePricingResult()` |
| Priced (actionable VQ) | `chuboe_vq_line` | `shared/vq-writer.js#writeVQBatch()` |
| Negative (not-carried / matched-no-price / etc.) | `shared/data/negative-cache.sqlite` per `DISTY_RULES` | `shared/api-negative-cache.js#record()` |

**Why this rule is load-bearing:** every consumer workflow — `enrich-poller`, Vortex Matches, Market Offer Matching, Quick Quote, Customer Excess Analysis, Price Intelligence Dashboard — reads from these tables. They are source-agnostic. When Heilind data lands in `chuboe_pricing_api_result`, every one of those workflows can use it automatically with zero code changes. The moment a new source decides to "have its own table" or "keep a local JSON cache for speed," every consumer either needs custom integration code OR misses the data.

**Anti-patterns to refuse if a future agent proposes them:**
- A per-source results table ("`chuboe_heilind_results`")
- A local JSON / Redis cache for scrape data ("for performance")
- A source-specific enrichment poller ("for Heilind because it's different")
- Bypassing `writePricingResult` because the source's envelope shape is "unusual" — fix the mapper, not the writer

**Per-source quirks** (Heilind's single-tier pricing, Sager's envelope-status gate, etc.) belong INSIDE the per-source mapper, BEFORE the standard writers see the data. Downstream consumers should never need to know which source the data came from beyond the `source` field on the cache row.

Memory: [[feedback-standard-storage-for-all-sources]] codifies this rule cross-cutting beyond just scrape sources.

---

# Architecture Intent (forward-looking)

**Folder location is the routing signal.** A file at `~/workspace/inbox/<source>/...` is unambiguously a `<source>` envelope. The watcher derives source identity from the folder path; the JSON envelope does not need to carry source metadata for routing purposes.

**Slug convention** — `<source>` is a lowercase, no-TLD short name (`heilind`, never `heilind.com`). For franchise distributors the slug equals the `disty` field exported by `shared/linecards/<slug>.js` — that module is the source of truth. The same slug appears in all four locations: `~/workspace/outbox/<slug>/`, `~/workspace/inbox/<slug>/`, `mappers/<slug>.js`, and the desktop's `scrape-adapters/<slug>.md`. Mismatched slugs are the most common routing failure — see `desktop-scraper-contract.md` § Slug convention for full rules.

Today's structural compromise: the canonical envelope (per `desktop-scraper-contract.md`) still includes `distributor` / `bpValue` / `bpName` per `franchiseResults.distributors[]` entry, because the watcher currently hands the envelope straight to `shared/vq-writer.js#writeVQBatch` which needs that info. The subfolder structure is locked in on both sides so this redundancy is harmless and the routing signal is already in place for the next evolution.

**Per-source mappers (`mappers/<source>.js`) — now part of the contract, not just a future plan.**

Two places these matter:

1. **Pattern C ingestion (live as of this revision).** A `"distributor_scrape_bulk"` envelope arrives with a raw export file + meta sidecar. The watcher reads `expectFormat` from the sidecar, dispatches to `Trading Analysis/Distributor Scrape Loading/mappers/<source>.js`, which exports a `parseBulkExport(filePath, items, context) → {items: [...canonical...]}` function. The mapper's job is the inverse of the desktop adapter's job — turn the vendor-specific export back into the canonical envelope shape, re-joining each row to its `items[].id` so demand context is preserved. Output goes straight to `writeVQBatch`.

2. **Pattern A/B normalization (future, optional).** Today's canonical envelope still carries `distributor`/`bpValue`/`bpName` per result, so the desktop has to know each site's BP identity. The next evolution is to let desktop adapters emit site-natural shapes and have `mappers/<source>.js` fill in slug, BP key, and name from a per-source constant table on the server. When that lands, the desktop contract can simplify and the per-site `scrape-adapters/<source>.md` shrinks.

**Mapper file convention:**
- Path: `Trading Analysis/Distributor Scrape Loading/mappers/<source>.js`
- Required export: `parseBulkExport(absFilePath, items, context) → Promise<{items: CanonicalItem[]}>` for pattern C; `normalize(rawEnvelope) → CanonicalEnvelope` for pattern A/B normalization (when that evolution ships).
- Per-mapper unit tests: drop a saved fixture export under `mappers/__fixtures__/<source>/` and a `mappers/<source>.test.js` exercising both happy-path and partial-result cases. Real bulk exports change shape over time; the fixture is the regression guard.

**Bidirectional future.** Eventually the server publishes RFQ MPN lists into the same folder structure (`~/workspace/outbox/<source>/rfq-<key>.json` or similar), the desktop Claude picks them up, scrapes, and drops results back into `~/workspace/inbox/<source>/`. The folder pair becomes the full message bus; no additional source metadata required in either direction.

Implications for current and future drafting:
- Do not propose JSON-level routing schemes (e.g. a top-level `source` field at envelope root). The folder is authoritative.
- New distributors get a new folder, full stop. No registry edit required to start receiving files (though the per-source mapper layer, when it exists, will need one new file per source).
- Renaming a folder is renaming the source. Treat it as a refactor, not a config change.

## Desktop docs are pulled, not pushed (added 2026-05-15)

The desktop Claude Code instance does NOT read this server directly. It reads a daily-synced local cache populated by `pull-from-astute.ps1` (Task Scheduler, daily 6am + on user logon). The sync set is defined in that script; current members:

- `Trading Analysis/Distributor Scrape Loading/desktop-scraper-contract.md` (the primary playbook for the desktop instance)
- `Trading Analysis/Distributor Scrape Loading/distributor-scrape-loading.md` (this file)
- `astute-workinstructions/CLAUDE.md`
- `astute-workinstructions/integration-paths.md`
- `shared/data-model.md`

To propagate a substantive change to the desktop instance, edit the relevant file here. The next sync (worst case 24h) brings it down. The desktop's bootstrap CLAUDE.md (`desktop-scraper-contract.md`) is deliberately small — it points at the cache, never duplicates content. Drift between server and desktop is therefore bounded by sync cadence, not by remembered-vs-written content.

---

# Open Questions

1. **Avnet BP**: the `c_bpartner` table has multiple Avnet rows (`Avnet`, `Avnet EM`, `Avnet Silica`, `Avnet Abacus`, `Avnet EMG`). Before Avnet's first scrape load, operator must pick the canonical US Avnet BP. Once chosen, add it to `shared/franchise-api.js` `DISTRIBUTORS` so it shows up in cache reconstitution.
2. **Cross-ref classifier**: enrich-rfq passes a `crossRefClassifier` callback to `writeVQFromAPI` for MPN-variant ambiguity (TPS3837K33DBVT vs TPS3837K33DBVR). The watcher could plumb the same callback through. Deferred until we see the false-positive rate on real scraped data.
3. **Concurrency**: a single cron lock currently serializes the watcher. If volume grows, we could shard by `rfqSearchKey` — but the natural-key idempotency guard means parallel-safe-by-default if we ever lift it.
4. **Pacing oversight**: the local side enforces pacing rules per `desktop-scraper-contract.md`. The server has no visibility into whether they were honored. Consider stamping the local agent's rough lookup-per-minute rate into the envelope so the server can refuse envelopes that look auto-scraped at unsafe rates.

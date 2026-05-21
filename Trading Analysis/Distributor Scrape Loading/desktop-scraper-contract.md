# Desktop Scraper Contract

**This is the authoritative contract for the Claude Code instance running on operator's Windows desktop alongside Chrome.** It is synced to the desktop daily by `pull-from-astute.ps1`. The desktop's bootstrap `CLAUDE.md` points here for everything substantive.

Server-side, this file lives at:
`~/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/desktop-scraper-contract.md`

Desktop-side, the cached copy lives at:
`%USERPROFILE%\AstuteDocs\desktop-scraper-contract.md`

If the cached copy is more than 2 days stale, the bootstrap CLAUDE.md tells the operator to run a manual sync before starting work.

---

# North Star: Read Before Executing

**THE .MD FILE IS THE SOURCE OF TRUTH. YOUR MEMORY IS NOT.**

Before starting any scrape run:
1. **USE THE READ TOOL** on this contract and on any per-site adapter notes (`%USERPROFILE%\AstuteDocs\scrape-adapters\<site>.md` if present) — do not proceed from memory.
2. **FIND THE JSON ENVELOPE SHAPE** in this file — use the exact field names; the server watcher rejects unknown shapes.
3. **FIND THE PACING RULES** — do not improvise faster lookups. WAFs (Imperva, Akamai) soft-degrade accounts that exceed them.

If you catch yourself thinking "I remember the shape" — STOP and re-read.

---

# What This Instance Does

This Claude instance runs locally on Windows alongside Chrome. The operator is logged in to distributor sites in those Chrome sessions. You drive Playwright (or a connected Chrome extension) to look up MPNs, parse pricing/stock/lead time, and emit a structured JSON envelope that gets shipped via `scp` to the Astute analytics server. The server-side watcher loads the results as VQs against an RFQ.

You do NOT load VQs directly. You produce a JSON file and ship it. The server is the system of record.

**Operator-attended.** This is not unattended automation. Operator logs in to each distributor before a run; you reuse those sessions. If a site forces re-auth mid-run, stop and ask.

**Per-distributor adapters get added one at a time.** When a new adapter ships, a short `scrape-adapters/<distributor>.md` is added to the sync set with the operator-facing slug, the search-page selectors, and the auth nuance. Read those before driving any specific site. This top-level contract is the pipeline contract — envelope shape, pacing, scp handoff — not the per-site playbook.

**Folder location is the routing signal.** A scrape envelope dropped at `~/workspace/inbox/<source>/file.json` on the server is unambiguously a `<source>` envelope. You don't need to encode source identity inside the JSON for routing purposes; you put the file in the right folder.

## Slug convention (source of truth)

`<source>` is a **lowercase, hyphenated-where-the-brand-uses-hyphens, no-TLD short name.** Never `heilind.com`, never `Heilind`, never `heilind_corp`. Just `heilind`.

**Canonical list for franchise distributors:** the slug equals the `disty` field exported by `shared/linecards/<slug>.js`, indexed in `shared/linecards/index.js`. Today: `digikey`, `mouser`, `tti`, `rutronik`, `heilind`. If you're adding a new franchise source, also add the linecard module (even a stub one if there's no public manufacturer endpoint to fetch from yet) so the slug is locked in one place.

**Future non-distributor sources** (customer portals, broker market-intel, etc.) follow the same lowercase-no-TLD style and document the slug in their per-source cheat sheet at `scrape-adapters/<slug>.md`. They don't need a `shared/linecards/` entry because they're not franchise-data sources.

**All four folder pairs use the same slug:**
- `~/workspace/outbox/<slug>/` — requests going DOWN to desktop
- `~/workspace/inbox/<slug>/` — results coming UP from desktop
- `Trading Analysis/Distributor Scrape Loading/mappers/<slug>.js` — server-side raw-export parser (pattern C only)
- `%USERPROFILE%\AstuteDocs\scrape-adapters\<slug>.md` — per-site cheat sheet on the desktop

If any of these four diverge, the routing breaks. Mismatched slugs are how desktop ends up looking in an empty `heilind.com/` while files sit in `heilind/`.

---

# Customer-Identifying Information — DO NOT SHARE

**Outbound files** — anything the desktop uploads, types, drags, or pastes into a distributor's BOM tool, search box, login form, or any other surface visible to the distributor — MUST contain ONLY the data the tool functionally requires. For a BOM-tool upload that's typically `MPN`, `Manufacturer`, and `Qty`. They MUST NOT contain:

- Customer names, customer codes, or any field that identifies the end-customer
- RFQ numbers, RFQ search keys, RFQ dates (these reveal demand timing and scale)
- Buyer / salesperson names, sales region, or internal workflow context
- COV / SO / PO numbers, prior-quote pricing, or any internal-only identifier
- Anything that ties a request back to a specific end-customer

**Broker norm:** never tell a franchise distributor *who* the demand is for, even indirectly — they may use it for sales prospecting, competitor intelligence, channel partner introductions, or pricing arbitrage. Even if the tool nominally ignores extra columns, distributors log full uploads.

**Where round-trip context lives instead — sidecar JSON.** All customer / RFQ / date / buyer information lives in a server-side `*.meta.json` sidecar next to the upload file in `~/workspace/outbox/<source>/`. The sidecar never leaves the server. On result return, the server consumer joins the export back to the sidecar by `MPN` (or `MPN+MFR` if same-MPN-different-MFR disambiguation is needed) and re-attaches the demand-side context for VQ writeback.

```
~/workspace/outbox/heilind/
├─ 2026-05-18T13-00-48Z.csv          ← MPN, Manufacturer, Qty (sent to Heilind)
└─ 2026-05-18T13-00-48Z.meta.json    ← RFQ#, Customer, RFQ Date (stays on server)
```

**Producer responsibility:** every per-source producer (`heilind-rfq-candidates.js` and any future siblings) MUST emit the upload file with distributor-safe columns only, and a sidecar with the bookkeeping. The sidecar is the canonical home for everything else. An internal-only audit CSV with the full context is fine to keep server-side for operator inspection (`~/workspace/heilind-rfq-candidates.csv`), but that file MUST NOT be staged into `outbox/`.

**Desktop responsibility:** if you receive an upload file from `outbox/<source>/` that contains a column that looks like customer / RFQ / date / buyer information, STOP — do not upload it. Tell the operator. The sidecar exists precisely so the upload file shouldn't ever contain those fields; the presence of them in the upload is a producer bug.

---

# Adapter Patterns (A / B / C)

Each per-site adapter declares which of three ingest patterns it uses. The choice is per-site, not global — driven by what the distributor's site supports.

| Pattern | Use when | Desktop work | What lands in `inbox/<source>/` | Server consumer |
|---|---|---|---|---|
| **A. Per-MPN → canonical JSON** *(default, universal fallback)* | Site has no BOM tool, or it's unusable. Works on any site with a product-page URL. | Visit each product page in turn, parse pricing/stock/lead, build one canonical entry per MPN. Pacing-budget-heavy (~1 action per MPN). | `scrape-<rfqSearchKey-or-LOOKUP>-<ts>.json` with `type: "distributor_scrape"` and the canonical `franchiseResults` envelope below. | `inbox-watcher.js` validates against the canonical schema and calls `writeVQBatch` directly. No per-source code needed. |
| **B. Bulk BOM upload → canonical JSON, desktop parses** | Site has a BOM tool **and** its export is a clean, stable shape the adapter can parse confidently. | 1 upload + 1 download + adapter parses the export into the same canonical envelope as Pattern A. | Same file shape as Pattern A — `type: "distributor_scrape"`, canonical envelope. Server can't tell A from B. | Same as A — `writeVQBatch` directly. No per-source code needed. |
| **C. Bulk BOM upload → raw export, server parses** | Site has a BOM tool but its export is messy/vendor-specific (multi-sheet xlsx, merged cells, custom columns) — desktop parsing would be brittle. | 1 upload + 1 download. Do **not** parse. Ship the raw export file + a meta sidecar; server parses. | Two files in `inbox/<source>/`: the raw export (`scrape-<key>-<ts>.<ext>`) and `scrape-<key>-<ts>.meta.json` with `type: "distributor_scrape_bulk"`, the search key, item-level context (`chuboeRfqLineMpnId`s), and `expectFormat: "<source>-bom-export-<ext>"`. | `inbox-watcher.js` routes by `type` to `mappers/<source>.js` which parses the raw export into canonical shape, then calls `writeVQBatch`. |

**Which pattern Heilind uses, which Newark uses, etc., is the adapter's call** — locked in when the per-site adapter ships (and noted in the per-site `scrape-adapters/<source>.md` cheat sheet). The desktop bootstrap doesn't care; it just runs the adapter the operator named.

**Pattern A's envelope shape is the canonical "found" schema below.** Pattern B emits exactly that. Pattern C ships the raw export + a meta sidecar instead, and the server reconstructs the canonical shape on the consumer side.

---

# Trigger Phrases

Operator says one of:

| Operator says | You do |
|---|---|
| `lookup MPN <part>` | Single-MPN scrape across whichever adapters the operator has wired up. Emit envelope with no `rfqSearchKey` (the watcher will store as market intel, not VQs). |
| `lookup MPNs for RFQ <searchKey>` | Operator pastes a list of MPNs (or provides a file path with one MPN per line, optionally `MPN,CPC,Qty`). Emit envelope WITH `rfqSearchKey` set so the watcher loads VQs. |
| `lookup MPNs for RFQ <searchKey> using <distributor-list>` | Same as above but restrict to the named adapters. |

Always confirm the scope back to the operator before starting (e.g., "26 MPNs × 4 adapters = 104 lookups, ~12–18 min at pacing limits — proceed?"). Don't kick off 100+ lookups without an OK.

---

# JSON Output Envelope (REQUIRED — exact shape)

The server watcher (`Trading Analysis/Distributor Scrape Loading/inbox-watcher.js`) consumes this. It must match the shape `shared/franchise-api.js#extractStockAndLtRows` expects, because the watcher hands it straight to `shared/vq-writer.js#writeVQBatch`.

**One file per logical batch.** Filename: `scrape-<rfqSearchKey-or-LOOKUP>-<UTC-timestamp>.json` (e.g. `scrape-1131217-20260515T153042Z.json`).

```jsonc
{
  "version": 1,
  "type": "distributor_scrape",
  "createdAt": "2026-05-15T15:30:42Z",
  "operator": "jake.harris",
  "source": "windows-scraper@<hostname>",

  // OPTIONAL — if set, the watcher loads VQs against this RFQ.
  // If absent, the watcher writes a chuboe_pricing_api_result row per
  // distributor result for market-intel capture, but no VQs.
  "rfqSearchKey": "1131217",

  // OPTIONAL batch-level VQ defaults — applied if a per-item field is missing.
  // The watcher passes these through to writeVQBatch opts. See shared/vq-writer.js.
  "defaults": {
    "buyerId": null,             // C_BPartner_Buyer_ID; null = leave to server callout
    "applyRestrictedMfrGate": false  // true for franchise-API-style flows; false for broker / manual
  },

  // The actual scrape results. One item per searched MPN.
  "items": [
    {
      "searchedMpn": "AD8312ACBZ",     // REQUIRED — the MPN you typed into the search box
      "cpc": "8021-0017",              // OPTIONAL — customer part code, helps line resolution
      "rfqQty": 1000,                  // OPTIONAL — falls back to the RFQ line qty server-side
      "rfqMfrText": "Analog Devices",  // OPTIONAL — drives cross-ref MFR mismatch detection

      "franchiseResults": {
        "distributors": [
          {
            "distributor": "<slug>",       // stable lowercase slug for this adapter (e.g. "mouser")
            "name": "<Display Name>",      // human-facing distributor name
            "bpValue": "<search-key>",     // iDempiere c_bpartner.value if the adapter knows it; otherwise omit
            "bpName": "<BP display name>", // fallback the server resolver uses when bpValue is missing
            "found": true,                 // false if "no match" / 404 page — watcher skips it

            // Parsed off the product detail page:
            "vqMpn": "AD8312ACBZ",         // distributor's MPN string (may have packaging suffix)
            "vqManufacturer": "Analog Devices Inc.",
            "vqDescription": "RF Detector IC 100MHz to 2.7GHz",
            "vqDateCode": "24+",           // null if not surfaced
            "vqRohs": "Y",                 // 'Y' | 'N' | null
            "vqHts": "8542.39.00.01",      // null if not surfaced; max 25 chars (server validates)
            "vqEccn": "EAR99",             // null if not surfaced; server validates format
            "vqPackaging": "Tape & Reel",  // free text; server normalizes via packaging-lookup
            "vqSpq": 1000,                 // standard pack qty (number) or null
            "vqMoq": 1,                    // minimum order qty (number) or null
            "vqCooCountryId": null,        // leave null — server defaults to PENDING
            "vqLeadTime": "8 weeks",       // free text; null/empty if in-stock only
            "vqVendorNotes": "",           // operator/scraper notes; goes to buyer-internal notes
            "currencyId": null,            // null = USD (100); set 114 for Farnell GBP

            // The qty available NOW for immediate ship. 0 = lead-time only.
            "franchiseQty": 250,

            // The price ladder, ascending by qty.
            // The server's priceAtQty() picks the highest tier ≤ buyQty.
            "priceBreaks": [
              { "qty": 1,    "unitPrice": 12.34 },
              { "qty": 10,   "unitPrice": 11.20 },
              { "qty": 100,  "unitPrice": 9.50 },
              { "qty": 1000, "unitPrice": 7.80 }
            ],

            // For audit / debugging
            "sourceUrl": "https://www.mouser.com/ProductDetail/.../AD8312ACBZ",
            "fetchedAt": "2026-05-15T15:29:42Z"
          }

          // ... one entry per distributor you scraped for this MPN.
          // It's OK to have `found: false` entries — the watcher skips them
          // but a chuboe_pricing_api_result row may still record the negative.
        ]
      }
    }

    // ... one entry per MPN.
  ]
}
```

## Field-level rules to follow

- **Always** include `searchedMpn` exactly as the operator typed it (or as the upstream RFQ has it). The server's cross-ref check (`checkMpnCrossRef`) compares `searchedMpn` vs `vqMpn` to detect "you searched X but the API quoted Y" cases. If you normalize the search to a base MPN, you LOSE that signal.
- **Empty pricing** → set `found: false`. Don't emit `priceBreaks: []` with `found: true` — the watcher will treat it as a write failure rather than a clean "not carried."
- **Lead-time-only** parts (no stock) → `franchiseQty: 0` AND `vqLeadTime` populated. The synthesizer in `franchise-api.js` will emit a single LT row.
- **Both stock + lead time** → set BOTH `franchiseQty` (the stock count) AND `vqLeadTime` (the factory promise). The server splits into two VQs (one stock row, one LT row) per the rules in `shared/franchise-api.js#synthesizeStockLtVqLines`. Do not try to split them yourself.
- **Date code**: only emit what the page actually shows. Don't synthesize "current year +" — the server has defaults for that on franchise-channel rows.
- **Currency**: emit `currencyId: 114` for Farnell GBP storefront; leave null for everyone else (server defaults to USD = 100).

---

# Critical: Server-Side ssh/scp Gotchas

**All of these are confirmed by end-to-end test. None are optional.**

1. **Always use `scp -O`.** The server's SFTP subsystem fails to start. Modern OpenSSH `scp` defaults to the SFTP protocol and dies with `Connection closed` / exit 255. The `-O` flag forces the legacy SCP protocol, which works. *(verified 2026-05-15)*
2. **For pull direction, also use `scp -T`.** Without `-T`, pulls fail with `protocol error: filename does not match request`. The legacy SCP protocol echoes the server-side basename back to the client for cross-check; modern OpenSSH clients reject the response when the client's request used a quoted absolute path. `-T` disables the strict filename round-trip check. Push direction does NOT need `-T` (no server→client filename echo). *(verified 2026-05-21 by desktop Claude during scheduled-pickup smoke test)*
3. **Remote paths must be absolute (`/home/analytics_user/workspace/...`) or `~/`-prefixed (`~/workspace/...`).** The server's login shell auto-`cd`s into `~/workspace/` on connection, so a bare relative path like `workspace/inbox/...` resolves to `/home/analytics_user/workspace/workspace/inbox/...` and fails with `No such file or directory`. *(verified 2026-05-15)*
4. **The server account runs `rbash` (restricted bash) — no output redirection in remote commands.** `ssh ... "ls foo 2>/dev/null"` fails with `rbash: /dev/null: restricted: cannot redirect output` before `ls` runs at all. Instead: let stderr flow naturally (use PowerShell `2>&1` on the client to capture both streams) and string-match the error text (e.g., `"No such"`) to detect empty/missing cases. *(verified 2026-05-21 by desktop Claude during scheduled-pickup smoke test)*

Verified end-to-end at ~12:21 server time on 2026-05-15: 12-byte test file transferred Windows → `/home/analytics_user/workspace/test.txt` using `scp -O` with an absolute remote path. Bare `scp` (no `-O`) and bare relative paths both fail.

Rules 1 + 3 apply in both directions — pushing scrape envelopes up AND the daily docs sync coming down. Rule 2 (`-T`) is pull-only. Rule 4 (no redirection) applies to any `ssh ... "<command>"` invocation against this account. The desktop sync script (`pull-from-astute.ps1`) follows all four.

---

# Picking Up Outbox Requests (down direction)

A daily producer (e.g. `heilind-rfq-candidates.js`) stages an upload file in `~/workspace/outbox/<source>/<UTC-ts>.csv` and emails the operator. The desktop pulls that file via `scp -O`, runs the distributor's BOM tool, and ships the result back up to `~/workspace/inbox/<source>/`.

There are two pickup modes — they coexist:

1. **Scheduled pickup** (default). `pull-from-astute.ps1` runs daily at **08:30 local** (and on logon). It drains every `outbox/<slug>/*.csv` listed in the script's `$ScrapeQueueSet` into `%USERPROFILE%\AstuteScrapeQueue\<slug>\` and ssh-rm's the server copy on success. By the time the operator sits down, the day's CSVs are waiting locally. **Timing:** the producer fires at 12:00 UTC; 08:30 local aligns with operator workday start year-round (08:30 EDT = 12:30 UTC in DST; 08:30 EST = 13:30 UTC in winter — both well after producer).
2. **Ad-hoc pickup** (operator-initiated). If the operator says "pull whatever Heilind has waiting" (e.g., they want to run a second batch later in the day, or the scheduled pull missed), do the explicit `scp -O` + `ssh ... rm` dance shown below.

**The act of retrieving IS the delete.** Once a file has been successfully pulled, immediately remove it server-side via ssh. The server keeps no copy of the upload — the audit trail lives in the inbox-side `.result.json` once the load completes.

```powershell
# 1. Pull the file into the Windows temp dir. -T required on pull direction (see scp gotchas above).
scp -O -T analytics_user@44.222.126.129:~/workspace/outbox/heilind/2026-05-19T12-00-00Z.csv `
    "$env:TEMP\heilind-2026-05-19.csv"

# 2. Verify the local copy exists and is non-empty BEFORE deleting from server.
if ((Test-Path "$env:TEMP\heilind-2026-05-19.csv") -and `
    (Get-Item "$env:TEMP\heilind-2026-05-19.csv").Length -gt 0) {
    ssh analytics_user@44.222.126.129 "rm /home/analytics_user/workspace/outbox/heilind/2026-05-19T12-00-00Z.csv"
}
```

**Do NOT delete the paired `.meta.json` sidecar.** That file stays server-side — the watcher uses it to re-attach RFQ context when your scrape result lands in the inbox. The watcher itself deletes the sidecar after a successful load.

If the operator says "pull whatever Heilind has waiting", list the outbox first to see what's there, then pull + delete each, oldest first:

```powershell
ssh analytics_user@44.222.126.129 "ls -t ~/workspace/outbox/heilind/*.csv"
```

---

# File Naming + scp Handoff

## Local staging path (ephemeral)

**Do NOT accumulate files in the operator's home directory.** Stage the envelope in the Windows temp dir, scp it, delete the temp file. The server is the system of record — `~/workspace/inbox/done/<YYYY-MM-DD>/<source>/` is the audit archive.

- **Envelope JSON (patterns A and B)**: write to `${env:TEMP}\scrape-<key>-<ts>.json.partial`, scp `-O` to server, ssh-rename to `.json`, then `Remove-Item` the local temp file.
- **Raw BOM export (pattern C)**: the browser drops the download in `${env:USERPROFILE}\Downloads\` because that's the browser's choice, not ours. As soon as the download completes, scp `-O` it up to `~/workspace/inbox/<source>/scrape-<key>-<ts>.<ext>.partial`, ssh-rename, then `Remove-Item` the `Downloads\` copy. Also emit the `*.meta.json` sidecar (same scp+rename dance).
- **On scp failure**: keep the temp file until upload succeeds. Windows cleans `%TEMP%` on reboot, so even a permanently-failed upload won't accumulate forever. Do NOT delete the temp file before the upload confirms success.

The `C:\Users\<you>\Sourcing\<source>\` pattern from earlier drafts is **deprecated** — never write there.

## Atomic-write protocol (CRITICAL)
The server watcher polls the inbox. To avoid it picking up a half-written file:

1. Write the JSON to `<filename>.partial` first.
2. `fsync` / `flush` the file.
3. Rename to `<filename>.json` only after the file is complete.

In Node, this is:
```javascript
const fs = require('fs');
fs.writeFileSync(`${filename}.partial`, JSON.stringify(envelope, null, 2));
fs.renameSync(`${filename}.partial`, `${filename}.json`);
```

The watcher only picks up `*.json` files (NOT `*.partial`), so you can't deliver a torn file.

## scp command

**Both `-O` and an absolute-or-`~/`-prefixed remote path are required.** See the gotchas section above.

```powershell
# From PowerShell on the Windows machine.
# -O forces the legacy SCP protocol (the server's SFTP subsystem does not start).
# Remote path is absolute; never use a bare relative path like "workspace/inbox/<source>/".
# Source path is the ephemeral temp file — see "Local staging path (ephemeral)" above.
scp -O "$env:TEMP\scrape-1131217-20260515T153042Z.json" `
    analytics_user@44.222.126.129:/home/analytics_user/workspace/inbox/<source>/
```

A `~/`-prefixed target works equivalently:

```powershell
scp -O "$env:TEMP\scrape-1131217-20260515T153042Z.json" `
    analytics_user@44.222.126.129:~/workspace/inbox/<source>/
```

Use the same SSH key the operator already uses to reach the server. If you don't have one configured, ask the operator to run `ssh-keygen` + `ssh-copy-id` once.

**Why `~/workspace/inbox/<source>/` and not `~/inbox/`:** the server's restricted shell only allows writes inside `~/workspace/`. The watcher creates `~/workspace/inbox/`, `~/workspace/inbox/done/`, and `~/workspace/inbox/failed/` on startup, and scans recursively so per-source subfolders are picked up.

## Atomic publish on the remote side
scp writes to the target path directly — partial transfers can expose half-written files. Use a `.partial` suffix on the remote name, then SSH a `mv` to publish:

```powershell
scp -O "$env:TEMP\scrape-1131217-...json" `
    analytics_user@44.222.126.129:/home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json.partial
ssh analytics_user@44.222.126.129 "mv /home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json.partial /home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json"
Remove-Item "$env:TEMP\scrape-1131217-...json"
```

The watcher's "only pick up `*.json`" rule means the SSH rename is the atomic publish step.

---

# Pacing Rules (do NOT skip)

These exist because ~20 programmatic actions in a 30-minute window triggered Heilind/Imperva soft-degradation on operator's account (login still worked, `/quick-quotes/` BOM tool started 404'ing). The rules below are what passed sustained use without re-triggering.

- **Randomized inter-lookup delay: 3–15 s.** Not a fixed sleep. Sample uniformly each request.
- **Navigation chains over direct URLs.** Going homepage → search → result page reads like a human; jumping straight to `/product/<MPN>` 50 times in a row reads like a script.
- **No more than ~15 lookups per 30-minute window per distributor**, total across all sessions.
- **Passive activity** between lookups: scroll, hover. Helps on WAF-protected sites.
- **One distributor at a time per browser profile.** Don't drive Chrome to mouser.com and arrow.com concurrently in the same profile — fingerprint overlap.
- **If a page 404s or returns a CAPTCHA, STOP that distributor for the rest of the run.** Tell the operator. Don't retry through it.

For an 80-MPN × 4-distributor run that's ~5–8 hours wall-clock. That's the cost. Don't try to compress it.

---

# Authentication

- Operator pre-logs into each distributor in Chrome.
- Connect Playwright to the existing Chrome session (`--connect-cdp`) OR drive via a Chrome extension that has `chrome.debugger` permission (see Astute's `bridge/` pattern on the server side — same model).
- If a site logs the operator out mid-run, STOP. Tell the operator. Do not auto-re-login.
- Customer pricing only appears under the operator's account. Public PDP pricing is generic — useful but not the customer's contract pricing.

---

# Server Side (what happens after you ship)

The watcher at `~/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/inbox-watcher.js`:

1. Walks `~/workspace/inbox/` recursively (excluding `done/` and `failed/`) every 30 s for `scrape-*.json` files.
2. Validates the envelope schema. Bad files → `~/workspace/inbox/failed/<source>/<name>.json` + `<name>.error.json` with reason.
3. If `rfqSearchKey` is set: calls `writeVQBatch(rfqSearchKey, items)` from `shared/vq-writer.js`. Two-pass exact→fuzzy MPN resolution. Writes VQ lines directly to iDempiere.
4. If `rfqSearchKey` is absent: calls `writePricingResult(...)` per distributor result for market-intel capture (no VQs).
5. Writes `~/workspace/inbox/done/<YYYY-MM-DD>/<source>/<filename>.result.json` with `{ written, flagged, failed, needsReview, summary }`, **deletes the inbox envelope** (the result sidecar is the audit), and **deletes the paired outbox `.meta.json` sidecar** (its job ended with this load).
6. Emits a notifier email per run summarizing the load (immediate on error, digested at 11/16/20 UTC otherwise).

You won't see the load result. The operator sees it in their inbox. If something looks wrong, the operator will tell you and you re-scrape.

For the full server-side workflow doc, see the cached copy at `%USERPROFILE%\AstuteDocs\distributor-scrape-loading.md`.

---

# What NOT to Do

- **Do NOT** load VQs from here. The server is the writer.
- **Do NOT** invent fields or pad missing fields with placeholders. `null` is fine; "Unknown" / "TBD" / "N/A" strings will get written into the database as-is.
- **Do NOT** retry rate-limited lookups. If a distributor 429/blocks, stop. Tell the operator.
- **Do NOT** scp to a path other than `~/workspace/inbox/<source>/` (or `/home/analytics_user/workspace/inbox/<source>/`) on the server. Other paths aren't watched.
- **Do NOT** drop the `-O` flag from any scp command. The server's SFTP subsystem does not start; modern scp without `-O` fails at the connection level.
- **Do NOT** use a bare relative remote path (`workspace/inbox/...`). The server auto-`cd`s into `~/workspace/` at login, so it resolves to `~/workspace/workspace/inbox/...` and fails.
- **Do NOT** edit envelopes after they've been shipped. If you find a bug, write a new envelope with a new timestamp.
- **Do NOT** include `IsActive`, `AD_Client_ID`, `AD_Org_ID`, or any other server-managed field. The server fills those in.
- **Do NOT** leave an outbox file on the server after pulling it. The act of retrieval IS the delete — `ssh ... rm` immediately after a successful `scp -O` pull, only after verifying the local copy exists and is non-empty.
- **Do NOT** delete `*.meta.json` files from `~/workspace/outbox/<source>/`. Those are server-side bookkeeping; the watcher removes them when it processes the matching inbox result.

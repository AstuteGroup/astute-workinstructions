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

# Critical: Server-Side scp Gotchas (verified 2026-05-15)

**Both of these are confirmed by end-to-end test. They are not optional.**

1. **Always use `scp -O`.** The server's SFTP subsystem fails to start. Modern OpenSSH `scp` defaults to the SFTP protocol and dies with `Connection closed` / exit 255. The `-O` flag forces the legacy SCP protocol, which works.
2. **Remote paths must be absolute (`/home/analytics_user/workspace/...`) or `~/`-prefixed (`~/workspace/...`).** The server's login shell auto-`cd`s into `~/workspace/` on connection, so a bare relative path like `workspace/inbox/...` resolves to `/home/analytics_user/workspace/workspace/inbox/...` and fails with `No such file or directory`.

Verified end-to-end at ~12:21 server time on 2026-05-15: 12-byte test file transferred Windows → `/home/analytics_user/workspace/test.txt` using `scp -O` with an absolute remote path. Bare `scp` (no `-O`) and bare relative paths both fail.

Both rules apply in both directions — pushing scrape envelopes up AND the daily docs sync coming down. The desktop sync script (`pull-from-astute.ps1`) uses `scp -O` for the same reason.

---

# File Naming + scp Handoff

## Local staging path
`C:\Users\<you>\Sourcing\<source>\` — one subfolder per distributor adapter (e.g. `C:\Users\jake.harris\Sourcing\mouser\`). Create on first run.

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
scp -O "C:\Users\<you>\Sourcing\<source>\scrape-1131217-20260515T153042Z.json" `
    analytics_user@44.222.126.129:/home/analytics_user/workspace/inbox/<source>/
```

A `~/`-prefixed target works equivalently:

```powershell
scp -O "C:\Users\<you>\Sourcing\<source>\scrape-1131217-20260515T153042Z.json" `
    analytics_user@44.222.126.129:~/workspace/inbox/<source>/
```

Use the same SSH key the operator already uses to reach the server. If you don't have one configured, ask the operator to run `ssh-keygen` + `ssh-copy-id` once.

**Why `~/workspace/inbox/<source>/` and not `~/inbox/`:** the server's restricted shell only allows writes inside `~/workspace/`. The watcher creates `~/workspace/inbox/`, `~/workspace/inbox/done/`, and `~/workspace/inbox/failed/` on startup, and scans recursively so per-source subfolders are picked up.

## Atomic publish on the remote side
scp writes to the target path directly — partial transfers can expose half-written files. Use a `.partial` suffix on the remote name, then SSH a `mv` to publish:

```powershell
scp -O "C:\Users\<you>\Sourcing\<source>\scrape-1131217-...json" `
    analytics_user@44.222.126.129:/home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json.partial
ssh analytics_user@44.222.126.129 "mv /home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json.partial /home/analytics_user/workspace/inbox/<source>/scrape-1131217-...json"
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
5. Moves the input to `~/workspace/inbox/done/<YYYY-MM-DD>/<source>/<filename>` + writes `<filename>.result.json` with `{ written, flagged, failed, needsReview, summary }`.
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

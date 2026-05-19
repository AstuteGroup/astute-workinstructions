# Integration Paths — Supplier Coverage Strategy

**Purpose:** Canonical map of how Astute integrates with each electronic-component supplier — distributor, MFR-direct, aggregator, or broker. Replaces ad-hoc decisions about "should we build an integration for X?" with a structured framework so every new supplier evaluation produces consistent outputs.

**Read this before:**
- Starting any new supplier integration
- Evaluating whether to invest in a heavier integration (EDI, headless agent)
- Triaging a "we should connect to Y" request from sales/sourcing

**Related docs:**
- `api-integration-roadmap.md` — implementation timeline / status / open issues
- `shared/franchise-api.js` — current Path A live state (which APIs are wired)
- `shared/data/linecards/` — per-distributor linecard JSON files used for pre-filtering

---

## 1. Four integration paths

| | **Path A — API** | **Path B — Browser extension** | **Path C — Headless agent** | **EDI** |
|---|---|---|---|---|
| **What it is** | Documented REST/GraphQL/JSON over partner-key auth | Chrome extension drives the operator's real browser session | Server-side headless Chromium (Playwright/Puppeteer) with stored service-account creds | Standardized B2B messages (X12 / EDIFACT) over AS2 / SFTP / VAN |
| **Where it runs** | Cron or on-demand, server-side | Operator's Chrome, operator-triggered | Cron or on-demand, server-side | Scheduled batch (hourly / daily file drops) |
| **Human in loop?** | No | Yes | No | No |
| **Auth handling** | API key, no MFA | Operator's logged-in session handles MFA | Stored creds; MFA = blocker | Identity-of-mailbox (AS2 cert) or SFTP key |
| **Anti-bot tolerance** | N/A | Highest — looks fully human | Lowest — Cloudflare/Akamai/Imperva often detect | N/A — different transport |
| **Setup effort** | Hours-days (write client) | Days (extension + selectors) | Days-weeks (stealth tuning) | Weeks-months (mapping + cert) |
| **Durability** | High | Medium — UI changes break selectors | Low-medium — anti-bot escalates | Very high — contractual, versioned mapping |
| **Best for** | Documented partner APIs | Portals with MFA / anti-bot / occasional CAPTCHAs | Simple portals with structured responses, no MFA, low anti-bot | High-volume direct-buy relationships |

### When each path is the right answer

- **API:** Default when available. Lowest operational overhead.
- **Browser extension:** When the supplier has aggressive anti-bot (Cloudflare Managed Challenge, Akamai Bot Manager, Imperva) OR MFA, and the per-RFQ access pattern can tolerate operator-initiated trigger.
- **Headless agent:** When the supplier has no API but also no aggressive anti-bot, and we need 24/7 autonomous polling. Verify anti-bot posture before committing.
- **EDI:** When (a) we're a direct-buy customer with the supplier, (b) volume justifies the relationship cost, and (c) the supplier offers it. Most durable option but slowest to stand up.

---

## 2. The two-stage funnel

Every supplier integration should be designed as **two stages**:

```
For each RFQ line MPN:
├─ Stage 0: Linecard filter — drop suppliers who don't carry this MFR
├─ Stage 1: Stock-existence probe (cheap, anonymous, sub-second)
│            ├─ Public catalog API (DK/Mouser/Newark stock — already have)
│            ├─ NetComponents listing (we already poll this for VQs)
│            ├─ Arrow API's Verical tree (free, we already get this)
│            └─ Anonymous public-side of supplier site (where accessible)
└─ Stage 2: Only if Stage 1 says "yes":
            ├─ Browser extension session (logged-in contract pricing)
            ├─ Headless agent (login + scrape)
            └─ EDI consumption (if subscribed)
```

**Why this matters:**
- For any Path B/C/EDI supplier, **every query is expensive** (anti-bot escalation, operator browser-session time, EDI relationship-souring on low conversion). Pre-filtering at Stage 0 + Stage 1 kills 80-95% of would-be Stage 2 queries.
- For EDI suppliers especially, low conversion ratios get noticed by their sales reps. A linecard-filtered + Stage-1-gated EDI feed produces a defensible conversion story.
- Public catalog stock is "worth chasing?" — Path B/C/EDI is "actually allocated and priced for us?"

### Practical caveats

1. **Public stock ≠ accurate stock.** Public catalog showing "in stock" can be promotional or already committed. Stage 2 reveals real allocation.
2. **Some suppliers poison anonymous data** (vague "In Stock" / "Limited" / "Special Order"). Treat Stage 1 as a low-resolution filter, not a quantitative answer.
3. **Anonymous probes still need to behave well** — datacenter-IP rate-limit awareness applies even without login.

---

## 3. RFQ-type × Stage 1 signal applicability

Not every Stage 1 signal is valid for every RFQ type. Check this table when wiring a supplier:

| RFQ type | NC / broker feeds | Verical via Arrow | Authorized distributor stock | MFR-direct cache | Anonymous public catalog |
|---|---|---|---|---|---|
| **Shortage / spot-buy** | ✅ primary | ✅ | partial (only if normal channel OOS) | rarely | sometimes |
| **PPV / competitive** | ⚠️ noise mostly | partial | ✅ baseline | ✅ contract pricing | ✅ |
| **Lead-time / scheduled** | ❌ broker stock ≠ lead-time commit | ❌ | ✅ | ✅ | ✅ |
| **3PL / consigned (LAM-style)** | ❌ | ❌ | ✅ contracted only | ✅ if contracted | ✅ |
| **EOL / obsolete** | ✅ Rochester via NC | ✅ | ⚠️ usually empty | ❌ | ✅ |
| **NPI / pre-release** | ❌ | ❌ | ⚠️ early-stock partial | ✅ MFR-direct primary | ⚠️ |

**Implication:** Rochester via NC is *the* answer for shortage and EOL — but irrelevant for lead-time and 3PL flows where Rochester's actual integration value is contracted authorized lifetime pricing on long-life mil/industrial parts. The same supplier may have different Stage 1 signals depending on what we're sourcing.

---

## 4. Anti-bot probe methodology

Before classifying any supplier into Path A/B/C, run a **two-part probe**: (a) check developer/api subdomains for an unadvertised API, and (b) probe the main site for anti-bot posture.

**Step 1 — Subdomain sweep (do this BEFORE classifying as Path B/C).** MFRs frequently host their developer API on `developer.<domain>` or `api.<domain>` even when the marketing site says nothing about it. Skip this step and you'll classify suppliers as Path B/C when a clean Path A is sitting one subdomain over (this happened with Samtec on 2026-05-14 — initial classification was Path C; subdomain sweep revealed [developer.samtec.com](https://developer.samtec.com/) is an open-signup API portal).

```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
for sub in "developer" "api" ; do
  url="https://${sub}.<supplier-domain>/"
  status=$(curl -s -o /tmp/sub-tmp.html -w "%{http_code}" -A "$UA" --max-time 7 -L "$url")
  echo "${url} -> ${status}"
done
```

Interpretation:
- `200` with rich body / docs / "Sign up" → likely public API → **Path A — verify**
- `200` with tiny stub body (< 1 KB, no API-doc keywords) → probably internal backend, not partner-facing → **ask supplier rep**
- `403` via CloudFront / Cloudflare with "Request blocked" → partner-gated API exists → **ask supplier rep for access**
- `000` (DNS fail) or `404` → no API on standard subdomain → proceed to Step 2

**Step 2 — Main-site anti-bot probe (for Path B/C classification).**

```bash
curl -s -I -A "$UA" --max-time 12 -L "https://www.<supplier>.com/" -D /tmp/probe-headers.txt
head -25 /tmp/probe-headers.txt
```

### Interpreting the response

| Response signal | Anti-bot identified | Path verdict |
|---|---|---|
| `cf-mitigated: challenge` or body title `"Just a moment..."` | Cloudflare Managed Challenge | **Path B** |
| `_abck` + `bm_sz` cookies + `server: AkamaiGHost` | Akamai Bot Manager (Enterprise) | **Path B** |
| `X-Iinfo` header or `incap_ses_` cookie | Imperva / Incapsula | **Path B** |
| `server: cloudflare` + 403 with body containing "cloudflare" | Cloudflare full block (Bot Mgmt active) | **Path B** |
| `set-cookie: __cf_bm` only, 200 response | Cloudflare passive (observe + rate-limit) | **Path C usually fine** |
| `server: nginx` + 403 with custom error page | Custom WAF, server-side blocked | **Path B** |
| `cookie: OCXS` set via slowAES JS | Custom JS-challenge (e.g., DDoS-Guard family) | **Path B** |
| No anti-bot headers, `server` is nginx/Apache/CloudFront/Azure FD, 200 response | None | **Path C** |
| 200 with SF B2B Commerce headers (`/sfsites/c/resource/`, `dxp-styling-hooks`) | None — Salesforce-hosted | **Path C** (with SF SSO login) |

### Why this works

Anti-bot vendors leave fingerprints in headers and cookies that are nearly impossible to suppress. The probe takes < 1 second per supplier and produces a deterministic verdict. Re-probe annually or when a supplier reports portal changes.

---

## 5. Per-supplier intake checklist

When starting a new supplier integration, fill in this dossier **before** committing engineering work:

```
Supplier:                  <name>
Type:                      Franchise dist / MFR-direct / Aggregator / Broker / Specialty
Anti-bot:                  <from probe>
Path verdict:              A / B / C / EDI
Auth model:                API key / OAuth+MFA / SF SSO / username-password / SFTP cert
Regional accounts:         US / UK / EMEA / APAC / multi
Linecard scope:            <MFR families>
Linecard file:             shared/data/linecards/<supplier>_latest.json  (or "not yet built")
Stage 1 signals:           NC / Verical / public catalog / Octopart / none
  - NC listings?           y/n + volume guess
  - Verical?               y/n
  - Anonymous catalog?     y/n (verified with probe)
  - Octopart coverage?     y/n (if Nexar licensed)
RFQ-type applicability:    Shortage / PPV / Lead-time / 3PL / EOL / NPI  (mark which apply)
Conversion expectation:    rough Stage 2 → won-quote yield estimate
Status:                    Live / Pending / Backlog / Hold
Notes:                     <free text>
Last verified:             YYYY-MM-DD
```

A "Hold" status is valid and useful — capture suppliers we explicitly chose not to pursue and the reason. Don't relitigate the same evaluation every six months.

---

## 6. Master tracker

### Live (Path A)

| Supplier | BP name | Regional accounts | Notes |
|---|---|---|---|
| DigiKey | — | US ✓, UK/EU 🟡 | Add UK creds for Ltd parity |
| Mouser | Mouser | US ✓, UK/EU 🟡 | Add UK creds for Ltd parity |
| Arrow (+ Verical) | Arrow Electronics | US ✓, **MyArrow UK 🟡** | UK contract pricing = biggest Ltd-wins category per RFQ 1132586 |
| Future | Future Electronics Corporation | US ✓, UK 🟡 | Ltd ~9% cheaper on average; UK contract or FX artifact |
| Rutronik | Rutronik Inc. | US ✓, UK 🟡 | Add EU arm |
| TTI | TTI Inc | US ✓, UK ? | Inc-favorable per RFQ 1132586 |
| Newark / Farnell / element14 | Newark in One (Element 14) | multi | |
| Master Electronics | Master Electronics | US | |
| Sager | Sager - v3004 | US | |
| Waldom | — | US | Specialty franchise |
| OEMSecrets | — | — | Aggregator. Verify live status. |

### Pending (Path A — credentials/access)

| Supplier | Status | Blocker |
|---|---|---|
| Avnet (+ Silica EMEA) | Troubleshooting | Biggest unresolved franchise gap |
| TI MFR-direct | Awaiting API approval | Currently manual load |

### Backlog (Path A — not started)

| Supplier | Notes |
|---|---|
| **Samtec direct** | **Open-signup API** at [developer.samtec.com](https://developer.samtec.com/) — Catalog / Pricing / Orders endpoints + daily pricing file. Easiest unclaimed Path A target. |
| RS Online | Specialty; RS Catalogue API |
| Octopart / Nexar | Could cover several Path B/C in one paid API; evaluate before building per-supplier |
| LCSC | Aggregator (Asia). Path A backlog (api.lcsc.com responds 403/CloudFront — partner-gated; ask rep) OR Path C from anonymous catalog. |

### Backlog (Path B — browser extension)

| Supplier | Anti-bot | Auth | Status |
|---|---|---|---|
| **Coilcraft** | Cloudflare Managed Challenge (verified 2026-05-14) | account login | No account needed for `/partupload/` |
| **Heilind** | Imperva (per existing memory) | account login | EDI 832/846 also being pursued |
| **Microchip Direct** | Akamai Bot Manager Pro + Azure B2C MFA (verified 2026-05-14) | OAuth + likely MFA | Account on file |
| **PUI Audio** | Custom nginx WAF — 403 to non-browser (verified 2026-05-14) | account login | Account on file |
| **Powell Electronics** | Cloudflare full block (verified 2026-05-14) | account login | **HOLD** — see dossier below |

### Backlog (Path C — headless agent)

| Supplier | Anti-bot | Status |
|---|---|---|
| **Rochester Electronics** | None — Salesforce B2B Commerce (verified 2026-05-14) | Account on file; cleanest Path C candidate. `api.rocelec.com` exists but returns 491-byte stub — likely internal, ask rep about a partner API before committing to Path C build. |
| **LCSC** | None — CloudFront/S3 (verified 2026-05-14) | Modal login on `/`. `api.lcsc.com` is partner-gated (CloudFront 403) — try Path A first via direct ask. |

### Pending (EDI primary)

| Supplier | Status | Notes |
|---|---|---|
| **PEI-Genesis** | Account being created | EDI publicly advertised (X12, EDIFACT, SFTP, VAN, XML). Path B as bridge during EDI build. |

### Hold / contingency

| Supplier | Reason | Reconsider when |
|---|---|---|
| Powell Electronics | ~90% linecard overlap with PEI; more hostile to integration (Cloudflare full block); EDI not advertised | PEI shows structural shortfall on TE/Amphenol pricing across 3-6 months |
| Sourcengine | Broker, not in current scope | — |
| Win Source | Broker, not in current scope | — |
| Fusion Worldwide | Broker, not in current scope | — |
| ADI direct (myAnalog) | No account; not flagged as priority | Customer mix shifts ADI-heavy |

---

## 7. Per-supplier dossiers (detail)

### Coilcraft

- **Type:** MFR-direct (magnetics — inductors, transformers, RF chokes)
- **Anti-bot:** Cloudflare Managed Challenge (`cf-mitigated: challenge`, classic "Just a moment..." page). Verified 2026-05-14.
- **Public API:** None found. Web search returned no `api.coilcraft.*`, `developer.coilcraft.*`, or GitHub client. They offer a `/partupload/` web form (CSV/TSV bulk upload → results table) — no documented API behind it.
- **CalcuQuote partner status:** Not listed on CalcuQuote's partner roster (verified 2026-05-14).
- **EDI:** Not advertised; would require direct-buy relationship.
- **Path verdict:** **Path B** (browser extension). Headless ruled out because CF Managed Challenge specifically targets headless browsers; stealth-headless setups are brittle and break silently.
- **Stage 1 signal:** Same Cloudflare wall applies to anonymous probing — no cheap signal. Use linecard + customer context to gate Stage 2.
- **Conversion expectation:** Stable pricing makes caching forgiving; pricing changes are infrequent (annual or less). Low operational cadence required.
- **Notes:** Coilcraft is franchised through DigiKey, Mouser, Avnet, TTI — most parts flow through Path A APIs we already have. Path B against Coilcraft direct is only worth building for (a) parts not stocked at authorized distribution, (b) factory-direct contract pricing on volume, (c) lead-time visibility.

### Heilind

- **Type:** Franchise distributor (connectors — TE / Amphenol / Molex emphasis)
- **Anti-bot:** Imperva (per `project_heilind_edi.md`, scraping ruled out)
- **Public API:** None
- **Path verdict:** **Path B** (extension) OR **EDI** as long-term goal
- **EDI status:** Pursuing 832/846 — see `project_heilind_edi.md`. Operator checking colleagues for existing setup as of 2026-04-14.
- **CalcuQuote partner status:** Listed (BidCQ supplier-portal model, not direct API/EDI to us)
- **Notes:** Among the most-aggressive anti-bot of the connector master distributors. Browser extension is the realistic bridge.

### Microchip Direct

- **Type:** MFR-direct (microcontrollers, analog, FPGAs — and Atmel/SST/Atmel families post-acquisition)
- **Anti-bot:** **Akamai Bot Manager Pro** — `_abck` + `bm_sz` cookies, `server: AkamaiGHost`, 503 challenge response. Verified 2026-05-14.
- **Auth:** Azure B2C OAuth at `login.microchip.com/fa3b8c7a-.../b2c_1a_signup_signin/oauth2/v2.0/authorize` — likely MFA-enforced for direct accounts.
- **Path verdict:** **Path B only.** Akamai Bot Manager Pro is the heaviest enterprise-grade anti-bot in widespread use; headless setups get flagged near-deterministically. Real-Chrome operator session is the only durable path.
- **Stage 1 signal:** None — Akamai blocks anonymous probes as hard as authenticated ones. Use linecard + customer context to gate Stage 2.
- **Account:** On file.

### PUI Audio

- **Type:** MFR-direct (audio transducers, speakers, buzzers, microphones)
- **Anti-bot:** Custom nginx WAF — 403 to any non-browser client even with realistic Chrome UA. Looks like a Magento-style storefront with deliberate server-side blocking. Verified 2026-05-14.
- **Path verdict:** **Path B.** Headless ruled out — server-side requests actively rejected.
- **Account:** On file.
- **Notes:** Different company from Power Integrations (`power.com` / POWI). Confirm PUI Audio when scoping.

### PEI-Genesis

- **Type:** Master distributor (connectors — mil-aero, industrial)
- **Anti-bot:** Cloudflare passive on `/`, custom JS challenge (slowAES, `OCXS` cookie) on `/robots.txt`. Verified 2026-05-14.
- **Public API:** None.
- **EDI:** **Publicly advertised.** Site states they support ANSI X.12, EDIFACT, and "any other accepted standard." Transports: secure FTP, XML, VAN. Source: [PEI-Genesis EDI page](https://www.peigenesis.com/en/value-added-services/supply-chain-solutions/edi.html).
- **Linecard scope:** Amphenol Aerospace, ITT Cannon, Souriau-Sunbank, Positronic, Glenair, Bel/Cinch, Switchcraft, Conec, AB Connectors, Lemo (limited). Connector-focused. Build `shared/data/linecards/pei_latest.json` before any Stage 2 work.
- **Path verdict:** **EDI primary, Path B bridge.**
  - Phase 1 (now): Path B (extension) on operator's authenticated session — used until EDI is live.
  - Phase 2 (~30-90d post-account): SFTP 832 (price catalog) + 845 (P&A) + optionally 846 (inventory). SFTP is simpler than VAN/AS2; PEI explicitly supports it.
  - Phase 3 (volume-justified): 850/855/856/810 for PO/ack/ASN/invoice automation.
- **Stage 1 signals:** Anonymous catalog *may* load (Cloudflare passive); NC listings *may* exist — verify both after account is created.
- **Conversion concern:** Low conversion on EDI relationships can sour them. **Build linecard pre-filter FIRST** so PEI only gets queried on connector MPNs. Defer EDI ask until 3-6 months of bridge-phase data shows real conversion potential.
- **Onboarding asks (for PEI rep):**
  1. "Do you support 832 and 845 for distributor partners?"
  2. "Can you provide a customer-specific price file via SFTP?"
  3. "Is there a customer portal API or CSV export for pricing/availability?"
  4. "Can we get SFTP credentials + EDI mapping doc?"
  5. **"Do you have a partner/developer API?"** — `api.peigenesis.com` resolves and responds 200 (ASP.NET / Cloudflare) but with no visible developer docs. Likely an internal backend, but worth asking rep — could be a hidden Path A that would supersede EDI for our use case.

### Powell Electronics

- **Status:** **HOLD** — do not pursue in parallel with PEI.
- **Type:** Master distributor (connectors — mil-aero, industrial)
- **Real domain:** `www.powell.com` (legacy `powellelectronics.com` redirects to `survey-smiles.com` — dead)
- **EMEA arm:** `powell-electronics.eu` (separate entity)
- **Anti-bot:** **Cloudflare full block** — 403 to any non-browser request including realistic Chrome UA. Verified 2026-05-14. More aggressive than PEI's posture.
- **shop.powell.com:** Salesforce B2B Commerce (CSP confirms — seen as a trusted frame-ancestor in Samtec's headers), also behind same Cloudflare block.
- **`robots.txt`:** Polite to legit crawlers (Crawl-delay: 10s, Visit-time: 04:00-08:45 UTC) but Cloudflare blocks anything that doesn't pass its fingerprint.
- **Public API:** None found.
- **Public EDI:** Not advertised (unlike PEI). Likely available if direct customer, but requires sales conversation.
- **Linecard scope:** TE Connectivity (Deutsch/Raychem), Amphenol, Glenair, Samtec, AirBorn, Positronic, CINCH, Conesys, Harwin, HUBER+SUHNER, ITT Cannon, HARTING, Radiall, Souriau, Switchcraft, AB Connectors. **~90% overlap with PEI.**
- **Path verdict if pursued:** Path B only. No Stage 1 anonymous signal available.
- **Why HOLD:**
  1. ~90% linecard overlap with PEI means low marginal coverage gain.
  2. More hostile to integration — no anonymous Stage 1 signal, only NC listings or operator-driven queries.
  3. Worse onboarding economics — no public EDI advertisement, harder ask.
- **Reconsider when:** PEI shows structural shortfall on TE / Amphenol contract pricing across 3-6 months of conversion data — i.e., we're losing connector RFQs that Powell would have won on price/stock.

### Samtec direct

- **Type:** MFR-direct (board-to-board, RF, optics, high-speed connectors)
- **Anti-bot (main site):** Cloudflare passive only — `__cf_bm` cookie set, no challenge. Verified 2026-05-14.
- **Public API:** **YES — open-signup developer portal at [developer.samtec.com](https://developer.samtec.com/).** Discovered 2026-05-14 via subdomain sweep after operator asked "does Samtec have an API?" (initial classification had missed this).
- **API endpoints:**
  - `api.samtec.com/catalog/` — product catalog data
  - `api.samtec.com/pricing/` — pricing data
  - `api.samtec.com/orders/` — order management (likely 850/855 equivalent over REST)
  - Daily pricing file dump for batch ingestion (poor-man's EDI 832 equivalent), available in multiple currencies
- **Auth:** Token-based ("Got your web token?" on developer portal). Open signup, NOT partner-gated.
- **Onboarding contact:** apionboarding@samtec.com
- **Path verdict:** **Path A — open signup.** Easiest unclaimed Path A target on the entire backlog; Samtec actively wants developers consuming their data.
- **Account:** On file (no API account yet — needs signup at developer portal).
- **Notes:** Memory entry `ltd-mfr-pricing-patterns` says both Inc and Ltd manual-load Samtec — neutral pricing because both sides use MFR list. **API integration removes the manual load and gives us live lead-time + daily pricing file ingestion on both sides simultaneously.** Replaces the previous "Path C — headless feasible" classification (which was wrong because the original probe in Section 4 only checked main domain).

### Rochester Electronics

- **Type:** Specialty (EOL / obsolete / lifetime supply)
- **Anti-bot:** None — Salesforce B2B Commerce (Lightning + DXP). Verified 2026-05-14.
- **Possible undiscovered API:** `api.rocelec.com` resolves and returns 200 — but with a 491-byte body and no developer-portal links. Probably an internal Salesforce-Akamai backend, not a partner-facing API. **Ask Rochester rep during onboarding whether a partner API exists** before committing to Path C build — could be a hidden Path A.
- **Path verdict (provisional):** **Path C** (headless feasible) — cleanest Path C candidate in the backlog. Upgrade to Path A if rep confirms.
- **Auth:** Salesforce SSO.
- **Account:** On file.
- **Stage 1 signal:** NetComponents listings (Rochester posts frequently on NC — operator confirmed). Anonymous Salesforce catalog also accessible. Two free signals — pick cheaper.
- **RFQ-type applicability:** Primary value is shortage + EOL flows. Lead-time / 3PL value depends on lifetime-buy contract pricing.

### LCSC

- **Type:** Aggregator / Asian distributor channel
- **Anti-bot (main site):** None — CloudFront/S3. Verified 2026-05-14.
- **Possible Path A:** `api.lcsc.com` exists but returns CloudFront 403 "Request blocked" — partner-gated API. **Ask LCSC for API credentials before building Path C** — they may grant access on request, in which case Path A is the better answer.
- **Path verdict (provisional):** **Path A if rep grants API access; Path C otherwise.** Headless against their main site is trivial; only fall back to it if Path A is denied.
- **Auth:** Modal login on `/` (no separate /login page; 302s to `/`). API auth model TBD pending response from LCSC.
- **Notes:** Only broker/aggregator in current scope (operator decision 2026-05-14). Sourcengine / Win Source / Fusion explicitly out.

---

## 8. The "we already have it" inventory

For quick reference, suppliers already covered (Path A live) — **do not propose new integrations for these**:

DigiKey · Mouser · Arrow (+ Verical) · Future · Rutronik · TTI · Newark/Farnell/element14 · Master Electronics · Sager · Waldom · OEMSecrets

If yesterday's CalcuQuote-vs-API comparison shows a pricing gap on any of these, the gap is **commercial (account tier / regional)**, not technical. The fix is plumbing additional credentials (e.g., UK arm) into the existing API client, not building a new integration.

---

## 9. Update log

| Date | Change | Verified by |
|---|---|---|
| 2026-05-14 | Initial creation. Verified anti-bot posture for Coilcraft, Samtec, PUI Audio, Rochester, Microchip Direct, LCSC, PEI-Genesis, Powell Electronics. Established three-path × two-stage × RFQ-type framework. Dropped Sourcengine / Win Source / Fusion per scope decision. Hold on Powell pending PEI conversion data. | Jake Harris + Claude (session c19ca65b-3f97-427e-980a-cd9fd56cedcf successor) |
| 2026-05-14 | **Section 4 methodology revised** — added Step 1 subdomain sweep (developer.<domain> / api.<domain>) BEFORE main-site probe. Triggered by Samtec correction: subdomain sweep revealed [developer.samtec.com](https://developer.samtec.com/) is an open-signup API portal with Catalog / Pricing / Orders endpoints + daily pricing file. Samtec reclassified Path C → **Path A backlog**. Also noted possible hidden APIs for Rochester (api.rocelec.com 200 stub), PEI-Genesis (api.peigenesis.com 200 stub), LCSC (api.lcsc.com 403 partner-gated) — all need rep confirmation, none yet upgraded to Path A. Powell developer-subdomain hit was false positive (legacy `powellelectronics.com` domain redirected to survey-smiles.com). | Jake Harris + Claude |

---

## How to use this doc

- **New supplier appears in CalcuQuote-comparison gap analysis** → run the anti-bot probe (Section 4), fill in the intake checklist (Section 5), add a tracker row (Section 6), write a dossier (Section 7) if it goes anywhere.
- **Existing supplier reports portal changes / outages** → re-probe and update Section 7 dossier.
- **Re-validate annually** — anti-bot vendors change posture; supplier sites get re-platformed.

When adding a new supplier dossier, propagate the supplier-row from Section 6's table into the Section 7 detail block once we know enough to write more than two sentences about it.

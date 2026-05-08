# AMAT RFQ Management

**Status:** PAUSED — pending IT support to activate the supplier portal credentials and confirm 2FA delivery channel.
**Owner:** Jake Harris.
**Created:** 2026-04-28.

---

## Purpose

Pull RFQ-related data from Applied Materials' **Supplier Collaboration Vault 2.0** (SCV 2.0) — accessed via the My Applied Partner Portal at https://myapp.amat.com/Login.html — so the seller team can act on Applied's RFQs without spending the manual click-through time the portal currently demands.

This workflow is the AMAT-specific analogue to RFQ Loading (#4). RFQ Loading consumes customer email/document attachments. AMAT's RFQs do not arrive that way — they sit inside SCV 2.0 and must be scraped on a recurring basis.

---

## Why pause

The portal is gated by:

1. **Astute supplier credentials** (`AMAT_USER` / `AMAT_PASS`) — IT needs to confirm we may automate access under Applied's supplier ToU and provide the operational account to use.
2. **2-factor authentication** — Applied sends a code on each fresh login. Operator (Jake) is willing to relay codes interactively. We need to confirm the delivery channel (email vs SMS vs Authenticator app) so the run pattern can be designed correctly.

Until both are settled, no scraping runs.

---

## End-to-End Workflow

> Phase 1 (initial enablement) is the only phase active today. Phases 2-4 are scoped but not built — they will be expanded once Phase 1 is unblocked and the portal layout has been recorded.

### Phase 1 — Enablement (current)

**Step 1. IT confirms credentials + ToU.** *(Do not skip — automated access without ToU clearance is a compliance risk.)* Operator escalates to IT. IT provides the Astute supplier login that may be used for automated access and confirms it is permissible under Applied's supplier terms.

**Step 2. Operator stores credentials silently.** Run `node "Trading Analysis/AMAT RFQ Management/set-creds.js"`. The script prompts for `AMAT_USER` (visible) and `AMAT_PASS` (hidden, no-echo) and writes both to `~/workspace/.env` with mode `0600`. Credentials never appear in chat or session transcripts.

**Output:** `AMAT_USER` and `AMAT_PASS` set in `~/workspace/.env`.

**Step 3. Operator runs the login probe interactively.** Run `node "Trading Analysis/AMAT RFQ Management/login.js"`. The script:
- launches headless Chromium against https://myapp.amat.com/Login.html,
- screenshots every step into `~/workspace/amat-portal/screenshots/`,
- dumps visible form elements to stdout (so unmatched selectors can be diagnosed),
- pauses at the 2FA prompt — operator pastes the code from email/SMS,
- saves the post-login session state to `~/workspace/amat-portal/session-state.json`.

**Output:** working session cookie + screenshots confirming we landed on the SCV 2.0 dashboard.

**Step 4. Map the SCV 2.0 layout.** *(Do not skip — selectors must be recorded against a real session before any unattended run.)* With the saved session, navigate to each SCV 2.0 page that holds RFQ data the operator wants pulled. Capture URL, page structure, table schema, and pagination. Record findings in the "SCV 2.0 page map" section below.

**Output:** documented page map (URLs + fields + selectors) appended to this file.

### Phases 2-4 — Scoped, not built

| Phase | Scope | Status |
|-------|-------|--------|
| 2 | Scraper builds — one Playwright module per SCV 2.0 surface (open RFQs, line detail, attachments, etc.) | Pending Phase 1 completion |
| 3 | Normalize scrape output → RFQ load via existing RFQ Loading workflow / `shared/rfq-writer.js` | Pending Phase 2 |
| 4 | Cron entry + 2FA-aware run pattern (session reuse where possible, operator-prompt fallback) | Pending Phase 3 |

---

## Open questions (to resolve before Phase 2)

1. **What specifically inside SCV 2.0?** RFQ list, line detail, attachments, ack/decline status, schedule changes, something else? Operator to confirm before scraper modules are scoped.
2. **2FA delivery channel?** Email, SMS, Authenticator app, hardware key? Drives whether session reuse can keep 2FA infrequent or if every run needs operator interaction.
3. **Run cadence?** On-demand (operator triggers) vs scheduled (e.g., 6 AM daily). Drives how aggressively we cache the session.
4. **Output destination?** Email digest, CSV, write into OT via `shared/rfq-writer.js`, or feed into the existing `RFQ Loading` workflow? Likely the latter — but operator confirms.
5. **Does Applied have an EDI / API alternative?** If yes, scraping is the wrong tool. Worth a 5-minute check with IT during Phase 1.

---

## Files in scope

| Path | Purpose | Committed? |
|------|---------|------------|
| `Trading Analysis/AMAT RFQ Management/amat-rfq-management.md` | This file. | Yes |
| `Trading Analysis/AMAT RFQ Management/set-creds.js` | Silent credential prompt → `.env`. | Yes |
| `Trading Analysis/AMAT RFQ Management/login.js` | Login probe (Phase 1, Step 3). | Yes |
| `~/workspace/.env` | Holds `AMAT_USER` / `AMAT_PASS` (and other secrets). | No (gitignored) |
| `~/workspace/amat-portal/screenshots/*.png` | Step-by-step captures from each login probe run. May contain authenticated UI — keep local. | No |
| `~/workspace/amat-portal/session-state.json` | Saved Playwright auth cookies. **Treat as a credential.** | No |

---

## Risks / things to flag up front

- **Applied's supplier ToU** may prohibit automated access even with valid credentials. Step 1 confirms.
- **Portal HTML can change without notice.** Selectors will break occasionally and need re-tuning. Expect maintenance.
- **MFA cookies expire.** Run pattern must gracefully fall back to operator-prompted 2FA when the saved session is rejected.
- **Session-state.json is sensitive.** It's effectively a logged-in cookie jar. It lives outside the repo for that reason.

---

## SCV 2.0 page map

*(Filled in during Phase 1, Step 4. Empty until then.)*

| Surface | URL | Key columns / fields | Selectors | Pagination |
|---------|-----|----------------------|-----------|------------|
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

---

## Related workflows

- **RFQ Loading** (`Trading Analysis/RFQ Loading/rfq-loading.md`) — likely consumer of the normalized scrape output.
- **Stock RFQ Loading** (`Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md`) — broker-side analogue; pattern for end-to-end automation that may be reused.
- **Vortex Matches** / **Quick Quote** — downstream surfaces that will benefit once AMAT RFQs flow into OT.

# Broker Offers - STEP 3: Per-message decision tree
#
# This file contains the workflow-specific decision logic for Broker Offers.

For each unseen message, follow the per-message decision tree:

## 2.1 JUNK CHECK

Route to `not_offer` if:
- Subject matches OOO / auto-reply / undeliverable / bounce / read-receipt / newsletter
- Body contains SMTP bounce headers (Reporting-MTA:, Final-Recipient:, Diagnostic-Code:)
- Empty body AND no parseable attachment

## 2.2 PARTNER RESOLUTION

Try in order, first match wins:
- **Subject hint:** MO_<NNNNN>, Search Key <NNNNN>, [#<NNNNN>] → use BP search key directly
- **Body hint:** BP: <NNNNN>, Partner: <NNNNN>, Vendor: <NNNNN>
- **Forward chain:** parse all From: lines in body; prefer deepest non-@astutegroup.com sender. Resolve via shared/partner-lookup.js 4-tier resolver (exact email → email domain → domain hint → name match)
- **External direct send:** outer From not @astutegroup.com → resolve via partner-lookup
- **Company-name fallback:** scan subject/body for clearly-named company → resolvePartner({ companyName: '<name>', partnerType: 'vendor' })
- If no match + lines extracted → clarify_partner (sidecar + email Jake)
- If no match + no lines → needs_partner (email Jake)

## 2.3 LINE EXTRACTION

- Download attachments if has_attachment is true. Prefer xlsx > csv > pdf.
- For xlsx/csv: look for MPN column (synonyms: mpn, part number, mfr part, aml, p/n). Other columns: qty, price, mfr, dateCode, description, cpc.
- For pdf: use Read tool, extract tabular content if confident.
- Try HTML body (inline tables) and plaintext body (tab/pipe-delimited).
- Plain-prose lists count: qty/mfr/mpn on consecutive lines = valid offer.
- Filter junk MPNs: reject URL fragments, footer/signature noise.
- If 0 valid lines → needs_review with reason "no parseable lines"

**IMAGE ATTACHMENTS (screenshot offer sheets):**

The `read` JSON includes an `images` array. If:
- Any image has `isLikelyContent: true` (≥20KB, not inline signature), OR
- Body text is sparse (<50 chars of actual content after stripping signatures), OR
- The expected data (MPN list) is missing from the text body

Then the offer data may be in an image:

1. Run: `node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js download-attachments <uid> --workflow broker-offers --include-images`
2. Use the **Read tool** on each downloaded image path (Claude has vision — you CAN read PNG/JPG files)
3. Extract MPN, qty, price, MFR, date code, COO from the image just as you would from text
4. Proceed with the normal routing flow using the extracted data

## 2.4 OFFER TYPE DETERMINATION

Agent decides based on signals:

| Signal                                                        | → Offer Type              |
|---------------------------------------------------------------|---------------------------|
| Body hint "Type: Broker"                                       | 1000001 (Broker Stock)    |
| Body hint "Type: Franchise" or "Type: Franchise Offers"        | 1000002 (Franchise Offers)|
| Body hint "Type: Franchise Stock"                              | 1000004 (Franchise Stock) |
| Sender domain = known franchise (Arrow, Avnet, Digi-Key, etc.) | 1000002 or 1000004        |
| Subject/body contains "liquidation", "excess", "lot", "closeout"| 1000001 (Broker Stock)    |
| Subject/body contains "franchise", "authorized", "stock offer"  | 1000004 (Franchise Stock) |
| Default unknown broker                                         | 1000001 (Broker Stock)    |

## 2.5 CROSS-FORWARD DEDUP CHECK

Query for recent offer from same BP + same type + same line count + first/last MPN match.
If found → dup_skip with existingSearchKey.

## 2.6 WRITE TO OT

Route to load_offer with payload:
```json
{
  "bpartnerId": "<resolved BP ID>",
  "offerType": "<1000001 | 1000002 | 1000004>",
  "lines": [ { "mpn": "...", "mfr": "...", "qty": 0, "price": 0, "dateCode": "...", "coo": "...", "cpc": "..." } ],
  "partnerName": "<resolved partner name>",
  "originalSender": "<outer From email>",
  "originalCc": ["<array of CC emails>"],
  "originalSubject": "<email subject>"
}
```

## REPLY-STITCH HANDLING

If a message has pending_state (from a prior clarify_partner sidecar):

**Reply-directive check (run before merge).** Call `parseSidecarReplyDirective` on the reply body:
`node -e "const g=require('/home/analytics_user/workspace/astute-workinstructions/shared/workflow-reply-grammars'); console.log(JSON.stringify(g.parseSidecarReplyDirective(\`<body text>\`)))"`

- `directive: 'DROP'` (operator typed SKIP / DROP / IGNORE / DISCARD on the first non-quoted line) → route `drop_pending`. STOP — do not merge.
- `directive: 'MERGE'` → continue with the merge logic below.

Merge logic:
- Merge pending_state.extracted with the current reply body
- Check if Jake provided a company name or BP search key
- If so, resolve the partner and route to load_offer with full merged payload
- If still unresolved and retry_count < 2, re-route clarify_partner
- If retry_count >= 2, route to needs_partner with reason "clarify_partner round-tripped 2x; operator replies haven't resolved the partner — manual triage needed"

## ERROR HANDLING

- If any single message hits a transient error (writeOffer 5xx, partner lookup throws), log it and continue with the next message. Do not abort the batch.
- Email Jake a one-line summary at the end if any errored.

## RATE-LIMITED DEFERRAL HANDLING

When `load_offer` returns `{ rateLimited: true, ... }`:
- If `alreadyDeferred: false` → this is the FIRST deferral. Send ONE notification to Jake explaining the budget exhaustion. The email will stay UNSEEN for automatic retry.
- If `alreadyDeferred: true` → this is a REPEAT deferral (budget still exhausted). Do NOT send another notification. Just exit silently — the email remains UNSEEN and will retry on the next tick when budget resets.

CRITICAL: Repeat notifications for the same deferred email waste Jake's inbox and provide no new information. The handler tracks deferral state via breadcrumbs.

## EXIT

If 0 unseen messages, exit silently.

## NOTIFICATION POLICY (CRITICAL)

- All notifications go to Jake (jake.harris@Astutegroup.com) + internal Astute CC'd parties
- NEVER send notifications to external brokers/franchises
- clarify_partner → emails Jake only (Reply-To: brokeroffers@ for sidecar round-trip)
- load_offer confirmation → internal parties only; excludes external sender

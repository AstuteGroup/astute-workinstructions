/**
 * Send the developer-call summary email to Jake.
 * Three findings from today's LAM Kitting Fuses submission via API.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { createNotifier } = require('../../shared/notifier');

const TO = 'jake.harris@Astutegroup.com';
const SUBJECT = 'OT findings from LAM Kitting API submission (Apr 9) — for dev call';

const BODY = `Hi Jake,

Summary of what we proved end-to-end via the iDempiere REST API today, plus 3 items for the dev conversation. All references in OT-speak.

================================================================
WORKING TODAY — R_Request 1157760, DocumentNo 1155666
================================================================

Posted via: POST /api/v1/models/R_Request

Payload fields:
  R_RequestType_ID     = 1000000   (Approve Order)
  R_Status_ID          = 1000000   (Submitted)
  Priority             = '5'
  Chuboe_RFQ_ID        = 1141455   (RFQ DocumentNo 1132040)
  C_BPartner_ID        = 1001105   (Fuses Unlimited, search_key 1003109)
  SalesRep_ID          = 1000004   (Jake Harris)
  Summary              = 'Please approve LAM Kitting orders'
  Chuboe_Approval_Text = <verbatim Copy Text from OT, 4190 chars>

Backed by 4 adempiere.chuboe_vq_line records with IsPurchased='Y' and full Tier 2 fields populated (C_BPartner_Location_ID, Chuboe_Warehouse_Group_ID, Chuboe_Warehouse_ID, M_Shipper_ID, Chuboe_Inco_Term_ID, DatePromised, DueDate, Chuboe_Packaging_ID):

  chuboe_vq_line_id  RFQ Line  MPN              Qty  Cost
  -----------------  --------  ---------------  ---  -------
  2004665            110       LP-CC-30          30  24.0308
  2004668            210       KLKR007.T         20  19.1480
  2004670            1540      #ABC-12          105   0.2707
  2004674            2020      S505H-500-R      200   1.1036

Plus 1 data-capture VQ on RFQ 1131217:
  2004760            1670      1A1119-10-R      850   0.3274


================================================================
ITEM 1 — Traceability mapping bug in vq-writer.js
================================================================

File: shared/vq-writer.js
Function: deriveTraceability(vendorTypeId)

Current logic:
  return vendorTypeId === 1000002 ? 1000001 : 1000003;

Maps ONLY Chuboe_VendorType_ID = 1000002 (Franchise) to Chuboe_Traceability_ID = 1000001 (Authorized Distribution Certs). Every other vendor type falls through to 1000003 (Non-Traceable).

Vendor types that SHOULD also map to 1000001 per Astute classification (all authorized channels):
  1000001  Manufacture Direct Component
  1000002  Franchise                      (already correct)
  1000007  Manufacture Direct Assemblies
  1000008  Catalog                        (DigiKey, Mouser, Newark, TTI, Waldom, Fuses Unlimited, ...)
  1000009  Online Distributor             (Avnet, ...)

Note: this exact set is ALREADY declared in vq-writer.js as MFR_DIRECT_OR_FRANCHISE for date-code defaulting — it just wasn't reused inside deriveTraceability().

Caught today on Fuses Unlimited (Chuboe_VendorType_ID = 1000008). Patched the 5 Fuses VQs manually via PATCH /api/v1/models/Chuboe_VQ_Line/{id} { Chuboe_Traceability_ID: 1000001 }.

OPEN — backfill scope:
On RFQ 1132040 (chuboe_rfq.value = '1132040', chuboe_rfq_id = 1141455) alone, the following historical chuboe_vq_line records have the wrong traceability:

  94 records  Chuboe_VendorType_ID = 1000008 (Catalog)            -> currently 1000003 Non-Traceable
   2 records  Chuboe_VendorType_ID = 1000009 (Online Distributor) -> currently 1000003 Non-Traceable

The same writer has been used across other RFQs and workflows (Stock RFQ Loading, LAM Kitting, RFQ API Enrichment, Market Offer Analysis, HTS/ECCN Backfill). Backfill scope is potentially much larger.

Lookup tables:
  adempiere.chuboe_vendortype                       (vendor type definitions)
  adempiere.chuboe_traceability                     (4 rows: 1000000 OCM, 1000001 Auth Dist Certs, 1000002 Packing Slip, 1000003 Non-Traceable)
  adempiere.c_bpartner.chuboe_vendortype_id         (vendor's classification)
  adempiere.chuboe_vq_line.chuboe_traceability_id   (the field set at write time)

Need from dev: confirm the rule and decide whether/how to backfill.


================================================================
ITEM 2 — Need access to adempiere.chuboe_rfq_colsql_v
================================================================

This view generates the "Copy Text" content (the structured RFQ + RFQ Line + Vendor Quote blocks) that lands in adempiere.r_request.chuboe_approval_text when an Approve Order is created in OT.

Current state:
  - View exists in production iDempiere DB
  - NOT replicated to the analytics replica (cannot query from psql side; pg_class returns 0 rows for any name variant)
  - REST API CAN see the model — GET /api/v1/models/Chuboe_RFQ_ColSql_V — but the framework auto-injects WHERE isactive='Y' and the view has no isactive column. Returns:
      500 GET Error
      org.postgresql.util.PSQLException: ERROR: column "isactive" does not exist
        Position: 48

Impact on the API workflow:
Today's submission required Jake to open a new Approve Order request tab in OT manually so OT would render the view, then copy the text and paste it into the terminal so the script could embed it in the Chuboe_Approval_Text field of the POST. This works for one batch on a small RFQ but breaks down on:
  - Larger RFQs where the same RFQ has multiple submission batches over time. The OT-rendered Copy Text dumps EVERY chuboe_vq_line where IsPurchased='Y' for the RFQ — so on batch 2, the dump includes batch 1's already-submitted lines and the user has to manually filter visually.
  - Any fully-automated cron / no-human-in-loop submissions.

Asks (any one of these unblocks automation):
  A) Add chuboe_rfq_colsql_v to the analytics replication slot. I'd query it via psql with a Chuboe_RFQ_ID + vq_line_id filter.
  B) Remove or override the auto-isactive filter on this specific view in the REST API metadata (AD_Table or system config). Then GET /api/v1/models/Chuboe_RFQ_ColSql_V?\$filter=Chuboe_RFQ_ID eq X works.
  C) Share the view DDL: pg_dump --schema-only -t adempiere.chuboe_rfq_colsql_v on prod. I rebuild it in the analytics replica and query locally. Drift risk if Chuck ever changes the prod definition.
  D) Expose a process/report endpoint that takes (Chuboe_RFQ_ID, list of Chuboe_VQ_Line_ID values) and returns the rendered text. Cleanest long-term — the support team's expected text becomes a parameterized API call.

My preference: D > A > B > C.


================================================================
ITEM 3 — "Message to User" field identification
================================================================

I dumped all 70 columns on adempiere.r_request and could not find a dedicated "Message to User" field. Text columns I see and what they actually contain in the wild:

  Column                    Type      Fill rate (last 7d Approve Orders, n=116)   Notes
  ------------------------  --------  ------------------------------------------  ---------------------------------------
  summary                   varchar   116/116 (100%)                              Short subject line
  chuboe_approval_text      text      113/116 ( 97%)                              Structured Copy Text body — canonical
  result                    text       10/116 (  9%)                              When filled, DUPLICATES chuboe_approval_text — not a separate user message
  lastresult                varchar   varies                                      Auto-managed audit log of last action
  nextaction                char       universally 'F'                            Single-char enum
  chuboe_usernotify_id      ARRAY       0/116                                     Never set on Approve Orders
  ad_user_id                numeric     0/116                                     Never set on Approve Orders

None of these match the OT UI label "Message to User" semantically. Need to confirm:
  - Is "Message to User" a label on the Create Request window that maps to one of these columns? (My guess: it could be summary if OT renames it in the UI.)
  - Or is it UI-only / part of an email notification template that doesn't persist to r_request?
  - Or is there a column elsewhere (a join table?) that I should be looking at?

Why this matters:
Once we know the right field, every Approve Order auto-written via API should include a leading line in the message field listing the RFQ line numbers being submitted in this batch:

  RFQ Lines: 110, 210, 1540, 2020

This is a real productivity win for the data entry team — currently they have to scan the 4000+ char Chuboe_Approval_Text body to find each "RFQ Line #:" header. On a 20-line batch this gets painful.


================================================================
WORKFLOW PROVEN END-TO-END
================================================================

Step 1 - Load VQs                  POST  /api/v1/models/Chuboe_VQ_Line       (shared/vq-writer.js)
Step 2 - Patch Tier 2 + IsPurchased PUT   /api/v1/models/Chuboe_VQ_Line/{id}  (shared/record-updater.js)
Step 3 - Generate Copy Text         <manual via OT today — blocked on Item 2>
Step 4 - POST Approve Order         POST  /api/v1/models/R_Request           (proven today, R_Request 1157760)

Steps 1, 2, 4 are fully automated. Step 3 is the only manual step in the chain — unblocking it via Item 2 above gives us hands-off batch submissions.

Let me know after the dev call which path forward (Item 2 option A/B/C/D) and which column maps to "Message to User" (Item 3) and I'll wire up the renderer/parser accordingly.

— Claude (via Jake's analytics terminal)
`;

(async () => {
  const notifier = createNotifier({
    fromEmail: 'vortex@orangetsunami.com',
    fromName: 'Analytics Terminal',
    smtpPass: process.env.WORKMAIL_PASS,
  });
  const ok = await notifier.sendEmail(TO, SUBJECT, BODY);
  console.log(ok ? `✓ Sent to ${TO}` : `✗ Failed to send to ${TO}`);
})().catch(e => { console.error(e); process.exit(1); });

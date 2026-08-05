#!/usr/bin/env node
/**
 * Check RFQ creation history
 */

const { psqlQuery } = require('../shared/db-helpers');

async function main() {
  console.log('=== RFQ creation details ===');
  const rfqs = psqlQuery(`
    SELECT
      rfq.value as rfq_value,
      rfq.created,
      u.name as created_by,
      rfq.description
    FROM chuboe_rfq rfq
    LEFT JOIN ad_user u ON rfq.createdby = u.ad_user_id
    WHERE rfq.value IN ('1140512', '1140676', '1140942')
    ORDER BY rfq.created DESC
  `);
  console.log(rfqs);

  console.log('\n=== How was 550-2205F added to RFQ 1140676? ===');
  const lineDetails = psqlQuery(`
    SELECT
      rl.chuboe_rfq_line_id,
      rl.created,
      u.name as created_by,
      rlm.chuboe_mpn
    FROM chuboe_rfq rfq
    JOIN chuboe_rfq_line rl ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    JOIN chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    LEFT JOIN ad_user u ON rl.createdby = u.ad_user_id
    WHERE rfq.value = '1140676'
    AND UPPER(rlm.chuboe_mpn) LIKE '%550-2205%'
  `);
  console.log(lineDetails);

  console.log('\n=== Check: What changed in POV lookup between weeks? ===');
  // Check if PO803997 status or data changed recently
  const poHistory = psqlQuery(`
    SELECT
      o.documentno,
      o.docstatus,
      o.created::date as po_created,
      o.updated::date as po_updated,
      ol.chuboe_po_string,
      ol.updated::date as line_updated
    FROM c_order o
    JOIN c_orderline ol ON o.c_order_id = ol.c_order_id
    WHERE o.documentno = 'PO803997'
  `);
  console.log(poHistory || '(not found)');
}

main().catch(console.error);

/**
 * PATCH Tier 2 PO-processing fields onto the 4 Fuses VQs loaded today on RFQ 1132040.
 * Marks them IsPurchased=Y so they're ready for PO creation in OT.
 *
 * Per Jake (2026-04-09): all 4 ship from Fuses Unlimited (V000117), receive at
 * BROWNSVILLE / W111 LAM KITTING, FedEx Ground, EXW, promise/due 2026-04-16
 * (today + 5 business days, all are stock).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { patchRecord } = require('../../shared/record-updater');

const VQ_IDS = [2004665, 2004668, 2004670, 2004674];

const PATCH = {
  C_BPartner_Location_ID:     1001395, // V000117 - Fuses Unlimited
  Chuboe_Warehouse_Group_ID:  1000008, // BROWNSVILLE
  Chuboe_Warehouse_ID:        1000015, // W111: LAM KITTING
  M_Shipper_ID:               1000003, // FedEx Ground
  Chuboe_Inco_Term_ID:        1000000, // EXW - Ex Works
  Chuboe_Packaging_ID:        1000010, // OTHER
  DatePromised:               '2026-04-16',
  DueDate:                    '2026-04-16',
  IsPurchased:                'Y',
};

async function main() {
  console.log(`[fuses-tier2] PATCH ${VQ_IDS.length} VQs with Tier 2 fields`);
  for (const id of VQ_IDS) {
    try {
      await patchRecord('Chuboe_VQ_Line', id, PATCH);
      console.log(`  ✓ ${id}`);
    } catch (e) {
      console.log(`  ✗ ${id}  ${e.message.substring(0, 200)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

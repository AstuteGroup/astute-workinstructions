#!/bin/bash
# Dump system VQs + RFQ-line data for a given RFQ + (optional) mirror.
#
# Usage:
#   ./dump-rfq-data.sh <rfq_chuboe_id> [mirror_chuboe_id] <scratch_dir>
#
# Example:
#   ./dump-rfq-data.sh 1142001 1142008 ~/workspace/scratch/cq-rfq-1132586

ORIG=$1
if [[ -z $ORIG ]]; then
  echo "Usage: $0 <rfq_chuboe_id> [mirror_chuboe_id] <scratch_dir>" >&2
  exit 1
fi

# Detect whether arg 2 is the mirror or the scratch dir
if [[ $2 == /* || $2 == ~* ]]; then
  MIRROR=""
  SCRATCH=$2
else
  MIRROR=$2
  SCRATCH=$3
fi

if [[ -z $SCRATCH ]]; then
  echo "scratch dir required" >&2
  exit 1
fi

mkdir -p "$SCRATCH"

# RFQ ID list
if [[ -n $MIRROR ]]; then
  RFQ_LIST="$ORIG, $MIRROR"
else
  RFQ_LIST="$ORIG"
fi

# 1. VQ dump
psql --csv -P pager=off -c "SELECT v.chuboe_rfq_id, v.chuboe_vq_line_id AS vq_id, v.chuboe_mpn AS mpn, v.chuboe_mfr_text AS mfr_text, bp.name AS vendor_name, bp.value AS vendor_key, v.qty, v.cost, v.chuboe_lead_time AS lead_time, v.chuboe_date_code AS date_code, v.chuboe_traceability_id AS traceability_id, v.created::date AS created_date, v.chuboe_rfq_line_id AS rfq_line_id FROM adempiere.chuboe_vq_line v LEFT JOIN adempiere.c_bpartner bp ON v.c_bpartner_id = bp.c_bpartner_id WHERE v.chuboe_rfq_id IN ($RFQ_LIST) AND v.isactive='Y' ORDER BY v.chuboe_rfq_id, v.chuboe_mpn" -o "$SCRATCH/system-vqs.csv"
echo "Wrote $SCRATCH/system-vqs.csv ($(wc -l < "$SCRATCH/system-vqs.csv") rows incl header)"

# 2. RFQ line + accepted MPN dump (original only — mirror has same lines)
psql --csv -P pager=off -c "SELECT l.chuboe_rfq_line_id AS line_id, l.chuboe_cpc AS cpc, l.chuboe_mpn AS line_primary_mpn, l.description AS line_desc, l.qty AS line_qty, lm.chuboe_mpn AS accepted_mpn FROM adempiere.chuboe_rfq_line l LEFT JOIN adempiere.chuboe_rfq_line_mpn lm ON l.chuboe_rfq_line_id = lm.chuboe_rfq_line_id AND lm.isactive='Y' WHERE l.chuboe_rfq_id = $ORIG AND l.isactive='Y' ORDER BY l.chuboe_rfq_line_id" -o "$SCRATCH/rfq-lines.csv"
echo "Wrote $SCRATCH/rfq-lines.csv ($(wc -l < "$SCRATCH/rfq-lines.csv") rows incl header)"

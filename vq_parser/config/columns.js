// CSV column names matching the chuboe_vq_line DB table
const VQ_COLUMNS = [
  'chuboe_rfq_id',
  'chuboe_buyer_id',
  'c_bpartner_id',
  'ad_user_id',
  'chuboe_mpn',
  'chuboe_mfr_text',
  'qty',
  'cost',
  'c_currency_id',
  'chuboe_date_code',
  'chuboe_moq',
  'chuboe_spq',
  'chuboe_packaging_id',
  'chuboe_lead_time',
  'c_country_id',
  'chuboe_rohs',
  'chuboe_note_public'
];

// Old friendly name → DB column name mapping (for internal reference)
const FRIENDLY_TO_DB = {
  'RFQ Search Key': 'chuboe_rfq_id',
  'Buyer': 'chuboe_buyer_id',
  'Business Partner Search Key': 'c_bpartner_id',
  'Contact': 'ad_user_id',
  'MPN': 'chuboe_mpn',
  'MFR Text': 'chuboe_mfr_text',
  'Quoted Quantity': 'qty',
  'Cost': 'cost',
  'Currency': 'c_currency_id',
  'Date Code': 'chuboe_date_code',
  'MOQ': 'chuboe_moq',
  'SPQ': 'chuboe_spq',
  'Packaging': 'chuboe_packaging_id',
  'Lead Time': 'chuboe_lead_time',
  'COO': 'c_country_id',
  'RoHS': 'chuboe_rohs',
  'Vendor Notes': 'chuboe_note_public'
};

// Map email addresses to buyer names
const BUYER_EMAIL_MAP = {
  'jake.harris@astutegroup.com': 'Jake Harris',
  'jake@astutegroup.com': 'Jake Harris',
};

// Common column name aliases for fuzzy matching (used by parsers to recognize email columns)
const COLUMN_ALIASES = {
  'chuboe_rfq_id': ['rfq', 'rfq#', 'rfq number', 'ref', 'reference', 'quote ref'],
  'chuboe_mpn': ['mpn', 'part number', 'part#', 'part #', 'p/n', 'pn', 'mfr part', 'mfg part', 'manufacturer part', 'component'],
  'chuboe_mfr_text': ['manufacturer', 'mfr', 'mfg', 'brand', 'make', 'vendor mfr'],
  'qty': ['qty', 'quantity', 'qty available', 'available', 'stock', 'avail qty', 'avail'],
  'cost': ['price', 'unit price', 'cost', 'unit cost', 'ea', 'each', 'price each', 'price/unit', 'up'],
  'c_currency_id': ['currency', 'cur', 'ccy'],
  'chuboe_date_code': ['date code', 'dc', 'datecode', 'd/c', 'date_code', 'lot'],
  'chuboe_moq': ['moq', 'min qty', 'minimum order', 'min order qty', 'minimum'],
  'chuboe_spq': ['spq', 'std pack', 'standard pack', 'pack qty', 'std pkg'],
  'chuboe_packaging_id': ['packaging', 'package', 'pkg', 'pack type', 'packing'],
  'chuboe_lead_time': ['lead time', 'leadtime', 'lt', 'delivery', 'lead', 'ard', 'eta', 'availability'],
  'c_country_id': ['coo', 'country', 'country of origin', 'origin', 'made in'],
  'chuboe_rohs': ['rohs', 'rohs compliant', 'rohs status', 'reach'],
  'chuboe_note_public': ['notes', 'remarks', 'comments', 'description', 'note', 'remark'],
  'ad_user_id': ['contact', 'contact name', 'rep', 'sales rep'],
  'chuboe_buyer_id': ['buyer', 'buyer name', 'requested by'],
  'c_bpartner_id': ['vendor', 'supplier', 'bp', 'business partner', 'vendor code']
};

module.exports = { VQ_COLUMNS, FRIENDLY_TO_DB, BUYER_EMAIL_MAP, COLUMN_ALIASES };

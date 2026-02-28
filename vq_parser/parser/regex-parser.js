const { cleanString, stripCurrency, stripHtmlTags } = require('../utils/sanitize');
const logger = require('../utils/logger');

const FIELD_PATTERNS = {
  MPN: [
    /(?:MPN|Part\s*(?:Number|#|No\.?)|P\/N|PN)\s*[:=\-]?\s*([A-Z0-9][A-Z0-9\-\/\.#\+]+)/i,
    /\bof\s+([A-Z0-9][A-Z0-9\-\/\.#]{3,})\s+(?:at|for|@)\b/i,
  ],
  'MFR Text': [
    /(?:Manufacturer|MFR|MFG|Brand)\s*[:=\-]?\s*([A-Za-z][A-Za-z\s&\.]+?)(?:\s*$|\s*[,;|\t])/im,
  ],
  'Cost': [
    /(?:Price|Cost|Unit\s*Price|Sell\s*Price|UP)(?:\s*\([^)]*\))?\s*[:=\-]?\s*\$?\s*([\d,]+\.?\d{0,5})/i,
    /\$\s*([\d,]+\.?\d{0,4})/,
  ],
  'Quoted Quantity': [
    /(?:Qty|Quantity|Quoted\s*Qty|QTY\s*Available|Stock|Avail(?:able)?)\s*[:=\-]?\s*([\d,]+)/i,
    /(\d[\d,]*)\s*(?:pcs?|pieces?|units?|ea)\b/i,
  ],
  'Date Code': [
    /(?:Date\s*Code|DC|D\/C)\s*[:=\-]?\s*([A-Z0-9\+\/\-\s]{2,20})/i,
  ],
  'MOQ': [
    /(?:MOQ|Min(?:imum)?\s*(?:Order)?\s*Qty)\s*[:=\-]?\s*([\d,]+)/i,
  ],
  'SPQ': [
    /(?:SPQ|Std\.?\s*Pack|Standard\s*Pack)\s*[:=\-]?\s*([\d,]+)/i,
  ],
  'Packaging': [
    /(?:Packaging|Package|Pkg)\s*[:=\-]?\s*(Tray|Tube|Reel|Tape|Bulk|Cut\s*Tape|DryPack|Bag|Box)/i,
  ],
  'Lead Time': [
    /(?:Lead\s*Time|LT|Delivery|ETA|ARD|LT\s*\([^)]*\))\s*[:=\-]?\s*([^\n,;]{2,30})/i,
    /\b(In\s*Stock|Stock|(\d+)\s*(?:days?|weeks?|wks?))\b/i,
  ],
  'COO': [
    /(?:COO|Country(?:\s*of\s*Origin)?|Origin|Made\s*in)\s*[:=\-]?\s*([A-Za-z\s]{2,20})/i,
  ],
  'RoHS': [
    /(?:RoHS)\s*[:=\-]?\s*(Yes|No|Y|N|Compliant|Non-Compliant)/i,
  ],
  'Vendor Notes': [
    /(?:Remark|Remarks|Notes?|Comments?)\s*[:=\-]?\s*([^\n]+)/i,
  ],
};

// Known KV keys for detecting key-value pair format
const KV_KEYS = [
  'customer', 'mfg', 'mfr', 'manufacturer', 'brand',
  'mpn requested', 'mpn quote', 'mpn', 'part number', 'p/n', 'pn', 'part#',
  'mfr part', 'mfr part number',
  'sell price(usd)', 'sell price (usd)', 'price', 'unit price', 'cost',
  'price (usd)', 'price(usd)', 'up', 'unit cost',
  'quoted qty', 'qty', 'quantity', 'qty available', 'available qty',
  'date code', 'dc', 'd/c',
  'moq', 'min qty', 'minimum order qty',
  'spq', 'std pack', 'standard pack',
  'packaging', 'package', 'pkg',
  'lead time', 'lt', 'lt(weeks)', 'lt (weeks)', 'delivery', 'eta',
  'coo', 'country of origin', 'origin', 'country',
  'rohs',
  'remark', 'remarks', 'notes', 'note', 'comment', 'comments',
  'amount', 'total',
];


// Detect multi-line KV format where key is on one line and value on the next
function parseMultiLineKV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const kvPairs = {};
  
  for (let i = 0; i < lines.length - 1; i++) {
    const key = lines[i].toLowerCase();
    const value = lines[i + 1];
    
    // Check if current line is a known key and next line looks like a value (not another key)
    if (KV_KEYS.some(k => key === k) && value && !KV_KEYS.some(k => value.toLowerCase() === k)) {
      kvPairs[key] = value.trim();
      i++; // skip the value line
    }
  }
  
  return kvPairs;
}

// Detect key-value pair format
function parseKeyValuePairs(text) {
  const lines = text.split('\n');
  const kvPairs = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Try tab-separated key-value
    let parts = line.split('\t').map(s => s.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const key = parts[0].toLowerCase();
      if (KV_KEYS.some(k => key === k || key.startsWith(k))) {
        kvPairs[key] = parts.slice(1).join(' ').trim();
        continue;
      }
    }

    // Try multi-space separator (2+ spaces)
    const spaceMatch = line.match(/^(.+?)\s{2,}(.+)$/);
    if (spaceMatch) {
      const key = spaceMatch[1].trim().toLowerCase();
      const value = spaceMatch[2].trim();
      if (KV_KEYS.some(k => key === k || key.startsWith(k))) {
        kvPairs[key] = value;
        continue;
      }
    }

    // Try single-space separator for known keys (e.g. 'Sell Price(USD) $0.31')
    const singleSpaceMatch = line.match(/^([A-Za-z][A-Za-z\s]*(?:\([^)]*\))?)\s+(.+)$/);
    if (singleSpaceMatch) {
      const key = singleSpaceMatch[1].trim().toLowerCase();
      const value = singleSpaceMatch[2].trim();
      if (KV_KEYS.some(k => key === k)) {
        kvPairs[key] = value;
        continue;
      }
    }

    // Try colon separator
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && colonIdx < 40) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      if (KV_KEYS.some(k => key === k || key.startsWith(k)) && value) {
        kvPairs[key] = value;
        continue;
      }
    }
  }

  return kvPairs;
}

function mapKVToFields(kvPairs) {
  const line = {};
  const kvMap = {
    'mpn requested': 'MPN', 'mpn quote': 'MPN', 'mpn': 'MPN',
    'part number': 'MPN', 'p/n': 'MPN', 'pn': 'MPN', 'part#': 'MPN',
    'mfr part': 'MPN', 'mfr part number': 'MPN',
    'mfg': 'MFR Text', 'mfr': 'MFR Text', 'manufacturer': 'MFR Text', 'brand': 'MFR Text',
    'sell price(usd)': 'Cost', 'sell price (usd)': 'Cost', 'price': 'Cost',
    'unit price': 'Cost', 'cost': 'Cost', 'unit cost': 'Cost',
    'price (usd)': 'Cost', 'price(usd)': 'Cost', 'up': 'Cost',
    'quoted qty': 'Quoted Quantity', 'qty': 'Quoted Quantity', 'quantity': 'Quoted Quantity',
    'qty available': 'Quoted Quantity', 'available qty': 'Quoted Quantity',
    'date code': 'Date Code', 'dc': 'Date Code', 'd/c': 'Date Code',
    'moq': 'MOQ', 'min qty': 'MOQ', 'minimum order qty': 'MOQ',
    'spq': 'SPQ', 'std pack': 'SPQ', 'standard pack': 'SPQ',
    'packaging': 'Packaging', 'package': 'Packaging', 'pkg': 'Packaging',
    'lead time': 'Lead Time', 'lt': 'Lead Time', 'lt(weeks)': 'Lead Time',
    'lt (weeks)': 'Lead Time', 'delivery': 'Lead Time', 'eta': 'Lead Time',
    'coo': 'COO', 'country of origin': 'COO', 'origin': 'COO', 'country': 'COO',
    'rohs': 'RoHS',
    'remark': 'Vendor Notes', 'remarks': 'Vendor Notes', 'notes': 'Vendor Notes',
    'note': 'Vendor Notes', 'comment': 'Vendor Notes', 'comments': 'Vendor Notes',
  };

  for (const [key, value] of Object.entries(kvPairs)) {
    const field = kvMap[key];
    if (field && value) {
      // Prefer "MPN Quote" over "MPN Requested"
      if (field === 'MPN' && line['MPN'] && key.includes('requested')) continue;
      // Overwrite MPN with "MPN Quote" if we already have "MPN Requested"
      if (field === 'MPN' && key.includes('quote')) {
        line[field] = cleanString(value);
        continue;
      }
      if (!line[field]) {
        line[field] = cleanString(value);
      }
    }
  }

  return line;
}

function parseWithRegex(text) {
  const plainText = stripHtmlTags(text);

  // Skip KV parsing for HTML content - let table parser handle it
  const isHtml = /<table/i.test(text);

  // Strategy A0: Try multi-line KV extraction first (key on one line, value on next)
  if (!isHtml) {
    const mlKV = parseMultiLineKV(plainText);
    const mlMapped = mapKVToFields(mlKV);
    const mlFieldCount = Object.keys(mlMapped).filter(k => mlMapped[k]).length;
    if (mlFieldCount >= 3 && (mlMapped['MPN'] || mlMapped['Cost'])) {
      logger.debug('Regex: Multi-line KV pair extraction succeeded');
      return {
        lines: [mlMapped],
        confidence: mlFieldCount >= 5 ? 0.8 : 0.6
      };
    }
  }

  // Strategy A: Try key-value pair extraction first (skip for HTML)
  const kvPairs = parseKeyValuePairs(plainText);
  const kvFieldCount = Object.keys(kvPairs).filter(k => {
    const kvMap = {
      'mpn requested': 1, 'mpn quote': 1, 'mpn': 1, 'part number': 1, 'p/n': 1,
      'mfg': 1, 'mfr': 1, 'manufacturer': 1,
      'sell price(usd)': 1, 'price': 1, 'unit price': 1, 'cost': 1,
      'quoted qty': 1, 'qty': 1, 'quantity': 1,
      'date code': 1, 'dc': 1, 'd/c': 1,
      'spq': 1, 'moq': 1, 'lt': 1, 'lt(weeks)': 1, 'lead time': 1,
      'remark': 1, 'remarks': 1, 'notes': 1,
    };
    return kvMap[k];
  }).length;

  if (kvFieldCount >= 3 && !isHtml) {
    const kvLine = mapKVToFields(kvPairs);
    if (kvLine['MPN'] || kvLine['Cost']) {
      logger.debug('Regex: KV pair extraction succeeded');
      return {
        lines: [kvLine],
        confidence: kvFieldCount >= 5 ? 0.8 : 0.6
      };
    }
  }

  // Strategy B: Standard regex extraction (skip for HTML)
  if (isHtml) return { lines: [], confidence: 0 };
  const lines = [];
  let confidence = 0;

  const mpnMatches = [];
  for (const pattern of FIELD_PATTERNS.MPN) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
    while ((match = regex.exec(plainText)) !== null) {
      const val = match[1].trim();
      if (val.length < 3 || /^(THE|AND|FOR|FROM|THIS|THAT|WITH|HAVE|BEEN|WILL|YOUR|THEY|THEM|THAN|REQUESTED|QUOTE)$/i.test(val)) continue;
      mpnMatches.push({ value: val, index: match.index });
    }
  }

  const seenMPNs = new Set();
  const uniqueMPNs = mpnMatches.filter(m => {
    const key = m.value.toUpperCase();
    if (seenMPNs.has(key)) return false;
    seenMPNs.add(key);
    return true;
  });

  if (uniqueMPNs.length === 0) {
    return { lines: [], confidence: 0 };
  }

  if (uniqueMPNs.length === 1) {
    const line = { MPN: uniqueMPNs[0].value };
    let fieldCount = 1;
    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      if (field === 'MPN') continue;
      for (const pattern of patterns) {
        const match = plainText.match(pattern);
        if (match) {
          line[field] = cleanString(match[1]);
          fieldCount++;
          break;
        }
      }
    }
    confidence = 0.3 + (Math.min(fieldCount - 1, 6) * 0.1);
    lines.push(line);
  } else {
    for (let i = 0; i < uniqueMPNs.length; i++) {
      const startIdx = uniqueMPNs[i].index;
      const endIdx = i + 1 < uniqueMPNs.length ? uniqueMPNs[i + 1].index : plainText.length;
      const segment = plainText.substring(startIdx, endIdx);
      const line = { MPN: uniqueMPNs[i].value };
      for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
        if (field === 'MPN') continue;
        for (const pattern of patterns) {
          const match = segment.match(pattern);
          if (match) {
            line[field] = cleanString(match[1]);
            break;
          }
        }
      }
      lines.push(line);
    }
    confidence = 0.4;
  }

  return { lines, confidence };
}

module.exports = { parseWithRegex, parseKeyValuePairs, mapKVToFields };

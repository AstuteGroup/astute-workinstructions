#!/usr/bin/env node
/**
 * Market Pulse Weekly - Week 25 Report
 *
 * Generates Market Pulse report for a specific week using Power BI Data file
 *
 * Usage:
 *   node market-pulse-week25.js [week-number]
 *
 * Sections:
 * 1. Performance Snapshot - Infor Weekly Summary (Bookings vs Billings, GP-based)
 * 2. Market Intelligence - Coming soon (OT data)
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Simple manufacturer normalization for report consolidation
 * Strips punctuation, whitespace, legal suffixes to get canonical form
 *
 * Examples:
 * - "Micron Technology Inc" → "micron technology"
 * - "Micron Technology, Inc." → "micron technology"
 * - "TYCO ELECTRONICS CORP." → "te connectivity"  (via alias map)
 */
function normalizeManufacturer(mfr) {
  if (!mfr) return '';

  // Step 1: Prenormalize - strip punctuation, collapse whitespace, uppercase
  let normalized = String(mfr)
    .replace(/[^A-Za-z0-9\s/&\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  // Step 2: Strip generic legal-entity suffixes iteratively
  const suffix = /\s+(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|GMBH|AG|SA|NV|BV|LLC|HOLDINGS|HLDG|HLDGS|GROUP|PRODUCTS|COMPONENTS|ELECTRONICS|SEMICONDUCTOR|SEMICONDUCTORS|MFG|MANUFACTURING|TECHNOLOGIES|TECHNOLOGY)$/;
  while (suffix.test(normalized)) {
    normalized = normalized.replace(suffix, '').trim();
  }

  // Step 3: Apply common aliases (hardcoded for key manufacturers)
  const aliases = {
    'MICRON TECH': 'MICRON TECHNOLOGY',
    'MICRON': 'MICRON TECHNOLOGY',
    'TI': 'TEXAS INSTRUMENTS',
    'TXN': 'TEXAS INSTRUMENTS',
    'TYCO': 'TE CONNECTIVITY',
    'TYCO ELECTRONICS': 'TE CONNECTIVITY',
    'ON SEMI': 'ON SEMICONDUCTOR',
    'ONSEMI': 'ON SEMICONDUCTOR',
  };

  if (aliases[normalized]) {
    normalized = aliases[normalized];
  }

  // Step 4: Final lowercase for comparison
  return normalized.toLowerCase();
}

// Week to analyze (default: 25, can override via command line)
const WEEK_NUM = process.argv[2] ? parseInt(process.argv[2]) : 25;

// Sales team mapping for regional breakdown
const SALES_TEAM_MAP = {
  // Jeff Wallace → USA
  'aaromend': 'USA', 'danireis': 'USA', 'jakemcal': 'USA', 'jamediaz': 'USA',
  'joshsyre': 'USA', 'justgood': 'USA', 'melissab': 'USA', 'michstif': 'USA',
  'thomhayn': 'USA', 'willrobi': 'USA',

  // Joel Marquez → MEX
  'alejpadi': 'MEX', 'alexpart': 'MEX', 'alfrmart': 'MEX', 'carlmore': 'MEX',
  'carohine': 'MEX', 'joelflor': 'MEX', 'juanbote': 'MEX', 'ricamora': 'MEX',
  'salvhorn': 'MEX',

  // Laurel Kee → APAC - Laurel
  'ivychew': 'APAC - Laurel', 'jaspkee': 'APAC - Laurel',
  'laurekee': 'APAC - Laurel', 'rayng': 'APAC - Laurel',

  // Lavanya Manohar → APAC - Lavanya
  'lavamano': 'APAC - Lavanya', 'manika': 'APAC - Lavanya',
  'meenaksh': 'APAC - Lavanya',

  // Kris Munoz/Silvia Wong → APAC - Silvia
  'jamexu': 'APAC - Silvia', 'silvmuno': 'APAC - Silvia',
  'springtu': 'APAC - Silvia', 'wingzhan': 'APAC - Silvia',
  'winnlee': 'APAC - Silvia',

  // Edyna Lee → APAC - Edyna
  'clemchen': 'APAC - Edyna', 'edynlee': 'APAC - Edyna',
  'erinlee': 'APAC - Edyna', 'madifisc': 'APAC - Edyna',
  'serenzha': 'APAC - Edyna',

  // Directors/VP
  'jeffwall': 'USA', 'joelmarq': 'MEX', 'joshpucc': 'USA',
  'laurelke': 'APAC - Laurel', 'lavanyam': 'APAC - Lavanya',

  // Other
  'julicard': 'Other',
};

/**
 * Format currency
 */
function formatCurrency(amount, short = false) {
  if (!amount || amount === '0' || amount === 0) return '$0';
  const num = parseFloat(amount);
  if (short) {
    if (Math.abs(num) >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
    if (Math.abs(num) >= 1000) return '$' + (num / 1000).toFixed(0) + 'K';
  }
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Format percentage
 */
function formatPercent(value) {
  if (!value && value !== 0) return '0.0%';
  const num = parseFloat(value);
  return (num * 100).toFixed(1) + '%';
}

/**
 * Aggregate data for a specific week
 */
function aggregateWeek(bookingsData, billingsData, weekNum, excludeKLA = false) {
  // Filter for week
  let weekBookings = bookingsData.filter(row => row['Week Number'] === weekNum);
  let weekBillings = billingsData.filter(row => row['Week Number'] === weekNum);

  // Filter out KLA if requested
  if (excludeKLA) {
    weekBookings = weekBookings.filter(row => {
      const customer = (row['Customer Name'] || '').toUpperCase();
      return !customer.includes('KLA');
    });
    weekBillings = weekBillings.filter(row => {
      const customer = (row['Customer Name'] || '').toUpperCase();
      return !customer.includes('KLA');
    });
  }

  // Aggregate Bookings by team
  const bookingsByTeam = {};
  weekBookings.forEach(row => {
    const salesperson = row['CO Internal Salesperson'];
    const team = SALES_TEAM_MAP[salesperson] || 'Other';

    if (!bookingsByTeam[team]) {
      bookingsByTeam[team] = { revenue: 0, gp: 0, cos: new Set(), customers: new Set() };
    }

    bookingsByTeam[team].revenue += row['Booked Revenue'] || 0;
    bookingsByTeam[team].gp += row['Booked GP'] || 0;
    bookingsByTeam[team].cos.add(row['CO Number']);
    bookingsByTeam[team].customers.add(row['Customer Name']);
  });

  // Aggregate Billings by Sales Region (or fallback to salesperson mapping)
  const billingsByTeam = {};
  weekBillings.forEach(row => {
    // Use Sales Region field directly if available, else map salesperson
    let team = row['Sales Region'] || null;
    if (!team) {
      const salesperson = row['Internal Salesperson'];
      team = SALES_TEAM_MAP[salesperson] || 'Other';
    }

    if (!billingsByTeam[team]) {
      billingsByTeam[team] = { revenue: 0, gp: 0, cos: new Set(), customers: new Set() };
    }

    billingsByTeam[team].revenue += row['Invoice Revenue'] || 0;
    billingsByTeam[team].gp += row['Invoice GP'] || 0;
    billingsByTeam[team].cos.add(row['CO Number']);
    billingsByTeam[team].customers.add(row['Customer Name']);
  });

  // Convert Sets to counts and calculate GM
  Object.keys(bookingsByTeam).forEach(team => {
    bookingsByTeam[team].cos = bookingsByTeam[team].cos.size;
    bookingsByTeam[team].customers = bookingsByTeam[team].customers.size;
    bookingsByTeam[team].gm = bookingsByTeam[team].revenue > 0 ?
      (bookingsByTeam[team].gp / bookingsByTeam[team].revenue) : 0;
  });

  Object.keys(billingsByTeam).forEach(team => {
    billingsByTeam[team].cos = billingsByTeam[team].cos.size;
    billingsByTeam[team].customers = billingsByTeam[team].customers.size;
    billingsByTeam[team].gm = billingsByTeam[team].revenue > 0 ?
      (billingsByTeam[team].gp / billingsByTeam[team].revenue) : 0;
  });

  // Consolidate APAC sub-teams for regional totals
  const apacTeams = ['APAC - Laurel', 'APAC - Silvia', 'APAC - Lavanya', 'APAC - Edyna'];
  const apacBookings = { revenue: 0, gp: 0 };
  const apacBillings = { revenue: 0, gp: 0 };

  apacTeams.forEach(team => {
    if (bookingsByTeam[team]) {
      apacBookings.revenue += bookingsByTeam[team].revenue;
      apacBookings.gp += bookingsByTeam[team].gp;
    }
    if (billingsByTeam[team]) {
      apacBillings.revenue += billingsByTeam[team].revenue;
      apacBillings.gp += billingsByTeam[team].gp;
    }
  });
  apacBookings.gm = apacBookings.revenue > 0 ? (apacBookings.gp / apacBookings.revenue) : 0;
  apacBillings.gm = apacBillings.revenue > 0 ? (apacBillings.gp / apacBillings.revenue) : 0;

  // Calculate totals
  const bookingsTotal = { revenue: 0, gp: 0 };
  Object.values(bookingsByTeam).forEach(t => {
    bookingsTotal.revenue += t.revenue;
    bookingsTotal.gp += t.gp;
  });
  bookingsTotal.gm = bookingsTotal.revenue > 0 ? (bookingsTotal.gp / bookingsTotal.revenue) : 0;

  const billingsTotal = { revenue: 0, gp: 0 };
  Object.values(billingsByTeam).forEach(t => {
    billingsTotal.revenue += t.revenue;
    billingsTotal.gp += t.gp;
  });
  billingsTotal.gm = billingsTotal.revenue > 0 ? (billingsTotal.gp / billingsTotal.revenue) : 0;

  return {
    bookings: { byTeam: bookingsByTeam, total: bookingsTotal },
    billings: { byTeam: billingsByTeam, total: billingsTotal },
    apac: { bookings: apacBookings, billings: apacBillings }
  };
}

/**
 * Find large returns/credits in a week's data
 * Returns array of { customer, gp, type } for returns > $50K GP
 */
function findLargeReturns(bookingsData, billingsData, weekNum, threshold = 50000) {
  const returns = [];

  // Check bookings
  const weekBookings = bookingsData.filter(row => row['Week Number'] === weekNum);
  weekBookings.forEach(row => {
    const gp = row['Booked GP'] || 0;
    if (gp < -threshold) {
      returns.push({
        customer: row['Customer Name'],
        gp: gp,
        type: 'bookings'
      });
    }
  });

  // Check billings
  const weekBillings = billingsData.filter(row => row['Week Number'] === weekNum);
  weekBillings.forEach(row => {
    const gp = row['Invoice GP'] || 0;
    if (gp < -threshold) {
      returns.push({
        customer: row['Customer Name'],
        gp: gp,
        type: 'billings'
      });
    }
  });

  return returns;
}

/**
 * Collect Performance Snapshot data
 * Also loads prior year data for YoY comparisons if available
 */
function collectPerformanceSnapshot() {
  console.log(`Collecting Performance Snapshot for Week ${WEEK_NUM}...`);

  const filePath = path.join(__dirname, '../data/Market Pulse Power BI Data.xlsx');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Market Pulse Power BI Data file not found at: ${filePath}`);
  }

  const wb = XLSX.readFile(filePath);
  const bookingsData = XLSX.utils.sheet_to_json(wb.Sheets['Bookings 2026']);
  const billingsData = XLSX.utils.sheet_to_json(wb.Sheets['Billings 2026']);

  // Load prior year data for YoY comparison (if sheets exist)
  let priorYearBookingsData = null;
  let priorYearBillingsData = null;
  if (wb.Sheets['Bookings 2025'] && wb.Sheets['Billings 2025']) {
    priorYearBookingsData = XLSX.utils.sheet_to_json(wb.Sheets['Bookings 2025']);
    priorYearBillingsData = XLSX.utils.sheet_to_json(wb.Sheets['Billings 2025']);
    console.log(`  Prior year data (2025) loaded for YoY comparison`);
  } else {
    console.log(`  Prior year data (2025) not available - YoY comparison skipped`);
  }

  // Aggregate for current week and prior week (both Ex-KLA and Total)
  const currentWeekExKLA = aggregateWeek(bookingsData, billingsData, WEEK_NUM, true);
  const priorWeekExKLA = aggregateWeek(bookingsData, billingsData, WEEK_NUM - 1, true);

  const currentWeekTotal = aggregateWeek(bookingsData, billingsData, WEEK_NUM, false);
  const priorWeekTotal = aggregateWeek(bookingsData, billingsData, WEEK_NUM - 1, false);

  // Calculate KLA-only metrics (difference between Total and Ex-KLA)
  const kla = {
    bookings: {
      gp: currentWeekTotal.bookings.total.gp - currentWeekExKLA.bookings.total.gp,
      revenue: currentWeekTotal.bookings.total.revenue - currentWeekExKLA.bookings.total.revenue
    },
    billings: {
      gp: currentWeekTotal.billings.total.gp - currentWeekExKLA.billings.total.gp,
      revenue: currentWeekTotal.billings.total.revenue - currentWeekExKLA.billings.total.revenue
    }
  };

  // Find large returns/credits (>$50K GP)
  const currentReturns = findLargeReturns(bookingsData, billingsData, WEEK_NUM);
  const priorReturns = findLargeReturns(bookingsData, billingsData, WEEK_NUM - 1);

  console.log(`  Week ${WEEK_NUM}: ${currentWeekExKLA.bookings.total.gp > 0 ? 'Found' : 'No'} bookings, ${currentWeekExKLA.billings.total.gp > 0 ? 'Found' : 'No'} billings`);
  console.log(`  Week ${WEEK_NUM - 1}: ${priorWeekExKLA.bookings.total.gp > 0 ? 'Found' : 'No'} bookings, ${priorWeekExKLA.billings.total.gp > 0 ? 'Found' : 'No'} billings`);

  // Aggregate prior year data (same week last year) for YoY comparison
  let priorYearWeekExKLA = null;
  if (priorYearBookingsData && priorYearBillingsData) {
    priorYearWeekExKLA = aggregateWeek(priorYearBookingsData, priorYearBillingsData, WEEK_NUM, true);
    console.log(`  Week ${WEEK_NUM} 2025: ${priorYearWeekExKLA.bookings.total.gp > 0 ? 'Found' : 'No'} bookings (YoY comparison available)`);
  }

  return {
    currentWeek: WEEK_NUM,
    priorWeek: WEEK_NUM - 1,
    current: { exKLA: currentWeekExKLA, total: currentWeekTotal },
    prior: { exKLA: priorWeekExKLA, total: priorWeekTotal },
    priorYear: priorYearWeekExKLA ? { current: { exKLA: priorYearWeekExKLA } } : null,
    kla,
    returns: {
      current: currentReturns,
      prior: priorReturns
    },
    bookingsData,
    billingsData
  };
}

/**
 * Execute PostgreSQL query using heredoc to avoid escaping issues
 */
function execQuery(sql) {
  try {
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' << 'EOFQUERY'\n${sql}\nEOFQUERY`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' }
    );
    return output.trim();
  } catch (error) {
    console.error('Query error:', error.message);
    return '';
  }
}

/**
 * Parse multi-row query results
 */
function parseRows(output, columnNames) {
  if (!output) return [];
  return output.split('\n').map(line => {
    const values = line.split('|');
    const result = {};
    columnNames.forEach((name, i) => {
      result[name] = values[i] || null;
    });
    return result;
  });
}

/**
 * Consolidate manufacturer variants and re-aggregate data
 *
 * Handles cases like:
 * - "Micron Technology Inc" + "Micron Technology, Inc." → single consolidated entry
 * - For part families: consolidates (MT* + Micron Technology Inc) + (MT* + Micron Technology, Inc.) → single MT* entry
 * - Sums numeric fields (booked_gp, rfq_lines, etc.)
 * - Takes max for OEM customer counts
 * - Keeps first non-null value for descriptive fields
 *
 * @param {Array} rows - Array of row objects with manufacturer field
 * @param {string} mfrField - Name of the manufacturer field (default: 'manufacturer')
 * @param {string} groupKey - Optional additional grouping key (e.g., 'mpn' for part families)
 * @param {Array} sumFields - Fields to sum during consolidation
 * @param {Array} maxFields - Fields to take max of during consolidation
 * @returns {Array} Consolidated rows with canonical manufacturer names
 */
function consolidateManufacturers(rows, mfrField = 'manufacturer', groupKey = null, sumFields = [], maxFields = []) {
  if (!rows || rows.length === 0) return [];

  const consolidated = new Map();

  rows.forEach(row => {
    const rawMfr = row[mfrField];
    if (!rawMfr) return;

    const canonical = normalizeManufacturer(rawMfr);
    const key = groupKey ? `${row[groupKey]}|||${canonical}` : canonical;

    if (!consolidated.has(key)) {
      // First occurrence - initialize with current row
      consolidated.set(key, {
        ...row,
        [mfrField]: rawMfr, // Keep original formatting for display
        _canonical: canonical,
        _key: key
      });
    } else {
      // Subsequent occurrence - aggregate
      const existing = consolidated.get(key);

      // Sum numeric fields
      sumFields.forEach(field => {
        const val = parseFloat(row[field]) || 0;
        existing[field] = (parseFloat(existing[field]) || 0) + val;
      });

      // Take max of specified fields
      maxFields.forEach(field => {
        const val = parseFloat(row[field]) || 0;
        existing[field] = Math.max(parseFloat(existing[field]) || 0, val);
      });

      // For GM%, recalculate after summing GP and revenue
      if (sumFields.includes('booked_gp') && sumFields.includes('booked_revenue')) {
        const gp = parseFloat(existing.booked_gp) || 0;
        const rev = parseFloat(existing.booked_revenue) || 0;
        existing.booked_gm_pct = rev > 0 ? ((gp / rev) * 100).toFixed(1) : '0.0';
      }
    }
  });

  return Array.from(consolidated.values());
}

/**
 * Classify part type based on manufacturer and part family
 * Manufacturer-first approach for better accuracy
 */
function classifyPartType(partFamily, manufacturer) {
  if (!partFamily || !manufacturer) return 'Other';
  const mfr = manufacturer.toUpperCase();
  const prefix = partFamily.toUpperCase();

  // Memory ICs (manufacturer-based)
  if (mfr.includes('MICRON') || mfr.includes('ISSI') || mfr.includes('ALLIANCE') ||
      mfr.includes('CYPRESS') || mfr.includes('WINBOND') || mfr.includes('HYNIX') ||
      mfr.includes('MACRONIX') || mfr.includes('AMIC')) {
    return 'Memory';
  }

  // Passives - Resistors/Capacitors/Inductors (manufacturer-based)
  if (mfr.includes('MURATA') || mfr.includes('TDK') || mfr.includes('YAGEO') ||
      mfr.includes('SAMSUNG ELECTRO') || mfr.includes('KEMET') || mfr.includes('AVX') ||
      mfr.includes('PANASONIC') || mfr.includes('SUSUMU') || mfr.includes('OHMITE') ||
      mfr.includes('BOURNS') || mfr.includes('KOA')) {
    return 'Passives';
  }

  // Discrete Semiconductors - Diodes/Transistors/MOSFETs (manufacturer-based first)
  if (mfr.includes('NEXPERIA') || mfr.includes('DIODES INC') ||
      mfr.includes('CENTRAL SEMICONDUCTOR') || mfr.includes('COMCHIP')) {
    return 'Discretes';
  }
  if (mfr.includes('ON SEMICONDUCTOR') || mfr.includes('VISHAY') || mfr.includes('ROHM')) {
    // These manufacturers make both discretes and other parts - check prefix
    if (prefix.match(/^(MMBZ|MBR|BAW|BAV|BAS|BAT|BZX|1N|PMBT|BSS|2N|NVMF|DMTH)/)) {
      return 'Discretes';
    }
  }

  // Power Management ICs
  if (mfr.includes('TEXAS INSTRUMENTS')) {
    if (prefix.match(/^TPS/)) return 'Power Mgmt ICs';
    if (prefix.match(/^SN74/)) return 'Logic ICs';
    if (prefix.match(/^(LM|TL)/)) return 'Analog ICs';
    return 'ICs';
  }

  // Infineon - Power & Automotive semiconductors
  if (mfr.includes('INFINEON')) {
    return 'Power/Auto ICs';
  }

  // ST Microelectronics
  if (mfr.includes('ST MICRO') || mfr === 'ST') {
    if (prefix.match(/^STM/)) return 'Microcontrollers';
    return 'ICs';
  }

  // Microchip
  if (mfr.includes('MICROCHIP') || mfr.includes('ATMEL')) {
    return 'Microcontrollers';
  }

  // Interface ICs
  if (mfr.includes('FTDI') || mfr.includes('SILICON LABS')) {
    return 'Interface ICs';
  }

  // FPGAs
  if (mfr.includes('ALTERA') || mfr.includes('XILINX') || mfr.includes('LATTICE')) {
    return 'FPGAs';
  }

  // Analog Devices
  if (mfr.includes('ANALOG DEVICES') || mfr.includes('LINEAR TECH') || mfr.includes('MAXIM')) {
    return 'Analog ICs';
  }

  // Memory-specific prefixes (fallback)
  if (prefix.match(/^(MT|IS|HY|W|MX|AT24|24[CLF])/)) {
    return 'Memory';
  }

  // Passive-specific prefixes (fallback)
  if (prefix.match(/^(GRM|GCM|GRT|CGA|CL|CC|RC|ERJ|RK|VJ|MLG|ERA|AT|RG|C)/)) {
    return 'Passives';
  }

  // Discrete-specific prefixes (fallback)
  if (prefix.match(/^(BAS|BAV|BAT|BZX|1N|PMBT|BSS|MMBT|2N|PATT)/)) {
    return 'Discretes';
  }

  return 'Other';
}

/**
 * Define External Market Data (Manual Entry)
 * Source: Industry reports from Sourceability, Avnet, J2 Sourcing, etc.
 * Updated: 2026-06-23 (Week 25)
 *
 * UNIFIED LIFECYCLE COLORS (4-STATE MODEL):
 * - Normal: #10b981 (green)
 * - Constrained: #ea580c (orange)
 * - Allocated: #dc2626 (red)
 * - Recovery: #3b82f6 (blue)
 */
function getExternalMarketData() {
  // Week 27 (July 2, 2026) - COMPREHENSIVE External Market Intelligence
  // Sources: Industry research (FindChips, Octopart, Avnet, 773 GROUP, EE News Europe, Tom's Hardware)
  // Manufacturer announcements: Infineon, TI, STMicroelectronics, NXP, Microchip, Molex, TE Connectivity, Walsin
  // Updated: 2026-07-02

  // PRICE INCREASE ANNOUNCEMENTS (Effective THIS WEEK & Recent):
  // - July 1-6, 2026: Infineon (+5-8%), TI (selective increases), Molex (+3-7%), TE Connectivity (+4-6%)
  // - June 2026: STMicroelectronics (+6-10% on Jun 28), NXP (+8-12% on Jun 1), Walsin (+5% on Jun 1)
  // - Microchip: Selective price increases on constrained lines (per notification letter June 29)

  // MARKET EVENTS (This Week):
  // - Apple price hikes announced June 25
  // - Memory price-fixing lawsuit June 29
  // - AMD hits record high June 30
  // - TSMC stock down July 1
  // - Supermicro secures $7B financing
  // - AMD-Rackspace AI partnership announced
  // - Micron CEO: shortage through 2027

  return [
    {
      category: 'Memory (DRAM/NAND/HBM)',
      status: 'Allocated',
      statusColor: '#dc2626',
      keySignals: 'CRITICAL: Prices +60% in 2025, another +30-40% expected in 2026; HBM consumes 3-5x wafer capacity vs DDR5; entire 2026 HBM4 capacity SOLD OUT; relief pushed to 2027-2028 (Micron CEO confirmed); price-fixing lawsuit filed Jun 29; AI consuming 70% of production',
      industryLeadTime: '40-65+w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'MT*, IS*, MX* in shortage signals; multiple OEM customers competing for supply',
      otPartFamilies: ['MT', 'IS', 'MX'],
      priceIncreases: 'Multiple rounds: +60% YoY 2025, +30-40% expected 2026',
      marketEvents: 'Price-fixing lawsuit (Jun 29), Micron CEO: shortage through 2027'
    },
    {
      category: 'MLCCs (Passives)',
      status: 'Allocated',
      statusColor: '#dc2626',
      keySignals: 'NEW STRUCTURAL SHORTAGE: High-end MLCCs prices +15-20% (AI grades +50-60%); lead times 4-6 months (16-26w); utilization 90-95%; AI servers require 40K-440K MLCCs each; manufacturers at capacity limits',
      industryLeadTime: '16-26w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'GRM* family showing multi-customer demand; high-capacitance (10µF+) parts most constrained',
      otPartFamilies: ['GRM'],
      priceIncreases: 'Walsin +5% (effective Jun 1), AI-grade capacitors +50-60% YoY',
      marketEvents: 'Multiple manufacturers announcing 2nd price increase of 2026 = structural shortage signal'
    },
    {
      category: 'MCUs (STM32, Renesas)',
      status: 'Allocated',
      statusColor: '#dc2626',
      keySignals: 'STM32 lead times 16-55 weeks depending on family; automotive-grade MOST constrained; STMicroelectronics announced +6-10% price increase (effective Jun 28); industrial/automotive ADAS driving demand; capacity expansions not keeping pace',
      industryLeadTime: '16-55w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'STM* showing extended lead times across multiple part families; automotive customers competing',
      otPartFamilies: ['STM'],
      priceIncreases: 'STMicroelectronics +6-10% (Jun 28, 2026); Microchip selective increases (Jun 29)',
      marketEvents: 'STM on 2nd increase of 2026 = structural constraint'
    },
    {
      category: 'Power Management ICs',
      status: 'Constrained',
      statusColor: '#ea580c',
      keySignals: 'Texas Instruments selective price increases effective July 1-6; Infineon +5-8% (Jul 1); automotive/EV demand driving constraints; capacity expansions underway but lagging demand',
      industryLeadTime: '12-30w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'TPS* (TI power management) in shortage signals; Infineon parts showing extended lead times',
      otPartFamilies: ['TPS', 'IR', 'IRL'],
      priceIncreases: 'TI selective increases (Jul 1-6), Infineon +5-8% (Jul 1)',
      marketEvents: 'Multiple manufacturers on 2nd increase of 2026 = structural shortage'
    },
    {
      category: 'Connectors & Passives',
      status: 'Constrained',
      statusColor: '#ea580c',
      keySignals: 'Molex +3-7% (Jul 1), TE Connectivity +4-6% (Jul 1-6); automotive and industrial demand driving constraints; some specialty connectors 20-30w lead times',
      industryLeadTime: '12-30w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'Automotive-grade connectors showing multi-customer demand',
      otPartFamilies: ['MOLEX', 'TE'],
      priceIncreases: 'Molex +3-7% (Jul 1), TE Connectivity +4-6% (Jul 1-6)',
      marketEvents: 'Price increases effective THIS WEEK (July 1-6)'
    },
    {
      category: 'Discrete Semiconductors',
      status: 'Constrained',
      statusColor: '#ea580c',
      keySignals: 'NXP +8-12% price increase (Jun 1); automotive power discretes most affected; EV and renewable energy demand creating spot shortages',
      industryLeadTime: '12-24w',
      alignment: 'MATCHES',
      alignmentIcon: '✅',
      otSignal: 'NXP parts in shortage signals; automotive discretes showing extended lead times',
      otPartFamilies: ['BAS', 'BAV', 'BC'],
      priceIncreases: 'NXP +8-12% (Jun 1, 2026)',
      marketEvents: 'NXP on 2nd increase of 2026'
    },
    {
      category: 'Logic ICs (Commodity)',
      status: 'Normal',
      statusColor: '#10b981',
      keySignals: 'TI inventory 222 days; commodity logic plentiful; mature-node risk building late 2026 as fabs pivot to advanced nodes; TI selective increases may signal future tightening',
      industryLeadTime: '8-16w',
      alignment: 'BETTER SUPPLY',
      alignmentIcon: '⚠️',
      otSignal: 'SN74* showing normal availability; TI stock position strong',
      otPartFamilies: ['SN74', '74HC', '74LVC'],
      priceIncreases: 'TI selective increases (Jul 1-6) — watch for future tightening',
      marketEvents: 'TI inventory high but selective increases may signal pivot'
    }
  ];
}

/**
 * Calculate Temperature Gauge from constraint signals (Section 3)
 * Uses UNIFIED LIFECYCLE COLORS
 */
function calculateTemperatureGauge(constraintIndicators) {
  // Count signals by severity (4-state model: Normal, Constrained, Allocated, Recovery)
  const allocatedCount = constraintIndicators.franchiseLeadTimes.filter(lt => lt.status === 'Allocated').length;
  const constrainedCount = constraintIndicators.franchiseLeadTimes.filter(lt => lt.status === 'Constrained').length;
  const recoveryCount = constraintIndicators.franchiseLeadTimes.filter(lt => lt.status === 'Recovery').length;
  const shortageSignalCount = constraintIndicators.multiCustomerParts.length;

  const totalSignals = allocatedCount + constrainedCount + shortageSignalCount;

  // Classify overall market temperature using 4-STATE MODEL with aggressive thresholds
  let temperature, color, message;
  if (allocatedCount >= 3 || totalSignals >= 12) {
    temperature = 'Allocated';
    color = '#dc2626';  // Red
    message = 'Critical allocation signals active — severe supply constraints (40-65+ week lead times)';
  } else if (allocatedCount >= 1 || totalSignals >= 5) {
    temperature = 'Constrained';
    color = '#ea580c';  // Orange
    message = 'Supply tightening detected — extended lead times (16-40 weeks)';
  } else if (recoveryCount >= 2) {
    temperature = 'Recovery';
    color = '#3b82f6';  // Blue
    message = 'Market loosening — lead times declining from previous constraints';
  } else {
    temperature = 'Normal';
    color = '#10b981';  // Green
    message = 'Market conditions stable — normal lead times (8-16 weeks)';
  }

  return {
    temperature,
    color,
    message,
    totalSignals,
    allocatedCount,
    constrainedCount,
    recoveryCount,
    shortageSignalCount
  };
}

/**
 * Collect Constraint Indicators data (Section 2)
 * Pulls from OT database for early warning signals
 */
function collectConstraintIndicators() {
  console.log('Collecting Constraint Indicators from OT database...');

  // Section 2.1: Hot Part Families - Shortage Signals (2+ OEM customers)
  // Full funnel view: RFQ → VQ → CQ → SO with GP/GM tracking
  // - Groups by part family prefix (GRM21, TPS, BAS, SN74, etc.)
  // - Shows OEM-only count vs Total (incl. EMS) count
  // - Tracks conversion funnel and booked business performance
  const multiCustomerQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
             CURRENT_DATE as end_date
    ),
    -- Part family prefix → manufacturer override mapping
    -- Used to correct manufacturer attribution when DB data is incorrect
    -- Currently only fixing MT* parts (Micron) - expand as needed when other issues are found
    mfr_overrides AS (
      SELECT prefix, chuboe_mfr_id FROM (VALUES
        ('MT', 1000002)     -- Micron Technology Inc (MT*, MT40*, MT41*, etc.)
      ) AS t(prefix, chuboe_mfr_id)
    ),
    normalized_mpns_raw AS (
      SELECT
        rfqm.chuboe_rfq_line_mpn_id,
        rfqm.chuboe_rfq_line_id,
        rfqm.chuboe_rfq_id,
        rfqm.chuboe_mpn as original_mpn,
        -- Normalize MPN: strip common packaging suffixes
        UPPER(TRIM(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(rfqm.chuboe_mpn, ',[0-9]+$', ''),
              '-(TR|TP|CT|REEL)$', '', 'i'),
            'T[0-9]+G$', '')
        )) as normalized_mpn,
        -- Extract part family prefix
        CASE
          WHEN UPPER(rfqm.chuboe_mpn) LIKE 'GRM%' THEN SUBSTRING(UPPER(rfqm.chuboe_mpn), 1, 5)
          WHEN UPPER(rfqm.chuboe_mpn) LIKE 'SN74%' THEN SUBSTRING(UPPER(rfqm.chuboe_mpn), 1, 4)
          ELSE SUBSTRING(REGEXP_REPLACE(UPPER(rfqm.chuboe_mpn), '[0-9,\-].*$', ''), 1, 4)
        END as part_family,
        rfqm.chuboe_mfr_id as db_mfr_id
      FROM adempiere.chuboe_rfq_line_mpn rfqm
      WHERE rfqm.isactive = 'Y'
    ),
    -- Apply manufacturer override based on part family prefix
    normalized_mpns AS (
      SELECT
        n.chuboe_rfq_line_mpn_id,
        n.chuboe_rfq_line_id,
        n.chuboe_rfq_id,
        n.original_mpn,
        n.normalized_mpn,
        n.part_family,
        -- Use override manufacturer if available, otherwise use DB manufacturer
        COALESCE(o.chuboe_mfr_id, n.db_mfr_id) as chuboe_mfr_id
      FROM normalized_mpns_raw n
      LEFT JOIN mfr_overrides o ON n.part_family = o.prefix
    ),
    -- Map each part family to the RFQ lines that belong to it (30-day shortage RFQs only)
    part_family_rfq_lines AS (
      SELECT DISTINCT n.part_family, n.chuboe_rfq_line_id, n.chuboe_mfr_id
      FROM normalized_mpns n
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq rfq ON n.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_rfq_type rt ON rfq.chuboe_rfq_type_id = rt.chuboe_rfq_type_id AND rt.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
        AND rt.name = 'Shortage'
    ),
    -- Get unique sales orders per part family (prevents duplication when RFQ line has multiple MPNs in same family)
    -- Look for sales from any RFQ that sold in the last 30 days, not just RFQs created in the last 30 days
    part_family_sales_detail AS (
      SELECT DISTINCT
        n.part_family,
        n.chuboe_mfr_id,
        so.c_orderline_id,
        so.linenetamt,
        bi.s_order_line_gp
      FROM normalized_mpns n
      CROSS JOIN current_window
      JOIN adempiere.chuboe_cq_line cq ON n.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      JOIN adempiere.c_orderline so ON cq.chuboe_cq_line_id = so.chuboe_cq_line_id AND so.isactive = 'Y'
      JOIN adempiere.bi_order_line_v bi ON so.c_orderline_id = bi.order_line_id
      WHERE bi.order_date_ordered::date BETWEEN current_window.start_date AND current_window.end_date
    ),
    -- Aggregate GP by part family/manufacturer to avoid Cartesian product when joining to MPN-level data
    part_family_sales_agg AS (
      SELECT
        part_family,
        chuboe_mfr_id,
        COUNT(DISTINCT c_orderline_id) as so_lines,
        COALESCE(SUM(linenetamt), 0) as booked_revenue,
        COALESCE(SUM(s_order_line_gp), 0) as booked_gp
      FROM part_family_sales_detail
      GROUP BY part_family, chuboe_mfr_id
    )
    SELECT
      n.part_family as mpn,
      m.name as manufacturer,
      -- Total customers (including EMS)
      COUNT(DISTINCT rfq.c_bpartner_id) as total_customers,
      -- OEM-only customers (excluding Tier 1 EMS)
      COUNT(DISTINCT CASE
        WHEN bp.name NOT ILIKE '%Sanmina%'
         AND bp.name NOT ILIKE '%Jabil%'
         AND bp.name NOT ILIKE '%Flextronics%'
         AND bp.name NOT ILIKE '%Plexus%'
         AND bp.name NOT ILIKE '%Celestica%'
         AND bp.name NOT ILIKE '%Benchmark%'
         AND bp.name NOT ILIKE '%Foxconn%'
         AND bp.name NOT ILIKE '%Wistron%'
        THEN rfq.c_bpartner_id
      END) as oem_customers,
      COUNT(DISTINCT n.normalized_mpn) as unique_parts,
      -- Example MPNs (truncated to ~60 chars to show 2-3 examples)
      LEFT(STRING_AGG(DISTINCT n.original_mpn, ', ' ORDER BY n.original_mpn), 60) as example_mpns,
      -- Funnel metrics: RFQ → VQ → CQ → SO
      COUNT(DISTINCT n.chuboe_rfq_line_id) as rfq_lines,
      COUNT(DISTINCT vq.chuboe_vq_line_id) as vq_lines,
      COUNT(DISTINCT CASE WHEN vq.cost IS NULL OR vq.cost = 0 THEN vq.chuboe_vq_line_id END) as no_quote_count,
      COUNT(DISTINCT cq.chuboe_cq_line_id) as cq_lines,
      -- Booked business performance (using pre-aggregated GP to prevent multiplication)
      COALESCE(MAX(pfs.so_lines), 0) as so_lines,
      COALESCE(MAX(pfs.booked_revenue), 0) as booked_revenue,
      COALESCE(MAX(pfs.booked_gp), 0) as booked_gp,
      CASE
        WHEN MAX(pfs.booked_revenue) > 0
        THEN ROUND((MAX(pfs.booked_gp) / MAX(pfs.booked_revenue)), 4)
        ELSE NULL
      END as booked_gm_pct
    FROM normalized_mpns n
    CROSS JOIN current_window
    JOIN adempiere.chuboe_rfq rfq ON n.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
    JOIN adempiere.chuboe_rfq_type rt ON rfq.chuboe_rfq_type_id = rt.chuboe_rfq_type_id AND rt.isactive = 'Y'
    JOIN adempiere.chuboe_mfr m ON n.chuboe_mfr_id = m.chuboe_mfr_id
    JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_vq_line vq ON n.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_cq_line cq ON n.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
    LEFT JOIN part_family_sales_agg pfs ON n.part_family = pfs.part_family AND n.chuboe_mfr_id = pfs.chuboe_mfr_id
    WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      AND rt.name = 'Shortage'
    GROUP BY n.part_family, m.name
    HAVING COUNT(DISTINCT CASE
      WHEN bp.name NOT ILIKE '%Sanmina%'
       AND bp.name NOT ILIKE '%Jabil%'
       AND bp.name NOT ILIKE '%Flextronics%'
       AND bp.name NOT ILIKE '%Plexus%'
       AND bp.name NOT ILIKE '%Celestica%'
       AND bp.name NOT ILIKE '%Benchmark%'
       AND bp.name NOT ILIKE '%Foxconn%'
       AND bp.name NOT ILIKE '%Wistron%'
      THEN rfq.c_bpartner_id
    END) >= 2  -- 2+ OEM customers (no EMS inflation)
    ORDER BY booked_gp DESC, oem_customers DESC
    LIMIT 10;
  `;

  // Section 2.2: Franchise Lead Time Analysis (Market Temperature by Part Type)
  // Shows supply chain stress via franchise distributor lead times
  // Stock items included as 0 weeks (healthy supply signal)
  const franchiseLeadTimeQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
             CURRENT_DATE as end_date
    ),
    baseline_window AS (
      SELECT CURRENT_DATE - INTERVAL '90 days' as start_date,
             CURRENT_DATE as end_date
    ),
    -- Parse lead time to numeric weeks
    parsed_vqs AS (
      SELECT
        vql.chuboe_vq_line_id,
        vql.created::date as quote_date,
        vql.chuboe_lead_time,
        rfqm.chuboe_rfq_line_mpn_id,
        rfqm.chuboe_mpn,
        rfqm.chuboe_mfr_id,
        m.name as manufacturer,
        -- Extract part family prefix
        CASE
          WHEN UPPER(rfqm.chuboe_mpn) LIKE 'GRM%' THEN SUBSTRING(UPPER(rfqm.chuboe_mpn), 1, 5)
          WHEN UPPER(rfqm.chuboe_mpn) LIKE 'SN74%' THEN SUBSTRING(UPPER(rfqm.chuboe_mpn), 1, 4)
          ELSE SUBSTRING(REGEXP_REPLACE(UPPER(rfqm.chuboe_mpn), '[0-9,\-].*$', ''), 1, 4)
        END as part_family,
        -- Parse lead time to weeks (numeric)
        CASE
          -- Stock/immediate
          WHEN vql.chuboe_lead_time ILIKE '%stock%' OR vql.chuboe_lead_time = '0' THEN 0
          -- X Weeks format
          WHEN vql.chuboe_lead_time ~ '^[0-9]+ Week' THEN
            REGEXP_REPLACE(vql.chuboe_lead_time, ' Week.*', '')::numeric
          -- X Days format (convert to weeks)
          WHEN vql.chuboe_lead_time ~ '^[0-9]+ Day' THEN
            ROUND((REGEXP_REPLACE(vql.chuboe_lead_time, ' Day.*', '')::numeric / 7.0), 1)
          ELSE NULL
        END as leadtime_weeks
      FROM adempiere.chuboe_vq_line vql
      CROSS JOIN baseline_window
      JOIN adempiere.c_bpartner v ON vql.c_bpartner_id = v.c_bpartner_id
      JOIN adempiere.chuboe_rfq_line rfql ON vql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON rfql.chuboe_rfq_line_id = rfqm.chuboe_rfq_line_id
      JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
      WHERE vql.isactive = 'Y'
        AND rfqm.isactive = 'Y'
        AND vql.created::date BETWEEN baseline_window.start_date AND baseline_window.end_date
        -- Franchise distributors only
        AND v.name ILIKE ANY(ARRAY['%Arrow%', '%Avnet%', '%Mouser%', '%Digi%Key%',
                                    '%Newark%', '%Future%', '%TTI%', '%Master%'])
        AND vql.chuboe_lead_time IS NOT NULL
        AND vql.chuboe_lead_time != ''
    ),
    -- Aggregate by part family for current 30d
    current_stats AS (
      SELECT
        part_family,
        manufacturer,
        COUNT(*) as vq_count,
        ROUND(AVG(leadtime_weeks), 1) as avg_leadtime,
        MIN(leadtime_weeks) as min_leadtime,
        MAX(leadtime_weeks) as max_leadtime,
        -- Lead time buckets (aligned with 4-state aggressive model)
        COUNT(CASE WHEN leadtime_weeks < 8 THEN 1 END) as bucket_stock,
        COUNT(CASE WHEN leadtime_weeks BETWEEN 8 AND 15 THEN 1 END) as bucket_normal,
        COUNT(CASE WHEN leadtime_weeks BETWEEN 16 AND 39 THEN 1 END) as bucket_constrained,
        COUNT(CASE WHEN leadtime_weeks >= 40 THEN 1 END) as bucket_allocated
      FROM parsed_vqs
      CROSS JOIN current_window
      WHERE quote_date BETWEEN current_window.start_date AND current_window.end_date
        AND leadtime_weeks IS NOT NULL
      GROUP BY part_family, manufacturer
      HAVING COUNT(*) >= 10
    ),
    -- Aggregate by part family for 90d baseline
    baseline_stats AS (
      SELECT
        part_family,
        manufacturer,
        ROUND(AVG(leadtime_weeks), 1) as avg_leadtime
      FROM parsed_vqs
      WHERE leadtime_weeks IS NOT NULL
      GROUP BY part_family, manufacturer
      HAVING COUNT(*) >= 20
    )
    SELECT
      c.part_family,
      c.manufacturer,
      c.avg_leadtime as current_avg_lt,
      b.avg_leadtime as baseline_avg_lt,
      ROUND(c.avg_leadtime - b.avg_leadtime, 1) as lt_change_weeks,
      ROUND(((c.avg_leadtime - b.avg_leadtime) / NULLIF(b.avg_leadtime, 0)) * 100, 1) as lt_change_pct,
      c.min_leadtime,
      c.max_leadtime,
      c.vq_count,
      c.bucket_stock,
      c.bucket_normal,
      c.bucket_constrained,
      c.bucket_allocated,
      -- Classify status (4-state model: uses BOTH average LT AND distribution)
      CASE
        -- Allocated: Either avg >= 40w OR >50% of individual VQs at 40+w (distribution-based allocation)
        WHEN c.avg_leadtime >= 40 THEN 'Allocated'
        WHEN c.bucket_allocated::FLOAT / NULLIF(c.vq_count, 0) > 0.50 THEN 'Allocated'
        -- Recovery: 20-40w range with SIGNIFICANT decline (≥20% reduction from baseline)
        WHEN c.avg_leadtime BETWEEN 20 AND 39.9
         AND ((c.avg_leadtime - b.avg_leadtime) / NULLIF(b.avg_leadtime, 0)) <= -0.20
        THEN 'Recovery'
        -- Constrained: 16-40 weeks (default for this range if not recovering)
        WHEN c.avg_leadtime >= 16 THEN 'Constrained'
        -- Normal: 8-16 weeks (stable market)
        WHEN c.avg_leadtime >= 8 THEN 'Normal'
        -- Stock: < 8 weeks (also Normal)
        ELSE 'Normal'
      END as status
    FROM current_stats c
    JOIN baseline_stats b ON c.part_family = b.part_family AND c.manufacturer = b.manufacturer
    ORDER BY
      CASE
        WHEN c.avg_leadtime >= 40 THEN 1  -- Allocated first
        WHEN c.avg_leadtime >= 16 THEN 2  -- Constrained second
        WHEN c.avg_leadtime BETWEEN 20 AND 39.9 AND c.avg_leadtime < b.avg_leadtime THEN 3  -- Recovery third
        ELSE 4  -- Normal last
      END,
      c.avg_leadtime DESC
    LIMIT 15;
  `;


  // Section 4: Trending Shortage Manufacturers (Top 10 by Booked GP - Shortage RFQs only)
  const trendingMfrsQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
             CURRENT_DATE as end_date
    ),
    -- Map each manufacturer to its RFQ lines (30-day shortage RFQs only)
    mfr_rfq_lines AS (
      SELECT DISTINCT rfqm.chuboe_mfr_id, rfqm.chuboe_rfq_line_id
      FROM adempiere.chuboe_rfq_line_mpn rfqm
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.chuboe_rfq_type rt ON rfq.chuboe_rfq_type_id = rt.chuboe_rfq_type_id AND rt.isactive = 'Y'
      WHERE rfqm.isactive = 'Y'
        AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
        AND rt.name = 'Shortage'
    ),
    -- Get unique sales orders per manufacturer (prevents duplication when RFQ line has multiple MPNs from same mfr)
    mfr_sales_detail AS (
      SELECT DISTINCT
        mrl.chuboe_mfr_id,
        so.c_orderline_id,
        bi.s_order_line_gp,
        bp.name as customer_name
      FROM mfr_rfq_lines mrl
      JOIN adempiere.chuboe_cq_line cq ON mrl.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
      JOIN adempiere.c_orderline so ON cq.chuboe_cq_line_id = so.chuboe_cq_line_id AND so.isactive = 'Y'
      JOIN adempiere.bi_order_line_v bi ON so.c_orderline_id = bi.order_line_id
      JOIN adempiere.c_order o ON so.c_order_id = o.c_order_id AND o.isactive = 'Y'
      JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
    ),
    -- Aggregate GP by manufacturer to avoid Cartesian product when joining to MPN-level data
    mfr_sales_agg AS (
      SELECT
        chuboe_mfr_id,
        COUNT(DISTINCT c_orderline_id) as sold,
        COALESCE(SUM(s_order_line_gp), 0) as booked_gp,
        COALESCE(SUM(CASE WHEN customer_name ILIKE '%KLA%' THEN s_order_line_gp ELSE 0 END), 0) as kla_gp
      FROM mfr_sales_detail
      GROUP BY chuboe_mfr_id
    )
    SELECT
      m.name as manufacturer,
      -- Total customers (including EMS)
      COUNT(DISTINCT rfq.c_bpartner_id) as total_customers,
      -- OEM-only customers (excluding Tier 1 EMS)
      COUNT(DISTINCT CASE
        WHEN bp.name NOT ILIKE '%Sanmina%'
         AND bp.name NOT ILIKE '%Jabil%'
         AND bp.name NOT ILIKE '%Flextronics%'
         AND bp.name NOT ILIKE '%Plexus%'
         AND bp.name NOT ILIKE '%Celestica%'
         AND bp.name NOT ILIKE '%Benchmark%'
         AND bp.name NOT ILIKE '%Foxconn%'
         AND bp.name NOT ILIKE '%Wistron%'
        THEN rfq.c_bpartner_id
      END) as oem_customers,
      COUNT(DISTINCT rfqm.chuboe_rfq_line_id) as rfq_lines,
      COUNT(DISTINCT vq.chuboe_vq_line_id) as vq_lines,
      COUNT(DISTINCT cq.chuboe_cq_line_id) as cq_lines,
      -- Booked business performance (using pre-aggregated GP to prevent multiplication)
      MAX(ms.sold) as sold,
      CASE
        WHEN COUNT(DISTINCT cq.chuboe_cq_line_id) > 0
        THEN ROUND((MAX(ms.sold)::numeric /
                    COUNT(DISTINCT cq.chuboe_cq_line_id)::numeric), 4)
        ELSE 0
      END as cq_sold_pct,
      MAX(ms.booked_gp) as booked_gp,
      MAX(ms.kla_gp) as kla_gp
    FROM adempiere.chuboe_mfr m
    CROSS JOIN current_window
    JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
    JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
    JOIN adempiere.chuboe_rfq_type rt ON rfq.chuboe_rfq_type_id = rt.chuboe_rfq_type_id AND rt.isactive = 'Y'
    JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
    LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
    LEFT JOIN mfr_sales_agg ms ON m.chuboe_mfr_id = ms.chuboe_mfr_id
    WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
      AND rt.name = 'Shortage'
    GROUP BY m.name
    HAVING COUNT(DISTINCT rfqm.chuboe_rfq_line_id) >= 10
      AND MAX(ms.booked_gp) > 0
    ORDER BY booked_gp DESC
    LIMIT 10;
  `;

  // Section 7: Regional Demand Divergence (APAC Concentration)
  const regionalDivergenceQuery = `
    WITH current_window AS (
      SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
             CURRENT_DATE as end_date
    ),
    rfq_by_region AS (
      SELECT
        m.name as manufacturer,
        rfqm.chuboe_rfq_line_id,
        CASE
          WHEN bp.name ILIKE ANY(ARRAY['%Hong Kong%', '%Singapore%', '%Taiwan%', '%China%', '%Korea%', '%Japan%', '%Malaysia%', '%Thailand%', '%India%'])
            THEN 'APAC'
          WHEN bp.name ILIKE ANY(ARRAY['%Mexico%', '%Guadalajara%'])
            THEN 'MEX'
          WHEN bp.name ILIKE ANY(ARRAY['%USA%', '%United States%', '%California%', '%Texas%', '%Oregon%'])
            OR bp.name NOT ILIKE '%Mexico%'
            THEN 'USA'
          ELSE 'Other'
        END as region
      FROM adempiere.chuboe_mfr m
      CROSS JOIN current_window
      JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
      JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
      JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
      WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
    )
    SELECT
      manufacturer,
      COUNT(DISTINCT chuboe_rfq_line_id) as total_rfqs,
      ROUND((COUNT(DISTINCT CASE WHEN region = 'APAC' THEN chuboe_rfq_line_id END)::numeric /
             NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) * 100, 1) as apac_pct,
      ROUND((COUNT(DISTINCT CASE WHEN region = 'USA' THEN chuboe_rfq_line_id END)::numeric /
             NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) * 100, 1) as usa_pct,
      ROUND((COUNT(DISTINCT CASE WHEN region = 'MEX' THEN chuboe_rfq_line_id END)::numeric /
             NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) * 100, 1) as mex_pct,
      ROUND((COUNT(DISTINCT CASE WHEN region = 'Other' THEN chuboe_rfq_line_id END)::numeric /
             NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) * 100, 1) as other_pct,
      CASE
        WHEN (COUNT(DISTINCT CASE WHEN region = 'APAC' THEN chuboe_rfq_line_id END)::numeric /
              NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) >= 0.7
        THEN '🔴 APAC Concentrated'
        ELSE '🟢 Balanced'
      END as signal
    FROM rfq_by_region
    GROUP BY manufacturer
    HAVING COUNT(DISTINCT chuboe_rfq_line_id) >= 20
      AND (COUNT(DISTINCT CASE WHEN region = 'APAC' THEN chuboe_rfq_line_id END)::numeric /
           NULLIF(COUNT(DISTINCT chuboe_rfq_line_id), 0)::numeric) >= 0.5
    ORDER BY apac_pct DESC
    LIMIT 10;
  `;

  // Execute queries
  const multiCustomerOutput = execQuery(multiCustomerQuery);
  const franchiseLeadTimeOutput = execQuery(franchiseLeadTimeQuery);
  const trendingMfrsOutput = execQuery(trendingMfrsQuery);
  const regionalDivergenceOutput = execQuery(regionalDivergenceQuery);

  // Parse results and add part type classification
  const multiCustomerPartsParsed = parseRows(multiCustomerOutput,
    ['mpn', 'manufacturer', 'total_customers', 'oem_customers', 'unique_parts', 'example_mpns',
     'rfq_lines', 'vq_lines', 'no_quote_count', 'cq_lines', 'so_lines',
     'booked_revenue', 'booked_gp', 'booked_gm_pct'])
    .map(part => ({
      ...part,
      part_type: classifyPartType(part.mpn, part.manufacturer)
    }));

  // Consolidate manufacturer variants for Hot Part Families
  // Group by (part_family, canonical_mfr) and sum all numeric fields
  const multiCustomerParts = consolidateManufacturers(
    multiCustomerPartsParsed,
    'manufacturer',
    'mpn', // Group by (mpn/part_family + canonical_mfr)
    ['rfq_lines', 'vq_lines', 'no_quote_count', 'cq_lines', 'so_lines', 'booked_revenue', 'booked_gp', 'unique_parts'],
    ['total_customers', 'oem_customers']
  );

  const franchiseLeadTimes = parseRows(franchiseLeadTimeOutput,
    ['part_family', 'manufacturer', 'current_avg_lt', 'baseline_avg_lt', 'lt_change_weeks', 'lt_change_pct',
     'min_leadtime', 'max_leadtime', 'vq_count', 'bucket_stock', 'bucket_normal', 'bucket_constrained', 'bucket_allocated', 'status'])
    .map(lt => ({
      ...lt,
      part_type: classifyPartType(lt.part_family, lt.manufacturer)
    }));

  const trendingMfrsParsed = parseRows(trendingMfrsOutput,
    ['manufacturer', 'total_customers', 'oem_customers', 'rfq_lines', 'vq_lines', 'cq_lines', 'sold', 'cq_sold_pct', 'booked_gp', 'kla_gp']);

  // Consolidate manufacturer variants for By Manufacturer table
  const trendingMfrs = consolidateManufacturers(
    trendingMfrsParsed,
    'manufacturer',
    null, // No grouping key - consolidate purely by manufacturer
    ['rfq_lines', 'vq_lines', 'cq_lines', 'sold', 'booked_gp', 'kla_gp'],
    ['total_customers', 'oem_customers']
  );

  const regionalDivergence = parseRows(regionalDivergenceOutput,
    ['manufacturer', 'total_rfqs', 'apac_pct', 'usa_pct', 'mex_pct', 'other_pct', 'signal']);

  console.log(`  Multi-Customer Parts: ${multiCustomerParts.length} found`);
  console.log(`  Franchise Lead Time Signals: ${franchiseLeadTimes.length} found`);
  console.log(`  Trending Manufacturers: ${trendingMfrs.length} found`);
  console.log(`  Regional Divergence Signals: ${regionalDivergence.length} found`);

  return {
    multiCustomerParts,
    franchiseLeadTimes,
    trendingMfrs,
    regionalDivergence
  };
}

/**
 * Detect holiday impacts for a given week
 * Returns holiday name if week falls during major holiday period
 */
function detectHolidayImpact(weekNum, year) {
  // Chinese New Year (varies by lunar calendar)
  const chineseNewYear = {
    2024: [6, 7],      // Feb 10-16
    2025: [5],         // Jan 29 - Feb 4
    2026: [7],         // Feb 17-23
    2027: [6]          // Feb 6-12
  };

  // Thanksgiving (US) - 4th Thursday in November
  const thanksgiving = {
    2024: [47],
    2025: [47],
    2026: [47],
    2027: [47]
  };

  // Christmas/New Year
  const christmas = {
    2024: [52, 1],
    2025: [52, 1],
    2026: [52, 1],
    2027: [52, 1]
  };

  if (chineseNewYear[year] && chineseNewYear[year].includes(weekNum)) {
    return 'Chinese New Year';
  }
  if (thanksgiving[year] && thanksgiving[year].includes(weekNum)) {
    return 'Thanksgiving';
  }
  if (christmas[year] && christmas[year].includes(weekNum)) {
    return 'Christmas/New Year';
  }

  return null;
}

/**
 * Generate lifecycle observations for Performance Snapshot
 * Maps bookings/billings metrics to lifecycle states
 * Filters out distortions from large returns
 * Adds holiday context and YoY comparisons
 */
function generateLifecycleObservations(snapshot, priorYearSnapshot) {
  const observations = [];
  const { current, prior, returns } = snapshot;

  // Calculate key metrics
  const bbRatio = current.exKLA.billings.total.gp > 0 ?
    (current.exKLA.bookings.total.gp / current.exKLA.billings.total.gp) : 0;
  const bookingsGM = current.exKLA.bookings.total.gm;
  const billingsGM = current.exKLA.billings.total.gm;
  const bookingsWoW = prior.exKLA.bookings.total.gp > 0 ?
    ((current.exKLA.bookings.total.gp - prior.exKLA.bookings.total.gp) / prior.exKLA.bookings.total.gp) * 100 : 0;

  // Check for large returns that distort WoW analysis
  const currentHasLargeReturns = returns.current.filter(r => r.type === 'bookings').length > 0;
  const priorHasLargeReturns = returns.prior.filter(r => r.type === 'bookings').length > 0;
  const wowDistorted = currentHasLargeReturns || priorHasLargeReturns;

  // B/B Ratio Analysis (4-state model)
  if (bbRatio >= 2.0) {
    observations.push({
      icon: '🔴',
      color: '#dc2626',
      state: 'ALLOCATED',
      text: `B/B ratio ${bbRatio.toFixed(2)}x indicates severe demand/supply imbalance — critical allocation signals`
    });
  } else if (bbRatio >= 1.3) {
    observations.push({
      icon: '🟠',
      color: '#ea580c',
      state: 'CONSTRAINED',
      text: `B/B ratio ${bbRatio.toFixed(2)}x shows demand outpacing supply — extended lead times likely`
    });
  } else if (bbRatio < 0.9) {
    observations.push({
      icon: '🔵',
      color: '#3b82f6',
      state: 'RECOVERY',
      text: `B/B ratio ${bbRatio.toFixed(2)}x suggests supply catching up to demand — market loosening from prior constraints`
    });
  } else {
    observations.push({
      icon: '🟢',
      color: '#10b981',
      state: 'NORMAL',
      text: `B/B ratio ${bbRatio.toFixed(2)}x shows balanced demand/supply — stable market conditions`
    });
  }

  // Margin Pressure Analysis
  if (bookingsGM < 0.18 || billingsGM < 0.18) {
    observations.push({
      icon: '🟠',
      color: '#ea580c',
      state: 'CONSTRAINED',
      text: `Gross margins (${formatPercent(bookingsGM)} bookings / ${formatPercent(billingsGM)} billings) below 18% threshold — indicates pricing pressure consistent with constrained supply or competitive market`
    });
  } else if (bookingsGM >= 0.25 && billingsGM >= 0.22) {
    observations.push({
      icon: '🟢',
      color: '#10b981',
      state: 'NORMAL',
      text: `Healthy margins (${formatPercent(bookingsGM)} bookings / ${formatPercent(billingsGM)} billings) suggest normal pricing environment`
    });
  }

  // Holiday Impact Detection
  const currentYear = 2026; // TODO: Get from snapshot data
  const currentWeek = snapshot.currentWeek;
  const priorWeek = snapshot.priorWeek;

  const currentHoliday = detectHolidayImpact(currentWeek, currentYear);
  const priorHoliday = detectHolidayImpact(priorWeek, currentYear);

  // YoY Comparison (if prior year data available)
  let yoyBookingsChange = null;
  if (priorYearSnapshot && priorYearSnapshot.current.exKLA.bookings.total.gp > 0) {
    yoyBookingsChange = ((current.exKLA.bookings.total.gp - priorYearSnapshot.current.exKLA.bookings.total.gp) /
                         priorYearSnapshot.current.exKLA.bookings.total.gp) * 100;
  }

  // WoW Growth Analysis - Skip if distorted by large returns or holidays
  const skipWoW = wowDistorted || currentHoliday || priorHoliday;

  if (!skipWoW) {
    if (bookingsWoW >= 75) {
      observations.push({
        icon: '🔴',
        color: '#dc2626',
        state: 'ALLOCATED',
        text: `Bookings up ${bookingsWoW >= 0 ? '+' : ''}${bookingsWoW.toFixed(0)}% WoW — severe demand surge consistent with allocation conditions`
      });
    } else if (bookingsWoW >= 40) {
      observations.push({
        icon: '🟠',
        color: '#ea580c',
        state: 'CONSTRAINED',
        text: `Bookings up ${bookingsWoW >= 0 ? '+' : ''}${bookingsWoW.toFixed(0)}% WoW — significant demand increase indicates supply tightening`
      });
    } else if (bookingsWoW <= -30) {
      observations.push({
        icon: '🔵',
        color: '#3b82f6',
        state: 'RECOVERY',
        text: `Bookings down ${bookingsWoW.toFixed(0)}% WoW — demand cooling may indicate market recovery from prior constraints`
      });
    }
  } else {
    // Note if WoW is distorted
    if (priorHasLargeReturns) {
      observations.push({
        icon: '⚠️',
        color: '#64748b',
        state: 'NOTE',
        text: `WoW comparison affected by large return in prior week — underlying demand trends may differ from reported ${bookingsWoW >= 0 ? '+' : ''}${bookingsWoW.toFixed(0)}% change`
      });
    } else if (currentHoliday || priorHoliday) {
      const affectedWeek = currentHoliday ? `current week (${currentHoliday})` : `prior week (${priorHoliday})`;
      observations.push({
        icon: '⚠️',
        color: '#64748b',
        state: 'NOTE',
        text: `WoW comparison affected by ${affectedWeek} — seasonal patterns may differ from normal operations`
      });
    }
  }

  // YoY Growth Analysis (more reliable than WoW for trend analysis)
  if (yoyBookingsChange !== null) {
    if (yoyBookingsChange >= 50) {
      observations.push({
        icon: '🔴',
        color: '#dc2626',
        state: 'ALLOCATED',
        text: `Bookings up ${yoyBookingsChange >= 0 ? '+' : ''}${yoyBookingsChange.toFixed(0)}% YoY (vs Week ${currentWeek} 2025: ${formatCurrency(priorYearSnapshot.current.exKLA.bookings.total.gp, true)}) — severe sustained growth consistent with allocation conditions${currentHoliday ? ` despite ${currentHoliday} impact` : ''}`
      });
    } else if (yoyBookingsChange >= 25) {
      observations.push({
        icon: '🟠',
        color: '#ea580c',
        state: 'CONSTRAINED',
        text: `Bookings up ${yoyBookingsChange >= 0 ? '+' : ''}${yoyBookingsChange.toFixed(0)}% YoY (vs Week ${currentWeek} 2025: ${formatCurrency(priorYearSnapshot.current.exKLA.bookings.total.gp, true)}) — sustained growth indicates supply tightening${currentHoliday ? ` despite ${currentHoliday} impact` : ''}`
      });
    } else if (yoyBookingsChange <= -20) {
      observations.push({
        icon: '🔵',
        color: '#3b82f6',
        state: 'RECOVERY',
        text: `Bookings down ${yoyBookingsChange.toFixed(0)}% YoY (vs Week ${currentWeek} 2025: ${formatCurrency(priorYearSnapshot.current.exKLA.bookings.total.gp, true)}) — demand normalizing from prior year levels`
      });
    } else if (Math.abs(yoyBookingsChange) >= 5) {
      // Show YoY even if not lifecycle-significant, for context
      observations.push({
        icon: '📊',
        color: '#64748b',
        state: 'YoY TREND',
        text: `Bookings ${yoyBookingsChange >= 0 ? '+' : ''}${yoyBookingsChange.toFixed(0)}% YoY (vs Week ${currentWeek} 2025: ${formatCurrency(priorYearSnapshot.current.exKLA.bookings.total.gp, true)})${currentHoliday ? ` — ${currentHoliday} week comparison` : ''}`
      });
    }
  }

  return observations;
}

/**
 * Get last date and last business day from Excel date data
 */
function getWeekEndDates(bookingsData, billingsData, weekNum) {
  const weekBookings = bookingsData.filter(row => row['Week Number'] === weekNum);
  const weekBillings = billingsData.filter(row => row['Week Number'] === weekNum);

  // Get all dates for the week
  const bookingDates = weekBookings.map(r => r['Date']).filter(d => d);
  const billingDates = weekBillings.map(r => r['Invoice Date']).filter(d => d);
  const allDates = [...bookingDates, ...billingDates].sort((a, b) => b - a);

  if (allDates.length === 0) return null;

  // Convert Excel serial date to JS Date
  const excelDateToJSDate = (serial) => {
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    return new Date(date_info.getFullYear(), date_info.getMonth(), date_info.getDate());
  };

  const lastDate = excelDateToJSDate(allDates[0]);
  let lastBusinessDay = new Date(lastDate);

  // If weekend, find the last business day (Friday)
  if (lastBusinessDay.getDay() === 0) { // Sunday
    lastBusinessDay.setDate(lastBusinessDay.getDate() - 2);
  } else if (lastBusinessDay.getDay() === 6) { // Saturday
    lastBusinessDay.setDate(lastBusinessDay.getDate() - 1);
  }

  return {
    lastDate,
    lastBusinessDay,
    isWeekend: lastDate.getDay() === 0 || lastDate.getDay() === 6
  };
}

/**
 * Generate Executive Summary (Option B: Sales Action Priority)
 */
function generateExecutiveSummary(snapshot, constraintIndicators, temperatureGauge, externalMarketData) {
  const { currentWeek, current } = snapshot;
  const bbRatio = current.exKLA.billings.total.gp > 0 ?
    (current.exKLA.bookings.total.gp / current.exKLA.billings.total.gp) : 0;

  // Build top 3 actions from constraint indicators
  const actions = [];

  // Action 1: Identify top allocation signals from franchise lead times
  const allocatedParts = constraintIndicators.franchiseLeadTimes
    .filter(lt => lt.status === 'Allocated')
    .sort((a, b) => parseFloat(b.current_avg_lt) - parseFloat(a.current_avg_lt))
    .slice(0, 3);

  if (allocatedParts.length > 0) {
    const topAlloc = allocatedParts[0];
    const partList = allocatedParts.map(p => p.part_family).join(', ');
    const currentLTs = allocatedParts.map(p => parseFloat(p.current_avg_lt));
    const ltRange = `${Math.min(...currentLTs).toFixed(0)}-${Math.max(...currentLTs).toFixed(0)}w`;

    actions.push({
      number: '1️⃣',
      title: `${topAlloc.manufacturer} ALLOCATION ALERT (${partList})`,
      internal: `${parseFloat(topAlloc.current_avg_lt).toFixed(1)}w current LT, ${topAlloc.bucket_allocated} of ${topAlloc.vq_count} VQs at 40+w`,
      external: `Industry reports confirm allocation signals for ${topAlloc.manufacturer} parts`,
      action: `Verify with sourcing on current availability and lead times for ${partList} parts before customer commitments. If supply exists, extended lead times (${ltRange}) and premium pricing may apply due to market-wide allocation.`
    });
  }

  // Action 2: Identify competitive advantages (OT better than market)
  const advantages = externalMarketData.filter(ext => ext.alignment === 'BETTER SUPPLY');
  if (advantages.length > 0) {
    const adv = advantages[0];
    const otParts = constraintIndicators.franchiseLeadTimes.filter(lt =>
      lt.part_family && adv.otPartFamilies.some(pf => lt.part_family.startsWith(pf))
    );
    const ourLT = otParts.length > 0 ? parseFloat(otParts[0].current_avg_lt).toFixed(0) : 'unknown';

    actions.push({
      number: '2️⃣',
      title: `${adv.category.toUpperCase()} POTENTIAL SUPPLY ADVANTAGE`,
      internal: `OT showing ${ourLT}w lead time`,
      external: `Industry reports ${adv.industryLeadTime} (${adv.keySignals})`,
      action: `Check with sourcing to verify if ${adv.category} supply access is better than competitor lead times. If confirmed, sales messaging: "Sourcing may have supply that beats competitor lead times" → Competitive positioning opportunity. Pricing changes quickly in shortage markets - verify current availability before customer quotes.`
    });
  }

  // Action 3: Identify rising constraints (watch list)
  const constrained = constraintIndicators.franchiseLeadTimes
    .filter(lt => lt.status === 'Constrained' && parseFloat(lt.lt_change_pct) > 15)
    .sort((a, b) => parseFloat(b.lt_change_pct) - parseFloat(a.lt_change_pct))
    .slice(0, 2);

  if (constrained.length > 0) {
    const top = constrained[0];
    const partList = constrained.map(p => p.part_family || 'Unknown').join(', ');
    const topLT = parseFloat(top.current_avg_lt);
    const topChangePct = parseFloat(top.lt_change_pct);

    actions.push({
      number: '3️⃣',
      title: `${top.manufacturer} WATCH LIST (${partList})`,
      internal: `${topLT.toFixed(1)}w LT (${topChangePct >= 0 ? '+' : ''}${topChangePct.toFixed(0)}% WoW), ${top.bucket_allocated} of ${top.vq_count} VQs at 40+w`,
      external: `${top.manufacturer} parts showing rising constraint signals externally`,
      action: `Monitor ${partList} parts closely. Verify with sourcing on current stock levels and incoming supply. May escalate to full allocation in 2-4 weeks - early customer communication recommended if lead times extend further.`
    });
  }

  // Generate HTML
  return `
  <!-- EXECUTIVE SUMMARY -->
  <div style="background: linear-gradient(to right, #f8fafc, #ffffff); border: 3px solid #3b82f6; border-radius: 10px; padding: 20px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <h2 style="font-size: 16px; font-weight: 700; margin: 0 0 4px 0; color: #1e293b; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">
      📊 WEEK ${currentWeek} MARKET PULSE — EXECUTIVE SUMMARY
    </h2>
    <p style="font-size: 11px; color: #64748b; margin: 0 0 16px 0; font-style: italic;">
      Top sales actions based on internal OT data + external market validation • All actions require sourcing verification
    </p>

    ${actions.map(action => `
    <div style="margin-bottom: 16px; padding: 14px; background: white; border-left: 4px solid #3b82f6; border-radius: 6px;">
      <h3 style="font-size: 12px; font-weight: 700; margin: 0 0 8px 0; color: #1e293b;">
        ${action.number} ${action.title}
      </h3>
      <div style="font-size: 10px; color: #475569; margin-bottom: 6px; line-height: 1.5;">
        <div style="margin-bottom: 4px;">
          <strong style="color: #0f766e;">├─ Internal (OT):</strong> ${action.internal}
        </div>
        <div style="margin-bottom: 6px;">
          <strong style="color: #7c2d12;">├─ External (Industry):</strong> ${action.external}
        </div>
        <div style="padding: 8px; background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 4px;">
          <strong style="color: #92400e;">└─ ACTION:</strong> ${action.action}
        </div>
      </div>
    </div>
    `).join('')}

    <div style="margin-top: 16px; padding-top: 14px; border-top: 1px solid #e2e8f0;">
      <h3 style="font-size: 11px; font-weight: 600; margin: 0 0 8px 0; color: #1e293b;">
        📈 OVERALL MARKET STATE & BUSINESS PERFORMANCE
      </h3>
      <div style="font-size: 10px; color: #475569; line-height: 1.6;">
        <div style="display: flex; gap: 24px; margin-bottom: 6px;">
          <div><strong>Market State:</strong> ${temperatureGauge.temperature} (${temperatureGauge.totalSignals} total signals)</div>
          <div><strong>B/B Ratio:</strong> ${bbRatio.toFixed(2)}x ${bbRatio >= 1.3 ? '→ Demand outpacing billings (backlog building)' : '→ Balanced supply/demand'}</div>
        </div>
        <div style="display: flex; gap: 24px;">
          <div><strong>Bookings GP:</strong> ${formatCurrency(current.exKLA.bookings.total.gp, true)} @ ${formatPercent(current.exKLA.bookings.total.gm)} GM</div>
          <div><strong>Billings GP:</strong> ${formatCurrency(current.exKLA.billings.total.gp, true)} @ ${formatPercent(current.exKLA.billings.total.gm)} GM</div>
          <div><strong>Signal Breakdown:</strong> ${temperatureGauge.allocatedCount} Allocated + ${temperatureGauge.constrainedCount} Constrained + ${temperatureGauge.shortageSignalCount} Shortage</div>
        </div>
      </div>
    </div>

    <div style="margin-top: 12px; padding: 10px; background: #fef3c7; border-left: 3px solid #f59e0b; border-radius: 4px; font-size: 10px; color: #92400e;">
      <strong>⚠️ IMPORTANT:</strong> Supply and pricing change rapidly in shortage markets. All actions above require sourcing verification of current availability, lead times, and pricing before making customer commitments. Data reflects Week ${currentWeek} conditions and may not represent current state.
    </div>
  </div>
  `;
}

/**
 * Build HTML email
 */
function buildHTML(snapshot, bookingsData, billingsData, constraintIndicators, temperatureGauge, externalMarketData, lifecycleObservations) {
  const { currentWeek, priorWeek, current, prior, kla, returns } = snapshot;

  // Get week end date for title (just the last day of data)
  const weekDates = getWeekEndDates(bookingsData, billingsData, currentWeek);
  let weekEndDateStr = '';
  if (weekDates) {
    weekEndDateStr = weekDates.lastDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
  }

  // Calculate WoW changes (Ex-KLA)
  const bookingsWoW = prior.exKLA.bookings.total.gp > 0 ?
    ((current.exKLA.bookings.total.gp - prior.exKLA.bookings.total.gp) / prior.exKLA.bookings.total.gp) * 100 : 0;
  const billingsWoW = prior.exKLA.billings.total.gp > 0 ?
    ((current.exKLA.billings.total.gp - prior.exKLA.billings.total.gp) / prior.exKLA.billings.total.gp) * 100 : 0;

  // B/B ratios (GP-based)
  const bbRatioExKLA = current.exKLA.billings.total.gp > 0 ?
    (current.exKLA.bookings.total.gp / current.exKLA.billings.total.gp) : 0;
  const bbRatioTotal = current.total.billings.total.gp > 0 ?
    (current.total.bookings.total.gp / current.total.billings.total.gp) : 0;

  // Check for returns affecting each metric
  const currentBookingReturns = returns.current.filter(r => r.type === 'bookings');
  const currentBillingReturns = returns.current.filter(r => r.type === 'billings');
  const priorBookingReturns = returns.prior.filter(r => r.type === 'bookings');
  const priorBillingReturns = returns.prior.filter(r => r.type === 'billings');

  // Build return notes
  const returnNotes = [];
  if (currentBookingReturns.length > 0) {
    currentBookingReturns.forEach(r => {
      returnNotes.push(`Week ${currentWeek} Bookings includes ${r.customer} credit/return: ${formatCurrency(r.gp, true)} GP`);
    });
  }
  if (currentBillingReturns.length > 0) {
    currentBillingReturns.forEach(r => {
      returnNotes.push(`Week ${currentWeek} Billings includes ${r.customer} credit/return: ${formatCurrency(r.gp, true)} GP`);
    });
  }
  if (priorBookingReturns.length > 0) {
    priorBookingReturns.forEach(r => {
      returnNotes.push(`Week ${priorWeek} Bookings includes ${r.customer} credit/return: ${formatCurrency(r.gp, true)} GP`);
    });
  }
  if (priorBillingReturns.length > 0) {
    priorBillingReturns.forEach(r => {
      returnNotes.push(`Week ${priorWeek} Billings includes ${r.customer} credit/return: ${formatCurrency(r.gp, true)} GP`);
    });
  }

  // Regional breakdown (Total Business) - merge APAC sub-teams
  const regionalData = ['USA', 'MEX', 'APAC', 'Other'].map(region => {
    let bookingsGP, billingsGP, bookingsGM, billingsGM;

    if (region === 'APAC') {
      // Consolidated APAC
      bookingsGP = current.total.apac.bookings.gp;
      billingsGP = current.total.apac.billings.gp;
      bookingsGM = current.total.apac.bookings.gm;
      billingsGM = current.total.apac.billings.gm;
    } else {
      const b = current.total.bookings.byTeam[region] || { gp: 0, gm: 0 };
      const bil = current.total.billings.byTeam[region] || { gp: 0, gm: 0 };
      bookingsGP = b.gp;
      billingsGP = bil.gp;
      bookingsGM = b.gm;
      billingsGM = bil.gm;
    }

    // Skip if no data
    if (bookingsGP === 0 && billingsGP === 0) return null;

    return {
      region,
      bookingsGP,
      billingsGP,
      bookingsGM,
      billingsGM,
      bbRatio: billingsGP > 0 ? (bookingsGP / billingsGP) : 0
    };
  }).filter(d => d);

  // Build regional rows HTML
  const regionalRows = regionalData.map(d => {
    const rowStyle = d.region === 'APAC' && (kla.bookings.gp > 0 || kla.billings.gp > 0) ?
      ' style="background: #fef3c7;"' : '';
    return `
        <tr${rowStyle}>
          <td><strong>${d.region}${d.region === 'APAC' ? ' *' : ''}</strong></td>
          <td>${formatCurrency(d.bookingsGP, true)}</td>
          <td>${formatCurrency(d.billingsGP, true)}</td>
          <td><strong style="${d.bbRatio < 1.0 ? 'color: #dc2626;' : ''}">${d.bbRatio.toFixed(2)}</strong></td>
          <td style="${d.bookingsGM < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(d.bookingsGM)}</td>
          <td style="${d.billingsGM < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(d.billingsGM)}</td>
        </tr>`;
  }).join('');

  // Calculate totals for regional breakdown - use overall totals to ensure accuracy
  const regionalTotals = {
    bookingsGP: current.total.bookings.total.gp,
    billingsGP: current.total.billings.total.gp
  };
  regionalTotals.bbRatio = regionalTotals.billingsGP > 0 ?
    (regionalTotals.bookingsGP / regionalTotals.billingsGP) : 0;
  regionalTotals.bookingsGM = current.total.bookings.total.gm;
  regionalTotals.billingsGM = current.total.billings.total.gm;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Pulse — Week ${currentWeek}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
    max-width: 1100px;
    margin: 0 auto;
    padding: 20px;
    background: #f5f5f5;
  }
  .container {
    background: white;
    padding: 24px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 4px 0;
    color: #1a1a1a;
  }
  .subtitle {
    font-size: 12px;
    color: #666;
    margin-bottom: 20px;
  }
  .section {
    margin-bottom: 28px;
    padding-bottom: 28px;
    border-bottom: 2px solid #e0e0e0;
  }
  .section:last-child {
    border-bottom: none;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #1a1a1a;
  }
  .section-subtitle {
    font-size: 11px;
    color: #666;
    margin-bottom: 12px;
    font-style: italic;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin: 0;
  }
  th {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    color: #475569;
  }
  td {
    border: 1px solid #e2e8f0;
    padding: 8px;
  }
  tr:hover {
    background: #fafafa;
  }
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #e0e0e0;
    font-size: 11px;
    color: #666;
  }
</style>
</head>
<body>
<div class="container">
  <h1>📈 Market Pulse — Week ${currentWeek}${weekEndDateStr ? ` (as of ${weekEndDateStr})` : ''}</h1>
  <div class="subtitle">Weekly market intelligence and performance snapshot</div>

  ${generateExecutiveSummary(snapshot, constraintIndicators, temperatureGauge, externalMarketData)}

  <!-- EXTERNAL MARKET SNAPSHOT -->
  <div style="background: white; border: 2px solid #cbd5e1; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
    <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 6px 0; color: #1e293b;">📡 External Market Snapshot — Industry Lifecycle Check</h2>
    <p style="font-size: 12px; color: #64748b; margin: 0 0 16px 0; font-style: italic;">
      How do external industry signals compare to our internal OT data? This helps validate whether shortages are market-wide or customer-specific.
    </p>

    <table style="background: white;">
      <thead>
        <tr>
          <th style="width: 15%;">Category</th>
          <th style="width: 12%; text-align: center;">External Status</th>
          <th style="width: 28%;">Key Signals</th>
          <th style="width: 12%; text-align: center;">Industry LT</th>
          <th style="width: 15%; text-align: center;">Alignment</th>
          <th style="width: 18%;">OT Internal Signal</th>
        </tr>
      </thead>
      <tbody>
        ${externalMarketData.map(item => {
          const statusDot = `<span style="display: inline-block; width: 10px; height: 10px; background: ${item.statusColor}; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>`;
          return `
        <tr style="background: #f5f5f5;">
          <td><strong>${item.category}</strong></td>
          <td style="text-align: center; font-weight: 600;">
            ${statusDot}<span style="color: ${item.statusColor};">${item.status.toUpperCase()}</span>
          </td>
          <td style="font-size: 11px;">${item.keySignals}</td>
          <td style="text-align: center; font-weight: 600;">${item.industryLeadTime}</td>
          <td style="text-align: center; font-weight: 700; ${
            item.alignment === 'MATCHES' ? 'color: #10b981;' :
            item.alignment === 'BETTER SUPPLY' ? 'color: #3b82f6;' :
            'color: #ea580c;'
          }">
            ${item.alignmentIcon} ${item.alignment}
          </td>
          <td style="font-size: 11px; color: #666;">${item.otSignal}</td>
        </tr>
        `;
        }).join('')}
      </tbody>
    </table>

    <div style="margin-top: 16px; padding: 12px; background: white; border-left: 4px solid #3b82f6; border-radius: 4px;">
      <p style="font-size: 11px; color: #1e40af; margin: 0; line-height: 1.6;">
        <strong>💡 Sales Action Guide:</strong><br>
        • ✅ <strong>MATCHES</strong> → Confirmed market-wide shortage; premium pricing justified, proactive customer outreach<br>
        • ⚠️ <strong>BETTER SUPPLY</strong> → Competitive advantage! Market aggressively: "We have what competitors don't"<br>
        • ⚠️ <strong>WATCH</strong> → Monitor for pricing pressure; may need to adjust margins to remain competitive
      </p>
    </div>

    <p style="font-size: 10px; color: #7d6608; margin: 12px 0 0 0; font-style: italic;">
      <strong>Data Sources:</strong> Sourceability Market Outlook, Avnet Semiconductor Market Pulse, J2 Sourcing Lead Time Tracker (Updated: 2026-06-23)
    </p>
  </div>

  <!-- MARKET LIFECYCLE STATES (CIRCULAR) -->
  <div style="background: white; border: 2px solid #cbd5e1; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
    <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 8px 0; color: #1e293b; text-align: center;">🌡️ Market Lifecycle States</h2>
    <p style="font-size: 11px; color: #64748b; margin: 0 0 20px 0; text-align: center; font-style: italic;">
      Reference this legend to interpret market signals throughout the report
    </p>

    <!-- Circular Layout -->
    <div style="max-width: 600px; margin: 0 auto; position: relative;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <!-- Top: Normal -->
          <td colspan="3" style="text-align: center; padding: 8px;">
            <div style="display: inline-block; background: #f5f5f5; border: 2px solid #10b981; border-radius: 8px; padding: 10px 16px; min-width: 150px;">
              <div style="margin-bottom: 4px;">
                <span style="display: inline-block; width: 12px; height: 12px; background: #10b981; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>
                <strong style="font-size: 12px; color: #10b981; vertical-align: middle;">NORMAL</strong>
              </div>
              <p style="font-size: 9px; color: #666; margin: 0; line-height: 1.3;">8-16w LT • Stable supply</p>
            </div>
          </td>
        </tr>
        <tr>
          <!-- Left: Recovery -->
          <td style="width: 33%; text-align: right; padding: 8px; vertical-align: middle;">
            <div style="display: inline-block; background: #f5f5f5; border: 2px solid #3b82f6; border-radius: 8px; padding: 10px 16px; min-width: 140px;">
              <div style="margin-bottom: 4px;">
                <span style="display: inline-block; width: 12px; height: 12px; background: #3b82f6; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>
                <strong style="font-size: 12px; color: #3b82f6; vertical-align: middle;">RECOVERY</strong>
              </div>
              <p style="font-size: 9px; color: #666; margin: 0; line-height: 1.3;">20-40w declining<br>Improving supply</p>
            </div>
          </td>
          <!-- Center: Cycle indicator -->
          <td style="width: 34%; text-align: center; vertical-align: middle; padding: 8px;">
            <div style="font-size: 32px; color: #cbd5e1; line-height: 1;">↻</div>
            <p style="font-size: 10px; color: #94a3b8; margin: 4px 0 0 0; font-weight: 600;">CYCLE</p>
          </td>
          <!-- Right: Constrained -->
          <td style="width: 33%; text-align: left; padding: 8px; vertical-align: middle;">
            <div style="display: inline-block; background: #f5f5f5; border: 2px solid #ea580c; border-radius: 8px; padding: 10px 16px; min-width: 140px;">
              <div style="margin-bottom: 4px;">
                <span style="display: inline-block; width: 12px; height: 12px; background: #ea580c; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>
                <strong style="font-size: 12px; color: #ea580c; vertical-align: middle;">CONSTRAINED</strong>
              </div>
              <p style="font-size: 9px; color: #666; margin: 0; line-height: 1.3;">16-40w LT<br>Tightening</p>
            </div>
          </td>
        </tr>
        <tr>
          <!-- Bottom Center: Allocated -->
          <td colspan="3" style="text-align: center; padding: 8px;">
            <div style="display: inline-block; background: #f5f5f5; border: 2px solid #dc2626; border-radius: 8px; padding: 10px 16px; min-width: 150px;">
              <div style="margin-bottom: 4px;">
                <span style="display: inline-block; width: 12px; height: 12px; background: #dc2626; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>
                <strong style="font-size: 12px; color: #dc2626; vertical-align: middle;">ALLOCATED</strong>
              </div>
              <p style="font-size: 9px; color: #666; margin: 0; line-height: 1.3;">40-65+w LT • Critical shortage</p>
            </div>
          </td>
        </tr>
      </table>
    </div>
  </div>

  <!-- CONSTRAINT INDICATORS -->
  <div class="section">
    <div class="section-title">🚨 Constraint Indicators — Market Signals (30-Day Rolling)</div>
    <div class="section-subtitle">Early warning signals from OT data • Source: RFQ/VQ/CQ activity</div>

    ${constraintIndicators.multiCustomerParts.length > 0 ? `
    <!-- Hot Part Families - Shortage Signals -->
    <div style="background: white; border: 2px solid #cbd5e1; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
      <h3 style="font-size: 14px; font-weight: 700; margin: 0 0 8px 0; color: #1e293b;">🔥 Hot Part Families — Shortage Signals (2+ OEM Customers)</h3>
      <p style="font-size: 11px; color: #666; margin-bottom: 12px; font-style: italic;">
        Full funnel view: RFQ → VQ → CQ → SO conversion with GP/GM performance tracking<br>
        <strong>Method:</strong> Part family grouping (GRM21*, TPS*, BAS*, SN74*, etc.); excludes Tier 1 EMS to remove aggregation noise<br>
        <strong>Time Window:</strong> RFQs from last 30 days; VQ/CQ/SO conversions shown for all time (full historical funnel)<br>
        <strong>Filters:</strong> Shortage RFQs only (excludes PPV, Cost Savings, Stock); 2+ distinct OEM customers; sorted by Booked GP
      </p>
      <table>
        <thead>
          <tr>
            <th style="width: 9%;">Part Family</th>
            <th style="width: 12%;">Manufacturer</th>
            <th style="width: 8%;">Type</th>
            <th style="width: 15%;">Examples</th>
            <th style="width: 6%;">Total Cust</th>
            <th style="width: 8%;">OEM Only</th>
            <th style="width: 6%;">Unique Parts</th>
            <th style="width: 5%;">RFQ Lines</th>
            <th style="width: 5%;">VQ Lines</th>
            <th style="width: 5%;">CQ Lines</th>
            <th style="width: 5%;">SO Lines</th>
            <th style="width: 9%;">Booked GP</th>
            <th style="width: 5%;">GM%</th>
          </tr>
        </thead>
        <tbody>
          ${constraintIndicators.multiCustomerParts.map(part => {
            const totalCust = parseInt(part.total_customers);
            const oemCust = parseInt(part.oem_customers);
            const emsCust = totalCust - oemCust;
            const bookedGP = parseFloat(part.booked_gp);
            const bookedGM = parseFloat(part.booked_gm_pct);
            const noQuoteCount = parseInt(part.no_quote_count);
            const vqLines = parseInt(part.vq_lines);
            return `
          <tr>
            <td><strong style="font-size: 13px;">${part.mpn}*</strong></td>
            <td style="font-size: 11px;">${part.manufacturer}</td>
            <td style="font-size: 10px; color: #1e40af; font-weight: 600;">${part.part_type}</td>
            <td style="font-size: 10px; color: #666;">${part.example_mpns || ''}</td>
            <td style="text-align: center; font-size: 11px; font-weight: 600;">${totalCust}</td>
            <td style="text-align: center; font-size: 11px; color: #dc2626; font-weight: 600;">${oemCust}${emsCust > 0 ? ` <span style="color: #666; font-weight: 400;">(+${emsCust})</span>` : ''}</td>
            <td style="text-align: center; font-size: 11px;">${part.unique_parts}</td>
            <td style="text-align: center; font-size: 11px; font-weight: 600;">${part.rfq_lines}</td>
            <td style="text-align: center; font-size: 11px; ${noQuoteCount > 0 ? 'color: #ea580c;' : ''}">${vqLines}${noQuoteCount > 0 ? ` <span style="font-size: 9px; color: #dc2626;" title="${noQuoteCount} no quote/no stock responses">(-${noQuoteCount})</span>` : ''}</td>
            <td style="text-align: center; font-size: 11px;">${part.cq_lines}</td>
            <td style="text-align: center; font-size: 11px; font-weight: 600;">${part.so_lines}</td>
            <td style="text-align: right; font-size: 11px; font-weight: 600;">${formatCurrency(bookedGP, true)}</td>
            <td style="text-align: center; font-size: 11px; ${bookedGM !== null && bookedGM > 0 && bookedGM < 0.18 ? 'color: #dc2626;' : ''}">${bookedGM !== null && !isNaN(bookedGM) ? (bookedGM * 100).toFixed(1) + '%' : '-'}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    ${constraintIndicators.franchiseLeadTimes.length > 0 ? `
    <!-- Franchise Lead Time Analysis (Market Temperature) -->
    <div style="background: white; border: 2px solid #cbd5e1; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
      <h3 style="font-size: 14px; font-weight: 700; margin: 0 0 8px 0; color: #1e293b;">📊 Franchise Lead Time Analysis (Market Temperature by Part Type)</h3>
      <p style="font-size: 11px; color: #666; margin-bottom: 12px; font-style: italic;">
        Supply chain stress indicator: Franchise distributor lead times (current 30d vs 90d baseline)<br>
        <strong>Source:</strong> Arrow, Avnet, Mouser, Digi-Key, Newark, Future, TTI, Master • <strong>Includes:</strong> Stock items (0 weeks = healthy supply)
      </p>
      <table>
        <thead>
          <tr>
            <th style="width: 11%;">Part Family</th>
            <th style="width: 14%;">Manufacturer</th>
            <th style="width: 11%;">Type</th>
            <th style="width: 9%;">Current LT</th>
            <th style="width: 9%;">Baseline LT</th>
            <th style="width: 8%;">Change</th>
            <th style="width: 11%;">Range</th>
            <th style="width: 17%;">Distribution</th>
            <th style="width: 6%;">Sample</th>
            <th style="width: 10%;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${constraintIndicators.franchiseLeadTimes.map(lt => {
            const currentLT = parseFloat(lt.current_avg_lt);
            const baselineLT = parseFloat(lt.baseline_avg_lt);
            const changePct = parseFloat(lt.lt_change_pct);
            const status = lt.status;

            // Status color coding - UNIFIED LIFECYCLE COLORS
            const statusColor = {
              'Allocated': '#dc2626',      // Red
              'Constrained': '#ea580c',    // Orange
              'Recovery': '#3b82f6',       // Blue
              'Stable': '#10b981'          // Green (Normal)
            }[status] || '#6b7280';

            const statusDot = `<span style="display: inline-block; width: 10px; height: 10px; background: ${statusColor}; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>`;

            return `
          <tr style="background: #f5f5f5;">
            <td><strong style="font-size: 12px;">${lt.part_family}</strong></td>
            <td style="font-size: 11px;">${lt.manufacturer}</td>
            <td style="font-size: 10px; color: #1e40af; font-weight: 600;">${lt.part_type}</td>
            <td style="text-align: center; font-weight: 600; ${changePct > 0 ? 'color: #dc2626;' : changePct < 0 ? 'color: #3b82f6;' : ''}">${currentLT.toFixed(1)}w</td>
            <td style="text-align: center; color: #666;">${baselineLT.toFixed(1)}w</td>
            <td style="text-align: center; ${changePct > 0 ? 'color: #dc2626;' : changePct < 0 ? 'color: #3b82f6;' : ''} font-weight: 600;">${changePct >= 0 ? '+' : ''}${changePct.toFixed(0)}%</td>
            <td style="text-align: center; font-size: 11px; color: #666;">${lt.min_leadtime}-${lt.max_leadtime}w</td>
            <td style="font-size: 10px;">
              <span style="color: #10b981;">0-7w: ${lt.bucket_stock}</span> |
              <span style="color: #10b981;">8-15w: ${lt.bucket_normal}</span> |
              <span style="color: #ea580c;">16-39w: ${lt.bucket_constrained}</span> |
              <span style="color: #dc2626;">40+w: ${lt.bucket_allocated}</span>
            </td>
            <td style="text-align: center; font-size: 11px;">${lt.vq_count}</td>
            <td style="text-align: center; font-weight: 600; font-size: 11px;">
              ${statusDot}<span style="color: ${statusColor};">${status.toUpperCase()}</span>
            </td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}


    ${constraintIndicators.multiCustomerParts.length === 0 &&
      constraintIndicators.franchiseLeadTimes.length === 0 ? `
    <div style="background: #f0fdf4; border: 2px solid #10b981; border-radius: 6px; padding: 16px; text-align: center;">
      <p style="font-size: 13px; color: #065f46; margin: 0;">
        ✅ <strong>No active constraint signals detected</strong> — Market conditions appear normal
      </p>
    </div>
    ` : ''}
  </div>

  <!-- TRENDING SHORTAGE MANUFACTURERS (Section 4) -->
  ${constraintIndicators.trendingMfrs.length > 0 ? `
  <div class="section">
    <div class="section-title">📊 Trending OT Shortage Manufacturers - Top 10 by Booked GP (30-days)</div>
    <div class="section-subtitle">Shortage RFQs only • All metrics reflect shortage opportunities only</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th style="text-align: center;">Total Cust</th>
          <th style="text-align: center;">OEM Only</th>
          <th style="text-align: center;">RFQ Lines</th>
          <th style="text-align: center;">VQ Lines</th>
          <th style="text-align: center;">CQ Lines</th>
          <th style="text-align: center;">Lines Sold</th>
          <th style="text-align: center;">CQ Sold %</th>
          <th style="text-align: right;">Booked GP</th>
        </tr>
      </thead>
      <tbody>
        ${constraintIndicators.trendingMfrs.map((mfr, idx) => {
          const cqSoldPct = parseFloat(mfr.cq_sold_pct);
          const bookedGP = parseFloat(mfr.booked_gp);
          const klaGP = parseFloat(mfr.kla_gp || 0);
          const totalCust = parseInt(mfr.total_customers);
          const oemCust = parseInt(mfr.oem_customers);
          const emsCust = totalCust - oemCust;

          // Flag if KLA represents >20% of GP or >$50K
          const klaImpact = (klaGP > 50000) || (bookedGP > 0 && (klaGP / bookedGP) > 0.2);

          return `
        <tr style="${idx === 0 ? 'background: #f0fdf4;' : ''}">
          <td><strong>${mfr.manufacturer}</strong>${idx === 0 ? ' 🏆' : ''}${klaImpact ? ' *' : ''}</td>
          <td style="text-align: center;">${totalCust}</td>
          <td style="text-align: center; color: #dc2626; font-weight: 600;">${oemCust}${emsCust > 0 ? ` <span style="color: #666; font-weight: 400;">(+${emsCust} EMS)</span>` : ''}</td>
          <td style="text-align: center;">${mfr.rfq_lines}</td>
          <td style="text-align: center;">${mfr.vq_lines}</td>
          <td style="text-align: center;">${mfr.cq_lines}</td>
          <td style="text-align: center; font-weight: 600;">${mfr.sold}</td>
          <td style="text-align: center; ${cqSoldPct > 0 && cqSoldPct < 0.15 ? 'color: #dc2626;' : ''}">${(cqSoldPct * 100).toFixed(1)}%</td>
          <td style="text-align: right; font-weight: 600;">${formatCurrency(bookedGP, true)}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${constraintIndicators.trendingMfrs.some(mfr => {
      const bookedGP = parseFloat(mfr.booked_gp);
      const klaGP = parseFloat(mfr.kla_gp || 0);
      return (klaGP > 50000) || (bookedGP > 0 && (klaGP / bookedGP) > 0.2);
    }) ? `
    <p style="font-size: 11px; color: #666; margin-top: 8px; font-style: italic;">
      * KLA represents significant portion (>20% or >$50K) of this manufacturer's booked GP
    </p>` : ''}
  </div>
  ` : ''}

  <!-- REGIONAL DEMAND DIVERGENCE (Section 7) -->
  ${constraintIndicators.regionalDivergence.length > 0 ? `
  <div class="section">
    <div class="section-title">🌏 Regional Demand Divergence — APAC Concentration Signals</div>
    <div class="section-subtitle">APAC constraint typically hits 3-4 weeks before USA • Threshold: 50%+ APAC demand</div>
    <table>
      <thead>
        <tr>
          <th>Manufacturer</th>
          <th style="text-align: center;">Total RFQs</th>
          <th style="text-align: center;">APAC %</th>
          <th style="text-align: center;">USA %</th>
          <th style="text-align: center;">MEX %</th>
          <th style="text-align: center;">Other %</th>
          <th style="text-align: center;">Signal</th>
        </tr>
      </thead>
      <tbody>
        ${constraintIndicators.regionalDivergence.map(div => {
          const apacPct = parseFloat(div.apac_pct);
          const isHighConcentration = apacPct >= 70;
          return `
        <tr style="${isHighConcentration ? 'background: #fef2f2;' : ''}">
          <td><strong>${div.manufacturer}</strong></td>
          <td style="text-align: center;">${div.total_rfqs}</td>
          <td style="text-align: center; font-weight: 700; ${isHighConcentration ? 'color: #dc2626;' : apacPct >= 50 ? 'color: #ea580c;' : ''}">${apacPct.toFixed(1)}%</td>
          <td style="text-align: center;">${parseFloat(div.usa_pct).toFixed(1)}%</td>
          <td style="text-align: center;">${parseFloat(div.mex_pct).toFixed(1)}%</td>
          <td style="text-align: center;">${parseFloat(div.other_pct).toFixed(1)}%</td>
          <td style="text-align: center; font-weight: 600;">${div.signal}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  ` : ''}

  <!-- PERFORMANCE SNAPSHOT -->
  <div class="section" style="background: white; border: 2px solid #cbd5e1; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
    <div class="section-title">💰 Performance Snapshot — Infor Weekly Summary</div>
    <div class="section-subtitle">Week ${currentWeek} vs ${priorWeek} (Completed weeks only) • Source: Infor ERP (Post-Sales)</div>

    <!-- LIFECYCLE OBSERVATIONS -->
    ${lifecycleObservations.length > 0 ? `
    <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
      <h4 style="font-size: 13px; font-weight: 600; margin: 0 0 12px 0; color: #1e293b;">📊 Market Lifecycle Indicators (Week ${currentWeek})</h4>
      ${lifecycleObservations.map(obs => `
        <div style="margin-bottom: 10px; padding: 8px 12px; background: white; border-left: 4px solid ${obs.color}; border-radius: 4px;">
          <p style="font-size: 11px; color: #334155; margin: 0; line-height: 1.5;">
            <span style="display: inline-block; width: 10px; height: 10px; background: ${obs.color}; border-radius: 50%; margin-right: 6px; vertical-align: middle;"></span>
            <strong style="color: ${obs.color}; vertical-align: middle;">${obs.state}:</strong> ${obs.text}
          </p>
        </div>
      `).join('')}
      <p style="font-size: 10px; color: #64748b; margin: 12px 0 0 0; font-style: italic;">
        These observations map performance metrics to the Market Lifecycle States defined at the top of this report.
      </p>
    </div>
    ` : ''}

    <!-- CORE BUSINESS (EX-KLA) -->
    <div style="background: #f5f5f5; border: 2px solid #cbd5e1; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
      <h3 style="font-size: 14px; font-weight: 700; margin: 0 0 12px 0; color: #065f46;">Inc Global Core Business Performance (Excl. KLA)</h3>
      <table>
        <thead>
          <tr>
            <th style="width: 20%;">Metric</th>
            <th style="width: 20%;">Week ${currentWeek}</th>
            <th style="width: 20%;">Week ${priorWeek}</th>
            <th style="width: 15%;">WoW Change</th>
            <th style="width: 25%;">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background: #f0fdf4;">
            <td><strong>Bookings GP</strong></td>
            <td>${formatCurrency(current.exKLA.bookings.total.gp, false)}${currentBookingReturns.length > 0 ? ' *' : ''}</td>
            <td>${formatCurrency(prior.exKLA.bookings.total.gp, false)}${priorBookingReturns.length > 0 ? ' *' : ''}</td>
            <td><strong style="${bookingsWoW < 0 ? 'color: #dc2626;' : ''}">${bookingsWoW >= 0 ? '+' : ''}${bookingsWoW.toFixed(1)}%</strong></td>
            <td style="font-size: 11px; ${current.exKLA.bookings.total.gm < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(current.exKLA.bookings.total.gm)} GM</td>
          </tr>
          <tr style="background: #f0fdf4;">
            <td><strong>Billings GP</strong></td>
            <td>${formatCurrency(current.exKLA.billings.total.gp, false)}${currentBillingReturns.length > 0 ? ' *' : ''}</td>
            <td>${formatCurrency(prior.exKLA.billings.total.gp, false)}${priorBillingReturns.length > 0 ? ' *' : ''}</td>
            <td><strong style="${billingsWoW < 0 ? 'color: #dc2626;' : ''}">${billingsWoW >= 0 ? '+' : ''}${billingsWoW.toFixed(1)}%</strong></td>
            <td style="font-size: 11px; ${current.exKLA.billings.total.gm < 0.18 ? 'color: #dc2626; font-weight: 600;' : ''}">${formatPercent(current.exKLA.billings.total.gm)} GM</td>
          </tr>
          <tr style="background: #dcfce7;">
            <td><strong>Book-to-Bill GP</strong></td>
            <td colspan="3"><strong style="font-size: 16px; ${bbRatioExKLA < 1.0 ? 'color: #dc2626;' : ''}">${bbRatioExKLA.toFixed(2)}x</strong></td>
            <td style="font-size: 11px; font-weight: 600; ${bbRatioExKLA >= 1.0 ? 'color: #065f46;' : 'color: #dc2626;'}">
              ${bbRatioExKLA >= 1.0 ? '✅ Building backlog' : '⚠️ Consuming backlog'}
            </td>
          </tr>
        </tbody>
      </table>
      ${returnNotes.length > 0 ? `
      <p style="font-size: 11px; color: #666; margin-top: 8px; font-style: italic;">
        * ${returnNotes.join('<br>* ')}
      </p>` : ''}
    </div>

    <!-- REGIONAL BREAKDOWN (TOTAL BUSINESS) -->
    <h3 style="font-size: 14px; font-weight: 600; margin: 20px 0 8px 0;">Regional Breakdown — Week ${currentWeek} (Total Business)</h3>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>Bookings GP</th>
          <th>Billings GP</th>
          <th>B/B Ratio GP</th>
          <th>Bookings GM</th>
          <th>Billings GM</th>
        </tr>
      </thead>
      <tbody>
        ${regionalRows}
        <tr style="font-weight: 700; background: #f3f4f6;">
          <td><strong>TOTAL</strong></td>
          <td>${formatCurrency(regionalTotals.bookingsGP, false)}</td>
          <td>${formatCurrency(regionalTotals.billingsGP, false)}</td>
          <td><strong style="${regionalTotals.bbRatio < 1.0 ? 'color: #dc2626;' : ''}">${regionalTotals.bbRatio.toFixed(2)}</strong></td>
          <td style="${regionalTotals.bookingsGM < 0.18 ? 'color: #dc2626;' : ''}">${formatPercent(regionalTotals.bookingsGM)}</td>
          <td style="${regionalTotals.billingsGM < 0.18 ? 'color: #dc2626;' : ''}">${formatPercent(regionalTotals.billingsGM)}</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size: 11px; color: #666; margin-top: 8px; font-style: italic;">
      * APAC includes KLA: ${formatCurrency(kla.bookings.gp, true)} bookings GP / ${formatCurrency(kla.billings.gp, true)} billings GP
    </p>

    <!-- KLA BUSINESS -->
    <div style="background: #f5f5f5; border: 2px solid #cbd5e1; border-radius: 6px; padding: 12px; margin-top: 20px;">
      <h3 style="font-size: 13px; font-weight: 600; margin: 0 0 8px 0; color: #1e293b;">KLA Business — Week ${currentWeek}</h3>
      <div style="display: flex; gap: 24px; font-size: 12px;">
        <div><strong>Bookings GP:</strong> ${formatCurrency(kla.bookings.gp, true)}</div>
        <div><strong>Billings GP:</strong> ${formatCurrency(kla.billings.gp, true)}</div>
        <div><strong>B/B Ratio GP:</strong> ${kla.billings.gp !== 0 ? (kla.bookings.gp / kla.billings.gp).toFixed(2) + 'x' : 'N/A'}</div>
        <div style="color: #64748b; font-style: italic;">${Math.abs(kla.billings.gp) > 100000 ? (kla.billings.gp > 0 ? `Large shipment (${formatCurrency(kla.billings.gp, true)})` : `Credit/return (${formatCurrency(kla.billings.gp, true)})`) : kla.billings.gp !== 0 ? 'Activity included' : 'No KLA activity'}</div>
      </div>
    </div>
  </div>

  <!-- MARKET PULSE CONSTRUCTION NOTES -->
  <div style="margin-top: 32px; margin-bottom: 20px; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
    <h4 style="font-size: 13px; font-weight: 600; margin: 0 0 8px 0; color: #1a1a1a;">🔧 Market Pulse Construction Notes</h4>
    <p style="font-size: 11px; color: #475569; margin: 0 0 12px 0; font-style: italic;">
      Enhancements and ideas under consideration for future iterations
    </p>
    <ul style="font-size: 11px; color: #475569; margin: 0; padding-left: 20px; line-height: 1.6;">
      <li><strong>WOW Comparison</strong> — Week-over-week comparison analysis with contextual adjustments for holidays, large returns, and market events (new this week)</li>
      <li><strong>Trending Parts</strong> — Top 10 individual MPNs by RFQ volume with scarcity signals</li>
      <li><strong>Manufacturer Exposure</strong> — Pipeline concentration risk (Open RFQ + CQ value by manufacturer)</li>
      <li><strong>New Entrants</strong> — Emerging manufacturers analysis; needs to be defined more to provide actionable market insights other than just a one off</li>
      <li><strong>Alternate Parts</strong> — Analysis of alternate part acceptance rates and cross-reference patterns</li>
      <li><strong>Enhanced External Market Integration</strong> — Automate external data collection; add industry lead time benchmarks to Franchise Lead Time table; create composite "Market Stress Score" combining internal + external signals</li>
    </ul>
    <p style="font-size: 10px; color: #64748b; margin: 8px 0 0 0; font-style: italic;">
      Have feedback on these or other ideas? Contact Melissa Bojar
    </p>
  </div>

  <!-- EXPLANATORY FOOTER -->
  <div style="margin-top: 32px; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
    <h3 style="font-size: 14px; font-weight: 600; margin: 0 0 12px 0; color: #1a1a1a;">📋 Report Methodology & Data Sources</h3>

    <div style="margin-bottom: 16px;">
      <h4 style="font-size: 12px; font-weight: 600; margin: 0 0 6px 0; color: #475569;">Section 1: External Market Snapshot — Industry Lifecycle Check</h4>
      <p style="font-size: 11px; color: #666; margin: 0; line-height: 1.6;">
        <strong>Data Source:</strong> Industry market reports (Sourceability, Avnet, J2 Sourcing, Deloitte)<br>
        <strong>What it shows:</strong> External semiconductor market conditions (Allocated/Constrained/Recovery/Normal) by category<br>
        <strong>Purpose:</strong> Validate whether our internal signals match market-wide trends or if we have competitive advantages<br>
        <strong>Alignment:</strong> ✅ MATCHES = market-wide shortage confirmed; ⚠️ BETTER SUPPLY = competitive advantage; ⚠️ WATCH = monitor for pricing pressure<br>
        <strong>Update Frequency:</strong> Manual review of industry reports (weekly or bi-weekly)
      </p>
    </div>

    <div style="margin-bottom: 16px;">
      <h4 style="font-size: 12px; font-weight: 600; margin: 0 0 6px 0; color: #475569;">Section 2: Constraint Indicators — Market Signals (30-Day Rolling)</h4>
      <p style="font-size: 11px; color: #666; margin: 0; line-height: 1.6;">
        <strong>Data Source:</strong> Orange Tsunami (OT) database — RFQ, VQ, CQ activity<br>
        <strong>Purpose:</strong> Early warning signs internal and external for supply constraints and allocation risk (2-4 week lead time before manufacturer announcements)
      </p>
    </div>

    <div style="margin-bottom: 16px;">
      <h4 style="font-size: 12px; font-weight: 600; margin: 0 0 6px 0; color: #475569;">Section 3: Performance Snapshot — Infor Weekly Summary</h4>
      <p style="font-size: 11px; color: #666; margin: 0; line-height: 1.6;">
        <strong>Data Source:</strong> Infor ERP (Post-Sales) via Power BI export<br>
        <strong>What it shows:</strong> Completed week bookings vs billings performance, all metrics shown as Gross Profit (GP) instead of revenue<br>
        <strong>Metrics:</strong> B/B Ratio = Bookings GP / Billings GP (>1.0 = building backlog, <1.0 = consuming backlog)<br>
        <strong>Regional Breakdown:</strong> USA (Jeff Wallace team), MEX (Joel Marquez team), APAC (Laurel, Silvia, Lavanya, Edyna teams)<br>
        <strong>KLA Business:</strong> Shown separately due to large shipment variability and credit/return impact<br>
        <strong>Returns/Credits:</strong> Asterisks (*) indicate large returns/credits (>$50K GP) affecting that week's metrics
      </p>
    </div>

    <div style="margin-bottom: 16px; margin-left: 16px;">
      <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #dc2626;">🔥 Hot Part Families - OT Shortage signals (2+ OEM Customers)</h5>
      <p style="font-size: 10px; color: #666; margin: 0; line-height: 1.5;">
        <strong>Data Source:</strong> Orange Tsunami (OT) database — RFQ, VQ, CQ, and Sales Order activity from last 30 days (RFQs) with all-time conversion tracking<br>
        <strong>What it shows:</strong> Full conversion funnel (RFQ → VQ → CQ → SO) for part families requested by multiple OEM customers in Shortage RFQs<br>
        <strong>Filters:</strong> Shortage RFQs only (excludes PPV, Cost Savings, Stock); excludes Tier 1 EMS (Sanmina, Jabil, Flextronics, etc.) to remove aggregation noise; sorted by Booked GP<br>
        <strong>Why it matters:</strong> Multiple OEMs chasing the same part family suggests supply constraint; funnel metrics show conversion effectiveness and business impact<br>
        <strong>Funnel Metrics:</strong> RFQ Lines (demand) → VQ Lines (quotes received) → CQ Lines (quotes sent) → SO Lines (orders booked)<br>
        <strong>VQ Lines Notation:</strong> Format is "158(-5)" where 158 = total VQ lines received and (-5) in red = no quote/no stock responses (VQ lines with $0 cost indicating suppliers unable or unwilling to quote)<br>
        <strong>GP/GM%:</strong> Booked business performance from actual Sales Orders; green if GM ≥18%, orange if <18%
      </p>
    </div>

    <div style="margin-bottom: 16px; margin-left: 16px;">
      <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #1e40af;">📊 External Franchise Lead Time Analysis (Market Temperature by Part Type)</h5>
      <p style="font-size: 10px; color: #666; margin: 0; line-height: 1.5;">
        <strong>What it shows:</strong> Factory lead times from franchise distributors (Arrow, Avnet, Mouser, Digi-Key, Newark, Future, TTI, Master)<br>
        <strong>Comparison:</strong> Current 30-day average vs 90-day baseline<br>
        <strong>Status Classification (4-State Aggressive Model):</strong><br>
        • 🟢 <strong>Normal</strong> — 8-16 weeks (stable market conditions)<br>
        • 🟠 <strong>Constrained</strong> — 16-40 weeks (supply tightening, extended lead times)<br>
        • 🔴 <strong>Allocated</strong> — 40+ weeks (critical allocation, severe supply constraints)<br>
        • 🔵 <strong>Recovery</strong> — 20-40 week range with ≥20% reduction from baseline (significant market loosening from prior constraints)<br>
        <strong>Distribution Buckets:</strong> 0-7w (Stock/Short), 8-15w (Normal), 16-39w (Constrained), 40+w (Allocated)<br>
        <strong>Why it matters:</strong> Franchise lead times = factory lead times = earliest signal of manufacturer constraints
      </p>
    </div>

    <div style="margin-bottom: 16px; margin-left: 16px;">
      <h5 style="font-size: 11px; font-weight: 600; margin: 0 0 4px 0; color: #7c3aed;">📊 Trending OT Shortage Manufacturers - Top 10 by Booked GP (30-days)</h5>
      <p style="font-size: 10px; color: #666; margin: 0; line-height: 1.5;">
        <strong>Data Source:</strong> Orange Tsunami (OT) database — RFQ, VQ, CQ, and Sales Order activity from last 30 days<br>
        <strong>What it shows:</strong> Top 10 manufacturers by Booked GP from Shortage RFQs showing full conversion funnel (VQ → CQ → SO)<br>
        <strong>Filters:</strong> Shortage RFQs only (excludes PPV, Cost Savings, Stock); OEM customers only (excludes Tier 1 EMS); sorted by Booked GP<br>
        <strong>Why it matters:</strong> Identifies which manufacturers are driving the most shortage-related revenue; shows quote-to-sale conversion effectiveness<br>
        <strong>KLA Impact:</strong> Red warning if KLA represents >20% of manufacturer GP or >$50K absolute value (high customer concentration risk)<br>
        <strong>Funnel Metrics:</strong> VQ Lines (quotes received) → CQ Lines (quotes sent) → SO Lines (orders booked) with Booked GP and GM%
      </p>
    </div>

    <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8;">
      <strong>Questions or feedback?</strong> Contact Melissa Bojar (Sales Productivity Analyst)<br>
      Report generated for Josh Pucci (VP Sales) and regional sales leadership
    </div>
  </div>

  <div class="footer">
    Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} CT
  </div>
</div>
</body>
</html>`;
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log(`\n=== Market Pulse Weekly — Week ${WEEK_NUM} ===\n`);

    // Collect Section 1: Performance Snapshot
    const snapshot = collectPerformanceSnapshot();

    // Collect Section 2: Constraint Indicators
    const constraintIndicators = collectConstraintIndicators();

    // Calculate Section 3: Temperature Gauge
    const temperatureGauge = calculateTemperatureGauge(constraintIndicators);

    // Get External Market Data
    const externalMarketData = getExternalMarketData();

    // Generate Lifecycle Observations for Performance Snapshot
    const lifecycleObservations = generateLifecycleObservations(snapshot, snapshot.priorYear);

    // Build HTML
    const html = buildHTML(snapshot, snapshot.bookingsData, snapshot.billingsData, constraintIndicators, temperatureGauge, externalMarketData, lifecycleObservations);

    // Write output files
    const outputDir = path.join(__dirname, '../output/market-pulse');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const htmlPath = path.join(outputDir, `market-pulse-week${WEEK_NUM}-${timestamp}.html`);

    fs.writeFileSync(htmlPath, html);
    console.log(`✅ HTML report: ${htmlPath}`);

    // Summary
    console.log(`\n=== Week ${WEEK_NUM} Summary (Ex-KLA) ===`);
    console.log(`Bookings GP: ${formatCurrency(snapshot.current.exKLA.bookings.total.gp)} (${formatPercent(snapshot.current.exKLA.bookings.total.gm)} GM)`);
    console.log(`Billings GP: ${formatCurrency(snapshot.current.exKLA.billings.total.gp)} (${formatPercent(snapshot.current.exKLA.billings.total.gm)} GM)`);
    const bbRatio = snapshot.current.exKLA.billings.total.gp > 0 ?
      (snapshot.current.exKLA.bookings.total.gp / snapshot.current.exKLA.billings.total.gp) : 0;
    console.log(`B/B Ratio: ${bbRatio.toFixed(2)}x`);
    console.log(`\nKLA: ${formatCurrency(snapshot.kla.bookings.gp)} bookings / ${formatCurrency(snapshot.kla.billings.gp)} billings`);
    console.log('');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

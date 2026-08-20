#!/usr/bin/env node
/**
 * Packaging Variant Discovery Script
 *
 * Queries franchise APIs to discover what packaging suffix patterns exist
 * for different manufacturers. Uses DigiKey's keyword search which returns
 * ALL related products, not just the exact match.
 *
 * Approach:
 *   1. Take a sample of MPNs from our historical data (or input list)
 *   2. For each, strip common suffixes to get a "base" MPN
 *   3. Query DigiKey with the base
 *   4. Capture ALL returned MPNs in json.Products (before mpnMatch filter)
 *   5. Group by manufacturer and diff MPNs to extract suffix patterns
 *
 * Output:
 *   - packaging-variants-discovery.json: raw discovery data
 *   - packaging-variants-patterns.json: extracted suffix patterns by mfr
 *
 * Usage:
 *   node scripts/discover-packaging-variants.js [--sample N] [--input file.csv]
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(__dirname, '../shared/data');
const DISCOVERY_FILE = path.join(OUTPUT_DIR, 'packaging-variants-discovery.json');
const PATTERNS_FILE = path.join(OUTPUT_DIR, 'packaging-variants-patterns.json');

// DigiKey config (reuse from digikey.js)
const DIGIKEY_CONFIG = {
  clientId: process.env.DIGIKEY_CLIENT_ID || 'ivtDsDLOQ6l4TgHiKzRJeI42BUrw5ZRq',
  clientSecret: process.env.DIGIKEY_CLIENT_SECRET || '2gx8NL6aSwH9GkpH',
  accountId: process.env.DIGIKEY_ACCOUNT_ID || '14763716',
};

let cachedToken = null;
let tokenExpiry = null;

// ─── OAUTH ──────────────────────────────────────────────────────────────────

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: DIGIKEY_CONFIG.clientId,
      client_secret: DIGIKEY_CONFIG.clientSecret,
      grant_type: 'client_credentials',
    }).toString();

    const options = {
      hostname: 'api.digikey.com',
      path: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in * 1000);
            resolve(cachedToken);
          } else {
            reject(new Error(`Token error: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Token parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── DIGIKEY RAW SEARCH ─────────────────────────────────────────────────────

/**
 * Search DigiKey and return ALL products (not filtered by mpnMatch).
 * This is the key to discovering what related MPNs exist.
 */
async function searchDigiKeyRaw(keyword, limit = 50) {
  const token = await getAccessToken();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      Keywords: keyword,
      Limit: limit,
      // No filters - we want everything related to this keyword
    });

    const options = {
      hostname: 'api.digikey.com',
      path: '/products/v4/search/keyword',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': DIGIKEY_CONFIG.clientId,
        'X-DIGIKEY-Account-Id': DIGIKEY_CONFIG.accountId,
        'X-DIGIKEY-Locale-Site': 'US',
        'X-DIGIKEY-Locale-Language': 'EN',
        'X-DIGIKEY-Locale-Currency': 'USD',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('DigiKey rate limit (429)'));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`DigiKey API error ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }

        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── SUFFIX EXTRACTION ──────────────────────────────────────────────────────

/**
 * Given a list of related MPNs, find the common base and extract suffixes.
 *
 * Example:
 *   ['SN74LVC1G04DBVR', 'SN74LVC1G04DBVT', 'SN74LVC1G04DCKR']
 *   → { base: 'SN74LVC1G04', suffixes: ['DBVR', 'DBVT', 'DCKR'] }
 */
function extractSuffixPatterns(mpns) {
  if (!mpns || mpns.length < 2) return null;

  // Normalize
  const normalized = mpns.map(m => m.toUpperCase().trim());

  // Find longest common prefix
  let prefix = normalized[0];
  for (const mpn of normalized.slice(1)) {
    while (!mpn.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }

  if (prefix.length < 3) return null; // Too short to be meaningful

  // Extract suffixes
  const suffixes = normalized.map(m => m.slice(prefix.length)).filter(s => s.length > 0);

  return {
    base: prefix,
    suffixes: [...new Set(suffixes)].sort(),
    mpns: normalized,
  };
}

/**
 * Group suffixes by likely packaging type.
 * Common patterns:
 *   - R, T, 7, 13 = reel sizes
 *   - TR, TRPBF = tape and reel + lead-free
 *   - CT = cut tape
 *   - TU, TB = tube
 */
function classifySuffix(suffix) {
  const s = suffix.toUpperCase();

  if (/^(R|T|7|13)$/.test(s)) return 'REEL_SIZE';
  if (/REEL/.test(s)) return 'REEL';
  if (/TR/.test(s)) return 'TAPE_REEL';
  if (/CT/.test(s)) return 'CUT_TAPE';
  if (/^(TU|TB|TUBE)/.test(s)) return 'TUBE';
  if (/PBF/.test(s)) return 'LEAD_FREE';
  if (/^(E4|G4)$/.test(s)) return 'ROHS_VARIANT';
  if (/NOPB/.test(s)) return 'LEAD_FREE';

  return 'UNKNOWN';
}

// ─── DISCOVERY RUNNER ───────────────────────────────────────────────────────

/**
 * Run discovery on a list of MPNs.
 */
async function runDiscovery(mpns, opts = {}) {
  const { delayMs = 1000 } = opts;

  const discoveries = [];
  const byManufacturer = {};

  console.log(`\nRunning packaging variant discovery on ${mpns.length} MPNs...\n`);

  for (let i = 0; i < mpns.length; i++) {
    const mpn = mpns[i];
    console.log(`[${i + 1}/${mpns.length}] Querying: ${mpn}`);

    try {
      const result = await searchDigiKeyRaw(mpn);
      const products = result.Products || [];

      if (products.length === 0) {
        console.log(`  → No products found`);
        continue;
      }

      // Group products by manufacturer
      const byMfr = {};
      for (const p of products) {
        const mfr = p.Manufacturer?.Name || 'UNKNOWN';
        const pmpn = p.ManufacturerProductNumber;
        if (!pmpn) continue;

        if (!byMfr[mfr]) byMfr[mfr] = [];
        byMfr[mfr].push({
          mpn: pmpn,
          stock: p.QuantityAvailable || 0,
          variations: (p.ProductVariations || []).map(v => ({
            sku: v.DigiKeyProductNumber,
            package: v.PackageType?.Name,
            moq: v.MinimumOrderQuantity,
          })),
        });
      }

      // Extract patterns for each manufacturer
      for (const [mfr, parts] of Object.entries(byMfr)) {
        const mpnList = parts.map(p => p.mpn);
        const patterns = extractSuffixPatterns(mpnList);

        if (patterns && patterns.suffixes.length > 1) {
          console.log(`  → ${mfr}: Found ${patterns.suffixes.length} variants`);
          console.log(`     Base: ${patterns.base}`);
          console.log(`     Suffixes: ${patterns.suffixes.join(', ')}`);

          const discovery = {
            searchedMpn: mpn,
            manufacturer: mfr,
            ...patterns,
            products: parts,
          };

          discoveries.push(discovery);

          // Aggregate by manufacturer
          if (!byManufacturer[mfr]) {
            byManufacturer[mfr] = { suffixCounts: {}, examples: [] };
          }
          for (const suffix of patterns.suffixes) {
            const category = classifySuffix(suffix);
            if (!byManufacturer[mfr].suffixCounts[suffix]) {
              byManufacturer[mfr].suffixCounts[suffix] = { count: 0, category };
            }
            byManufacturer[mfr].suffixCounts[suffix].count++;
          }
          if (byManufacturer[mfr].examples.length < 5) {
            byManufacturer[mfr].examples.push({
              base: patterns.base,
              suffixes: patterns.suffixes,
            });
          }
        }
      }

    } catch (err) {
      console.log(`  → Error: ${err.message}`);
      if (err.message.includes('429')) {
        console.log(`  → Rate limited, stopping discovery`);
        break;
      }
    }

    // Rate limiting
    if (i < mpns.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { discoveries, byManufacturer };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let sampleSize = 50;
  let inputFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) {
      sampleSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--input' && args[i + 1]) {
      inputFile = args[i + 1];
      i++;
    }
  }

  // Get MPNs to test
  let mpns = [];

  if (inputFile) {
    // Read from file
    const content = fs.readFileSync(inputFile, 'utf8');
    mpns = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else {
    // Use sample of common MPNs from high-volume manufacturers
    // These are chosen to likely have packaging variants
    mpns = [
      // TI - known R/T suffix pattern
      'SN74LVC1G04DBV',
      'SN74HC595',
      'LM358',
      'TPS62130',
      'OPA2134',

      // Analog Devices - REEL/RZ patterns
      'AD8605',
      'ADP7118',
      'LTC3406',
      'MAX17043',

      // Microchip - various patterns
      'PIC16F877A',
      'ATMEGA328P',
      'MCP23017',

      // STMicro
      'STM32F103',
      'LM317',

      // Infineon / IR - PBF/TRPBF
      'IRFZ44N',
      'IRF540N',

      // ON Semi
      'LM339',
      'MC7805',

      // NXP
      'PCF8574',
      '74HC595',

      // Vishay
      'IRFZ44N',

      // Murata
      'GRM188R71H104',

      // TDK
      'C1608X5R1C104K',
    ].slice(0, sampleSize);
  }

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       PACKAGING VARIANT DISCOVERY                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nWill query ${mpns.length} MPNs to discover suffix patterns.\n`);

  const { discoveries, byManufacturer } = await runDiscovery(mpns);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write raw discoveries
  fs.writeFileSync(DISCOVERY_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mpnsQueried: mpns.length,
    discoveriesCount: discoveries.length,
    discoveries,
  }, null, 2));
  console.log(`\n✓ Raw discoveries written to: ${DISCOVERY_FILE}`);

  // Build and write patterns summary
  const patterns = {};
  for (const [mfr, data] of Object.entries(byManufacturer)) {
    // Sort suffixes by frequency
    const sorted = Object.entries(data.suffixCounts)
      .sort((a, b) => b[1].count - a[1].count);

    patterns[mfr] = {
      topSuffixes: sorted.slice(0, 10).map(([suffix, info]) => ({
        suffix,
        count: info.count,
        category: info.category,
      })),
      examples: data.examples,
    };
  }

  fs.writeFileSync(PATTERNS_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    manufacturerCount: Object.keys(patterns).length,
    patterns,
  }, null, 2));
  console.log(`✓ Patterns summary written to: ${PATTERNS_FILE}`);

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY BY MANUFACTURER');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const [mfr, data] of Object.entries(patterns)) {
    console.log(`${mfr}:`);
    for (const s of data.topSuffixes.slice(0, 5)) {
      console.log(`  ${s.suffix.padEnd(10)} (${s.category}) - seen ${s.count}x`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

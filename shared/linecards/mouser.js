/**
 * Mouser Linecard Fetcher
 *
 * Pulls the complete list of manufacturers Mouser is authorized to sell.
 * Used by scripts/linecard-refresh.js to detect franchise adds/drops via
 * month-over-month diff.
 *
 * Endpoint: GET https://api.mouser.com/api/v2/search/manufacturerlist
 * Auth:     API key in query string (canonical: env var MOUSER_API_KEY)
 * Quota:    Counts against Mouser's 1,000/day quota — negligible monthly.
 * Response: { MouserManufacturerList: { Count, ManufacturerList: [{ ManufacturerName }] } }
 *           ~850 entries as of 2026-04-20 (narrower than DigiKey's ~3,700
 *           because Mouser franchises are stricter).
 * Note:     Mouser does NOT expose manufacturer IDs on this endpoint — we
 *           only get names. That's fine for diff purposes; the negative
 *           cache keys on normalized MFR name, not ID.
 *
 * Exports:
 *   fetchLinecard() → Promise<Array<{ id: null, name: string }>>
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const API_KEY = process.env.MOUSER_API_KEY || '';

async function fetchLinecard() {
  if (!API_KEY) {
    throw new Error('MOUSER_API_KEY not configured in ~/workspace/.env');
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mouser.com',
      path: '/api/v2/search/manufacturerlist?apiKey=' + encodeURIComponent(API_KEY),
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('Mouser quota exhausted (429)'));
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Mouser auth failed — check MOUSER_API_KEY'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Mouser linecard HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(data);
          const list = j?.MouserManufacturerList?.ManufacturerList;
          if (!Array.isArray(list) || list.length === 0) {
            return reject(new Error(`Mouser linecard empty — unexpected shape: ${data.slice(0, 200)}`));
          }
          resolve(list.map(m => ({ id: null, name: m.ManufacturerName })));
        } catch (e) {
          reject(new Error(`Mouser linecard parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Mouser linecard timeout')); });
    req.end();
  });
}

module.exports = { fetchLinecard, disty: 'mouser', distyName: 'Mouser' };

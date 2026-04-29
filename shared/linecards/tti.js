/**
 * TTI Linecard Fetcher
 *
 * Endpoint: GET https://api.tti.com/service/api/v1/search/manufacturers
 * Auth:     apiKey header — reuses TTI_SEARCH_KEY
 * Response: { manufacturers: [{ manufacturerCode, manufacturer }] } — 181
 *           entries as of 2026-04-21 (narrower than DigiKey/Mouser because
 *           TTI is IP&E-focused, not broadline semi).
 *
 * Background: the endpoint constant `manufacturersPath` was already defined
 * in the main tti.js cog but never called — same "latent linecard endpoint"
 * pattern we found with Mouser.
 *
 * Exports: fetchLinecard() → Promise<Array<{ id: string, name: string }>>
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const API_KEY = process.env.TTI_SEARCH_KEY || '';

async function fetchLinecard() {
  if (!API_KEY) throw new Error('TTI_SEARCH_KEY not configured in ~/workspace/.env');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.tti.com',
      path: '/service/api/v1/search/manufacturers',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'apiKey': API_KEY,
        'Cache-Control': 'no-cache',
      },
      agent: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('TTI quota exhausted (429)'));
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('TTI auth failed — check TTI_SEARCH_KEY'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`TTI linecard HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const list = JSON.parse(data)?.manufacturers;
          if (!Array.isArray(list) || list.length === 0) {
            return reject(new Error(`TTI linecard empty: ${data.slice(0, 200)}`));
          }
          resolve(list.map(m => ({ id: m.manufacturerCode, name: m.manufacturer })));
        } catch (e) {
          reject(new Error(`TTI linecard parse: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTI linecard timeout')); });
    req.end();
  });
}

module.exports = { fetchLinecard, disty: 'tti', distyName: 'TTI' };

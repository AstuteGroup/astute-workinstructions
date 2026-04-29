/**
 * DigiKey Linecard Fetcher
 *
 * Pulls the complete list of manufacturers DigiKey is authorized to sell.
 * Used by scripts/linecard-refresh.js to detect franchise adds/drops via
 * month-over-month diff, then cascade-invalidate cached negatives so
 * newly-franchised parts get re-probed.
 *
 * Endpoint: GET https://api.digikey.com/products/v4/search/manufacturers
 * Auth:     2-Legged OAuth (reuses getAccessToken from the main cog)
 * Quota:    Counts against DigiKey's daily search quota — one call/month
 *           is negligible (<0.1% of 1,000/day).
 * Response: { Manufacturers: [{ Id, Name }, ...] } — ~3,700 entries as of
 *           2026-04-20.
 *
 * Exports:
 *   fetchLinecard() → Promise<Array<{ id: number, name: string }>>
 */

const https = require('https');
const path = require('path');

const { getAccessToken } = require(path.resolve(
  __dirname,
  '../../Trading Analysis/RFQ Sourcing/franchise_check/digikey.js'
));

const DIGIKEY_CLIENT_ID = process.env.DIGIKEY_CLIENT_ID || 'ivtDsDLOQ6l4TgHiKzRJeI42BUrw5ZRq';

async function fetchLinecard() {
  const token = await getAccessToken();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.digikey.com',
      path: '/products/v4/search/manufacturers',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'X-DIGIKEY-Client-Id': DIGIKEY_CLIENT_ID,
        'Accept': 'application/json',
      },
      // agent:false forces a fresh socket — avoids keepAlive pool weirdness
      // when this runs after other https calls in the same process (observed
      // hanging 30s when called after Mouser in linecard-refresh.js).
      agent: false,
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('DigiKey quota exhausted (429)'));
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('DigiKey auth failed — check credentials'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`DigiKey linecard HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(data);
          const arr = j.Manufacturers || [];
          if (!Array.isArray(arr) || arr.length === 0) {
            return reject(new Error(`DigiKey linecard empty — unexpected response shape: ${data.slice(0, 200)}`));
          }
          resolve(arr.map(m => ({ id: m.Id, name: m.Name })));
        } catch (e) {
          reject(new Error(`DigiKey linecard parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DigiKey linecard timeout')); });
    req.end();
  });
}

module.exports = { fetchLinecard, disty: 'digikey', distyName: 'DigiKey' };

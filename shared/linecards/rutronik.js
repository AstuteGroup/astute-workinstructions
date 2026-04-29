/**
 * Rutronik Linecard Fetcher
 *
 * Endpoint: GET https://www.rutronik24.com/api/linecard?apikey=...  (UNDOCUMENTED)
 * Auth:     apikey query param — reuses RUTRONIK_API_KEY
 * Response: ~160KB nested category tree. Each leaf category has a
 *           `suppliers: [{name, url, logo}]` array; the same supplier can
 *           appear at many leaves. Walk depth-first, dedupe by name →
 *           194 unique suppliers as of 2026-04-21.
 *
 * Warning:  This endpoint is NOT listed on Rutronik24's public API docs
 *           (https://www.rutronik24.com/api.html). It's stable today but
 *           could break without notice. linecard-refresh.js catches the
 *           fatal and emails the operator if it does.
 *
 * Exports:  fetchLinecard() → Promise<Array<{ id: null, name: string }>>
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const API_KEY = process.env.RUTRONIK_API_KEY || '';

async function fetchLinecard() {
  if (!API_KEY) throw new Error('RUTRONIK_API_KEY not configured in ~/workspace/.env');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.rutronik24.com',
      path: `/api/linecard?apikey=${encodeURIComponent(API_KEY)}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      agent: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('Rutronik quota exhausted (429)'));
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Rutronik auth failed — check RUTRONIK_API_KEY'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Rutronik linecard HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const tree = JSON.parse(data);
          // Depth-first walk: any `suppliers[]` at any depth contributes.
          // Dedupe by supplier name so the same vendor appearing under
          // multiple leaves counts once.
          const uniq = new Map();
          (function walk(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.suppliers)) {
              for (const s of node.suppliers) {
                if (s && s.name && !uniq.has(s.name)) uniq.set(s.name, s);
              }
            }
            for (const k of Object.keys(node)) {
              if (typeof node[k] === 'object') walk(node[k]);
            }
          })(tree);
          if (uniq.size === 0) {
            return reject(new Error('Rutronik linecard empty — tree shape may have changed'));
          }
          resolve([...uniq.values()].map(s => ({ id: null, name: s.name })));
        } catch (e) {
          reject(new Error(`Rutronik linecard parse: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Rutronik linecard timeout')); });
    req.end();
  });
}

module.exports = { fetchLinecard, disty: 'rutronik', distyName: 'Rutronik' };

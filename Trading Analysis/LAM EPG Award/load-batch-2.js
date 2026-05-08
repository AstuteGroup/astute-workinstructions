/**
 * Batch 2: 5 lines pasted by Jake.
 *   - Line 280: DigiKey K86X-AD-26S-BR (need 200; SPQ 42 → buy 210 if possible)
 *   - Line 690: Master RNCF0805TKT20K0 (need 530; user override "only order 500")
 *   - Line 720: Sager K86X-AD-26P-BR (need 85; LT, MOQ 42 → buy 85)
 *   - Line 1280: DigiKey C0603C333K5RAC (need 550; user-provided cost $0.0217 — overrides API)
 *   - Line 1610: DigiKey IS61WV25616BLL-10TL (need 40)
 */

const path = require('path');
const { loadVqRow } = require('./lib-load-vq-row');

const LINES = [
  { cpc: '668-014495-026', altMpn: 'K86X-AD-26S-BR',  altMfr: 'Kycon, Inc.',                vendor: 'DigiKey', need: 200 },
  { cpc: '615-122309-200', altMpn: 'RNCF0805TKT20K0', altMfr: 'Stackpole Electronics',      vendor: 'Master',  need: 530, qtyOverride: 500 },
  { cpc: '668-099029-026', altMpn: 'K86X-AD-26P-BR',  altMfr: 'Kycon, Inc.',                vendor: 'Sager',   need: 85 },
  { cpc: '648-051878-333', altMpn: 'C0603C333K5RAC',  altMfr: 'Kemet',                      vendor: 'DigiKey', need: 550, costOverride: 0.0217 },
  { cpc: '630-173321-001', altMpn: 'IS61WV25616BLL-10TL', altMfr: 'Integrated Silicon Solution', vendor: 'DigiKey', need: 40 },
  { cpc: '608-096583-504', altMpn: '84WR500KLF',      altMfr: 'BI Technologies Corp',       vendor: 'Waldom',  need: 105 },
];

(async () => {
  const results = [];
  for (const ln of LINES) {
    try {
      const r = await loadVqRow(ln);
      results.push({ ...ln, ok: true, ...r });
    } catch (e) {
      console.error(`✗ ${ln.cpc} ${ln.altMpn}:`, e.message.slice(0, 300));
      results.push({ ...ln, ok: false, error: e.message });
    }
  }
  console.log('\n=== BATCH SUMMARY ===');
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.cpc} vq=${r.vqLineId} buy=${r.buyQty} cost=$${r.cost}${r.partial?' PARTIAL':''}` : `✗ ${r.cpc} ${r.error}`);
  }
})().catch(e => { console.error(e); process.exit(1); });

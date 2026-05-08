const { loadVqRow } = require('./lib-load-vq-row');

(async () => {
  await loadVqRow({
    cpc: '668-096777-025',
    altMpn: 'DLS 3XP4AA35X',
    altMfr: 'Conec Elektronische Bauelemente GmbH',
    vendor: 'Waldom',
    need: 55,
  });
})().catch(e => { console.error(e); process.exit(1); });

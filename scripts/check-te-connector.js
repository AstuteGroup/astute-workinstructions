#!/usr/bin/env node
const { searchPart } = require('../shared/franchise-api');

async function check() {
  const mpn = '5-104363-2';
  const qty = 42;

  console.log('Checking', mpn, 'at qty', qty);
  console.log('='.repeat(60));

  // Check Sager specifically
  const sager = await searchPart('sager', mpn, qty, { skipCache: true });
  console.log('\nSAGER:');
  if (sager.found) {
    console.log('  Stock:', sager.franchiseQty);
    console.log('  Price @ qty ' + qty + ':', sager.franchiseRfqPrice ? '$' + sager.franchiseRfqPrice.toFixed(4) : 'N/A');
    console.log('  MOQ:', sager.vqMoq || 1);
    if (sager.priceBreaks && sager.priceBreaks.length > 0) {
      console.log('  Price Breaks:');
      sager.priceBreaks.forEach(pb => console.log('    Qty ' + pb.qty + ': $' + pb.unitPrice.toFixed(4)));
    }
  } else {
    console.log('  Not found or error:', sager.error || 'N/A');
  }

  // Quick check DigiKey and Mouser for comparison
  for (const disty of ['digikey', 'mouser']) {
    const result = await searchPart(disty, mpn, qty, { skipCache: true });
    console.log('\n' + disty.toUpperCase() + ':');
    if (result.found) {
      console.log('  Stock:', result.franchiseQty);
      console.log('  Price @ qty ' + qty + ':', result.franchiseRfqPrice ? '$' + result.franchiseRfqPrice.toFixed(4) : 'N/A');
      if (result.priceBreaks && result.priceBreaks.length > 0) {
        console.log('  Price Breaks:');
        result.priceBreaks.slice(0, 5).forEach(pb => console.log('    Qty ' + pb.qty + ': $' + pb.unitPrice.toFixed(4)));
        if (result.priceBreaks.length > 5) console.log('    ... (' + (result.priceBreaks.length - 5) + ' more)');
      }
    } else {
      console.log('  Not found or error:', result.error || 'N/A');
    }
  }
}

check().catch(e => console.error(e));

#!/usr/bin/env node
/**
 * Astute Purchase Order PDF Extractor
 * Extracts structured data from Astute PO PDFs and outputs JSON.
 *
 * Usage:
 *   node extractor.js <pdf_file_or_directory> [--output output.json]
 */

const fs = require('fs');
const path = require('path');

async function extractTextFromPDF(pdfPath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdfDocument = await loadingTask.promise;

  let fullText = '';
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join('\n');
    fullText += pageText + '\n';
  }
  return fullText;
}

function extractOrderNumber(text) {
  const match = text.match(/Order No:\s*\n?\s*(\S+)(?:\s+(W\d+))?/);
  if (match) {
    const orderNum = match[1];
    const warehouseMatch = text.match(new RegExp(orderNum + '\\s+(W\\d+)'));
    return {
      orderNumber: orderNum,
      warehouseCode: warehouseMatch ? warehouseMatch[1] : (match[2] || null)
    };
  }
  return { orderNumber: null, warehouseCode: null };
}

function extractVendorInfo(text) {
  const vendor = {
    contact_name: null,
    company: null,
    address: null,
    phone: null
  };

  const vendorMatch = text.match(/Order No:\s*\n?\s*\S+(?:\s+W\d+)?\s*\n([\s\S]+?)(?=\nVendor:\s*\n)/);
  if (vendorMatch) {
    const lines = vendorMatch[1].trim().split('\n').map(l => l.trim()).filter(l => l);

    if (lines.length > 0) vendor.contact_name = lines[0];
    if (lines.length > 1) vendor.company = lines[1];

    const phoneIdx = lines.findIndex(l => l.startsWith('Phone:'));
    if (phoneIdx !== -1) {
      vendor.phone = lines[phoneIdx].replace('Phone:', '').trim();
      if (lines.length > 2 && phoneIdx > 2) {
        vendor.address = lines.slice(2, phoneIdx).join(', ');
      }
    } else if (lines.length > 2) {
      vendor.address = lines.slice(2).join(', ');
    }
  }

  return vendor;
}

function extractDeliverTo(text) {
  const deliverTo = {
    company: null,
    address: null
  };

  const match = text.match(/(?:Phone:.*?\n)([\s\S]+?)(?=\nVendor:\s*\n\s*Deliver To:)/);
  if (match) {
    const lines = match[1].trim().split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length > 0) deliverTo.company = lines[0];
    if (lines.length > 1) deliverTo.address = lines.slice(1).join(', ');
  }

  return deliverTo;
}

function extractHeaderFields(text) {
  const fields = {};

  const dateMatch = text.match(/(\d{1,2}\s+\w{3}\s+\d{4})\s*\n?\s*(V\d+)/);
  if (dateMatch) {
    fields.date = dateMatch[1];
    fields.vendor_code = dateMatch[2];
  }

  if (text.includes('USD')) fields.currency = 'USD';

  const shipViaPatterns = ['FedEx Ground', 'FedEx Express', 'FedEx', 'UPS', 'DHL', 'Courier/Local Delivery', 'Courier', 'Will Call'];
  for (const pattern of shipViaPatterns) {
    if (text.includes(pattern)) {
      fields.ship_via = pattern;
      break;
    }
  }

  fields.is_3pl_order = false;
  fields.is_factored_order = false;

  const termsPatterns = ['Net 30 Days', 'Net 45 Days', 'Net 60 Days', 'Pro Forma', 'Due on Receipt', 'COD'];
  for (const pattern of termsPatterns) {
    if (text.includes(pattern)) {
      fields.terms = pattern;
      break;
    }
  }

  const deliveryTermsPatterns = ['Ex-Works', 'Delivered At Place', 'FOB', 'CIF', 'DAP', 'DDP'];
  for (const pattern of deliveryTermsPatterns) {
    if (text.includes(pattern)) {
      fields.delivery_terms = pattern;
      break;
    }
  }

  return fields;
}

function extractBuyerSalesperson(text) {
  const info = {
    buyer: { name: null, email: null },
    salesperson: { name: null, email: null }
  };

  const normalizedText = text.replace(/@astutegroup\.co\s*\n\s*m\b/gi, '@astutegroup.com');

  const emailMatches = normalizedText.match(/[a-z][a-z.]+@astutegroup\.com/gi) || [];
  const cleanEmails = [...new Set(emailMatches.map(e => e.toLowerCase().trim()))];

  const buyerSigMatch = text.match(/Buyer Signature:\s*\n?\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/);

  if (cleanEmails.length >= 1) {
    const firstEmailMatch = cleanEmails[0].match(/([a-z]+)\.([a-z]+)@/);
    if (firstEmailMatch) {
      const firstName = firstEmailMatch[1].charAt(0).toUpperCase() + firstEmailMatch[1].slice(1);
      const lastName = firstEmailMatch[2].charAt(0).toUpperCase() + firstEmailMatch[2].slice(1);
      info.buyer.name = `${firstName} ${lastName}`;
    }
    info.buyer.email = cleanEmails[0];
  }

  if (cleanEmails.length >= 2) {
    const secondEmail = cleanEmails[1];
    const salesEmailMatch = secondEmail.match(/([a-z]+)\.([a-z]+)@/);
    if (salesEmailMatch) {
      const firstName = salesEmailMatch[1].charAt(0).toUpperCase() + salesEmailMatch[1].slice(1);
      const lastName = salesEmailMatch[2].charAt(0).toUpperCase() + salesEmailMatch[2].slice(1);
      info.salesperson.name = `${firstName} ${lastName}`;
    }
    info.salesperson.email = secondEmail;
  }

  if (buyerSigMatch) {
    info.buyer.name = buyerSigMatch[1].trim();
  }

  return info;
}

function extractLineItems(text) {
  const items = [];

  const linePattern = /(\S+)\s*\n\s*([\d,]+\.?\d*)\s*\n\s*([\d,]+\.?\d*)\s*\n\s*([\d,]+\.?\d*)\s*\n\s*(\d+)\s*\n\s*(EA|PC|FT|M|KG|LB|SET|LOT|BOX)\s*\n?\s*(\d{1,2}\s+\w{3}\s+\d{4})/g;

  let match;
  const matches = [];
  while ((match = linePattern.exec(text)) !== null) {
    if (match[1].includes('Line') || match[1].includes('Item')) continue;

    matches.push({
      match: match,
      index: match.index,
      endIndex: match.index + match[0].length
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const item = {
      line_number: parseInt(m.match[5]),
      item_number: m.match[1],
      due_date: m.match[7],
      unit_of_measure: m.match[6],
      quantity_ordered: parseFloat(m.match[2].replace(/,/g, '')),
      unit_price: parseFloat(m.match[3].replace(/,/g, '')),
      extended_price: parseFloat(m.match[4].replace(/,/g, '')),
      description: null,
      promised_date: null,
      manufacturer: null,
      item_revision: null,
      drawing_number: null,
      drawing_revision: null,
      rohs: null,
      line_notes: null
    };

    const startPos = m.endIndex;
    const endPos = matches[i + 1] ? matches[i + 1].index : text.indexOf('Total:', startPos);
    const detailText = text.substring(startPos, endPos > startPos ? endPos : startPos + 500);

    // Description may span multiple lines before Promised Date/Manufacturer/RoHS
    // Capture all text between the due date and the first keyword
    const descMatch = detailText.match(/\n+([\s\S]+?)(?=\n+Promised Date:|\n+Item Revision:|\n+Manufacturer:|\n+Drawing|\n+RoHS:)/);
    if (descMatch) {
      // Join multiple lines into single description, removing extra whitespace
      item.description = descMatch[1].replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    const promisedMatch = detailText.match(/Promised Date:\s*(\d{1,2}\s+\w{3}\s+\d{4})?/);
    if (promisedMatch && promisedMatch[1]) item.promised_date = promisedMatch[1];

    const mfrMatch = detailText.match(/Manufacturer:\s*(.+?)(?=\n|$)/);
    if (mfrMatch) item.manufacturer = mfrMatch[1].trim();

    const revMatch = detailText.match(/Item Revision:\s*(\S+)/);
    if (revMatch) item.item_revision = revMatch[1];

    const drawingMatch = detailText.match(/Drawing Nbr:\s*(\S+)[\s\S]*?Rev:\s*(\S+)/);
    if (drawingMatch) {
      item.drawing_number = drawingMatch[1];
      item.drawing_revision = drawingMatch[2];
    }

    const rohsMatch = detailText.match(/RoHS:\s*(Yes|No)/i);
    if (rohsMatch) item.rohs = rohsMatch[1].charAt(0).toUpperCase() + rohsMatch[1].slice(1).toLowerCase();

    // Line Notes - freeform text after Manufacturer/RoHS
    // Skip the manufacturer value line and RoHS value line
    const noteLines = [];
    const lines = detailText.split('\n');
    let foundManufacturer = false;
    let foundRoHS = false;
    let skippedMfrValue = false;
    let skippedRohsValue = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('Manufacturer:')) {
        foundManufacturer = true;
        // If manufacturer value is on the same line, mark as already skipped
        if (trimmed.length > 13) {  // "Manufacturer:" is 13 chars
          skippedMfrValue = true;
        }
        continue;
      }
      if (trimmed.startsWith('RoHS:')) {
        foundRoHS = true;
        // If RoHS value is on the same line, mark as already skipped
        if (trimmed.length > 5) {  // "RoHS:" is 5 chars
          skippedRohsValue = true;
        }
        continue;
      }

      if (foundManufacturer && !skippedMfrValue) {
        // This is the manufacturer value line (when on separate line) - skip it
        skippedMfrValue = true;
        continue;
      }

      if (foundRoHS && !skippedRohsValue) {
        // This is the RoHS value line (when on separate line, e.g., "Yes" or "No") - skip it
        if (trimmed.match(/^(Yes|No)$/i)) {
          skippedRohsValue = true;
          continue;
        }
      }

      if (foundManufacturer || foundRoHS) {
        if (trimmed.match(/^(Total:|Buyer Signature:|Due Date is|Page \d|Only new|We reserve)/)) break;
        if (trimmed.match(/^[A-Z0-9-]+\s*$/) && trimmed.length > 5) break;
        if (trimmed.match(/^[\d,]+\.?\d*$/)) break;

        noteLines.push(trimmed);
      }
    }

    if (noteLines.length > 0) {
      item.line_notes = noteLines.join(' ').trim();
    }

    items.push(item);
  }

  return items;
}

function extractTotal(text) {
  const match = text.match(/Total:\s*\n?\s*USD\s*([\d,]+\.?\d*)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

async function extractPOData(pdfPath) {
  const text = await extractTextFromPDF(pdfPath);

  const { orderNumber, warehouseCode } = extractOrderNumber(text);
  const vendor = extractVendorInfo(text);
  const deliverTo = extractDeliverTo(text);
  const headerFields = extractHeaderFields(text);
  const people = extractBuyerSalesperson(text);
  const lineItems = extractLineItems(text);
  const total = extractTotal(text);

  return {
    source_file: path.basename(pdfPath),
    order_number: orderNumber,
    warehouse_code: warehouseCode,
    vendor: vendor,
    deliver_to: deliverTo,
    date: headerFields.date || null,
    vendor_code: headerFields.vendor_code || null,
    currency: headerFields.currency || null,
    ship_via: headerFields.ship_via || null,
    is_3pl_order: headerFields.is_3pl_order || false,
    is_factored_order: headerFields.is_factored_order || false,
    terms: headerFields.terms || null,
    delivery_terms: headerFields.delivery_terms || null,
    buyer: people.buyer,
    salesperson: people.salesperson,
    line_items: lineItems,
    total: total
  };
}

async function processPDFs(inputPath, outputPath) {
  const results = [];
  let pdfFiles = [];

  const stats = fs.statSync(inputPath);
  if (stats.isFile()) {
    pdfFiles = [inputPath];
  } else if (stats.isDirectory()) {
    pdfFiles = fs.readdirSync(inputPath)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => path.join(inputPath, f));
  }

  for (const pdfFile of pdfFiles) {
    console.error(`Processing: ${path.basename(pdfFile)}`);
    try {
      const data = await extractPOData(pdfFile);
      results.push(data);
    } catch (e) {
      console.error(`  Error: ${e.message}`);
      results.push({
        source_file: path.basename(pdfFile),
        error: e.message
      });
    }
  }

  const outputJson = JSON.stringify(results, null, 2);

  if (outputPath) {
    fs.writeFileSync(outputPath, outputJson);
    console.error(`\nOutput saved to: ${outputPath}`);
  } else {
    console.log(outputJson);
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Astute PO PDF Extractor');
    console.log('');
    console.log('Usage: node extractor.js <pdf_file_or_directory> [--output output.json]');
    console.log('');
    console.log('Examples:');
    console.log('  node extractor.js order.pdf              # Output to stdout');
    console.log('  node extractor.js ./orders/              # Process all PDFs in directory');
    console.log('  node extractor.js order.pdf -o out.json  # Save to file');
    process.exit(1);
  }

  const inputPath = args[0];
  let outputPath = null;

  const outputIdx = args.indexOf('--output');
  const outputIdxShort = args.indexOf('-o');
  const idx = outputIdx !== -1 ? outputIdx : outputIdxShort;
  if (idx !== -1 && args[idx + 1]) {
    outputPath = args[idx + 1];
  }

  await processPDFs(inputPath, outputPath);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});

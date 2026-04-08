#!/usr/bin/env node
/**
 * MST Item Builder — Generates Infor MST Items upload files
 *
 * Takes a list of parts (MPN, Description, Manufacturer) and produces
 * an Infor-ready MST Items Template with:
 *   - Product code mapping (SC, PA, CO, EM, etc.) from description prefix
 *   - Manufacturer matching against OT MFR list
 *   - Template defaults from row 1 of MST Items Template
 *
 * USAGE:
 *   const { buildMSTItems } = require('../shared/mst-item-builder');
 *   const result = buildMSTItems(parts, options);
 *   // result.outputPath — path to generated Excel
 *   // result.matched — count of MFR matches
 *   // result.unmatched — array of { mpn, mfr } for manual review
 *
 * INPUTS:
 *   parts: Array of { mpn, description, manufacturer }
 *   options: {
 *     templatePath: path to MST Items Template.xlsx (required)
 *     mfrListPath: path to OT MANUFACTURERS LIST.xlsx (required)
 *     outputPath: path for output file (required)
 *   }
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Product code mapping from description prefix
const PRODUCT_CODE_MAP = {
  'IC': 'SC', 'XSTR': 'SC', 'DIO': 'SC', 'LED': 'LED', 'OSC': 'SC',
  'RES': 'PA', 'CAP': 'PA', 'IDCTR': 'PA', 'POT': 'PA', 'RESSTR': 'PA', 'C': 'PA',
  'CONN': 'CO', 'CONT': 'CO', 'PIN': 'CO', 'HEADER': 'CO', 'KEYING PLUG': 'CO', 'STDF': 'CO',
  'RLY': 'EM', 'SW': 'EM', 'FUSE': 'EM', 'CB': 'EM',
  'PS': 'PO', 'XFMR': 'PO',
  'SPCR': 'O', 'CLIP': 'O', 'FR': 'O', 'COV': 'O',
  'HTSK': 'TH', 'WIRE': 'WC',
};

function getProductCode(desc) {
  const prefix = desc.split(',')[0].trim();
  if (prefix.startsWith('FUSE')) return 'EM';
  if (prefix.startsWith('TP ')) return 'CO';
  return PRODUCT_CODE_MAP[prefix] || 'O';
}

// Manufacturer matching
function normMfr(s) {
  return s.toLowerCase()
    .replace(/[,.\\/()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\binc\b\.?/g, '')
    .replace(/\bcorp\b\.?/g, '')
    .replace(/\bcorporation\b/g, '')
    .replace(/\bco\b\.?/g, '')
    .replace(/\bltd\b\.?/g, '')
    .replace(/\bellc\b/g, '')
    .replace(/\bllc\b/g, '')
    .trim();
}

function loadMfrList(mfrListPath) {
  const wb = XLSX.readFile(mfrListPath);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  return data.slice(1).filter(r => r[5] === 'Yes').map(r => ({
    key: (r[2] || '').toString().trim(),
    name: (r[3] || '').toString().trim(),
    nameLower: (r[3] || '').toString().trim().toLowerCase()
  }));
}

function matchMfr(epgMfr, mfrList) {
  const norm = normMfr(epgMfr);

  // Exact
  let match = mfrList.find(m => m.nameLower === epgMfr.toLowerCase());
  if (match) return match;

  // Normalized
  match = mfrList.find(m => normMfr(m.name) === norm);
  if (match) return match;

  // Contains
  match = mfrList.find(m => normMfr(m.name).includes(norm) || norm.includes(normMfr(m.name)));
  if (match) return match;

  // First word (min 4 chars)
  const firstWord = norm.split(' ')[0];
  if (firstWord.length >= 4) {
    match = mfrList.find(m => normMfr(m.name).split(' ')[0] === firstWord);
    if (match) return match;
  }

  return null;
}

/**
 * Build MST Items upload file
 * @param {Array} parts - Array of { mpn, description, manufacturer }
 * @param {Object} options - { templatePath, mfrListPath, outputPath }
 * @returns {Object} { outputPath, total, matched, unmatched }
 */
function buildMSTItems(parts, options) {
  const { templatePath, mfrListPath, outputPath } = options;

  // Load template
  const templateWb = XLSX.readFile(templatePath);
  const templateData = XLSX.utils.sheet_to_json(templateWb.Sheets[templateWb.SheetNames[0]], { header: 1 });
  const headers = templateData[0];
  const templateRow = templateData[1];

  // Load MFR list
  const mfrList = loadMfrList(mfrListPath);

  // Build output
  const outputData = [headers];
  const unmatched = [];
  let matched = 0;

  for (const part of parts) {
    const productCode = getProductCode(part.description || '');
    const mfrMatch = matchMfr(part.manufacturer || '', mfrList);

    const newRow = [...templateRow];
    newRow[1] = part.mpn;                              // Item
    newRow[2] = part.description || '';                 // Description
    newRow[10] = 'EA';                                 // U/M
    newRow[13] = productCode;                          // Product Code
    newRow[119] = mfrMatch ? mfrMatch.key : '';        // MFR Search Key
    newRow[120] = mfrMatch ? mfrMatch.name : part.manufacturer; // MFR Name
    newRow[126] = part.description || '';               // Extended Description

    if (mfrMatch) matched++;
    else unmatched.push({ mpn: part.mpn, mfr: part.manufacturer });

    outputData.push(newRow);
  }

  // Write
  const outWb = XLSX.utils.book_new();
  const outWs = XLSX.utils.aoa_to_sheet(outputData);
  XLSX.utils.book_append_sheet(outWb, outWs, 'MST Items');
  XLSX.writeFile(outWb, outputPath);

  return { outputPath, total: parts.length, matched, unmatched };
}

module.exports = { buildMSTItems, getProductCode, matchMfr, loadMfrList, PRODUCT_CODE_MAP };

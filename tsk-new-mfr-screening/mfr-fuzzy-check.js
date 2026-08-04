#!/usr/bin/env node
/**
 * Manufacturer Fuzzy Matcher + Website Verifier
 *
 * Usage:
 *   node mfr-fuzzy-check.js "Texas Instruments"
 *   node mfr-fuzzy-check.js "Texas Instruments" --check-website https://www.ti.com
 *   node mfr-fuzzy-check.js "Acme Corp" --url https://acme.com
 */

const { execSync } = require('child_process');

// Parse arguments
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log(`
Manufacturer Fuzzy Check - Find matching manufacturers in OT and verify via website

Usage:
  node mfr-fuzzy-check.js "<manufacturer name>" [options]

Options:
  --url <url>           Website URL to check if manufacturer (not distributor)
  --check-website       Auto-fetch URL from OT match or search for it
  --threshold <0-1>     Similarity threshold (default: 0.3)
  --limit <n>           Max results to return (default: 10)
  --help                Show this help

Examples:
  node mfr-fuzzy-check.js "Texas Instruments"
  node mfr-fuzzy-check.js "Maxim" --threshold 0.5
  node mfr-fuzzy-check.js "Analog Devices" --url https://www.analog.com
  `);
  process.exit(0);
}

const mfrName = args[0];
let websiteUrl = null;
let checkWebsite = false;
let threshold = 0.3;
let limit = 10;

// Parse options
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    websiteUrl = args[i + 1];
    checkWebsite = true;
    i++;
  } else if (args[i] === '--check-website') {
    checkWebsite = true;
  } else if (args[i] === '--threshold' && args[i + 1]) {
    threshold = parseFloat(args[i + 1]);
    i++;
  } else if (args[i] === '--limit' && args[i + 1]) {
    limit = parseInt(args[i + 1]);
    i++;
  }
}

/**
 * Run fuzzy match query against OT manufacturers
 * Matches against both name and description (alias) fields
 */
function fuzzyMatchManufacturers(name, threshold, limit) {
  // Escape single quotes for SQL
  const escapedName = name.replace(/'/g, "''");

  // Query matches against both name and description fields
  // Description often contains aliases like "M13275 - CET, Chino-Excel Technology"
  // Uses word_similarity() for description to find words within longer strings
  const query = `
    WITH scored AS (
      SELECT
        chuboe_mfr_id,
        name,
        value as code,
        url,
        description,
        similarity(LOWER(name), LOWER('${escapedName}')) as name_score,
        COALESCE(word_similarity(LOWER('${escapedName}'), LOWER(description)), 0) as desc_score,
        GREATEST(
          similarity(LOWER(name), LOWER('${escapedName}')),
          COALESCE(word_similarity(LOWER('${escapedName}'), LOWER(description)), 0)
        ) as best_score
      FROM adempiere.chuboe_mfr
      WHERE isactive = 'Y'
    )
    SELECT
      chuboe_mfr_id,
      name,
      code,
      url,
      description,
      best_score as sim_score,
      CASE
        WHEN LOWER(name) = LOWER('${escapedName}') THEN 'EXACT'
        WHEN best_score >= 0.6 THEN 'HIGH'
        WHEN best_score >= 0.4 THEN 'MEDIUM'
        ELSE 'LOW'
      END as match_quality,
      CASE
        WHEN name_score >= desc_score THEN 'name'
        ELSE 'alias'
      END as match_field
    FROM scored
    WHERE best_score >= ${threshold}
    ORDER BY
      CASE WHEN LOWER(name) = LOWER('${escapedName}') THEN 0 ELSE 1 END,
      best_score DESC
    LIMIT ${limit};
  `;

  try {
    const result = execSync(`psql -t -A -F'|' -c "${query.replace(/\n/g, ' ')}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    const rows = result.trim().split('\n').filter(r => r.length > 0).map(row => {
      const [id, name, code, url, description, score, quality, matchField] = row.split('|');
      return {
        id: parseInt(id),
        name: name?.trim(),
        code: code?.trim(),
        url: url?.trim() || null,
        alias: description?.trim() || null,
        score: parseFloat(score),
        quality,
        matchField  // 'name' or 'alias'
      };
    });

    return rows;
  } catch (err) {
    console.error('Query error:', err.message);
    return [];
  }
}

/**
 * Check if a website appears to be a manufacturer vs distributor
 * Uses Playwright to analyze the website content
 */
async function checkWebsiteType(url) {
  const { chromium } = require('playwright');

  // Normalize URL
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  console.log(`\nChecking website: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1'
    }
  });
  const page = await context.newPage();

  try {
    // Initial page load with retry
    let retries = 2;
    while (retries > 0) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        break;
      } catch (e) {
        retries--;
        if (retries === 0) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Wait a bit for JS to render
    await page.waitForTimeout(2000);

    // Get page content for analysis
    let content = await page.evaluate(() => {
      const text = document.body?.innerText?.toLowerCase() || '';
      const title = document.title?.toLowerCase() || '';
      const meta = document.querySelector('meta[name="description"]')?.content?.toLowerCase() || '';

      return { text: text.substring(0, 50000), title, meta };
    });

    // Try to find and visit About page for better signals
    const aboutLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const aboutPatterns = ['/about', '/company', '/who-we-are', '/our-company'];
      for (const link of links) {
        const href = link.href?.toLowerCase() || '';
        const text = link.innerText?.toLowerCase() || '';
        if (aboutPatterns.some(p => href.includes(p)) ||
            ['about', 'about us', 'company', 'who we are'].includes(text.trim())) {
          return link.href;
        }
      }
      return null;
    });

    if (aboutLink) {
      try {
        await page.goto(aboutLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
        const aboutContent = await page.evaluate(() => {
          return document.body?.innerText?.toLowerCase()?.substring(0, 30000) || '';
        });
        content.text += ' ' + aboutContent;
      } catch (e) {
        // Ignore about page errors
      }
    }

    // Keywords indicating MANUFACTURER
    const mfrKeywords = [
      // Core manufacturing language
      'we manufacture', 'we design', 'we produce', 'our products',
      'our engineering', 'our technology', 'our innovation',
      'manufacturing facility', 'production facility', 'our factory',
      'designed by', 'engineered by', 'made by', 'built by',
      'we build', 'we create', 'we develop',
      // Semiconductor-specific
      'semiconductor company', 'ic manufacturer', 'chip manufacturer',
      'analog semiconductor', 'digital semiconductor', 'mixed-signal',
      'integrated circuits', 'asic', 'fpga', 'microcontroller',
      'power management', 'amplifier', 'converter', 'sensor',
      'fabrication', 'wafer', 'foundry', 'fab', 'process node',
      // Product language
      'product portfolio', 'product line', 'product catalog',
      'our solutions', 'technology leader', 'industry leader',
      'applications include', 'designed for', 'optimized for',
      // R&D / engineering
      'r&d', 'research and development', 'engineering team',
      'design center', 'innovation center', 'patent', 'invented',
      // Passive/mechanical manufacturing
      'we produce', 'custom design', 'oem', 'custom manufacturing',
      'precision manufacturing', 'iso certified', 'quality control'
    ];

    // Keywords indicating DISTRIBUTOR
    const distKeywords = [
      // Core distributor language
      'authorized distributor', 'franchised distributor', 'distributor of',
      'we distribute', 'distribution partner', 'distribution network',
      'suppliers include', 'brands we carry', 'manufacturers we represent',
      'stocking distributor', 'value-added distributor', 'wholesale',
      // Linecard / multi-brand
      'linecard', 'line card', 'manufacturer partners',
      'brands include', 'product lines include', 'we carry',
      'authorized for', 'representing', 'agency',
      // Sourcing language
      'sourcing', 'procurement', 'supply chain', 'logistics',
      'buy from multiple', 'compare prices', 'rfq', 'quote request',
      'hard to find', 'obsolete parts', 'end of life',
      // Broker language
      'broker', 'surplus', 'excess inventory', 'independent distributor',
      'open market', 'global sourcing', 'component sourcing',
      // B2B commerce
      'add to cart', 'checkout', 'buy now', 'in stock',
      'next day shipping', 'same day shipping'
    ];

    const fullText = content.title + ' ' + content.meta + ' ' + content.text;

    // Count keyword matches
    let mfrScore = 0;
    let distScore = 0;
    const mfrMatches = [];
    const distMatches = [];

    for (const kw of mfrKeywords) {
      if (fullText.includes(kw)) {
        mfrScore++;
        mfrMatches.push(kw);
      }
    }

    for (const kw of distKeywords) {
      if (fullText.includes(kw)) {
        distScore++;
        distMatches.push(kw);
      }
    }

    // Determine classification
    let classification;
    let confidence;

    if (mfrScore > distScore * 2) {
      classification = 'MANUFACTURER';
      confidence = Math.min(0.95, 0.5 + (mfrScore / 20));
    } else if (distScore > mfrScore * 2) {
      classification = 'DISTRIBUTOR';
      confidence = Math.min(0.95, 0.5 + (distScore / 15));
    } else if (mfrScore > distScore) {
      classification = 'LIKELY_MANUFACTURER';
      confidence = 0.5 + ((mfrScore - distScore) / 20);
    } else if (distScore > mfrScore) {
      classification = 'LIKELY_DISTRIBUTOR';
      confidence = 0.5 + ((distScore - mfrScore) / 15);
    } else {
      classification = 'UNCERTAIN';
      confidence = 0.3;
    }

    await browser.close();

    return {
      url,
      classification,
      confidence: Math.round(confidence * 100),
      manufacturerSignals: mfrMatches.slice(0, 5),
      distributorSignals: distMatches.slice(0, 5),
      title: content.title.substring(0, 100)
    };

  } catch (err) {
    await browser.close();
    return {
      url,
      classification: 'ERROR',
      error: err.message
    };
  }
}

/**
 * Main execution
 */
async function main() {
  console.log(`\n🔍 Searching for manufacturer: "${mfrName}"`);
  console.log(`   Threshold: ${threshold}, Limit: ${limit}\n`);

  // Step 1: Fuzzy match against OT
  const matches = fuzzyMatchManufacturers(mfrName, threshold, limit);

  if (matches.length === 0) {
    console.log('❌ No matches found in OT manufacturer database.\n');
    console.log('   This manufacturer may need to be added to OT.');
  } else {
    console.log(`✅ Found ${matches.length} potential match(es):\n`);
    console.log('   ID        | Score | Quality | Field | Name                           | Alias/Description');
    console.log('   ----------|-------|---------|-------|--------------------------------|-------------------');

    for (const m of matches) {
      const name = (m.name || '').substring(0, 30).padEnd(30);
      const alias = m.alias ? m.alias.substring(0, 35) : '-';
      const scoreStr = m.score.toFixed(2).padStart(5);
      const quality = (m.quality || '').padEnd(7);
      const field = (m.matchField || 'name').padEnd(5);
      console.log(`   ${String(m.id).padEnd(9)} | ${scoreStr} | ${quality} | ${field} | ${name} | ${alias}`);
    }

    // If exact match found
    const exactMatch = matches.find(m => m.quality === 'EXACT');
    if (exactMatch) {
      console.log(`\n✓ EXACT MATCH: "${exactMatch.name}" (ID: ${exactMatch.id}, Code: ${exactMatch.code})`);
      if (exactMatch.url && checkWebsite && !websiteUrl) {
        websiteUrl = exactMatch.url;
      }
    }

    // Show alias matches separately
    const aliasMatches = matches.filter(m => m.matchField === 'alias' && m.quality !== 'LOW');
    if (aliasMatches.length > 0) {
      console.log(`\n📎 Alias matches found: ${aliasMatches.map(m => `"${m.name}" via "${m.alias}"`).join(', ')}`);
    }
  }

  // Step 2: Website verification if requested
  if (checkWebsite && websiteUrl) {
    const result = await checkWebsiteType(websiteUrl);

    console.log('\n📡 Website Analysis:');
    console.log(`   URL: ${result.url}`);
    console.log(`   Title: ${result.title || 'N/A'}`);

    if (result.error) {
      console.log(`   ❌ Error: ${result.error}`);
    } else {
      const icon = result.classification.includes('MANUFACTURER') ? '🏭' :
                   result.classification.includes('DISTRIBUTOR') ? '🏪' : '❓';
      console.log(`   Classification: ${icon} ${result.classification} (${result.confidence}% confidence)`);

      if (result.manufacturerSignals?.length > 0) {
        console.log(`   Manufacturer signals: ${result.manufacturerSignals.join(', ')}`);
      }
      if (result.distributorSignals?.length > 0) {
        console.log(`   Distributor signals: ${result.distributorSignals.join(', ')}`);
      }
    }
  } else if (checkWebsite && !websiteUrl) {
    console.log('\n⚠️  No URL available for website check. Provide with --url <url>');
  }

  console.log('');
}

main().catch(console.error);

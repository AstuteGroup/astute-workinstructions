const fs = require('fs');

const inputFile = '/home/justin.oberhofer/workspace/uploaded files/Excess Inspection Log_active(Austin Excess Audit).csv';
const mfrCodesFile = '/home/justin.oberhofer/workspace/all_mfr_codes.csv';
const mfrAliasFile = '/home/justin.oberhofer/workspace/mfr_aliases.txt';
const outputFile = '/home/justin.oberhofer/workspace/uploaded files/Excess Inspection Log_active(Austin Excess Audit)_updated.csv';

// Manual overrides for known problem matches
const MANUAL_OVERRIDES = {
    'micron': { code: 'M03720', name: 'Micron Technology Inc' },
    'onsemi': { code: 'M04180', name: 'On Semiconductor' },
    'kemet': { code: 'M03110', name: 'Kemet Electronics Corp' },
    'kemetcorporation': { code: 'M03110', name: 'Kemet Electronics Corp' },
    'quanticpaktron': { code: 'M04255', name: 'Paktron' },
    'concordelectronics': { code: 'M01303', name: 'Concord Electronics' },
    'panasonic': { code: 'M11906', name: 'Panasonic' },
};

// Load MFR aliases (MFR codes → M codes)
const mfrAliases = {};
try {
    const aliasContent = fs.readFileSync(mfrAliasFile, 'utf8');
    const aliasLines = aliasContent.split('\n').slice(2);
    for (const line of aliasLines) {
        if (!line.trim() || line.startsWith('(')) continue;
        const match = line.match(/^\s*(MFR\d+)\s*\|[^|]+\|\s*(M\d+)/);
        if (match) {
            mfrAliases[match[1]] = match[2];
        }
    }
    console.log(`Loaded ${Object.keys(mfrAliases).length} MFR→M aliases`);
} catch (e) {
    console.log('No alias file found, MFR codes will be used as-is');
}

// Normalize name - strip common suffixes
function normalize(s) {
    return s.toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/inc$|corp$|corporation$|llc$|ltd$|limited$|co$|company$|incorporated$/g, '');
}

function normalizeRaw(s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
            inQuotes = !inQuotes;
            current += char;
        } else if (char === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields;
}

// Load MFR codes from database export
const mfrContent = fs.readFileSync(mfrCodesFile, 'utf8');
const mfrLines = mfrContent.split('\n').slice(1);
const mfrDb = [];

for (const line of mfrLines) {
    if (!line.trim() || line.startsWith('(')) continue;
    const parts = line.split(',');
    if (parts.length >= 2) {
        let code = parts[0].trim();
        const name = parts.slice(1).join(',').trim();
        if (code.match(/^M\d+$|^MFR\d+$/)) {
            if (code.startsWith('MFR') && mfrAliases[code]) {
                code = mfrAliases[code];
            }
            mfrDb.push({ code, name, normalized: normalize(name) });
        }
    }
}
console.log(`Loaded ${mfrDb.length} MFR codes from database`);

function findBestMatch(searchName) {
    const searchNorm = normalize(searchName);
    const searchRaw = normalizeRaw(searchName);
    if (!searchNorm || searchNorm.length < 2) return null;

    // Check manual overrides first
    if (MANUAL_OVERRIDES[searchNorm]) {
        return { ...MANUAL_OVERRIDES[searchNorm], method: 'manual' };
    }
    if (MANUAL_OVERRIDES[searchRaw]) {
        return { ...MANUAL_OVERRIDES[searchRaw], method: 'manual' };
    }

    // Exact normalized match
    for (const mfr of mfrDb) {
        if (mfr.normalized === searchNorm && mfr.code.startsWith('M')) {
            return { code: mfr.code, name: mfr.name, method: 'exact' };
        }
    }

    // Contains match with high similarity
    let bestMatch = null;
    let bestRatio = 0;

    for (const mfr of mfrDb) {
        if (!mfr.code.startsWith('M')) continue; // Skip MFR codes without aliases
        const shorter = searchNorm.length < mfr.normalized.length ? searchNorm : mfr.normalized;
        const longer = searchNorm.length < mfr.normalized.length ? mfr.normalized : searchNorm;

        if (longer.includes(shorter)) {
            const ratio = shorter.length / longer.length;
            if (ratio >= 0.7 && ratio > bestRatio) {
                bestRatio = ratio;
                bestMatch = { code: mfr.code, name: mfr.name, method: 'contains', ratio };
            }
        }
    }

    if (bestMatch) return bestMatch;

    // Prefix match
    if (searchNorm.length >= 5) {
        const prefix = searchNorm.substring(0, 5);
        for (const mfr of mfrDb) {
            if (!mfr.code.startsWith('M')) continue;
            if (mfr.normalized.startsWith(prefix)) {
                const ratio = Math.min(searchNorm.length, mfr.normalized.length) /
                              Math.max(searchNorm.length, mfr.normalized.length);
                if (ratio >= 0.7) {
                    return { code: mfr.code, name: mfr.name, method: 'prefix' };
                }
            }
        }
    }

    return null;
}

// Read input file
const content = fs.readFileSync(inputFile, 'utf8');
const lines = content.split('\n');
const header = lines[0];
const headerCols = parseCSVLine(header);
const nameIdx = headerCols.indexOf('Name');
const mfrIdx = headerCols.indexOf('MFR');

// First pass: build existing mappings
const existingMappings = {};
const allRows = [];

for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseCSVLine(line);
    allRows.push({ lineNum: i, fields });

    const nameVal = (fields[nameIdx] || '').trim();
    const mfrVal = (fields[mfrIdx] || '').trim();

    if (nameVal.match(/^M\d+$/) && mfrVal) {
        const norm = normalize(mfrVal);
        if (!existingMappings[norm]) {
            existingMappings[norm] = nameVal;
        }
    }
}

console.log(`Found ${Object.keys(existingMappings).length} existing mappings in file\n`);

// Second pass: assign codes
const outputLines = [header];
let kept = 0, fromFile = 0, fromDb = 0, noMatch = 0;
const matches = [];
const unmatched = [];

for (const row of allRows) {
    const fields = row.fields;
    const nameVal = (fields[nameIdx] || '').trim();
    const mfrVal = (fields[mfrIdx] || '').trim();
    let newName = nameVal;

    if (nameVal.match(/^M\d+$/)) {
        kept++;
    } else if (mfrVal) {
        const norm = normalize(mfrVal);

        if (existingMappings[norm]) {
            newName = existingMappings[norm];
            fromFile++;
        } else {
            const match = findBestMatch(mfrVal);
            if (match) {
                newName = match.code;
                fromDb++;
                matches.push({ search: mfrVal, found: match.name, code: match.code, method: match.method });
            } else {
                newName = '';
                noMatch++;
                unmatched.push(mfrVal);
            }
        }
    }

    fields[nameIdx] = newName;

    const outputLine = fields.map(f => {
        if (f.includes(',') || f.includes('"')) {
            return `"${f.replace(/"/g, '""')}"`;
        }
        return f;
    }).join(',');

    outputLines.push(outputLine);
}

fs.writeFileSync(outputFile, outputLines.join('\n'));

console.log(`=== Fuzzy Matches Found ===`);
for (const m of matches) {
    console.log(`"${m.search}" → ${m.code} (${m.found}) [${m.method}]`);
}

if (unmatched.length > 0) {
    console.log(`\n=== Unmatched (not in database) ===`);
    const unique = [...new Set(unmatched)];
    for (const u of unique) {
        console.log(`  "${u}"`);
    }
}

console.log(`\n=== Results ===`);
console.log(`Kept existing codes: ${kept}`);
console.log(`Matched from file: ${fromFile}`);
console.log(`Matched from DB (fuzzy): ${fromDb}`);
console.log(`No match: ${noMatch}`);
console.log(`\nOutput: ${outputFile}`);

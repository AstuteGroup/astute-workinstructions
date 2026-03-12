const fs = require('fs');

const HEADER = 'RFQ Search Key,Buyer,Business Partner Search Key,Contact,MPN,MFR Text,Quoted Quantity,Cost,Currency,Date Code,MOQ,SPQ,Packaging,Lead Time,COO,RoHS,Vendor Notes';
const NUM_COLS = 17;

function fixCsvFile(inputPath) {
  const content = fs.readFileSync(inputPath, 'utf-8');
  const lines = content.trim().split('\n');

  const output = [HEADER];
  let fixed = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    const numCols = parts.length;

    if (numCols === NUM_COLS) {
      output.push(line);
    } else if (numCols < NUM_COLS) {
      // Add empty columns at the end to reach 17
      while (parts.length < NUM_COLS) {
        parts.push('');
      }
      output.push(parts.join(','));
      fixed++;
    } else {
      // Too many columns - try to fix by removing extra empties after column 12 (SPQ)
      // This assumes the extra column is an empty one in the MOQ/SPQ/Packaging area
      console.log(`Line ${i + 1}: ${numCols} columns - attempting fix`);

      // Count empty slots between Date Code (9) and first non-empty after it
      let extraEmpties = 0;
      for (let j = 10; j < parts.length - 4; j++) {
        if (parts[j] === '') extraEmpties++;
        else break;
      }

      if (numCols - NUM_COLS <= extraEmpties) {
        // Remove extra empty columns
        const toRemove = numCols - NUM_COLS;
        for (let r = 0; r < toRemove; r++) {
          // Find first empty after column 10 and remove it
          for (let j = 10; j < parts.length - 4; j++) {
            if (parts[j] === '') {
              parts.splice(j, 1);
              break;
            }
          }
        }
        output.push(parts.join(','));
        fixed++;
      } else {
        console.error(`  Cannot auto-fix, keeping as-is`);
        output.push(line);
      }
    }
  }

  // Verify
  let allGood = true;
  output.forEach((line, idx) => {
    const cols = line.split(',').length;
    if (cols !== NUM_COLS) {
      console.error(`VERIFY FAIL - Line ${idx + 1}: ${cols} columns`);
      allGood = false;
    }
  });

  if (allGood) {
    fs.writeFileSync(inputPath, output.join('\n') + '\n');
    console.log(`✓ Fixed ${inputPath}: ${output.length - 1} data rows, ${fixed} rows adjusted`);
  } else {
    const backupPath = inputPath.replace('.csv', '-broken.csv');
    fs.writeFileSync(backupPath, output.join('\n') + '\n');
    console.error(`✗ Some rows still have wrong column count. Saved to ${backupPath}`);
  }
}

// Fix both files
const dir = '/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/output';
console.log('Fixing 03-10...');
fixCsvFile(`${dir}/2026-03-10-erp-ready.csv`);
console.log('\nFixing 03-11...');
fixCsvFile(`${dir}/2026-03-11-erp-ready.csv`);

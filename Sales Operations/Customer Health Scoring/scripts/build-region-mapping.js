const XLSX = require('xlsx');

// Region mapping rules based on work location
const LOCATION_TO_REGION = {
  'Astute HQ': 'USA',
  'LATAM Office ': 'MEX',
  'Remote': 'REMOTE_UNKNOWN', // Need to classify individually

  // APAC locations
  'Astute Electronics HK Limited': 'APAC',
  'Astute Electronics Inc Pte. Ltd.': 'APAC',
  'Astute Electronics Incorporated Korea Branch': 'APAC',
  'Astute Electronics ShenZhen Ltd ': 'APAC',
  'Bangalore': 'APAC', // India team (resigned per requirements)
  'Chennai': 'APAC', // India team
  'Indonesia': 'APAC',
  'Malaysia': 'APAC',
  'Philippines': 'APAC',
  'Taiwan': 'APAC',
  'Thailand': 'APAC',
};

// Manual overrides for "Remote" employees based on requirements
// Carolina Hinestroza is mentioned as Mexico team in requirements
const REMOTE_OVERRIDES = {
  'Carolina Hinestroza': 'MEX',
  'Jake McAloose': 'USA', // Assume USA unless told otherwise
  'James Xu': 'USA',
  'Juan Botero': 'USA',
  'Liz Shelley': 'USA',
  'Michael Stifter': 'USA',
};

async function buildRegionMapping() {
  // Read employee roster
  const wb = XLSX.readFile('/home/melissa.bojar/workspace/lots-shipped-received/data/Employee_roster - 5.14.26.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rosterData = XLSX.utils.sheet_to_json(ws);

  // Filter for active sales employees
  const salesReps = rosterData.filter(r =>
    r.Department === 'Sales' &&
    r['Employment status'] === 'Active'
  );

  console.log(`Found ${salesReps.length} active sales employees\n`);

  // Build region mapping
  const regionMapping = {};
  const unknownRemote = [];

  salesReps.forEach(rep => {
    const name = rep.Employee;
    const location = rep['Work location name'];

    let region = LOCATION_TO_REGION[location];

    if (region === 'REMOTE_UNKNOWN') {
      region = REMOTE_OVERRIDES[name] || 'UNKNOWN';
      if (region === 'UNKNOWN') {
        unknownRemote.push({ name, title: rep.Title });
      }
    }

    regionMapping[name] = {
      region,
      location,
      title: rep.Title,
      manager: rep.Manager,
    };
  });

  // Query database to match names to ad_user_ids
  try {
    const { execSync } = require('child_process');
    const dbResult = execSync(`psql -t -A -F',' -c "SELECT u.ad_user_id, u.name, bp.issalesrep FROM adempiere.ad_user u JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id WHERE u.isactive = 'Y' AND bp.issalesrep = 'Y' ORDER BY u.name"`, { encoding: 'utf8' });

    const dbSalesReps = dbResult.trim().split('\n').map(line => {
      const [ad_user_id, name, issalesrep] = line.split(',');
      return { ad_user_id, name, issalesrep };
    }).filter(r => r.name); // Filter out empty lines
    console.log(`Found ${dbSalesReps.length} active sales reps in database\n`);

    // Match roster names to database user_ids
    const matched = [];
    const rosterOnly = [];
    const dbOnly = [];

    dbSalesReps.forEach(dbRep => {
      const mapping = regionMapping[dbRep.name];
      if (mapping) {
        matched.push({
          ad_user_id: dbRep.ad_user_id,
          name: dbRep.name,
          ...mapping,
        });
      } else {
        dbOnly.push(dbRep);
      }
    });

    // Find roster entries not in DB
    Object.keys(regionMapping).forEach(name => {
      if (!matched.find(m => m.name === name)) {
        rosterOnly.push({ name, ...regionMapping[name] });
      }
    });

    // Report results
    console.log('=== REGION MAPPING RESULTS ===\n');

    console.log(`Matched (in both roster and DB): ${matched.length}`);
    console.log('By region:');
    ['USA', 'MEX', 'APAC'].forEach(region => {
      const count = matched.filter(m => m.region === region).length;
      console.log(`  ${region}: ${count}`);
    });

    if (unknownRemote.length > 0) {
      console.log('\n⚠️  Remote employees needing region assignment:');
      unknownRemote.forEach(r => console.log(`  - ${r.name} (${r.title})`));
    }

    if (rosterOnly.length > 0) {
      console.log(`\n⚠️  In roster but not in DB (${rosterOnly.length}):`);
      rosterOnly.slice(0, 10).forEach(r => console.log(`  - ${r.name} (${r.title})`));
      if (rosterOnly.length > 10) console.log(`  ... and ${rosterOnly.length - 10} more`);
    }

    if (dbOnly.length > 0) {
      console.log(`\n⚠️  In DB but not in roster (${dbOnly.length}):`);
      dbOnly.slice(0, 10).forEach(r => console.log(`  - ${r.name} (ID: ${r.ad_user_id})`));
      if (dbOnly.length > 10) console.log(`  ... and ${dbOnly.length - 10} more`);
    }

    // Write output file
    const outputPath = '/home/melissa.bojar/workspace/astute-workinstructions/Sales Operations/Customer Health Scoring/output/salesrep-region-mapping.json';
    const fs = require('fs');
    fs.writeFileSync(outputPath, JSON.stringify({
      matched,
      rosterOnly,
      dbOnly,
      unknownRemote,
      generatedAt: new Date().toISOString(),
    }, null, 2));

    console.log(`\n✓ Mapping saved to: ${outputPath}`);
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
}

buildRegionMapping().catch(console.error);

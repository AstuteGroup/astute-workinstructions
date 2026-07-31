const XLSX = require('xlsx');
const wb = XLSX.readFile('/tmp/Positronic orders.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws);

// Email recipients from Polyxeni's email
const emailRecipients = [
  'Matt Eustace', 'Josh Syre', 'Nick Molloy', 'Jay Hugill', 'Stacey Watts',
  'Jake Harris', 'Agnes Morocz', 'Marcus Seitz', 'Richard Joannou', 'Louise Kennoy',
  'Leah Griffin', 'Stephen West', 'Lee Howard', 'Callum Britton', 'Anthoney Bramante',
  'Natalie Scammell', 'Neil Webkin', 'Ronen Moyal', 'Harj Handa', 'Wing Zhang',
  'Derrick Pinner', 'Alex Gorski', 'Lucy Baldwin', 'Ryan Mitchell', 'Will Goff',
  'Sarah Greenaway', 'Nick Rayner', 'James Docherty'
];

// Username mapping (first 4 chars of first name + first 4 chars of last name, lowercase)
const usernameMap = {};
emailRecipients.forEach(name => {
  const parts = name.split(' ');
  const first = parts[0].toLowerCase().substring(0, 4);
  const last = parts[parts.length - 1].toLowerCase().substring(0, 4);
  usernameMap[first + last] = name;
});

// Also check External Salesperson column
const bySalesperson = {};
data.forEach(row => {
  const internal = row['Internal Salesperson'] || '';
  const external = row['External Salesperson'] || '';

  [internal, external].forEach(sp => {
    if (!sp) return;
    if (!bySalesperson[sp]) {
      bySalesperson[sp] = { customers: new Set(), parts: new Set(), rows: 0, type: sp === internal ? 'internal' : 'external' };
    }
    bySalesperson[sp].customers.add(row.Customer);
    bySalesperson[sp].parts.add(row.Item);
    bySalesperson[sp].rows++;
  });
});

console.log('=== MAPPING EMAIL RECIPIENTS TO ORDER DATA ===\n');

emailRecipients.forEach(name => {
  const parts = name.split(' ');
  const first = parts[0].toLowerCase().substring(0, 4);
  const last = parts[parts.length - 1].toLowerCase().substring(0, 4);
  const username = first + last;

  const match = bySalesperson[username];
  if (match) {
    console.log(`✓ ${name} (${username}): ${match.rows} order lines`);
    console.log(`    Customers: ${[...match.customers].join(', ')}`);
  } else {
    console.log(`✗ ${name} (${username}): No orders in data`);
  }
});

console.log('\n=== SELLERS IN DATA NOT ON EMAIL LIST ===\n');
Object.entries(bySalesperson).forEach(([sp, info]) => {
  const matchedName = usernameMap[sp];
  if (!matchedName && sp !== 'unknown' && sp !== 'Astute' && info.rows > 0) {
    console.log(`${sp}: ${info.rows} order lines - Customers: ${[...info.customers].join(', ')}`);
  }
});

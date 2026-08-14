#!/usr/bin/env node
/**
 * Weekly Project Report Generator
 *
 * Run every Monday morning to summarize work from the previous week.
 *
 * Usage:
 *   node scripts/weekly-project-report.js           # Last 7 days (console)
 *   node scripts/weekly-project-report.js --week    # Previous Mon-Sun (console)
 *   node scripts/weekly-project-report.js --send    # Previous Mon-Sun + email
 *   node scripts/weekly-project-report.js --days 14 # Last 14 days (console)
 */

const { execSync } = require('child_process');
const path = require('path');

const HOME = process.env.HOME || '/home/justin.oberhofer';
const REPO_PATH = path.join(HOME, 'workspace/astute-workinstructions');
const RECIPIENT = 'justin.oberhofer@astutegroup.com';
const AUTHOR = 'Justin Oberhofer';

// Project metadata: description and folder location
const PROJECT_META = {
  'Inspection Queue Maintenance': {
    description: 'Automated workflow for managing the inspection queue in OT',
    folder: 'Business Ops/tsk-inspection-queue-maintenance/'
  },
  'Tariff Tracker': {
    description: 'Email-triggered workflow for extracting tariff/duty data from customs invoice PDFs',
    folder: 'Business Ops/tsk-tariff-tracker-extraction/'
  },
  'BOS Metrics': {
    description: 'Monthly Business Ops metrics report (CSE queue activity)',
    folder: 'Business Ops/cron-reports/cron-monthly/'
  },
  'Currency Conversion': {
    description: 'Workflow for processing Exchange Rate Matrix emails',
    folder: 'Business Ops/tsk-currency-conversion-upload/'
  },
  'MFR Screening': {
    description: 'New manufacturer screening and approval workflow',
    folder: 'Business Ops/tsk-new-mfr-screening/'
  },
  'Excess Processing': {
    description: 'Customer excess offer processing and analysis',
    folder: 'Trading Analysis/Customer Excess Analysis/'
  },
  'VQ Loading': {
    description: 'Vendor quote loading and processing',
    folder: 'Trading Analysis/RFQ Sourcing/vq_loading/'
  },
  'RFQ Loading': {
    description: 'RFQ creation and loading workflows',
    folder: 'Trading Analysis/RFQ Loading/'
  },
  'LAM Kitting': {
    description: 'LAM kitting reorder and inventory management',
    folder: 'Trading Analysis/LAM 3PL/'
  },
  'Email Notifier': {
    description: 'Shared email notification system',
    folder: 'shared/'
  },
  'Shared Utilities': {
    description: 'Common modules used across workflows',
    folder: 'shared/'
  },
  'CLI Scripts': {
    description: 'Command-line tools and installers',
    folder: 'scripts/'
  },
  'Other': {
    description: 'Miscellaneous updates and housekeeping',
    folder: null
  },
};

function getDateRange(args) {
  const today = new Date();
  let since, until;

  if (args.includes('--week') || args.includes('--send')) {
    const dayOfWeek = today.getDay();
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - daysToLastMonday - 7);
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    since = lastMonday;
    until = lastSunday;
  } else {
    const daysArg = args.indexOf('--days');
    const days = daysArg >= 0 ? parseInt(args[daysArg + 1]) || 7 : 7;
    since = new Date(today);
    since.setDate(today.getDate() - days);
    until = today;
  }

  return {
    since: since.toISOString().split('T')[0],
    until: until.toISOString().split('T')[0]
  };
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getWeekNumber(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = d - start;
  const oneWeek = 604800000;
  return Math.ceil((diff + start.getDay() * 86400000) / oneWeek);
}

function getGitLog(since) {
  try {
    const cmd = `git -C "${REPO_PATH}" log --since="${since}" --author="${AUTHOR}" --pretty=format:"%h|%ad|%s" --date=short`;
    return execSync(cmd, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

function getFilesChanged(since) {
  try {
    const cmd = `git -C "${REPO_PATH}" log --since="${since}" --author="${AUTHOR}" --name-only --pretty=format:"COMMIT|%h|%ad|%s" --date=short`;
    return execSync(cmd, { encoding: 'utf8' });
  } catch (e) {
    return '';
  }
}

function categorizeCommit(mainFile) {
  if (mainFile.includes('inspection-queue')) return 'Inspection Queue Maintenance';
  if (mainFile.includes('tariff-tracker')) return 'Tariff Tracker';
  if (mainFile.includes('bos-metrics') || mainFile.includes('BOS Metrics')) return 'BOS Metrics';
  if (mainFile.includes('currency')) return 'Currency Conversion';
  if (mainFile.includes('mfr-screening') || mainFile.includes('new-mfr')) return 'MFR Screening';
  if (mainFile.includes('excess')) return 'Excess Processing';
  if (mainFile.includes('vq_loading') || mainFile.includes('vq-loading')) return 'VQ Loading';
  if (mainFile.includes('rfq-loading') || mainFile.includes('RFQ Loading')) return 'RFQ Loading';
  if (mainFile.includes('LAM') || mainFile.includes('lam-kitting')) return 'LAM Kitting';
  if (mainFile.includes('notifier')) return 'Email Notifier';
  if (mainFile.includes('shared/')) return 'Shared Utilities';
  if (mainFile.includes('scripts/')) return 'CLI Scripts';
  return 'Other';
}

function categorizeCommits(logOutput) {
  const projects = {};
  const lines = logOutput.split('\n');
  let currentCommit = null;
  const seenCommits = new Set();

  for (const line of lines) {
    if (line.startsWith('COMMIT|')) {
      if (currentCommit && currentCommit.files.length > 0 && !seenCommits.has(currentCommit.hash)) {
        seenCommits.add(currentCommit.hash);
        const projectKey = categorizeCommit(currentCommit.files[0]);
        if (!projects[projectKey]) {
          projects[projectKey] = { commits: [], files: new Set() };
        }
        projects[projectKey].commits.push(currentCommit);
        currentCommit.files.forEach(f => projects[projectKey].files.add(f));
      }
      const [, hash, date, message] = line.split('|');
      currentCommit = { hash, date, message, files: [] };
    } else if (line.trim() && currentCommit) {
      currentCommit.files.push(line.trim());
    }
  }

  if (currentCommit && currentCommit.files.length > 0 && !seenCommits.has(currentCommit.hash)) {
    const projectKey = categorizeCommit(currentCommit.files[0]);
    if (!projects[projectKey]) {
      projects[projectKey] = { commits: [], files: new Set() };
    }
    projects[projectKey].commits.push(currentCommit);
    currentCommit.files.forEach(f => projects[projectKey].files.add(f));
  }

  return projects;
}

// Extract key highlights from commit messages
function extractHighlights(commits) {
  const highlights = [];
  const seen = new Set();

  for (const commit of commits) {
    const msg = commit.message.toLowerCase();
    let highlight = commit.message;

    // Clean up common prefixes
    highlight = highlight
      .replace(/^(Add|Fix|Update|Improve|Move|Rename|Remove|Complete|Change)\s+/i, '')
      .replace(/\s+\(.*?\)$/, ''); // Remove trailing parenthetical

    // Capitalize first letter
    highlight = highlight.charAt(0).toUpperCase() + highlight.slice(1);

    // Dedupe similar highlights
    const key = highlight.toLowerCase().replace(/[^a-z]/g, '').slice(0, 30);
    if (!seen.has(key)) {
      seen.add(key);
      highlights.push(highlight);
    }
  }

  return highlights.slice(0, 6); // Max 6 highlights per project
}

function generateConsoleReport(dateRange, projects, commits) {
  const weekNum = getWeekNumber(dateRange.since);

  // ANSI codes for formatting
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const CYAN = '\x1b[36m';

  console.log();
  console.log(`${BOLD}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}  WEEKLY PROJECT REPORT - Week ${weekNum}${RESET}`);
  console.log(`  ${formatDate(dateRange.since)} - ${formatDate(dateRange.until)}`);
  console.log(`${'═'.repeat(70)}`);
  console.log();
  console.log(`  ${BOLD}${commits.length} commits${RESET} across ${BOLD}${Object.keys(projects).length} projects${RESET}`);
  console.log();

  const sortedProjects = Object.entries(projects)
    .filter(([name]) => name !== 'Other')
    .sort((a, b) => b[1].commits.length - a[1].commits.length);

  // Add 'Other' at the end if it has commits
  if (projects['Other']) {
    sortedProjects.push(['Other', projects['Other']]);
  }

  for (const [name, data] of sortedProjects) {
    const meta = PROJECT_META[name] || { description: '' };
    const highlights = extractHighlights(data.commits);

    console.log();
    console.log(`${CYAN}${'━'.repeat(70)}${RESET}`);
    console.log();
    console.log(`  ${BOLD}${name.toUpperCase()}${RESET} ${DIM}(${data.commits.length} commits)${RESET}`);
    if (meta.folder) {
      console.log(`  ${DIM}${meta.folder}${RESET}`);
    }
    console.log();
    if (meta.description) {
      console.log(`  ${meta.description}`);
      console.log();
    }

    for (const h of highlights) {
      console.log(`    • ${h}`);
    }
  }

  console.log();
  console.log(`${'═'.repeat(70)}`);
  console.log();
}

function generateHtmlReport(dateRange, projects, commits) {
  const weekNum = getWeekNumber(dateRange.since);
  const sortedProjects = Object.entries(projects)
    .filter(([name]) => name !== 'Other')
    .sort((a, b) => b[1].commits.length - a[1].commits.length);

  if (projects['Other']) {
    sortedProjects.push(['Other', projects['Other']]);
  }

  let html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 700px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
      line-height: 1.5;
    }
    h1 {
      color: #2c3e50;
      font-size: 24px;
      margin-bottom: 5px;
    }
    .date-range {
      color: #7f8c8d;
      margin-bottom: 20px;
    }
    .summary {
      background: #f8f9fa;
      padding: 15px 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      border-left: 4px solid #3498db;
    }
    .project {
      margin-bottom: 25px;
      padding-bottom: 25px;
      border-bottom: 1px solid #eee;
    }
    .project:last-child {
      border-bottom: none;
    }
    .project-title {
      font-size: 18px;
      font-weight: 600;
      color: #2c3e50;
      margin-bottom: 5px;
    }
    .project-stats {
      font-size: 13px;
      color: #7f8c8d;
      margin-bottom: 10px;
    }
    .project-desc {
      color: #555;
      margin-bottom: 12px;
    }
    .highlights {
      margin: 0;
      padding-left: 20px;
    }
    .highlights li {
      margin-bottom: 6px;
      color: #444;
    }
    .footer {
      color: #999;
      font-size: 12px;
      margin-top: 30px;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>Weekly Project Report - Week ${weekNum}</h1>
  <div class="date-range">${formatDate(dateRange.since)} - ${formatDate(dateRange.until)}</div>

  <div class="summary">
    <strong>${commits.length} commits</strong> across <strong>${Object.keys(projects).length} projects</strong>
  </div>
`;

  for (const [name, data] of sortedProjects) {
    const meta = PROJECT_META[name] || { description: '' };
    const highlights = extractHighlights(data.commits);

    html += `
  <div class="project">
    <div class="project-title">${name}</div>
    <div class="project-stats">${data.commits.length} commits | ${data.files.size} files${meta.folder ? ` | <code>${meta.folder}</code>` : ''}</div>
`;

    if (meta.description) {
      html += `    <div class="project-desc">${meta.description}</div>\n`;
    }

    html += `    <ul class="highlights">\n`;
    for (const h of highlights) {
      html += `      <li>${h}</li>\n`;
    }
    html += `    </ul>\n`;
    html += `  </div>\n`;
  }

  html += `
  <div class="footer">
    Generated ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
  </div>
</body>
</html>`;

  return html;
}

async function sendReport(dateRange, projects, commits) {
  const nodemailer = require('nodemailer');
  require('dotenv').config({ path: path.join(HOME, 'workspace/.env') });

  const weekNum = getWeekNumber(dateRange.since);
  const htmlContent = generateHtmlReport(dateRange, projects, commits);
  const subject = `Weekly Project Report - Week ${weekNum}`;

  // Build plain text fallback
  const sortedProjects = Object.entries(projects)
    .filter(([name]) => name !== 'Other')
    .sort((a, b) => b[1].commits.length - a[1].commits.length);

  if (projects['Other']) {
    sortedProjects.push(['Other', projects['Other']]);
  }

  let textBody = `Weekly Project Report - Week ${weekNum}\n`;
  textBody += `${formatDate(dateRange.since)} - ${formatDate(dateRange.until)}\n\n`;
  textBody += `${commits.length} commits across ${Object.keys(projects).length} projects\n\n`;

  for (const [name, data] of sortedProjects) {
    const meta = PROJECT_META[name] || { description: '' };
    const highlights = extractHighlights(data.commits);

    textBody += `${name} (${data.commits.length} commits)\n`;
    if (meta.folder) {
      textBody += `${meta.folder}\n`;
    }
    textBody += '\n';
    for (const h of highlights) {
      textBody += `  - ${h}\n`;
    }
    textBody += '\n';
  }

  // Send inline HTML (no attachment)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: 465,
    secure: true,
    auth: {
      user: 'bizops@orangetsunami.com',
      pass: process.env.SMTP_PASS || process.env.WORKMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: 'Weekly Project Report <bizops@orangetsunami.com>',
    to: RECIPIENT,
    subject,
    text: textBody,
    html: htmlContent
  });

  console.log(`Report sent to ${RECIPIENT}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dateRange = getDateRange(args);
  const logOutput = getFilesChanged(dateRange.since);
  const projects = categorizeCommits(logOutput);
  const commits = getGitLog(dateRange.since);

  if (commits.length === 0) {
    console.log('No commits found in the specified date range.');
    return;
  }

  if (args.includes('--send')) {
    await sendReport(dateRange, projects, commits);
  } else {
    generateConsoleReport(dateRange, projects, commits);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

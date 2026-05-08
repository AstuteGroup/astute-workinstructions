// Applied Materials Supplier Portal — Phase 1 login probe.
// See ./amat-rfq-management.md (Phase 1, Step 3) for the operator workflow.
//
// Run interactively so you can paste the 2FA code:
//   ! node "Trading Analysis/AMAT RFQ Management/login.js"
//
// Reads credentials from ~/workspace/.env (set via ./set-creds.js).
// Screenshots + session cookies live OUTSIDE the repo at ~/workspace/amat-portal/
// (auth-bearing — must not be committed).

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://myapp.amat.com/Login.html';
const RUNTIME_DIR = '/home/analytics_user/workspace/amat-portal';
const SHOT_DIR = path.join(RUNTIME_DIR, 'screenshots');
const STATE_FILE = path.join(RUNTIME_DIR, 'session-state.json');

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

function shot(page, name) {
  const file = path.join(SHOT_DIR, `${Date.now()}_${name}.png`);
  return page.screenshot({ path: file, fullPage: true }).then(() => {
    console.log(`  [shot] ${file}`);
    return file;
  });
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans.trim()); }));
}

async function dumpInputs(page, label) {
  const inputs = await page.$$eval('input, button, a', els =>
    els.slice(0, 40).map(e => ({
      tag: e.tagName,
      type: e.type || null,
      name: e.name || null,
      id: e.id || null,
      placeholder: e.placeholder || null,
      text: (e.innerText || e.value || '').slice(0, 60)
    }))
  );
  console.log(`\n  [${label}] visible form elements:`);
  inputs.forEach(i => console.log(`    ${JSON.stringify(i)}`));
}

(async () => {
  if (!process.env.AMAT_USER || !process.env.AMAT_PASS) {
    console.error('ERROR: AMAT_USER / AMAT_PASS missing from ~/workspace/.env');
    console.error('Run: node "Trading Analysis/AMAT RFQ Management/set-creds.js"');
    process.exit(1);
  }

  const useState = fs.existsSync(STATE_FILE);
  console.log(`Launching Chromium (saved session: ${useState ? 'YES' : 'no'})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: useState ? STATE_FILE : undefined,
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log(`\n→ GET ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  console.log(`  url=${page.url()}`);
  console.log(`  title=${await page.title()}`);
  await shot(page, '01_landing');
  await dumpInputs(page, 'landing');

  if (useState && !/login/i.test(page.url())) {
    console.log('\n✓ Saved session is still valid. Final URL: ' + page.url());
    await shot(page, '02_already_logged_in');
    await context.storageState({ path: STATE_FILE });
    await browser.close();
    return;
  }

  const userSelectors = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[id*="email" i]',
    'input[id*="user" i]'
  ];
  let userEl = null;
  for (const sel of userSelectors) {
    userEl = await page.$(sel);
    if (userEl) { console.log(`\n  username field matched: ${sel}`); break; }
  }
  if (!userEl) {
    console.error('\n✗ Could not find username field. See screenshot + dump above.');
    await browser.close();
    process.exit(2);
  }
  await userEl.fill(process.env.AMAT_USER);
  await shot(page, '03_username_entered');

  let passEl = await page.$('input[type="password"]');
  if (!passEl) {
    console.log('  password field not yet visible — looking for Next/Continue button');
    const nextBtn = await page.$('button:has-text("Next"), button:has-text("Continue"), input[type="submit"]');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await shot(page, '04_after_next');
    }
    passEl = await page.$('input[type="password"]');
  }

  if (!passEl) {
    console.error('\n✗ Password field never appeared. Inspect screenshots.');
    await dumpInputs(page, 'no-password-state');
    await browser.close();
    process.exit(3);
  }

  await passEl.fill(process.env.AMAT_PASS);
  await shot(page, '05_password_entered');

  const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")');
  if (submitBtn) await submitBtn.click(); else await passEl.press('Enter');

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await shot(page, '06_after_submit');
  console.log(`\n  post-submit url=${page.url()}`);
  console.log(`  post-submit title=${await page.title()}`);
  await dumpInputs(page, 'post-submit');

  const codeSelectors = [
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="token" i]',
    'input[autocomplete="one-time-code"]'
  ];
  let codeEl = null;
  for (const sel of codeSelectors) {
    codeEl = await page.$(sel);
    if (codeEl) { console.log(`\n  2FA field matched: ${sel}`); break; }
  }

  if (codeEl) {
    const code = await prompt('\n>>> Enter 2FA code from your email/SMS: ');
    await codeEl.fill(code);
    await shot(page, '07_2fa_entered');
    const verifyBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")');
    if (verifyBtn) await verifyBtn.click(); else await codeEl.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await shot(page, '08_after_2fa');
  } else {
    console.log('\n  No 2FA field detected — either already trusted device, or different layout.');
  }

  console.log(`\n  final url=${page.url()}`);
  console.log(`  final title=${await page.title()}`);
  await shot(page, '09_final');

  await context.storageState({ path: STATE_FILE });
  console.log(`\n✓ Session state saved to ${STATE_FILE}`);
  console.log('  Subsequent runs should skip the login flow until the cookie expires.');
  console.log('  This file is auth-bearing — keep it out of git and chat.');

  await browser.close();
})().catch(err => {
  console.error('\n✗ Login script error:', err);
  process.exit(99);
});

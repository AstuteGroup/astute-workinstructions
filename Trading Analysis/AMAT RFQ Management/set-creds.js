// Silent prompt for AMAT credentials — writes to ~/workspace/.env without echoing the password.
// See ./amat-rfq-management.md (Phase 1, Step 2).
//
// Usage:
//   ! node "Trading Analysis/AMAT RFQ Management/set-creds.js"

const readline = require('readline');
const fs = require('fs');

const ENV_FILE = '/home/analytics_user/workspace/.env';

function promptVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function promptSilent(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.resume();
    stdin.setEncoding('utf8');
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = '';
    const onData = (ch) => {
      const c = ch.toString('utf8');
      if (c === '\n' || c === '\r' || c === '') {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buf);
      } else if (c === '') { // ctrl-c
        process.exit(130);
      } else if (c === '' || c === '\b') { // backspace
        buf = buf.slice(0, -1);
      } else {
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return { lines: [], map: {} };
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  const map = {};
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m) map[m[1]] = i;
  });
  return { lines, map };
}

function writeEnv({ lines, map }, key, value) {
  if (key in map) {
    lines[map[key]] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
    map[key] = lines.length - 1;
  }
}

(async () => {
  const env = readEnv();
  const hasUser = 'AMAT_USER' in env.map;
  const hasPass = 'AMAT_PASS' in env.map;

  if (hasUser || hasPass) {
    console.log(`Current state: AMAT_USER=${hasUser ? 'set' : 'unset'}, AMAT_PASS=${hasPass ? 'set' : 'unset'}`);
    const ans = await promptVisible('Overwrite existing values? [y/N]: ');
    if (!/^y/i.test(ans)) { console.log('Aborted, no changes.'); process.exit(0); }
  }

  const user = await promptVisible('AMAT_USER (email): ');
  if (!user) { console.error('Empty username, aborting.'); process.exit(1); }

  const pass = await promptSilent('AMAT_PASS (hidden): ');
  if (!pass) { console.error('Empty password, aborting.'); process.exit(1); }

  writeEnv(env, 'AMAT_USER', user);
  writeEnv(env, 'AMAT_PASS', pass);

  fs.writeFileSync(ENV_FILE, env.lines.join('\n'));
  try { fs.chmodSync(ENV_FILE, 0o600); } catch {}

  console.log(`\n✓ Wrote AMAT_USER and AMAT_PASS to ${ENV_FILE}`);
  console.log(`  AMAT_USER=${user}`);
  console.log(`  AMAT_PASS=${'*'.repeat(Math.min(pass.length, 12))} (${pass.length} chars)`);
})();

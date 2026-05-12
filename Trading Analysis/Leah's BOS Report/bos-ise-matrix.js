// Parses Leah's BOS_ISE_Assignments.xlsx into { loginToBos, displayToLogin,
// unmappedDisplays, bosCseForm } so bos-report.js can flag lines whose
// Customer CSE doesn't match the matrix's expected BOS for that ISE login.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const MATRIX_XLSX = path.join(__dirname, 'BOS_ISE_Assignments.xlsx');
const OVERRIDES_JSON = path.join(__dirname, 'ise-login-overrides.json');

const BOS_DISPLAY_TO_CSE = {
  Mohan:  'mohan',
  Bhuvan: 'bhuvan',
  Julie:  'julie.white',
  Vimal:  'vimal'
};

function autoDeriveLogin(display) {
  const parts = String(display).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 8).toLowerCase();
  return (parts[0].slice(0, 4) + parts[parts.length - 1].slice(0, 4)).toLowerCase();
}

function loadMatrix() {
  if (!fs.existsSync(MATRIX_XLSX)) {
    return { loginToBos: new Map(), displayToLogin: new Map(), unmappedDisplays: [], bosKnownInMatrix: new Set(), available: false };
  }
  const overrides = fs.existsSync(OVERRIDES_JSON) ? JSON.parse(fs.readFileSync(OVERRIDES_JSON, 'utf-8')) : {};
  const wb = XLSX.readFile(MATRIX_XLSX);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });

  const loginToBos = new Map();
  const displayToLogin = new Map();
  const unmappedDisplays = [];
  const bosKnownInMatrix = new Set();
  let currentBos = null;

  for (let i = 1; i < rows.length; i++) {
    const [bosCell, iseCell] = rows[i];
    const bosDisplay = String(bosCell || '').trim();
    const iseDisplay = String(iseCell || '').trim();
    if (bosDisplay) currentBos = bosDisplay;
    if (!iseDisplay || !currentBos) continue;

    const bosCse = BOS_DISPLAY_TO_CSE[currentBos] || currentBos.toLowerCase();
    bosKnownInMatrix.add(bosCse);

    const overrideLogin = Object.prototype.hasOwnProperty.call(overrides, iseDisplay) ? overrides[iseDisplay] : null;
    const login = overrideLogin !== null ? overrideLogin : autoDeriveLogin(iseDisplay);

    if (!login) {
      unmappedDisplays.push({ display: iseDisplay, bos: bosCse });
      continue;
    }
    loginToBos.set(login, bosCse);
    displayToLogin.set(iseDisplay, login);
  }

  return { loginToBos, displayToLogin, unmappedDisplays, bosKnownInMatrix, available: true };
}

function classifyLine(row, matrix) {
  if (!matrix.available) return { status: 'no-matrix' };
  const ise = String(row['Internal Salesperson'] || '').trim();
  const cseRaw = String(row['Customer CSE'] || '').trim();
  const cseNorm = cseRaw.toLowerCase();
  const expected = matrix.loginToBos.get(ise);

  if (!expected) return { status: 'orphan-ise', ise, actual: cseRaw };

  const cseUnassigned = !cseRaw || cseRaw === '.' || cseNorm === 'astute';
  if (cseUnassigned) return { status: 'unassigned-cse', ise, expected, actual: cseRaw };

  if (cseNorm !== expected) return { status: 'mismatch', ise, expected, actual: cseRaw };

  return { status: 'aligned' };
}

module.exports = { loadMatrix, classifyLine, BOS_DISPLAY_TO_CSE, autoDeriveLogin };

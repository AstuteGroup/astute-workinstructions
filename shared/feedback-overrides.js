/**
 * shared/feedback-overrides.js — small JSON store for operator-supplied
 * overrides that the offer pipeline reads on subsequent runs.
 *
 * This is the persistence layer between the reply-parser cog and the
 * offer-poller cog. The reply-parser reads operator emails, parses
 * structured commands (PARTNER/INTENT/SKIP), and writes overrides here.
 * The offer-poller reads them before processing each UID and applies them.
 *
 * Override shape (keyed by `account:uid` for partner overrides; by
 * `searchKey` for intent/skip overrides):
 *
 *   {
 *     "partner": {
 *       "excess:97": { bpId: 1000118, source: "user-reply", at: "2026-05-04T..." },
 *       ...
 *     },
 *     "intent": {
 *       "1024645": { intent: "spec-buy", source: "user-reply", at: "..." },
 *       ...
 *     },
 *     "skip": {
 *       "1024645": { reason: "user-reply", at: "..." },
 *       ...
 *     }
 *   }
 *
 * Overrides are consumed (deleted) by the poller once successfully applied.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.offer-pipeline');
const FILE = path.join(ROOT, 'feedback-overrides.json');

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

function loadAll() {
  if (!fs.existsSync(FILE)) return { partner: {}, intent: {}, skip: {}, lines: {}, ignore: {}, forceProcess: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      partner: obj.partner || {},
      intent: obj.intent || {},
      skip: obj.skip || {},
      lines: obj.lines || {},
      ignore: obj.ignore || {},
      forceProcess: obj.forceProcess || {},
    };
  } catch (e) {
    return { partner: {}, intent: {}, skip: {}, lines: {}, ignore: {}, forceProcess: {} };
  }
}

function saveAll(state) {
  ensureRoot();
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function setPartner(account, uid, bpId, source = 'user-reply') {
  const state = loadAll();
  state.partner[`${account}:${uid}`] = {
    bpId: Number(bpId),
    source,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getPartner(account, uid) {
  const state = loadAll();
  return state.partner[`${account}:${uid}`] || null;
}

function consumePartner(account, uid) {
  const state = loadAll();
  const key = `${account}:${uid}`;
  if (state.partner[key]) {
    delete state.partner[key];
    saveAll(state);
    return true;
  }
  return false;
}

function setIntent(searchKey, intent, source = 'user-reply') {
  const state = loadAll();
  state.intent[String(searchKey)] = {
    intent,
    source,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getIntent(searchKey) {
  const state = loadAll();
  return state.intent[String(searchKey)] || null;
}

function setSkip(searchKey, reason = 'user-reply') {
  const state = loadAll();
  state.skip[String(searchKey)] = {
    reason,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getSkip(searchKey) {
  const state = loadAll();
  return state.skip[String(searchKey)] || null;
}

function listAll() {
  return loadAll();
}

// ── Lines override (operator pasted line data in their reply) ─────────────

function setLines(account, uid, lines, source = 'user-reply') {
  const state = loadAll();
  state.lines[`${account}:${uid}`] = {
    lines: Array.isArray(lines) ? lines : [],
    source,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getLines(account, uid) {
  const state = loadAll();
  return state.lines[`${account}:${uid}`] || null;
}

function consumeLines(account, uid) {
  const state = loadAll();
  const key = `${account}:${uid}`;
  if (state.lines[key]) {
    delete state.lines[key];
    saveAll(state);
    return true;
  }
  return false;
}

// ── Ignore override (operator confirmed it's junk → NotOffer) ─────────────

function setIgnore(account, uid, source = 'user-reply') {
  const state = loadAll();
  state.ignore[`${account}:${uid}`] = {
    source,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getIgnore(account, uid) {
  const state = loadAll();
  return state.ignore[`${account}:${uid}`] || null;
}

function consumeIgnore(account, uid) {
  const state = loadAll();
  const key = `${account}:${uid}`;
  if (state.ignore[key]) {
    delete state.ignore[key];
    saveAll(state);
    return true;
  }
  return false;
}

// ── ForceProcess override (operator confirmed NOT junk → bypass classifier) ─

function setForceProcess(account, uid, source = 'user-reply') {
  const state = loadAll();
  state.forceProcess[`${account}:${uid}`] = {
    source,
    at: new Date().toISOString(),
  };
  saveAll(state);
}

function getForceProcess(account, uid) {
  const state = loadAll();
  return state.forceProcess[`${account}:${uid}`] || null;
}

function consumeForceProcess(account, uid) {
  const state = loadAll();
  const key = `${account}:${uid}`;
  if (state.forceProcess[key]) {
    delete state.forceProcess[key];
    saveAll(state);
    return true;
  }
  return false;
}

module.exports = {
  setPartner, getPartner, consumePartner,
  setIntent, getIntent,
  setSkip, getSkip,
  setLines, getLines, consumeLines,
  setIgnore, getIgnore, consumeIgnore,
  setForceProcess, getForceProcess, consumeForceProcess,
  listAll,
  FILE,
};

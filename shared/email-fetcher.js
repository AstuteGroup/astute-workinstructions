/**
 * Shared Email Fetcher
 *
 * Factory that creates an email fetcher bound to a WorkMail account.
 * Uses imapflow for direct IMAP access (no himalaya dependency).
 *
 * Usage:
 *   const { createFetcher } = require('../shared/email-fetcher');
 *   const fetcher = createFetcher('stockrfq');
 *   const envelopes = await fetcher.listEnvelopes('INBOX', 500);
 *   const body = await fetcher.readMessage(id);
 *
 * Credentials are loaded from ~/workspace/.env (centralized) with himalaya
 * config.toml as a legacy fallback. Required vars:
 *   WORKMAIL_PASS  — shared OT mailbox password
 *   IMAP_HOST      — default: imap.mail.us-east-1.awsapps.com
 *   IMAP_PORT      — default: 993
 *
 * Account-to-email mapping:
 *   vq       → vq@orangetsunami.com
 *   excess   → excess@orangetsunami.com
 *   stockrfq → stockRFQ@orangetsunami.com
 *   vortex   → vortex@orangetsunami.com
 */

const path = require('path');
// Load centralized credentials from ~/workspace/.env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const logger = require('./logger');

// Account name → email address mapping
const ACCOUNT_MAP = {
  vq: 'vq@orangetsunami.com',
  excess: 'excess@orangetsunami.com',
  stockrfq: 'stockRFQ@orangetsunami.com',
  vortex: 'vortex@orangetsunami.com',
  rfqloading: 'rfqloading@orangetsunami.com',
  brokeroffers: 'brokeroffers@orangetsunami.com',
  tracking: 'tracking@orangetsunami.com',
  lamkitting: 'lamkitting@orangetsunami.com',
};

const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

/**
 * Get the WorkMail password from env or himalaya config fallback
 */
function getPassword() {
  if (process.env.WORKMAIL_PASS) return process.env.WORKMAIL_PASS;
  if (process.env.SMTP_PASS) return process.env.SMTP_PASS;

  // Fallback: read from himalaya config if available
  try {
    const configPath = path.join(process.env.HOME, '.config', 'himalaya', 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/backend\.auth\.raw\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch (e) {
    // ignore
  }
  throw new Error('No WorkMail password found. Set WORKMAIL_PASS or SMTP_PASS env var.');
}

/**
 * Create an ImapFlow client for the given account
 */
function createClient(account, log) {
  const email = ACCOUNT_MAP[account.toLowerCase()];
  if (!email) throw new Error(`Unknown account: ${account}. Valid: ${Object.keys(ACCOUNT_MAP).join(', ')}`);

  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: email,
      pass: getPassword()
    },
    logger: false // suppress imapflow internal logging
  });
}

function createFetcher(account) {
  if (!account) throw new Error('email-fetcher: account is required');

  const log = logger.createLogger ? logger.createLogger(account) : logger;
  const email = ACCOUNT_MAP[account.toLowerCase()];
  if (!email) throw new Error(`Unknown account: ${account}`);

  /**
   * Run an operation with a connected IMAP client.
   * Handles connect/disconnect lifecycle automatically.
   */
  async function withClient(operation) {
    const client = createClient(account, log);
    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async function listEnvelopes(folder = 'INBOX', pageSize = 500) {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const envelopes = [];
          // Fetch the most recent pageSize messages
          const totalMessages = client.mailbox.exists;
          if (totalMessages === 0) return [];

          const startSeq = Math.max(1, totalMessages - pageSize + 1);
          const range = `${startSeq}:*`;

          for await (const msg of client.fetch(range, {
            envelope: true,
            flags: true,
            bodyStructure: true
          })) {
            const env = msg.envelope || {};
            const from = env.from && env.from[0] ? {
              name: env.from[0].name || '',
              addr: `${env.from[0].mailbox || ''}@${env.from[0].host || ''}`
            } : {};

            // Enumerate attachments in body structure (filename + content type + disposition)
            const attachments = enumerateAttachments(msg.bodyStructure);
            // "real" attachments: disposition=attachment AND has a filename AND not an inline image
            const realAttachments = attachments.filter(a =>
              a.disposition === 'attachment' &&
              a.filename &&
              !/^image\//i.test(a.contentType || '')
            );

            envelopes.push({
              id: msg.uid,
              seq: msg.seq,
              subject: env.subject || '',
              from: from,
              to: env.to || [],
              date: env.date ? env.date.toISOString() : '',
              flags: Array.from(msg.flags || []),
              hasAttachment: realAttachments.length > 0,
              attachments: realAttachments,              // [{filename, contentType, disposition}]
              attachmentNames: realAttachments.map(a => a.filename),
              inlineAttachmentCount: attachments.length - realAttachments.length
            });
          }
          return envelopes;
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error('Failed to list envelopes:', err.message);
      return [];
    }
  }

  async function readMessage(id, folder = 'INBOX') {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
          if (!msg || !msg.source) return '';

          const parsed = await simpleParser(msg.source);
          // Warn if message has attachments the caller may miss
          const realAtts = (parsed.attachments || []).filter(a =>
            a.filename && !/^image\//i.test(a.contentType || '')
          );
          if (realAtts.length > 0) {
            log.warn(`readMessage(${id}): ${realAtts.length} attachment(s) present — use downloadAttachments() to retrieve: ${realAtts.map(a=>a.filename).join(', ')}`);
          }
          return parsed.text || parsed.html || '';
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to read message ${id}:`, err.message);
      return '';
    }
  }

  async function getRawMessage(id, folder = 'INBOX') {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(String(id), {
            headers: ['from', 'to', 'cc', 'subject', 'date']
          }, { uid: true });
          if (!msg || !msg.headers) return '';
          // headers is a Buffer
          return msg.headers.toString();
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to read raw message ${id}:`, err.message);
      return '';
    }
  }

  async function verifyMessageGone(id, sourceFolder) {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(sourceFolder);
        try {
          // Try to fetch the UID — if it doesn't exist, it's gone
          try {
            const msg = await client.fetchOne(String(id), { uid: true }, { uid: true });
            return !msg; // if msg is null/undefined, it's gone
          } catch (e) {
            return true; // fetch failed = message gone
          }
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to verify message ${id} moved from ${sourceFolder}:`, err.message);
      return false;
    }
  }

  async function moveMessage(id, targetFolder = 'Processed', sourceFolder = 'INBOX') {
    try {
      return await withClient(async (client) => {
        // Ensure target folder exists
        try {
          await client.mailboxCreate(targetFolder);
        } catch (e) {
          // Ignore — folder already exists
        }

        const lock = await client.getMailboxLock(sourceFolder);
        try {
          await client.messageMove(String(id), targetFolder, { uid: true });
        } finally {
          lock.release();
        }

        const verified = await verifyMessageGone(id, sourceFolder);
        if (!verified) {
          log.error(`Move verification failed for message ${id} - still in ${sourceFolder}`);
          return false;
        }

        log.info(`Moved and verified message ${id} to ${targetFolder}`);
        return true;
      });
    } catch (err) {
      log.error(`Failed to move message ${id}:`, err.message);
      return false;
    }
  }

  async function listFolders() {
    try {
      return await withClient(async (client) => {
        const folders = await client.list();
        return folders.map(f => f.path || f.name);
      });
    } catch (err) {
      log.error('Failed to list folders:', err.message);
      return [];
    }
  }

  async function createFolder(name) {
    try {
      return await withClient(async (client) => {
        const folders = await client.list();
        const exists = folders.some(f => (f.path || f.name) === name);
        if (exists) {
          log.debug(`Folder "${name}" already exists`);
          return true;
        }
        await client.mailboxCreate(name);
        log.info(`Created folder: ${name}`);
        return true;
      });
    } catch (err) {
      log.debug(`Folder creation note for "${name}": ${err.message}`);
      return false;
    }
  }

  async function getMessageHeaders(id, folder = 'INBOX') {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(String(id), {
            envelope: true,
            flags: true
          }, { uid: true });
          if (!msg) return null;
          const env = msg.envelope || {};
          const from = env.from && env.from[0] ? {
            name: env.from[0].name || '',
            addr: `${env.from[0].mailbox || ''}@${env.from[0].host || ''}`
          } : {};
          return {
            id: msg.uid,
            subject: env.subject || '',
            from: from,
            date: env.date ? env.date.toISOString() : '',
            flags: Array.from(msg.flags || [])
          };
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to get headers for message ${id}:`, err.message);
      return null;
    }
  }

  async function markUnread(id, folder = 'INBOX') {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageFlagsRemove(String(id), ['\\Seen'], { uid: true });
          log.debug(`Marked message ${id} as unread`);
          return true;
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to mark message ${id} as unread:`, err.message);
      return false;
    }
  }

  /**
   * Download attachments from a message.
   * Returns array of { filename, content (Buffer), contentType, size }
   */
  async function downloadAttachments(id, folder = 'INBOX', outputDir = '.') {
    try {
      return await withClient(async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
          if (!msg || !msg.source) return [];

          const parsed = await simpleParser(msg.source);
          const results = [];

          for (const att of (parsed.attachments || [])) {
            const filename = att.filename || `attachment_${results.length}`;
            const outputPath = path.join(outputDir, filename);

            // Ensure output directory exists
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }

            fs.writeFileSync(outputPath, att.content);
            results.push({
              filename,
              path: outputPath,
              contentType: att.contentType,
              size: att.size || att.content.length
            });
            log.debug(`Saved attachment: ${outputPath} (${results[results.length - 1].size} bytes)`);
          }

          return results;
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      log.error(`Failed to download attachments for message ${id}:`, err.message);
      return [];
    }
  }

  return {
    account,
    listEnvelopes,
    readMessage,
    getRawMessage,
    verifyMessageGone,
    moveMessage,
    listFolders,
    createFolder,
    getMessageHeaders,
    markUnread,
    downloadAttachments
  };
}

/**
 * Check body structure for attachments
 */
function checkForAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some(child => checkForAttachments(child));
  }
  return false;
}

// Walk the BODYSTRUCTURE tree and collect every leaf part with an attachment-like signal.
// Returns [{filename, contentType, disposition, size}]
function enumerateAttachments(structure, out = []) {
  if (!structure) return out;
  if (structure.childNodes) {
    for (const child of structure.childNodes) enumerateAttachments(child, out);
    return out;
  }
  // Leaf part — capture if it's marked attachment or has an explicit filename
  const params = structure.parameters || {};
  const dispParams = structure.dispositionParameters || {};
  const filename = dispParams.filename || params.name || null;
  if (structure.disposition === 'attachment' || filename) {
    out.push({
      filename,
      contentType: structure.type && structure.subtype ? `${structure.type}/${structure.subtype}` : '',
      disposition: structure.disposition || 'inline',
      size: structure.size || 0
    });
  }
  return out;
}

module.exports = { createFetcher };

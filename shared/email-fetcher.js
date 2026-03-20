/**
 * Shared Email Fetcher
 *
 * Factory that creates an email fetcher bound to a himalaya account.
 * Wraps all himalaya email operations: list, read, move, folders.
 *
 * Usage:
 *   const { createFetcher } = require('../shared/email-fetcher');
 *   const fetcher = createFetcher('stockrfq');
 *   const envelopes = await fetcher.listEnvelopes('INBOX', 500);
 *   const body = await fetcher.readMessage(id);
 */

const { runHimalaya } = require('./himalaya-cli');
const logger = require('./logger');

function createFetcher(account) {
  if (!account) throw new Error('email-fetcher: account is required');

  const log = logger.createLogger ? logger.createLogger(account) : logger;

  async function listEnvelopes(folder = 'INBOX', pageSize = 500) {
    try {
      const args = ['envelope', 'list', '--account', account, '--folder', folder, '--page-size', String(pageSize)];
      const result = await runHimalaya(args);
      if (!result || !Array.isArray(result)) return [];
      return result.map(env => {
        const flags = env.flags || [];
        const hasAttachment = env.has_attachment ||
                             flags.includes('attachment') ||
                             flags.includes('@') ||
                             (typeof flags === 'string' && flags.includes('@'));
        return {
          id: env.id,
          subject: env.subject || '',
          from: env.from || {},
          to: env.to || {},
          date: env.date || '',
          flags: flags,
          hasAttachment
        };
      });
    } catch (err) {
      log.error('Failed to list envelopes:', err.message);
      return [];
    }
  }

  async function readMessage(id, folder = 'INBOX') {
    try {
      const args = ['message', 'read', '--account', account, '--folder', folder, String(id)];
      const result = await runHimalaya(args);
      return result || '';
    } catch (err) {
      log.error(`Failed to read message ${id}:`, err.message);
      return '';
    }
  }

  async function getRawMessage(id, folder = 'INBOX') {
    try {
      const args = ['message', 'read', '--account', account, '--folder', folder, '--header', 'from,to,cc,subject,date', String(id)];
      const result = await runHimalaya(args);
      return result || '';
    } catch (err) {
      log.error(`Failed to read raw message ${id}:`, err.message);
      return '';
    }
  }

  async function verifyMessageGone(id, sourceFolder) {
    try {
      const envelopes = await listEnvelopes(sourceFolder, 500);
      const stillExists = envelopes.some(e => String(e.id) === String(id));
      return !stillExists;
    } catch (err) {
      log.error(`Failed to verify message ${id} moved from ${sourceFolder}:`, err.message);
      return false;
    }
  }

  async function moveMessage(id, targetFolder = 'Processed', sourceFolder = 'INBOX') {
    try {
      const args = ['message', 'move', '--account', account, '--folder', sourceFolder, targetFolder, String(id)];
      await runHimalaya(args);

      const verified = await verifyMessageGone(id, sourceFolder);
      if (!verified) {
        log.error(`Move verification failed for message ${id} - still in ${sourceFolder}`);
        return false;
      }

      log.info(`Moved and verified message ${id} to ${targetFolder}`);
      return true;
    } catch (err) {
      log.error(`Failed to move message ${id}:`, err.message);
      return false;
    }
  }

  async function listFolders() {
    try {
      const args = ['folder', 'list', '--account', account];
      const result = await runHimalaya(args);
      if (!result || !Array.isArray(result)) return [];
      return result.map(f => f.name || f);
    } catch (err) {
      log.error('Failed to list folders:', err.message);
      return [];
    }
  }

  async function createFolder(name) {
    try {
      const folders = await listFolders();
      if (folders.includes(name)) {
        log.debug(`Folder "${name}" already exists`);
        return true;
      }

      const args = ['folder', 'create', '--account', account, name];
      await runHimalaya(args);
      log.info(`Created folder: ${name}`);
      return true;
    } catch (err) {
      log.debug(`Folder creation note for "${name}": ${err.message}`);
      return false;
    }
  }

  async function getMessageHeaders(id, folder = 'INBOX') {
    try {
      const args = ['envelope', 'list', '--account', account, '--folder', folder, '--page-size', '100'];
      const envelopes = await runHimalaya(args);
      if (!envelopes || !Array.isArray(envelopes)) return null;
      return envelopes.find(e => e.id === String(id)) || null;
    } catch (err) {
      log.error(`Failed to get headers for message ${id}:`, err.message);
      return null;
    }
  }

  async function markUnread(id, folder = 'INBOX') {
    try {
      const args = ['flag', 'remove', '--account', account, '--folder', folder, String(id), 'Seen'];
      await runHimalaya(args);
      log.debug(`Marked message ${id} as unread`);
      return true;
    } catch (err) {
      log.error(`Failed to mark message ${id} as unread:`, err.message);
      return false;
    }
  }

  async function downloadAttachments(id, folder = 'INBOX', outputDir = '.') {
    try {
      const args = ['attachment', 'download', '--account', account, '--folder', folder, String(id)];
      // himalaya downloads to current dir, so we'd need to handle outputDir
      const result = await runHimalaya(args);
      return result;
    } catch (err) {
      log.error(`Failed to download attachments for message ${id}:`, err.message);
      return null;
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

module.exports = { createFetcher };

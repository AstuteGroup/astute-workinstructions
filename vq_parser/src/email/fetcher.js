const { runHimalaya } = require('../utils/himalaya-cli');
const logger = require('../utils/logger');

const ACCOUNT = process.env.HIMALAYA_ACCOUNT || 'vq';

async function listEnvelopes(folder = 'INBOX', pageSize = 50) {
  try {
    const args = ['envelope', 'list', '--account', ACCOUNT, '--folder', folder, '--page-size', String(pageSize)];
    const result = await runHimalaya(args);
    if (!result || !Array.isArray(result)) return [];
    return result.map(env => {
      // Check for attachment flag in flags array (himalaya uses '@' for attachments)
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
    logger.error('Failed to list envelopes:', err.message);
    return [];
  }
}

async function readMessage(id, folder = 'INBOX') {
  try {
    // Get the full message content
    const args = ['message', 'read', '--account', ACCOUNT, '--folder', folder, String(id)];
    const result = await runHimalaya(args);
    return result || '';
  } catch (err) {
    logger.error(`Failed to read message ${id}:`, err.message);
    return '';
  }
}

async function getRawMessage(id, folder = 'INBOX') {
  try {
    const args = ['message', 'read', '--account', ACCOUNT, '--folder', folder, '--header', 'from,to,cc,subject,date', String(id)];
    const result = await runHimalaya(args);
    return result || '';
  } catch (err) {
    logger.error(`Failed to read raw message ${id}:`, err.message);
    return '';
  }
}

async function moveMessage(id, targetFolder = 'Processed', sourceFolder = 'INBOX') {
  try {
    const args = ['message', 'move', '--account', ACCOUNT, '--folder', sourceFolder, targetFolder, String(id)];
    await runHimalaya(args);
    logger.info(`Moved message ${id} to ${targetFolder}`);
    return true;
  } catch (err) {
    logger.error(`Failed to move message ${id}:`, err.message);
    return false;
  }
}

async function createFolder(name) {
  try {
    const args = ['folder', 'create', '--account', ACCOUNT, name];
    await runHimalaya(args);
    logger.info(`Created folder: ${name}`);
    return true;
  } catch (err) {
    // Folder may already exist
    logger.debug(`Folder creation note for "${name}": ${err.message}`);
    return false;
  }
}

async function getMessageHeaders(id, folder = 'INBOX') {
  try {
    // Use template to get headers
    const args = ['envelope', 'list', '--account', ACCOUNT, '--folder', folder, '--page-size', '100'];
    const envelopes = await runHimalaya(args);
    if (!envelopes || !Array.isArray(envelopes)) return null;
    return envelopes.find(e => e.id === String(id)) || null;
  } catch (err) {
    logger.error(`Failed to get headers for message ${id}:`, err.message);
    return null;
  }
}

async function markUnread(id, folder = 'INBOX') {
  try {
    const args = ['flag', 'remove', '--account', ACCOUNT, '--folder', folder, String(id), 'Seen'];
    await runHimalaya(args);
    logger.debug(`Marked message ${id} as unread`);
    return true;
  } catch (err) {
    logger.error(`Failed to mark message ${id} as unread:`, err.message);
    return false;
  }
}

module.exports = { listEnvelopes, readMessage, getRawMessage, moveMessage, createFolder, getMessageHeaders, markUnread };

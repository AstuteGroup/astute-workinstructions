/**
 * MFR Writer — creates and updates Manufacturer records via iDempiere REST API
 *
 * Creates new manufacturers in the chuboe_mfr table and updates their aliases.
 *
 * USAGE:
 *   const { writeMfr, updateMfrAlias } = require('../shared/mfr-writer');
 *
 *   // Create new manufacturer
 *   const result = await writeMfr({
 *     name: 'SHURE',
 *     url: 'https://www.shure.com/en-US',
 *     alias: 'Shure Incorporated',  // optional - goes in description field
 *   });
 *
 *   // result = {
 *   //   mfrId: 1021234,
 *   //   code: 'MFR1000XXX',
 *   //   name: 'SHURE',
 *   //   url: 'https://www.shure.com/en-US'
 *   // }
 *
 *   // Update alias/description with M code
 *   const updated = await updateMfrAlias({
 *     mfrId: 1021234,
 *     mCode: 'M12345',
 *     alias: 'Optional additional alias text',
 *   });
 *
 * VALIDATION:
 *   - name is required and must be non-empty
 *   - Checks for existing exact match on name (case-insensitive) before creating
 *   - Generates next MFR code (MFR1000XXX) automatically
 *
 * CONSUMERS:
 *   - MFR Check email workflow (mfr-batch-check.py reply handling)
 *   - Manual manufacturer creation
 */

const logger = require('./logger').createLogger('MFRWriter');
const { apiPost, apiGet, apiPut } = require('./api-client');
const { psqlQuery } = require('./db-helpers');

/**
 * Get the next available MFR code (Value field)
 * Pattern: MFR1000XXX where XXX increments
 */
async function getNextMfrCode() {
  // Query the highest existing MFR code
  const query = `
    SELECT value
    FROM adempiere.chuboe_mfr
    WHERE value LIKE 'MFR1%'
      AND isactive = 'Y'
    ORDER BY value DESC
    LIMIT 1;
  `;

  const rows = await psqlQuery(query);

  if (rows.length === 0) {
    return 'MFR1000001';
  }

  const lastCode = rows[0].value;
  // Extract the numeric part after 'MFR'
  const numPart = parseInt(lastCode.replace('MFR', ''), 10);
  const nextNum = numPart + 1;

  return `MFR${nextNum}`;
}

/**
 * Check if a manufacturer with this exact name already exists
 */
async function checkExistingMfr(name) {
  const query = `
    SELECT chuboe_mfr_id, name, value, url
    FROM adempiere.chuboe_mfr
    WHERE LOWER(name) = LOWER($1)
      AND isactive = 'Y'
    LIMIT 1;
  `;

  const rows = await psqlQuery(query, [name]);

  if (rows.length > 0) {
    return {
      exists: true,
      mfrId: rows[0].chuboe_mfr_id,
      name: rows[0].name,
      code: rows[0].value,
      url: rows[0].url,
    };
  }

  return { exists: false };
}

/**
 * Create a new manufacturer in OT
 *
 * @param {Object} opts
 * @param {string} opts.name - Manufacturer name (required)
 * @param {string} [opts.url] - Website URL
 * @param {string} [opts.alias] - Alias/notes (stored in description field)
 * @returns {Object} { mfrId, code, name, url, created: true } or { mfrId, code, name, url, created: false } if already exists
 */
async function writeMfr(opts) {
  const { name, url, alias } = opts;

  // Validate required fields
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('MFR Writer: name is required and must be non-empty');
  }

  const cleanName = name.trim();
  const cleanUrl = url?.trim() || null;
  const cleanAlias = alias?.trim() || null;

  logger.info(`Creating manufacturer: ${cleanName}`);

  // Check if already exists
  const existing = await checkExistingMfr(cleanName);
  if (existing.exists) {
    logger.info(`Manufacturer already exists: ${existing.name} (ID: ${existing.mfrId}, Code: ${existing.code})`);
    return {
      mfrId: existing.mfrId,
      code: existing.code,
      name: existing.name,
      url: existing.url,
      created: false,
      message: 'Manufacturer already exists',
    };
  }

  // Get next code
  const code = await getNextMfrCode();
  logger.info(`Assigned code: ${code}`);

  // Build payload
  // Per api-writeback.md, server auto-populates: AD_Client_ID, AD_Org_ID, IsActive, Created/Updated/By
  const payload = {
    Name: cleanName,
    Value: code,
  };

  if (cleanUrl) {
    payload.URL = cleanUrl;
  }

  if (cleanAlias) {
    payload.Description = cleanAlias;
  }

  // POST to API
  const response = await apiPost('chuboe_mfr', payload);

  const result = {
    mfrId: response.id,
    code: response.Value || code,
    name: response.Name || cleanName,
    url: response.URL || cleanUrl,
    created: true,
  };

  logger.info(`Created manufacturer: ${result.name} (ID: ${result.mfrId}, Code: ${result.code})`);

  return result;
}

/**
 * Get manufacturer by ID
 */
async function getMfrById(mfrId) {
  const query = `
    SELECT chuboe_mfr_id, name, value, url, description
    FROM adempiere.chuboe_mfr
    WHERE chuboe_mfr_id = $1
      AND isactive = 'Y'
    LIMIT 1;
  `;

  const rows = await psqlQuery(query, [mfrId]);

  if (rows.length === 0) {
    return null;
  }

  return {
    mfrId: rows[0].chuboe_mfr_id,
    name: rows[0].name,
    code: rows[0].value,
    url: rows[0].url,
    description: rows[0].description,
  };
}

/**
 * Update manufacturer's description/alias field with M code
 *
 * The description field format is: "M12345 - Alias text, Other alias"
 *
 * @param {Object} opts
 * @param {number} opts.mfrId - Manufacturer ID (required)
 * @param {string} opts.mCode - M code to add (e.g., "M12345") (required)
 * @param {string} [opts.alias] - Additional alias text to append
 * @returns {Object} { mfrId, code, name, description, updated: true }
 */
async function updateMfrAlias(opts) {
  const { mfrId, mCode, alias } = opts;

  // Validate required fields
  if (!mfrId) {
    throw new Error('MFR Writer: mfrId is required');
  }
  if (!mCode || typeof mCode !== 'string' || mCode.trim().length === 0) {
    throw new Error('MFR Writer: mCode is required and must be non-empty');
  }

  const cleanMCode = mCode.trim().toUpperCase();
  const cleanAlias = alias?.trim() || null;

  // Validate M code format (M followed by digits)
  if (!/^M\d+$/.test(cleanMCode)) {
    throw new Error(`MFR Writer: Invalid M code format "${cleanMCode}". Expected format: M12345`);
  }

  logger.info(`Updating manufacturer ${mfrId} with M code: ${cleanMCode}`);

  // Get current manufacturer data
  const mfr = await getMfrById(mfrId);
  if (!mfr) {
    throw new Error(`MFR Writer: Manufacturer ID ${mfrId} not found`);
  }

  // Build new description
  // Format: "M12345 - alias1, alias2" or just "M12345" if no alias
  let newDescription;
  if (cleanAlias) {
    newDescription = `${cleanMCode} - ${cleanAlias}`;
  } else {
    newDescription = cleanMCode;
  }

  // If there's existing description, append to it (unless it already has this M code)
  if (mfr.description) {
    if (mfr.description.includes(cleanMCode)) {
      logger.info(`M code ${cleanMCode} already in description, skipping update`);
      return {
        mfrId: mfr.mfrId,
        code: mfr.code,
        name: mfr.name,
        description: mfr.description,
        updated: false,
        message: 'M code already exists in description',
      };
    }
    // Prepend the new M code to existing description
    newDescription = `${cleanMCode} - ${mfr.description}`;
  }

  // PUT to API
  const payload = {
    Description: newDescription,
  };

  await apiPut('chuboe_mfr', mfrId, payload);

  const result = {
    mfrId: mfr.mfrId,
    code: mfr.code,
    name: mfr.name,
    description: newDescription,
    updated: true,
  };

  logger.info(`Updated manufacturer ${mfr.name} (ID: ${mfrId}) with description: ${newDescription}`);

  return result;
}

module.exports = {
  writeMfr,
  updateMfrAlias,
  checkExistingMfr,
  getNextMfrCode,
  getMfrById,
};

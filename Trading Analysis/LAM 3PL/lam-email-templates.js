/**
 * LAM 3PL Email Templates
 *
 * Standardized email formatting for all LAM workflows.
 * Single source of truth for email content.
 *
 * Usage:
 *   const { formatEmail } = require('./lam-email-templates');
 *   const { subject, body } = formatEmail('reorder', {
 *     date: '2026-07-30',
 *     mode: 'refresh',
 *     stats: { total: 193, critical: 65, pendingReceipt: 120 }
 *   });
 */

const { createNotifier } = require('../../shared/notifier');

// ─── EMAIL CONFIGURATION ─────────────────────────────────────────────────────

const EMAIL_CONFIG = {
  from: 'lamkitting@orangetsunami.com',
  fromName: 'LAM 3PL',
  defaultTo: 'jake.harris@astutegroup.com,josh.syre@astutegroup.com'
};

// ─── REPORT TYPES ────────────────────────────────────────────────────────────

const REPORT_TYPES = {
  reorder: {
    name: 'Reorder Report',
    modes: {
      refresh: 'Data refreshed from OT (no API sourcing)',
      source: 'Includes franchise API pricing',
      full: 'Full weekly run: OT data + franchise API pricing',
      excel: 'Excel reformatted from existing data'
    }
  },
  newLinesApprovals: {
    name: 'New Lines / Approvals',
    modes: {
      newParts: 'New parts added to roster',
      approval: 'Customer approval received - ready for PO',
      update: 'Updates to existing roster lines',
      default: 'New roster lines or approved changes'
    }
  },
  escalations: {
    name: 'Escalations Report',
    modes: {
      default: 'Parts requiring customer approval'
    }
  },
  removal: {
    name: 'Roster Removal Notice',
    modes: {
      default: 'Parts removed from roster - acknowledgement required'
    }
  },
  otUnavailable: {
    name: 'OT Database Unavailable',
    modes: {
      default: 'LAM Kitting refresh failed - OT database could not be reached'
    }
  }
};

// ─── FORMATTERS ──────────────────────────────────────────────────────────────

function formatStats(stats) {
  if (!stats) return '';

  const lines = [];

  if (stats.total !== undefined) {
    lines.push(`Total items: ${stats.total}`);
  }

  // Bucket breakdown (New Lines / Approvals)
  if (stats.order !== undefined || stats.review !== undefined || stats.noAction !== undefined) {
    lines.push('');
    lines.push('Action Required:');
    if (stats.order !== undefined) lines.push(`  Order (place PO): ${stats.order}`);
    if (stats.review !== undefined) lines.push(`  Review (verify first): ${stats.review}`);
    if (stats.noAction !== undefined) lines.push(`  No Action (stock OK): ${stats.noAction}`);
  }

  // Priority breakdown (Reorder Report)
  const priorities = [];
  if (stats.critical) priorities.push(`Critical: ${stats.critical}`);
  if (stats.pendingReceipt) priorities.push(`Pending Receipt: ${stats.pendingReceipt}`);
  if (stats.pendingOrder) priorities.push(`Pending Order: ${stats.pendingOrder}`);
  if (stats.high) priorities.push(`High: ${stats.high}`);
  if (stats.medium) priorities.push(`Medium: ${stats.medium}`);
  if (stats.low) priorities.push(`Low: ${stats.low}`);

  if (priorities.length > 0) {
    lines.push('');
    lines.push('Breakdown:');
    priorities.forEach(p => lines.push(`  ${p}`));
  }

  // Sourcing stats
  if (stats.sourced !== undefined || stats.noCoverage !== undefined) {
    lines.push('');
    lines.push('Sourcing:');
    if (stats.sourced !== undefined) lines.push(`  Sourced: ${stats.sourced}`);
    if (stats.noCoverage !== undefined) lines.push(`  No Coverage: ${stats.noCoverage}`);
    if (stats.restricted !== undefined) lines.push(`  Restricted MFR: ${stats.restricted}`);
  }

  // Removal stats
  if (stats.removed !== undefined) {
    lines.push('');
    lines.push(`Parts removed from roster: ${stats.removed}`);
    lines.push('');
    lines.push('ACTION REQUIRED: Please review and acknowledge this removal.');
  }

  // Addition stats
  if (stats.added !== undefined) {
    lines.push('');
    lines.push(`New parts added: ${stats.added}`);
  }

  return lines.join('\n');
}

function formatAuditTrail(auditTrail) {
  if (!auditTrail) return '';

  const lines = ['', 'Data Sources:'];

  if (auditTrail.inventoryDate) {
    lines.push(`  Inventory: ${auditTrail.inventoryDate} (weekly cache)`);
  }

  if (auditTrail.apiCacheDate) {
    lines.push(`  API Pricing: ${auditTrail.apiCacheDate} (cached)`);
  }

  if (auditTrail.otPullTimestamp) {
    lines.push(`  OT Data: ${auditTrail.otPullTimestamp} (live)`);
  }

  // Add staleness warnings
  if (auditTrail.inventoryAgeDays && auditTrail.inventoryAgeDays > 7) {
    lines.push('');
    lines.push(`  WARNING: Inventory cache is ${auditTrail.inventoryAgeDays} days old`);
  }

  return lines.join('\n');
}

function formatEmail(reportType, opts = {}) {
  const { date, mode = 'default', stats, notes, auditTrail } = opts;

  const report = REPORT_TYPES[reportType];
  if (!report) {
    throw new Error(`Unknown report type: ${reportType}`);
  }

  const modeDesc = report.modes[mode] || report.modes.default || '';

  // Subject
  const modeLabel = mode !== 'default' && mode !== 'refresh' ? ` (${capitalize(mode)})` : '';
  const subject = `LAM 3PL ${report.name}${modeLabel} - ${date}`;

  // Body
  const bodyParts = [
    `LAM 3PL ${report.name} - ${date}`,
    '',
    modeDesc
  ];

  // Audit trail (data sources) - always include first for visibility
  const auditTrailText = formatAuditTrail(auditTrail);
  if (auditTrailText) {
    bodyParts.push(auditTrailText);
  }

  const statsText = formatStats(stats);
  if (statsText) {
    bodyParts.push('');
    bodyParts.push(statsText);
  }

  if (notes) {
    bodyParts.push('');
    bodyParts.push('Notes:');
    bodyParts.push(notes);
  }

  return {
    subject,
    body: bodyParts.join('\n')
  };
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── SEND HELPER ─────────────────────────────────────────────────────────────

async function sendLamEmail(reportType, opts = {}) {
  const { date, mode, stats, notes, attachments = [], to, auditTrail } = opts;

  const { subject, body } = formatEmail(reportType, { date, mode, stats, notes, auditTrail });

  const notifier = createNotifier({
    fromEmail: EMAIL_CONFIG.from,
    fromName: EMAIL_CONFIG.fromName
  });

  const recipients = to || process.env.NOTIFY_EMAIL || EMAIL_CONFIG.defaultTo;

  if (attachments.length > 0) {
    await notifier.sendWithAttachment(recipients, subject, body, attachments);
  } else {
    await notifier.sendEmail(recipients, subject, body);
  }

  return { subject, to: recipients };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  EMAIL_CONFIG,
  REPORT_TYPES,
  formatEmail,
  formatStats,
  formatAuditTrail,
  sendLamEmail
};

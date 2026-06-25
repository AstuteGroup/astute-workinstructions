/**
 * shared/loader-patterns.js
 *
 * Reusable patterns for email-driven loaders. Extracted from the VQ loader
 * (reference implementation) to ensure all loaders handle edge cases consistently.
 *
 * See loader-changelog.md for cross-applicability rules.
 */

'use strict';

// ─── API ERROR CLASSIFICATION ─────────────────────────────────────────────────
// Distinguish transient errors (retry-eligible) from permanent errors (fail immediately).

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
];

/**
 * Classify an API error as transient (retry-eligible) or permanent.
 *
 * @param {Error|object} error - The error from an API call
 * @returns {{ transient: boolean, reason: string, statusCode?: number }}
 */
function classifyApiError(error) {
  if (!error) {
    return { transient: false, reason: 'unknown (no error)' };
  }

  // Check HTTP status code if available
  const statusCode = error.statusCode || error.status || (error.response && error.response.status);
  if (statusCode) {
    if (TRANSIENT_STATUS_CODES.has(statusCode)) {
      return { transient: true, reason: `HTTP ${statusCode}`, statusCode };
    }
    if (statusCode >= 400 && statusCode < 500) {
      // 4xx = client error = permanent (bad request, unauthorized, not found, etc.)
      return { transient: false, reason: `HTTP ${statusCode} (client error)`, statusCode };
    }
  }

  // Check error message patterns
  const msg = String(error.message || error);
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return { transient: true, reason: `pattern match: ${pattern.source}`, statusCode };
    }
  }

  // Default: assume permanent (safer to fail than retry indefinitely)
  return { transient: false, reason: 'unrecognized error pattern', statusCode };
}

// ─── RETRY WITH EXPONENTIAL BACKOFF ───────────────────────────────────────────

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param {function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3] - Maximum number of attempts
 * @param {number} [opts.baseDelayMs=1000] - Base delay between retries (doubled each attempt)
 * @param {number} [opts.maxDelayMs=30000] - Maximum delay cap
 * @param {function} [opts.shouldRetry] - Custom function(error) => boolean. If provided,
 *                                         overrides classifyApiError for retry decision.
 * @param {function} [opts.onRetry] - Callback(attempt, error, delayMs) before each retry
 * @returns {Promise<any>} - Result from fn, or throws if all attempts fail
 */
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry,
    onRetry,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Decide whether to retry
      const doRetry = shouldRetry
        ? shouldRetry(error)
        : classifyApiError(error).transient;

      if (!doRetry || attempt === maxAttempts) {
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const expDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.2 * expDelay; // ±10% jitter
      const delayMs = Math.min(expDelay + jitter, maxDelayMs);

      if (onRetry) {
        onRetry(attempt, error, delayMs);
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Retry wrapper specifically for line-level writes in loaders.
 * Wraps a single line write operation with retry logic.
 *
 * @param {function} writeFn - Async function that writes a single line
 * @param {object} [opts] - Same options as withRetry, plus:
 * @param {string} [opts.lineLabel] - Label for logging (e.g., "line 5", "MPN ABC123")
 * @returns {Promise<any>}
 */
async function retryLine(writeFn, opts = {}) {
  const { lineLabel, ...retryOpts } = opts;
  return withRetry(writeFn, {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    onRetry: (attempt, error, delayMs) => {
      const label = lineLabel || 'line';
      console.error(`[loader-patterns] Retry ${attempt} for ${label}: ${error.message} (waiting ${Math.round(delayMs)}ms)`);
    },
    ...retryOpts,
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyApiError,
  withRetry,
  retryLine,
  // Re-export failure-rate-gate for convenience (already a separate module)
  // Usage: const { evaluateFailureRate, notifyHighFailureRate } = require('./failure-rate-gate');
};

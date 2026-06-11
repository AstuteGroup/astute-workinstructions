/**
 * shared/ot-error.js
 *
 * Single source of truth for "was this write failure caused by OT being
 * unreachable (infrastructure) vs a genuine logical rejection (bad data)?"
 *
 * Why this exists
 * ---------------
 * Before 2026-05-26, every writer flattened ALL apiPost exceptions into one
 * reason code (`API_WRITE_ERROR` for bucket writers, a bare error string for
 * count-style writers). When the OT REST API went unreachable mid-batch
 * (network timeout / fetch failed / ECONNREFUSED), the failure-rate-gate
 * counted those timeouts as "data failures" and fired a red
 * "investigate vendor resolution" alarm — a false alarm. See the 2026-05-26
 * UID 8655 incident: 13 "resolver gaps" + 7 "failed" on RFQ 1133119 were all
 * OT going down, not bad vendors.
 *
 * `shared/api-client.js` already stamps `err.isNetworkError = true` on
 * transport failures after exhausting its retry budget (see its request()
 * catch block). This module reads that flag, with a defensive message-regex
 * fallback for the few paths that rethrow an error without the flag (e.g. the
 * verify-after-error path, or a 5xx surfaced as a generic Error).
 *
 * Used by all five writers (vq / cq / rfq / offer / load-bulk-summary) so the
 * gate, the notifier, and the resumer all agree on one reason code.
 */

'use strict';

/** Canonical reason code stamped on failed rows caused by OT being down. */
const OT_UNREACHABLE = 'OT_UNREACHABLE';

// Transport-level signatures that mean "couldn't reach OT", as opposed to an
// HTTP response carrying a logical rejection. Kept deliberately broad — a
// false positive here just defers a retryable row instead of alarming; a
// false negative re-introduces the original false-alarm bug.
const NETWORK_MSG_RE = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|network error|network timeout|UND_ERR|aborted|timeout after/i;

/**
 * @param {Error|null|undefined} e
 * @returns {boolean} true when the error is an OT-unreachable transport failure
 */
function isOtUnreachableError(e) {
  if (!e) return false;
  if (e.isNetworkError) return true;            // set by api-client.js
  if (e.cause && e.cause.isNetworkError) return true;
  return NETWORK_MSG_RE.test(String(e.message || ''));
}

/**
 * Classify a thrown write error into a reason code + network flag.
 *
 * @param {Error} e               the caught error
 * @param {string} logicalReason  the reason code to use when it's NOT a
 *                                network failure (e.g. 'API_WRITE_ERROR')
 * @returns {{ reason: string, network: boolean }}
 */
function classifyWriteError(e, logicalReason) {
  const network = isOtUnreachableError(e);
  return { reason: network ? OT_UNREACHABLE : logicalReason, network };
}

module.exports = { OT_UNREACHABLE, isOtUnreachableError, classifyWriteError };

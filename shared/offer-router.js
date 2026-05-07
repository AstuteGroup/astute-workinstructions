/**
 * shared/offer-router.js — type-driven dispatch from offer-poller to downstream cogs.
 *
 * Reads the offer's `chuboe_offer_type_id` (passed in as `offerType`, either
 * the numeric ID or the canonical name from `OFFER_TYPES` in offer-writeback.js)
 * and routes to one of three handlers:
 *
 *   Customer Excess (1000000)        → Customer Excess Analysis
 *   Customer Lead Time Buy (1000003) → Customer Excess Analysis
 *   Broker Stock Offer (1000001)     → broker data-capture (breadcrumb only)
 *   Franchise Offers (1000002)       → franchise data-capture (breadcrumb only)
 *   anything else                    → unrouted breadcrumb (warning)
 *
 * Each handler writes its own breadcrumb so the digest builder can render
 * "which path did this offer take, and why."
 */

'use strict';

const path = require('path');
const breadcrumbs = require('./breadcrumbs');

// Offer type ID → analysis route mapping
const TYPE_ID_TO_ROUTE = {
  1000000: { name: 'Customer Excess',         route: 'customer-excess-analysis' },
  1000001: { name: 'Broker Stock Offer',      route: 'broker-data-capture' },
  1000002: { name: 'Franchise Offers',        route: 'franchise-data-capture' },
  1000003: { name: 'Customer Lead Time Buy',  route: 'customer-excess-analysis' },
};

// Type name → ID (mirrors OFFER_TYPES from offer-writeback.js for the four
// inbox-fed types — keep in sync if the loader recognizes more)
const TYPE_NAME_TO_ID = {
  'Customer Excess': 1000000,
  'Broker Stock Offer': 1000001,
  'Franchise Offers': 1000002,
  'Customer Lead Time Buy': 1000003,
};

function resolveTypeId(offerType) {
  if (typeof offerType === 'number') return offerType;
  if (typeof offerType === 'string') {
    if (TYPE_NAME_TO_ID[offerType] != null) return TYPE_NAME_TO_ID[offerType];
    const n = Number(offerType);
    if (!isNaN(n)) return n;
  }
  return null;
}

/**
 * Dispatch an offer to its downstream handler. Idempotent — safe to call
 * multiple times on the same offerId (each handler writes its own breadcrumb,
 * downstream cogs are themselves idempotent).
 *
 * @param {object} ctx
 *   ctx.offerId    chuboe_offer_id (number) — required
 *   ctx.searchKey  chuboe_offer.value (string) — required
 *   ctx.offerType  type ID or canonical name — required
 *   ctx.partner    { id, name } — optional, for breadcrumb readability
 *   ctx.lineCount  number — optional
 *   ctx.source     who invoked us (e.g., 'offer-poller', 'manual-replay')
 */
async function dispatch(ctx) {
  if (!ctx || !ctx.offerId) throw new Error('offer-router.dispatch: ctx.offerId required');
  const typeId = resolveTypeId(ctx.offerType);
  const mapping = typeId != null ? TYPE_ID_TO_ROUTE[typeId] : null;

  if (!mapping) {
    breadcrumbs.write({
      cog: 'offer-router', event: 'unrouted',
      offerId: ctx.offerId, searchKey: ctx.searchKey,
      offerType: ctx.offerType, typeId,
      reason: 'no-route-for-type',
    });
    return { route: null, status: 'unrouted' };
  }

  // Always log the routing decision first — even if the downstream cog throws,
  // we want the digest to show which path WAS chosen.
  breadcrumbs.write({
    cog: 'offer-router', event: 'routed',
    offerId: ctx.offerId, searchKey: ctx.searchKey,
    offerType: mapping.name, typeId,
    route: mapping.route,
    rule: `type_id=${typeId} (${mapping.name}) → ${mapping.route}`,
    partner: ctx.partner,
    lineCount: ctx.lineCount,
    source: ctx.source,
  });

  // Invoke the downstream handler. Each is loaded lazily so a missing one
  // doesn't break the router for the others.
  try {
    if (mapping.route === 'customer-excess-analysis') {
      const { analyzeOffer } = require(path.resolve(__dirname, '../Trading Analysis/Customer Excess Analysis/analyze-offer'));
      return await analyzeOffer({ offerId: ctx.offerId, searchKey: ctx.searchKey, source: 'router' });
    }
    if (mapping.route === 'broker-data-capture') {
      breadcrumbs.write({
        cog: 'broker-data-capture', event: 'captured',
        offerId: ctx.offerId, searchKey: ctx.searchKey,
        partner: ctx.partner, lineCount: ctx.lineCount,
        note: 'data-capture only; no analysis or downstream action',
      });
      return { route: 'broker-data-capture', status: 'captured' };
    }
    if (mapping.route === 'franchise-data-capture') {
      breadcrumbs.write({
        cog: 'franchise-data-capture', event: 'captured',
        offerId: ctx.offerId, searchKey: ctx.searchKey,
        partner: ctx.partner, lineCount: ctx.lineCount,
        note: 'data-capture only; no analysis or downstream action',
      });
      return { route: 'franchise-data-capture', status: 'captured' };
    }
  } catch (err) {
    breadcrumbs.write({
      cog: 'offer-router', event: 'downstream-failed',
      offerId: ctx.offerId, searchKey: ctx.searchKey,
      route: mapping.route, error: err.message,
    });
    throw err;
  }
}

module.exports = { dispatch, TYPE_ID_TO_ROUTE, resolveTypeId };

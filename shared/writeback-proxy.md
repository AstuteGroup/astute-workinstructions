# Writeback Proxy

Single source of truth for how non-credentialed users (anyone other than `analytics_user`) trigger iDempiere writebacks.

**Code:** `/opt/writeback/cli` (privileged proxy), `shared/writeback-proxy-client.js` (drop-in JS shim)
**Audit log:** `/opt/writeback/audit/YYYY-MM.log` (readable only by `analytics_user`)

---

## TL;DR

If your session is running as `analytics_user`, keep doing what the existing writer modules already do (`require('../shared/rfq-writer')` etc.) — nothing changes.

If your session is running as any other user, you have no iDempiere credentials. To write to OT, route through the proxy:

```javascript
// Recommended: same surface as the original writers
const { writeRFQ, writeOffer, writeCQBatch /* ... */ } =
  require('../shared/writeback-proxy-client');

const result = await writeRFQ({ bpartnerId: 1000190, type: 'Stock', ... });
```

Or, from the shell:

```bash
echo '{"opts":{"bpartnerId":1000190,"type":"Stock","userId":1000004,"lines":[...]}}' \
  | sudo -n -u analytics_user /opt/writeback/cli rfq
```

---

## Why this exists

iDempiere credentials (`IDEMPIERE_USERNAME`, `IDEMPIERE_PASSWORD`, etc.) live in `/home/analytics_user/workspace/.env`, mode 600, inside a home directory whose mode is 700. Only `analytics_user` and root can read them.

This is deliberate: writes to production OT should go through a controlled path. The proxy lets other users trigger **a fixed set of writer functions** under the analytics_user identity, without ever holding the credentials themselves. Every call is audited.

## Trust model

| Concern | Mitigation |
|---|---|
| Other users reading credentials | `/home/analytics_user/` is 700; `.env` is 600. Filesystem-enforced. |
| Other users running arbitrary writer code as analytics_user | Sudoers only permits `/opt/writeback/cli` (exact path). That CLI's dispatch table is an allowlist of writer entry points. |
| Other users invoking writers outside the allowlist (e.g. `record-updater.patchRecord`) | Not exposed by the CLI. There is no other path: the user has no credentials of their own. |
| Server-side enforcement (defense in depth) | iDempiere role permissions still apply to whichever account analytics_user authenticates as. |
| Auditability | Every CLI invocation appends a JSONL line with caller (`SUDO_USER`), subcommand, payload shape (not values), and result status. |
| Sensitive payload data in logs | The audit log records only top-level key names + value shapes (e.g. `"lines": "array(42)"`), never the actual customer / cost / part-number values. |

## Allowed operations

The proxy exposes exactly these writer entry points:

| Subcommand | Writer | Required JSON keys on stdin | Source module |
|---|---|---|---|
| `rfq` | `writeRFQ(opts)` | `opts` | `shared/rfq-writer.js` |
| `offer` | `writeOffer(opts)` | `opts` | `shared/offer-writeback.js` |
| `offer-batch` | `writeOffers(offers)` | `offers` | `shared/offer-writeback.js` |
| `cq` | `writeCQ(rfqSearchKey, line, opts?)` | `rfqSearchKey`, `line` | `shared/cq-writer.js` |
| `cq-batch` | `writeCQBatch(rfqSearchKey, lines, opts?)` | `rfqSearchKey`, `lines` | `shared/cq-writer.js` |
| `vq-batch` | `writeVQBatch(rfqSearchKey, items, opts?)` | `rfqSearchKey`, `items` | `shared/vq-writer.js` |
| `vq-reviewed` | `writeReviewedItems(rfqSearchKey, reviewedItems, opts?)` | `rfqSearchKey`, `reviewedItems` | `shared/vq-writer.js` |
| `pricing` | `writePricingResult(opts)` | `opts` | `shared/api-result-writer.js` |
| `tick-vq` | `tickVQForPurchase(vqId, opts?)` | `vqId` | `shared/vq-patcher.js` |
| `approve-order` | `postApproveOrder(opts)` | `opts` | `shared/r-request-writer.js` |
| `mark-cq-sold` | `markCQSold(cqId, opts?)` | `cqId` | `shared/cq-patcher.js` |
| `validate-vq-purchase` | `validateVQForPurchase(vqId, opts?)` | `vqId` | `shared/vq-purchase-validator.js` |
| `validate-cq-sold` | `validateCQForSold(cqId, opts?)` | `cqId` | `shared/cq-sold-validator.js` |

The two `validate-*` subcommands are read-mostly (they hit `apiGet`) and are exposed so non-credentialed sessions can run dry-run diagnostics before asking the user to approve a write.

## Explicitly NOT exposed

The following writer paths exist in `shared/` but are intentionally **not** reachable through the proxy. If your task seems to need one, stop and discuss with the user rather than working around:

| Function | Why it's off-limits |
|---|---|
| `record-updater.patchRecord(table, id, payload)` | Generic PATCH on any chuboe_* table. Wide blast radius — any field on any row. |
| `record-updater.patchBatch(...)` | Same, batched. |
| `offer-writeback.deactivatePriorOffers(...)` | Bulk deactivation by `(bpartnerId, offerTypeId)`. Easy to deactivate more than intended; the function's own header docstring warns about this. |
| `offer-writeback.deactivateOfferById(...)` | Single deactivation, still bypasses the normal write flow. |
| `rfq-fast-loader.loadRFQ(...)` | Alternate RFQ path. |
| `api-result-writer.flushCacheToDB()` | Bulk-flushes the local pricing cache. |
| Direct `apiPost` / `apiPut` / `apiDelete` / `apiBatch` on any table | Bypasses every per-writer validation (vq-purchase-validator, cq-sold-validator, dedup checks, disqualified-vendor checks, bean-callout mitigations). |

To opt one in, edit `/opt/writeback/cli.js` (`SUBCOMMANDS`) and `shared/writeback-proxy-client.js` (`DISPATCH`).

## Behavior of the client shim

`shared/writeback-proxy-client.js` is identity-aware:

- **Running as `analytics_user`** — `require`s the original writer module and calls it directly. No subprocess, no sudo. Same performance as before.
- **Running as anyone else** — spawns `sudo -n -u analytics_user /opt/writeback/cli <subcommand>` with a JSON-stringified payload on stdin, parses the JSON response, returns the `result` field. Throws on non-zero exit with the writer/CLI error message.

This means the same `require('../shared/writeback-proxy-client')` line works in every session — there is no per-user branching at call sites.

## Direct CLI invocation (for shell scripts / debugging)

```bash
# Help
sudo -n -u analytics_user /opt/writeback/cli --help

# Run a writer (JSON on stdin)
echo '{"rfqSearchKey":"1124042","line":{"mpn":"ADS1115IDGST","qty":500,"resale":5.25}}' \
  | sudo -n -u analytics_user /opt/writeback/cli cq

# Output (success): { "ok": true, "result": <writer return value> }  exit 0
# Output (writer error):  Writer error: <msg>  exit 1
# Output (validation):    Missing required field(s) ...  exit 2
# Output (loader error):  Loader error: ...  exit 3
```

## Audit log

`/opt/writeback/audit/YYYY-MM.log` — JSONL, one event per line, readable only by `analytics_user`. Records:

- `started` — caller, subcommand, payload shape (top-level keys + value types/lengths)
- `ok` — same plus duration
- `error` — same plus the failure stage (`parse` | `validate` | `chdir` | `load` | `writer`) and the writer's stack trace if applicable

To inspect:

```bash
sudo -u analytics_user tail -50 /opt/writeback/audit/$(date +%Y-%m).log | jq .
```

## Limitations

- **The proxy constrains operation type, not content.** Within an allowed writer, the caller can pass any options that writer accepts. Each writer applies its own input validation (some are strict — see `vq-purchase-validator.js`; others are looser). If you need content-level constraints (e.g. "user X may only write CQs for customer Y"), add them in `/opt/writeback/cli.js` after the dispatch lookup.
- **No request-level rate limiting.** A misbehaving caller can flood the CLI. Per-call delays inside `cq-writer` / `vq-writer` apply, but the proxy itself doesn't queue or throttle.
- **Stderr noise.** The writers' transitive `require('dotenv').config(...)` prints a one-line banner on stderr each invocation. Harmless; can be silenced by setting `DOTENV_CONFIG_QUIET=true` in the `/opt/writeback/cli` wrapper.

## When to update this doc

Touch this file whenever you:
- Add or remove a subcommand in `/opt/writeback/cli.js`
- Change the sudoers fragment at `/etc/sudoers.d/writeback`
- Change which users can invoke the proxy
- Move the credentials file or the workspace path

# System Safeguards & Rate Limiting Architecture

> **Dashboard Link:** Add to API Monitoring Dashboard for real-time visibility.
>
> **Last Updated:** 2026-07-07 (after stockrfq-cq-agent OT crash investigation)

This document maps all rate limiting, throttling, timeout, and circuit breaker mechanisms in the codebase. These safeguards work together in layers to prevent system overload.

---

## Quick Reference

| Safeguard | Limit | Trigger | Recovery |
|-----------|-------|---------|----------|
| OT Health Gate | 5s probe | Before OT-writing jobs | Skip tick, retry next hour |
| Global OT Budget | 600/5min | All OT API writes | Block until window passes |
| VQ Rate Limiter | 500/run, 1500/hr | VQ batch writes | Block batch, retry next tick |
| Enrichment Limiter | 50/run, 100/hr/disty | Franchise API calls | Per-disty circuit (30min) |
| Mouser Throttle | 25/min | Mouser API calls | Token bucket wait (max 5min) |
| Job Timeout | 30min (agents), 2hr (regular) | Wall-clock execution | SIGTERM → SIGKILL |
| Stale Lock | 2hr | Hung process holding lock | Force-reclaim lock |
| Circuit Breakers | 10-20 consecutive fails | Repeated failures | Cooldown (15-30min) |

---

## Layer 1: Pre-flight Gates

### OT Health Probe
- **File:** `shared/ot-health.js`
- **Timeout:** 5 seconds
- **Check:** `GET ${IDEMPIERE_BASE_URL}/`
- **Success:** HTTP < 500 (even 401/404 = server alive)
- **On Failure:** Job skipped, sentinel unchanged, retries next tick

### Pause Files
| File | Scope |
|------|-------|
| `~/.cron-paused` | ALL jobs |
| `~/.cron-agents-paused` | Agent-tier only (Claude CLI) |
| `~/.{jobname}-paused` | Specific job |

### Per-Job Locks
- **File:** `shared/lockfile.js`
- **Location:** `~/.cron-locks/{jobName}.lock`
- **Stale After:** 2 hours
- **Dead PID Detection:** `process.kill(pid, 0)` test

---

## Layer 2: API Budgets & Throttles

### Global OT API Budget
- **File:** `shared/ot-api-budget.js`
- **State:** `~/.ot-api-budget.json`

**Limits:**
| Window | Limit | Notes |
|--------|-------|-------|
| 5 min | 600 | Burst protection (crash threshold was ~1000) |
| 15 min | 4,000 | |
| 1 hour | 15,000 | |
| 24 hours | 300,000 | P4 tier exempt |

**Per-Table Hourly Limits:**
| Table | Limit |
|-------|-------|
| chuboe_rfq | 3,000 |
| chuboe_rfq_line | 8,000 |
| chuboe_rfq_line_mpn | 8,000 |
| chuboe_vq_line | 12,000 |
| chuboe_cq_line | 6,000 |
| chuboe_offer | 3,000 |
| chuboe_offer_line | 15,000 |
| chuboe_offer_line_mpn | 8,000 |

**Priority Tiers:**
| Tier | Agents | Protection |
|------|--------|------------|
| P4 | rfq-loading, rfq-fast-loader, operator-request | Exempt burst/daily, 750 reserved/hr |
| P3 | vq-loading-agent | 400 reserved/hr |
| P2 | excess-agent, enrich-poller, inventory-cleanup | Standard |
| P1 | stockrfq-agent, stockrfq-cq-agent | Standard |
| P0 | offer-writeback | Throttled first |

### VQ Rate Limiter
- **File:** `shared/rate-limiter.js`
- **State:** `~/.vq-write-rate.json`

| Mode | Per-Run | Per-Hour | Per-Day | Delay |
|------|---------|----------|---------|-------|
| Normal | 500 | 1,500 | 5,000 | 100ms |
| Backfill (>20 unseen) | 300 | 1,500 | 5,000 | 200ms |

### Enrichment Rate Limiter
- **File:** `shared/enrichment-rate-limiter.js`
- **State:** `~/.enrichment-rate.json`

| Mode | Per-Run | Per-Hour/Disty | Delay |
|------|---------|----------------|-------|
| Normal | 50 | 100-150 | 0ms |
| Backfill (>30 unenriched) | 20 | 100-150 | 500ms |

### Mouser Token Bucket
- **File:** `shared/api-throttle.js`
- **State:** `shared/data/api-throttle-state.json`
- **Limit:** 25 calls/minute (margin under actual ~30 limit)
- **Max Wait:** 5 minutes per token acquisition

---

## Layer 3: Execution Limits

### Job Timeouts (NEW 2026-07-07)
- **File:** `scripts/cron-runner.js`

| Job Type | Default Timeout | Override |
|----------|-----------------|----------|
| Agent (tier='agent') | 30 minutes | `timeoutMs` in cron-jobs.js |
| Regular | 2 hours | `timeoutMs` in cron-jobs.js |

**Enforcement:**
1. SIGTERM sent when timeout reached
2. 5 second grace period
3. SIGKILL if still running
4. Exit code 124 (standard timeout)

### Claude CLI Limits
| Agent | --max-turns |
|-------|-------------|
| excess-agent | 80 |
| stockrfq-agent | 80 |
| stockrfq-cq-agent | 120 |
| rfq-loading-agent | 80 |
| vq-loading-agent | 120 |
| broker-offers-agent | 80 |
| tracking-agent | 40 |

---

## Layer 4: Circuit Breakers

| Circuit | Threshold | Cooldown | Scope |
|---------|-----------|----------|-------|
| VQ Writer | 15 consecutive fails | 15 min | VQ batches |
| Per-Distributor | 10 consecutive 429s | 30 min | Single distributor |
| Global OT | 20 consecutive fails | 15 min | ALL OT writes |

---

## Layer 5: Recovery Mechanisms

### Sentinel Catch-up
- **File:** `shared/cron-sentinel.js`
- **State:** `~/.cron-sentinels/{jobName}.json`
- **Behavior:** Missed runs auto-retry on next tick

### API Retry Queue
- **File:** `shared/api-queue.js`
- **State:** `~/.deferred-api-queue.json`
- **Worker:** `scripts/process-api-queue.js` (every 30min)

**Backoff by Error Type:**
| Error | Backoff | Max Attempts |
|-------|---------|--------------|
| PERMANENT (config) | None | 0 |
| AUTH (401) | 4 hours | 5 |
| RATE_LIMIT (429) | 2min - midnight+jitter | 10 |
| TRANSIENT (5xx) | 30 min | 5 |

---

## Monitoring & Detection

### Hung Job Check (NEW 2026-07-07)
- **File:** `scripts/check-hung-jobs.js`
- **Run:** Session greeting, or manually
- **Detects:** Jobs exceeding timeout, dead PID locks

```bash
# Check for hung jobs
node ~/workspace/astute-workinstructions/scripts/check-hung-jobs.js

# Fix hung jobs (kill + clean locks)
node ~/workspace/astute-workinstructions/scripts/check-hung-jobs.js --fix
```

### Cron Drift Check
- **File:** `scripts/check-cron-drift.js`
- **Run:** Session greeting
- **Detects:** Missing crontab entries, stale sentinels, orphan jobs

### Breadcrumb Log
- **File:** `~/.offer-pipeline/breadcrumbs.jsonl`
- **Events:** job-success, job-failure, job-timeout-kill, job-skip-ot-down, etc.

---

## Incident History

| Date | Incident | Root Cause | Fix |
|------|----------|------------|-----|
| 2026-06-01 | 252 VQs crashed OT | No burst limit | Added 600/5min budget |
| 2026-05-06 | Mouser 401 flap | MaxCallPerMinute | Added 25/min throttle |
| 2026-05-21 | Thundering herd | Quota reset rush | Added 0-8h jitter |
| 2026-07-06 | 69-min agent hang crashed OT | No execution timeout | Added 30min agent timeout |

---

## Dashboard Integration

**Recommended Metrics:**
1. OT API writes/5min (threshold: 600)
2. Per-table writes/hour
3. Circuit breaker status (open/closed)
4. Active job locks + age
5. Hung job alerts (>80% timeout)
6. Deferred queue depth

**State Files to Monitor:**
- `~/.ot-api-budget.json` - Global budget state
- `~/.vq-write-rate.json` - VQ limiter state
- `~/.enrichment-rate.json` - Enrichment limiter state
- `~/.cron-locks/*.lock` - Active job locks
- `~/.deferred-api-queue.json` - Retry queue

---

## See Also

- `cron-jobs.js` - Job registry with timeout configs
- `scripts/cron-runner.js` - Execution wrapper with timeout enforcement
- `shared/ot-api-budget.js` - Global budget implementation
- `email-workflow-architecture.md` - Agent workflow patterns

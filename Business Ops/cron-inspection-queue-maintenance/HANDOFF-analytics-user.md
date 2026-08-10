# Handoff: Inspection Queue Maintenance Setup

## TL;DR

**The cron job works out of the box** — no CLI update needed. The cron runs as `analytics_user`, so it uses the direct path (no proxy).

The proxy CLI update below is **only needed if you want to run manual fixes from a restricted user session** (e.g., justin.oberhofer).

---

## Cron Installation (Required)

Install the cron job:

```bash
node astute-workinstructions/scripts/install-crons.js          # preview
node astute-workinstructions/scripts/install-crons.js --apply  # apply
```

Verify:

```bash
crontab -l | grep inspection-queue
```

Test (dry-run):

```bash
node astute-workinstructions/scripts/cron-runner.js --job=inspection-queue-maintenance --dry-run --force
```

---

## Proxy CLI Update (Optional — for manual runs only)

**Skip this section** if you only need the automated daily cron.

If you want restricted users to run `linkAllocSOLine()` manually from their sessions, add this subcommand to `/opt/writeback/cli.js`:

```javascript
'link-alloc-so': async (payload) => {
  const { linkAllocSOLine } = require('/home/analytics_user/workspace/astute-workinstructions/shared/alloc-patcher');
  const { allocId, soLineId, opts = {} } = payload;
  if (!allocId || !soLineId) {
    throw new Error('link-alloc-so: allocId and soLineId are required');
  }
  return linkAllocSOLine(allocId, soLineId, opts);
},
```

Add it to the `SUBCOMMANDS` object after the existing entries.

### Testing the Proxy (after CLI update)

```bash
# As restricted user, test proxy call
node -e "
const { linkAllocSOLine } = require('./astute-workinstructions/shared/writeback-proxy-client');
(async () => {
  try {
    const result = await linkAllocSOLine(1, 1, { dryRun: true });
    console.log('Result:', result);
  } catch (e) {
    console.log('Expected validation error:', e.message);
  }
})();
"
```

---

## Why This Works Without the CLI Update

The `writeback-proxy-client.js` has two execution paths:

1. **Direct path** (when running as `analytics_user`): Requires the module directly, no proxy needed
2. **Proxy path** (when running as other users): Spawns `sudo -u analytics_user /opt/writeback/cli`

Since the cron runs under `analytics_user`'s crontab, it takes the direct path. The `alloc-patcher.js` module loads API credentials from `~/workspace/.env` (which exists for analytics_user) and works directly.

The proxy CLI subcommand is only needed when a *different* user wants to call the function.

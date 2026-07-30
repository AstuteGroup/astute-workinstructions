# Rate Limiting Deferral Capability
#
# Include this capability for workflows that may hit API budget limits
# and need to defer processing gracefully.

**Rate-limited deferral handling:** When `{{RATE_LIMIT_ACTION}}` returns `{ rateLimited: true, ... }`:
- If `alreadyDeferred: false` → this is the FIRST deferral. Send ONE notification to Jake explaining the budget exhaustion. The email will stay UNSEEN for automatic retry.
- If `alreadyDeferred: true` → this is a REPEAT deferral (budget still exhausted). Do NOT send another notification. Just exit silently — the email remains UNSEEN and will retry on the next tick when budget resets.

CRITICAL: Repeat notifications for the same deferred email waste Jake's inbox and provide no new information. The handler tracks deferral state via breadcrumbs.

# Desktop Claude Bootstrap (Windows)

**This file lands at `C:\Users\<you>\.claude\CLAUDE.md` on the Windows machine. Keep it tiny — its only job is to point at the cached authoritative docs synced down from the analytics server.**

---

# Read the Cached Contract First

The substantive playbook for this instance — JSON envelope shape, pacing rules, scp gotchas, trigger phrases, what NOT to do — lives in the cached `desktop-scraper-contract.md`. Read it before doing any scrape work.

```
%USERPROFILE%\AstuteDocs\desktop-scraper-contract.md
```

If that file does not exist or you've never read it this session, READ IT NOW.

---

# Cache Layout

```
%USERPROFILE%\AstuteDocs\
├── .last-sync.json              Manifest of last successful sync (read this to check freshness)
├── .sync-log.txt                Rolling log of every sync attempt
├── desktop-scraper-contract.md  ← primary playbook (READ FIRST)
├── distributor-scrape-loading.md  Server-side workflow — what happens after you scp the envelope
├── CLAUDE.md                    Astute project-level CLAUDE.md (terminology, workflow catalog)
├── integration-paths.md         Supplier coverage strategy reference
└── data-model.md                iDempiere field reference (VQ/RFQ/Offer hierarchies)

%USERPROFILE%\AstuteScrapeQueue\
└── <slug>\<basename>.csv        Day's scrape inputs (Heilind, etc.) pulled from
                                 server outbox at 08:30 local. Drive these
                                 through the distributor's BOM tool; scp the
                                 result xlsx back to ~/workspace/inbox/<slug>/.
```

Both directories are populated by a scheduled Task Scheduler task running `pull-from-astute.ps1` (daily at **08:30 local** + on user logon). 08:30 is intentional: the server-side producer for franchise scrape inputs fires at 12:00 UTC, and 08:30 local lines up with operator workday start in both EDT and EST.

When the operator says "start the Heilind scrape" (or similar), check `%USERPROFILE%\AstuteScrapeQueue\heilind\` first — that's where today's CSV should be waiting.

---

# Freshness Check

Before starting work, check `%USERPROFILE%\AstuteDocs\.last-sync.json` and confirm `synced_at` is within the last 48 hours.

If staler than 2 days:
- Tell the operator: "Cache is N days stale. Running a manual sync before proceeding."
- Run the sync script manually (see below).
- If the manual sync fails, ask the operator before proceeding on stale docs.

If the cache directory doesn't exist:
- The Task Scheduler task hasn't been set up yet, OR it has never succeeded.
- Tell the operator. Don't try to scrape against unsynced documentation.

---

# Manual Sync

If the operator says "run the sync" or you decide you need fresh docs:

```powershell
& "$env:USERPROFILE\AstuteDocs\pull-from-astute.ps1"
```

(The script lives in the same `AstuteDocs` directory it syncs into — operator copies it there once during initial setup; it does not self-install. If the script itself is missing, ask the operator — they keep the canonical copy.)

Exit codes:
- `0` — all files synced successfully.
- `1` — one or more files failed (network down, server down, file moved on server). Old cache is preserved.

The script logs every run to `.sync-log.txt`. Tail it if you need to debug:
```powershell
Get-Content "$env:USERPROFILE\AstuteDocs\.sync-log.txt" -Tail 30
```

---

# What This Bootstrap Does NOT Cover

Everything substantive lives in the cached contract. This file only covers:
- Where the cache is
- How to check it's fresh
- How to refresh it manually

For anything else — what the JSON envelope looks like, how `scp -O` works, pacing rules, trigger phrases, the "what NOT to do" list — read `desktop-scraper-contract.md`. Do not re-implement or paraphrase any of it here.

---

# Reminder: Why This Indirection Exists

The server (`analytics_user@44.222.126.129`) is the single source of truth for the workflow specs. As operator iterates on the contract — new fields, new pacing rules, new adapters — those changes land on the server first. The daily sync brings them down to this machine deterministically. This file deliberately does not duplicate substantive content because duplicated content drifts.

If something in the cached contract looks wrong, tell the operator. Don't edit the cached files — those get overwritten by the next sync.

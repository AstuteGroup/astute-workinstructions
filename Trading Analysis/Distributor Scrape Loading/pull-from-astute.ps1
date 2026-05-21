<#
.SYNOPSIS
    Pulls authoritative .md workflow docs AND any pending scrape-input CSVs from
    the Astute analytics server to a local cache + scrape queue.

.DESCRIPTION
    Runs as a scheduled task (daily 08:30 local + on user logon).

    Daily timing rationale: the server-side `heilind-producer` cron fires at
    12:00 UTC and writes `<ts>.csv` + `<ts>.meta.json` into `outbox/<slug>/`. The
    desktop pickup needs to run AFTER that. 08:30 LOCAL aligns with the operator
    workday start year-round (08:30 EDT = 12:30 UTC in DST; 08:30 EST = 13:30
    UTC in winter — both well after the 12:00 UTC producer).

    Two responsibilities:

    1. Docs sync (always runs first). Pulls `.md` workflow docs into
           %USERPROFILE%\AstuteDocs\
       Existing cache preserved on failure — stale copy beats empty mid-workday.

    2. Scrape-queue pickup (after docs). For each source slug in $ScrapeQueueSet:
       lists `outbox/<slug>/*.csv` on the server, scp-pulls each, verifies the
       local copy is non-empty, then ssh-rm's the server copy. Pulled files land
       at:
           %USERPROFILE%\AstuteScrapeQueue\<slug>\<basename>.csv
       The paired `<basename>.meta.json` sidecar STAYS server-side (the watcher
       re-attaches RFQ context after the scrape result lands in inbox/<slug>/).
       The act of successful pull IS the delete — see desktop-scraper-contract.md
       section "Picking Up Outbox Requests".

    Uses `scp -O` (legacy SCP protocol). The server's SFTP subsystem does not
    start; modern OpenSSH `scp` defaults to SFTP and fails with "Connection
    closed". Same finding applies to the scrape-envelope push direction.

    Cache layout:
        %USERPROFILE%\AstuteDocs\
            .last-sync.json          Manifest of last sync attempt (docs + queue)
            .sync-log.txt            Rolling log
            <files>                  Synced .md files
        %USERPROFILE%\AstuteScrapeQueue\<slug>\
            <basename>.csv           Pulled scrape inputs awaiting operator+Claude

.NOTES
    Server host (analytics_user@44.222.126.129), the docs sync set, and the
    scrape-queue source list are defined as constants at the top of this script —
    edit those if any change.

    Install the scheduled tasks once (PowerShell as admin, one-time):

        schtasks /Create /SC DAILY /ST 08:30 /TN "AstuteDocsSync" `
                 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$env:USERPROFILE\AstuteDocs\pull-from-astute.ps1`""

        schtasks /Create /SC ONLOGON /TN "AstuteDocsSyncOnLogon" `
                 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$env:USERPROFILE\AstuteDocs\pull-from-astute.ps1`""

    To update an existing 06:00 task to 08:30, see the bottom of
    desktop-scraper-contract.md § "Scheduled Outbox Pickup".
#>

[CmdletBinding()]
param()

# ─── CONFIG ─────────────────────────────────────────────────────────────────

$RemoteUser    = 'analytics_user'
$RemoteHost    = '44.222.126.129'
$LocalCacheDir = Join-Path $env:USERPROFILE 'AstuteDocs'
$LocalQueueDir = Join-Path $env:USERPROFILE 'AstuteScrapeQueue'
$LogFile       = Join-Path $LocalCacheDir '.sync-log.txt'
$ManifestFile  = Join-Path $LocalCacheDir '.last-sync.json'
$ConnectTimeoutSec = 10

# Scrape-queue sources to drain. Each slug expects `~/workspace/outbox/<slug>/`
# on the server to be a flat directory of `<basename>.csv` upload files paired
# with `<basename>.meta.json` sidecars. CSVs are pulled + server-deleted; meta
# sidecars stay server-side. To add a new source: add the slug here AND ensure
# the server-side producer is staging into `outbox/<slug>/`.
$ScrapeQueueSet = @('heilind')

# Sync set: each entry has Remote (absolute path on server) + Local (filename in cache dir).
# Server is source of truth — to add/remove files, edit here and redeploy the script.
$SyncSet = @(
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/desktop-scraper-contract.md';   Local = 'desktop-scraper-contract.md' }
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/distributor-scrape-loading.md'; Local = 'distributor-scrape-loading.md' }
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/CLAUDE.md';            Local = 'CLAUDE.md' }
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/integration-paths.md'; Local = 'integration-paths.md' }
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/shared/data-model.md'; Local = 'data-model.md' }

    # Per-source operational notes (server-side empirical observations) — useful
    # context for the desktop Claude when driving a specific adapter.
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/heilind-bom-tool-notes.md';   Local = 'heilind-bom-tool-notes.md' }
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/coilcraft-direct-notes.md';   Local = 'coilcraft-direct-notes.md' }

    # Per-site scrape-adapter cheat sheets (selectors, navigation chain, auth nuance).
    # Subfolder layout matches the contract: %USERPROFILE%\AstuteDocs\scrape-adapters\<slug>.md
    @{ Remote = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Distributor Scrape Loading/scrape-adapters/coilcraft.md'; Local = 'scrape-adapters\coilcraft.md' }
)

# ─── BOOTSTRAP ──────────────────────────────────────────────────────────────

if (-not (Test-Path $LocalCacheDir)) {
    New-Item -ItemType Directory -Path $LocalCacheDir -Force | Out-Null
}

function Write-SyncLog {
    param(
        [Parameter(Mandatory)] [string] $Message,
        [ValidateSet('INFO','WARN','ERROR')] [string] $Level = 'INFO'
    )
    $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $line = "$ts [$Level] $Message"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

Write-SyncLog "Sync start. Host=$RemoteUser@$RemoteHost Cache=$LocalCacheDir Files=$($SyncSet.Count)"

# ─── CONNECTIVITY CHECK ─────────────────────────────────────────────────────
# Fail fast and loudly if SSH is unreachable. Preserves the existing cache.

$sshArgs = @(
    '-o', "ConnectTimeout=$ConnectTimeoutSec",
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    "$RemoteUser@$RemoteHost",
    'echo connected'
)
$connOut = & ssh @sshArgs 2>&1
if ($LASTEXITCODE -ne 0 -or "$connOut" -notmatch 'connected') {
    Write-SyncLog "Connectivity check FAILED (exit=$LASTEXITCODE): $connOut" 'ERROR'
    Write-SyncLog "Existing cache preserved. Network/server/auth issue — investigate before next run." 'ERROR'
    exit 1
}
Write-SyncLog "Connectivity OK."

# ─── PULL EACH FILE ─────────────────────────────────────────────────────────

$results = @()
$okCount     = 0
$failedCount = 0

foreach ($item in $SyncSet) {
    # Single-quote the remote path on the remote side so spaces in paths
    # (e.g. "Trading Analysis/") survive the remote shell expansion.
    $remoteSpec = "$RemoteUser@${RemoteHost}:'" + $item.Remote + "'"
    $localPath  = Join-Path $LocalCacheDir $item.Local
    $tmpPath    = "$localPath.partial"

    # Ensure local parent directory exists — needed for subfolder entries
    # like `scrape-adapters\coilcraft.md`. scp won't create parent dirs.
    $parentDir = Split-Path -Parent $localPath
    if ($parentDir -and -not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    if (Test-Path $tmpPath) { Remove-Item $tmpPath -Force }

    # scp -O forces the legacy SCP protocol (SFTP subsystem doesn't start on server).
    # -T disables the modern strict filename round-trip check — without it, pull
    # direction fails with "protocol error: filename does not match request"
    # because the server echoes the basename while the client sent a quoted
    # absolute path. -q suppresses chatter; we capture exit code + any stderr.
    $scpOut = & scp -O -T -q $remoteSpec $tmpPath 2>&1
    $scpExit = $LASTEXITCODE

    if ($scpExit -eq 0 -and (Test-Path $tmpPath) -and ((Get-Item $tmpPath).Length -gt 0)) {
        # Atomic move: temp file into the canonical path, replacing any prior cached copy.
        Move-Item -Path $tmpPath -Destination $localPath -Force
        $size = (Get-Item $localPath).Length
        Write-SyncLog ("  OK    {0,-36} ({1} bytes)" -f $item.Local, $size)
        $results += [ordered]@{
            file   = $item.Local
            remote = $item.Remote
            status = 'ok'
            size   = $size
        }
        $okCount++
    }
    else {
        # Clean up partial; do NOT touch the existing cached copy (if any).
        if (Test-Path $tmpPath) { Remove-Item $tmpPath -Force }
        $err = if ("$scpOut") { "$scpOut".Trim() } else { "exit=$scpExit, no stderr captured" }
        $haveStale = Test-Path $localPath
        $note = if ($haveStale) { 'stale copy retained' } else { 'no cached copy available' }
        Write-SyncLog ("  FAIL  {0,-36} ({1}; {2})" -f $item.Local, $err, $note) 'WARN'
        $results += [ordered]@{
            file              = $item.Local
            remote            = $item.Remote
            status            = 'failed'
            error             = $err
            stale_copy_kept   = [bool]$haveStale
        }
        $failedCount++
    }
}

# ─── SCRAPE-QUEUE PICKUP ────────────────────────────────────────────────────
# Drain each `outbox/<slug>/*.csv` from the server to %USERPROFILE%\AstuteScrapeQueue\<slug>\.
# Successful pull → ssh-rm the server-side CSV (the meta.json sidecar stays put).
# Failure → log warn, leave server file alone, continue with other slugs.

$queueResults = @()
$queuePulled  = 0
$queueFailed  = 0

if (-not (Test-Path $LocalQueueDir)) {
    New-Item -ItemType Directory -Path $LocalQueueDir -Force | Out-Null
}

foreach ($slug in $ScrapeQueueSet) {
    $slugLocalDir  = Join-Path $LocalQueueDir $slug
    $slugRemoteDir = "/home/analytics_user/workspace/outbox/$slug"

    if (-not (Test-Path $slugLocalDir)) {
        New-Item -ItemType Directory -Path $slugLocalDir -Force | Out-Null
    }

    # List CSVs in the remote outbox. Empty list is fine — operator may have
    # already pulled today's batch ad-hoc, or producer hasn't fired yet.
    # `ls -1` gives one filename per line.
    #
    # IMPORTANT: do NOT add `2>/dev/null`. The server account runs `rbash`
    # (restricted bash), which forbids output redirection and rejects the
    # entire command before `ls` even runs. We let `ls` write its "No such
    # file" error to stderr, capture both streams via `2>&1`, and detect the
    # empty-folder case by string-matching the error rather than suppressing
    # it. The regex filter below (`\.csv\s*$`) drops the error line naturally.
    $lsArgs = @(
        '-o', "ConnectTimeout=$ConnectTimeoutSec",
        '-o', 'BatchMode=yes',
        "$RemoteUser@$RemoteHost",
        "ls -1 $slugRemoteDir/*.csv"
    )
    $lsOut = & ssh @lsArgs 2>&1
    $lsExit = $LASTEXITCODE

    if ($lsExit -ne 0 -and "$lsOut" -notmatch 'No such') {
        Write-SyncLog ("  QUEUE FAIL [{0}] list-failed: {1}" -f $slug, "$lsOut".Trim()) 'WARN'
        $queueResults += [ordered]@{ slug = $slug; status = 'list_failed'; error = "$lsOut".Trim() }
        $queueFailed++
        continue
    }

    $remoteCsvs = @("$lsOut" -split "`n" | Where-Object { $_ -match '\.csv\s*$' } | ForEach-Object { $_.Trim() })

    if ($remoteCsvs.Count -eq 0) {
        Write-SyncLog ("  QUEUE OK   [{0}] outbox empty — nothing to pull" -f $slug)
        $queueResults += [ordered]@{ slug = $slug; status = 'empty'; pulled = 0 }
        continue
    }

    Write-SyncLog ("  QUEUE      [{0}] {1} CSV(s) to pull" -f $slug, $remoteCsvs.Count)

    $slugPulled = 0
    $slugFiles  = @()

    foreach ($remoteCsv in $remoteCsvs) {
        $basename   = Split-Path -Leaf $remoteCsv
        $localPath  = Join-Path $slugLocalDir $basename
        $tmpPath    = "$localPath.partial"

        if (Test-Path $tmpPath) { Remove-Item $tmpPath -Force }

        # Single-quote the remote path to survive shell expansion on the remote side.
        # -T disables strict filename round-trip check (see docs-sync block above
        # for full rationale — required for pull direction).
        $remoteSpec = "$RemoteUser@${RemoteHost}:'" + $remoteCsv + "'"
        $scpOut  = & scp -O -T -q $remoteSpec $tmpPath 2>&1
        $scpExit = $LASTEXITCODE

        if ($scpExit -ne 0 -or -not (Test-Path $tmpPath) -or (Get-Item $tmpPath).Length -le 0) {
            if (Test-Path $tmpPath) { Remove-Item $tmpPath -Force }
            $err = if ("$scpOut") { "$scpOut".Trim() } else { "exit=$scpExit, no stderr captured" }
            Write-SyncLog ("    FAIL  {0}  ({1}) — server copy retained" -f $basename, $err) 'WARN'
            $slugFiles += [ordered]@{ file = $basename; status = 'pull_failed'; error = $err }
            $queueFailed++
            continue
        }

        # Atomic local move: tmp → final.
        Move-Item -Path $tmpPath -Destination $localPath -Force
        $size = (Get-Item $localPath).Length

        # Delete server-side ONLY after the local file is confirmed in place + non-empty.
        # Per contract: the act of retrieval IS the delete. The .meta.json sidecar
        # is NOT deleted — it stays on the server for the watcher to use later.
        $rmArgs = @(
            '-o', "ConnectTimeout=$ConnectTimeoutSec",
            '-o', 'BatchMode=yes',
            "$RemoteUser@$RemoteHost",
            "rm '$remoteCsv'"
        )
        $rmOut  = & ssh @rmArgs 2>&1
        $rmExit = $LASTEXITCODE

        if ($rmExit -eq 0) {
            Write-SyncLog ("    OK    {0}  ({1} bytes; server copy deleted)" -f $basename, $size)
            $slugFiles += [ordered]@{ file = $basename; status = 'ok'; size = $size }
            $slugPulled++
            $queuePulled++
        }
        else {
            # Local pull succeeded; server delete failed. Next run will re-pull
            # (overwriting the local file — same content) and try delete again.
            # Not a data-loss path; just noisy.
            $err = "$rmOut".Trim()
            Write-SyncLog ("    WARN  {0}  pulled OK but server-side rm failed: {1}" -f $basename, $err) 'WARN'
            $slugFiles += [ordered]@{ file = $basename; status = 'ok_rm_failed'; size = $size; error = $err }
            $slugPulled++
            $queuePulled++
            $queueFailed++
        }
    }

    $queueResults += [ordered]@{ slug = $slug; status = 'processed'; pulled = $slugPulled; files = $slugFiles }
}

if ($ScrapeQueueSet.Count -gt 0) {
    Write-SyncLog "Scrape queue: pulled $queuePulled CSV(s) across $($ScrapeQueueSet.Count) source(s); $queueFailed failures."
}

# ─── MANIFEST ───────────────────────────────────────────────────────────────

$manifest = [ordered]@{
    synced_at     = (Get-Date).ToString('o')
    host          = $RemoteHost
    user          = $RemoteUser
    ok_count      = $okCount
    failed_count  = $failedCount
    total         = $SyncSet.Count
    files         = $results
    scrape_queue  = [ordered]@{
        pulled       = $queuePulled
        failed       = $queueFailed
        sources      = $queueResults
        local_dir    = $LocalQueueDir
    }
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $ManifestFile -Encoding UTF8

# ─── EXIT ───────────────────────────────────────────────────────────────────

$totalFailed = $failedCount + $queueFailed
if ($totalFailed -gt 0) {
    Write-SyncLog "Sync completed with failures: docs $failedCount/$($SyncSet.Count) failed, scrape queue $queueFailed failed (pulled $queuePulled)." 'WARN'
    exit 1
}
else {
    Write-SyncLog "Sync OK. Docs $okCount/$($SyncSet.Count) refreshed; scrape queue pulled $queuePulled."
    exit 0
}

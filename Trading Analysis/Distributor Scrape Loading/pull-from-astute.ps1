<#
.SYNOPSIS
    Pulls authoritative .md workflow docs from the Astute analytics server to a local cache.

.DESCRIPTION
    Runs as a scheduled task (daily 6am local + on user logon) to keep the operator's
    desktop Claude Code instance reading from a fresh, deterministic copy of the
    server-side workflow documentation.

    Uses `scp -O` (legacy SCP protocol). The server's SFTP subsystem does not start;
    modern OpenSSH `scp` defaults to SFTP and fails with "Connection closed". Same
    finding applies to the scrape-envelope push direction — see desktop-scraper-contract.md.

    Cache layout:
        %USERPROFILE%\AstuteDocs\
            .last-sync.json    Manifest of last sync attempt
            .sync-log.txt      Rolling log
            <files>            Synced .md files

    Existing cache is preserved on failure (single-file or whole-sync). A stale copy
    is always preferable to an empty cache mid-workday.

.NOTES
    Server host (analytics_user@44.222.126.129) and the sync set are defined as
    constants at the top of this script — edit those if either changes.

    Install the scheduled task once (PowerShell as admin, one-time):

        schtasks /Create /SC DAILY /ST 06:00 /TN "AstuteDocsSync" `
                 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$env:USERPROFILE\AstuteDocs\pull-from-astute.ps1`""

        schtasks /Create /SC ONLOGON /TN "AstuteDocsSyncOnLogon" `
                 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$env:USERPROFILE\AstuteDocs\pull-from-astute.ps1`""
#>

[CmdletBinding()]
param()

# ─── CONFIG ─────────────────────────────────────────────────────────────────

$RemoteUser    = 'analytics_user'
$RemoteHost    = '44.222.126.129'
$LocalCacheDir = Join-Path $env:USERPROFILE 'AstuteDocs'
$LogFile       = Join-Path $LocalCacheDir '.sync-log.txt'
$ManifestFile  = Join-Path $LocalCacheDir '.last-sync.json'
$ConnectTimeoutSec = 10

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
    # -q suppresses chatter; we capture exit code + any stderr.
    $scpOut = & scp -O -q $remoteSpec $tmpPath 2>&1
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

# ─── MANIFEST ───────────────────────────────────────────────────────────────

$manifest = [ordered]@{
    synced_at     = (Get-Date).ToString('o')
    host          = $RemoteHost
    user          = $RemoteUser
    ok_count      = $okCount
    failed_count  = $failedCount
    total         = $SyncSet.Count
    files         = $results
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $ManifestFile -Encoding UTF8

# ─── EXIT ───────────────────────────────────────────────────────────────────

if ($failedCount -gt 0) {
    Write-SyncLog "Sync completed with failures: $failedCount failed / $okCount OK / $($SyncSet.Count) total." 'WARN'
    exit 1
}
else {
    Write-SyncLog "Sync OK. $okCount/$($SyncSet.Count) files refreshed."
    exit 0
}

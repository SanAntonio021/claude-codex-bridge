[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CurrentUserSid {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) {
        throw 'Unable to resolve the current Windows user SID.'
    }
    return $identity.User.Value
}

function Move-AtomicReplace {
    param([string]$Source, [string]$Destination)
    if ($null -eq ('BridgeReleaseNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeReleaseNative {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool MoveFileEx(string source, string destination, int flags);
}
'@
    }
    if (-not [BridgeReleaseNative]::MoveFileEx($Source, $Destination, 9)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-Object ComponentModel.Win32Exception($code, 'Unable to replace bridge release metadata atomically.'))
    }
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for a per-user bridge installation.'
}
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'claude-codex-bridge'
$pointerPath = Join-Path $runtimeRoot 'current.json'
if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
    throw 'No bridge release pointer exists.'
}
$pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$pointer.previous_release)) {
    throw 'There is no previous bridge release to roll back to.'
}
if ([string]$pointer.previous_release -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'Bridge current.json is invalid.'
}
$previousRoot = Join-Path (Join-Path $runtimeRoot 'releases') ([string]$pointer.previous_release)
if (-not (Test-Path -LiteralPath (Join-Path $previousRoot 'release-manifest.json') -PathType Leaf)) {
    throw 'The previous bridge release is not installed.'
}
$blocking = @()
$jobsRoot = Join-Path $runtimeRoot 'jobs'
if (Test-Path -LiteralPath $jobsRoot -PathType Container) {
    $blocking = Get-ChildItem -LiteralPath $jobsRoot -Filter '*.json' -File | ForEach-Object {
        Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    } | Where-Object {
        $_.state -in @('queued', 'dispatching', 'transport_delivered', 'running') -or
        ($_.state -eq 'needs_attention' -and $_.sync_status -eq 'awaiting_user')
    }
}
if ($blocking.Count -gt 0) {
    throw "Rollback is blocked by $($blocking.Count) active, queued, or awaiting-sync job(s)."
}
$replacement = [ordered]@{
    schema_version = 1
    current_release = [string]$pointer.previous_release
    previous_release = [string]$pointer.current_release
    updated_at = [DateTime]::UtcNow.ToString('o')
}
$temporary = Join-Path $runtimeRoot ('.current.json.{0}.tmp' -f $PID)
try {
    [System.IO.File]::WriteAllText($temporary, (($replacement | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
    Move-AtomicReplace -Source $temporary -Destination $pointerPath
    $permission = ('*{0}:(F)' -f (Get-CurrentUserSid))
    & icacls.exe $pointerPath '/inheritance:r' '/grant:r' $permission | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to protect the bridge release pointer.'
    }
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}
$replacement | ConvertTo-Json -Depth 4

[CmdletBinding()]
param(
    [switch]$RemoveRuntime,
    [string]$Confirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for a per-user bridge installation.'
}
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'claude-codex-bridge'
$taskName = 'ClaudeCodexBridgeDaemon'
$endpointPath = Join-Path $runtimeRoot 'daemon.json'
if (Test-Path -LiteralPath $endpointPath -PathType Leaf) {
    $endpoint = Get-Content -LiteralPath $endpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne (Get-Process -Id ([int]$endpoint.pid) -ErrorAction SilentlyContinue)) {
        throw 'The bridge daemon is still running. Stop it through the launcher before uninstalling.'
    }
}
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
if ($RemoveRuntime) {
    if ($Confirm -cne 'REMOVE') {
        throw 'Removing token, job history, retained workspaces, and installed releases requires -Confirm REMOVE.'
    }
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
        Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
    }
    [PSCustomObject]@{ uninstalled = $true; runtime_removed = $true } | ConvertTo-Json
    exit 0
}
[PSCustomObject]@{
    uninstalled = $true
    runtime_removed = $false
    retained = @('token', 'job history', 'retained workspaces', 'installed releases')
} | ConvertTo-Json -Depth 3

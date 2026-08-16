[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BridgeArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for a per-user bridge installation.'
}
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'claude-codex-bridge'
$pointerPath = Join-Path $runtimeRoot 'current.json'
if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
    throw 'No bridge release is installed. Run Install-Bridge.ps1 first.'
}
$pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$pointer.current_release) -or [string]$pointer.current_release -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'Bridge current.json is invalid.'
}
$releaseRoot = Join-Path (Join-Path $runtimeRoot 'releases') ([string]$pointer.current_release)
$releaseManifestPath = Join-Path $releaseRoot 'release-manifest.json'
$buildManifestPath = Join-Path $releaseRoot 'dist\build-manifest.json'
$entryPoint = Join-Path $releaseRoot 'dist\src\cli\main.js'
if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw 'The selected bridge release is incomplete.'
}
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildManifest = Get-Content -LiteralPath $buildManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildHash = (Get-FileHash -LiteralPath $buildManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($releaseManifest.build_id -ne $buildManifest.build_id -or $releaseManifest.fingerprints.build_manifest -ne $buildHash) {
    throw 'The selected bridge release failed its build identity check.'
}
$node = Get-Command node.exe -ErrorAction Stop
& $node.Source $entryPoint @BridgeArgs
exit $LASTEXITCODE

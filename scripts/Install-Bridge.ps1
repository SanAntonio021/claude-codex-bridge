[CmdletBinding()]
param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipDependencyInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-RuntimeRoot {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is required for a per-user bridge installation.'
    }
    return Join-Path $env:LOCALAPPDATA 'claude-codex-bridge'
}

function Get-CurrentUserSid {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) {
        throw 'Unable to resolve the current Windows user SID.'
    }
    return $identity.User.Value
}

function Protect-BridgeTree {
    param([Parameter(Mandatory = $true)][string]$Path)
    $permission = ('*{0}:(OI)(CI)F' -f (Get-CurrentUserSid))
    & icacls.exe $Path '/inheritance:r' '/grant:r' $permission '/T' '/C' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply owner-only ACL to $Path."
    }
}

function Protect-BridgeFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $permission = ('*{0}:(F)' -f (Get-CurrentUserSid))
    & icacls.exe $Path '/inheritance:r' '/grant:r' $permission | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to apply owner-only ACL to $Path."
    }
}

function Move-AtomicReplace {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
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

function Write-AtomicJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = Join-Path $directory ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path), $PID)
    try {
        $content = ($Value | ConvertTo-Json -Depth 8) + "`n"
        [System.IO.File]::WriteAllText($temporary, $content, [System.Text.UTF8Encoding]::new($false))
        Move-AtomicReplace -Source $temporary -Destination $Path
        Protect-BridgeFile -Path $Path
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

$packageRootFull = [System.IO.Path]::GetFullPath($PackageRoot)
$packageJsonPath = Join-Path $packageRootFull 'package.json'
$buildManifestPath = Join-Path $packageRootFull 'dist\build-manifest.json'
if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) -or -not (Test-Path -LiteralPath $buildManifestPath -PathType Leaf)) {
    throw 'PackageRoot must contain package.json and a prebuilt dist/build-manifest.json.'
}

$package = Read-JsonFile -Path $packageJsonPath
$build = Read-JsonFile -Path $buildManifestPath
if ($package.name -ne 'claude-codex-bridge' -or $package.version -ne $build.version) {
    throw 'Package metadata and build manifest do not describe the same bridge release.'
}
if ([string]$build.build_id -notmatch '^[0-9a-f]{64}$') {
    throw 'The build manifest has no valid build_id.'
}

$releaseId = ('{0}-{1}' -f $package.version, ([string]$build.build_id).Substring(0, 16))
if ($releaseId -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'The derived release ID is unsafe.'
}
$runtimeRoot = Get-RuntimeRoot
$releasesRoot = Join-Path $runtimeRoot 'releases'
$destination = Join-Path $releasesRoot $releaseId
$staging = Join-Path $releasesRoot ('.staging-{0}-{1}' -f $releaseId, $PID)
$pointerPath = Join-Path $runtimeRoot 'current.json'

New-Item -ItemType Directory -Path $releasesRoot -Force | Out-Null
Protect-BridgeTree -Path $runtimeRoot
Protect-BridgeTree -Path $releasesRoot
if (Test-Path -LiteralPath $destination) {
    $installed = Read-JsonFile -Path (Join-Path $destination 'release-manifest.json')
    if ($installed.build_id -ne $build.build_id) {
        throw "The existing release directory $releaseId has a different build identity."
    }
} else {
    if (Test-Path -LiteralPath $staging) {
        throw "Refusing to reuse an existing staging directory: $staging"
    }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        $excluded = @('.git', '.bridge-runtime', 'artifacts', 'release', 'coverage')
        if (-not $SkipDependencyInstall) {
            $excluded += 'node_modules'
        }
        Get-ChildItem -LiteralPath $packageRootFull -Force |
            Where-Object { $excluded -notcontains $_.Name } |
            ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force }
        if ($SkipDependencyInstall) {
            if (-not (Test-Path -LiteralPath (Join-Path $staging 'node_modules') -PathType Container)) {
                throw 'SkipDependencyInstall requires a vetted node_modules directory in the package payload.'
            }
        } else {
            Push-Location $staging
            try {
                & npm.cmd ci '--omit=dev' '--ignore-scripts'
                if ($LASTEXITCODE -ne 0) {
                    throw "npm ci failed with exit code $LASTEXITCODE."
                }
            } finally {
                Pop-Location
            }
        }
        $fingerprints = [ordered]@{
            package_json = (Get-FileHash -LiteralPath (Join-Path $staging 'package.json') -Algorithm SHA256).Hash.ToLowerInvariant()
            package_lock = (Get-FileHash -LiteralPath (Join-Path $staging 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
            build_manifest = (Get-FileHash -LiteralPath (Join-Path $staging 'dist\build-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        Write-AtomicJson -Path (Join-Path $staging 'release-manifest.json') -Value ([ordered]@{
            schema_version = 1
            release_id = $releaseId
            version = $package.version
            build_id = $build.build_id
            installed_at = [DateTime]::UtcNow.ToString('o')
            fingerprints = $fingerprints
        })
        Protect-BridgeTree -Path $staging
        [System.IO.Directory]::Move($staging, $destination)
    } catch {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

$previousRelease = $null
if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
    $existingPointer = Read-JsonFile -Path $pointerPath
    $previousRelease = [string]$existingPointer.current_release
    if ($previousRelease -eq $releaseId) {
        $previousRelease = $existingPointer.previous_release
    }
}
Write-AtomicJson -Path $pointerPath -Value ([ordered]@{
    schema_version = 1
    current_release = $releaseId
    previous_release = $previousRelease
    updated_at = [DateTime]::UtcNow.ToString('o')
})

[PSCustomObject]@{
    installed = $true
    release_id = $releaseId
    version = $package.version
    build_id = $build.build_id
    current_pointer = $pointerPath
    previous_release = $previousRelease
    restart_required = $true
} | ConvertTo-Json -Depth 4

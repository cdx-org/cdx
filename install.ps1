[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $InstallerArgs
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DefaultInstallRepo = 'https://github.com/cdx-org/cdx.git'
$DefaultInstallRef = 'main'
$InstallManagedMarker = '.cdx-install-managed'
$InstallRepo = if ($env:CDX_INSTALL_REPO) { $env:CDX_INSTALL_REPO } else { $DefaultInstallRepo }
$InstallRef = if ($env:CDX_INSTALL_REF) { $env:CDX_INSTALL_REF } else { $DefaultInstallRef }
$InstallSkipUpdate = if ($env:CDX_INSTALL_SKIP_UPDATE) { $env:CDX_INSTALL_SKIP_UPDATE } else { '0' }

function Write-Warn {
  param([string] $Message)
  Write-Host "install.ps1: $Message" -ForegroundColor Yellow
}

function Invoke-NativeQuiet {
  param(
    [Parameter(Mandatory = $true)] [string] $CommandName,
    [Parameter(Mandatory = $true)] [string[]] $Arguments
  )

  $oldErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $CommandName @Arguments *> $null
    return $global:LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
}

function Test-ProjectDir {
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }

  return (
    (Test-Path -LiteralPath (Join-Path $Path 'package.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Path 'src/install/cli.js') -PathType Leaf)
  )
}

function Add-SessionPath {
  param([AllowNull()] [string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return
  }

  $parts = @($env:Path -split [regex]::Escape([IO.Path]::PathSeparator) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  foreach ($part in $parts) {
    if ([string]::Equals($part.TrimEnd('\/'), $Path.TrimEnd('\/'), [StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }

  $env:Path = $Path + [IO.Path]::PathSeparator + $env:Path
}

function Update-SessionPath {
  foreach ($scope in @('Process', 'User', 'Machine')) {
    foreach ($name in @('ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)')) {
      $root = [Environment]::GetEnvironmentVariable($name, $scope)
      if (-not [string]::IsNullOrWhiteSpace($root)) {
        Add-SessionPath (Join-Path $root 'nodejs')
      }
    }

    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', $scope)
    if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
      Add-SessionPath (Join-Path $localAppData 'Programs\nodejs')
      Add-SessionPath (Join-Path $localAppData 'Microsoft\WindowsApps')
    }
  }

  Add-SessionPath 'C:\Program Files\nodejs'
  Add-SessionPath 'C:\Program Files (x86)\nodejs'
}

function Get-DefaultInstallDir {
  if ($env:CDX_INSTALL_DIR) {
    return [System.IO.Path]::GetFullPath($env:CDX_INSTALL_DIR)
  }

  if ($env:LOCALAPPDATA) {
    return (Join-Path $env:LOCALAPPDATA 'mcp-cdx')
  }

  return (Join-Path (Join-Path (Join-Path $HOME '.local') 'share') 'mcp-cdx')
}

function Get-GitHubArchiveUrl {
  $repo = $InstallRepo -replace '\.git$', ''
  if ($repo -match '^https://github\.com/[^/]+/[^/]+$') {
    return "$repo/archive/refs/heads/$InstallRef.zip"
  }

  throw "git is required for non-GitHub install repo: $InstallRepo"
}

function Assert-LastExitCode {
  param(
    [string] $Action
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Action failed with exit code $LASTEXITCODE"
  }
}

function Invoke-GitOrThrow {
  param(
    [Parameter(Mandatory = $true)] [string[]] $GitArgs,
    [Parameter(Mandatory = $true)] [string] $FailureMessage
  )

  $exitCode = Invoke-NativeQuiet 'git' $GitArgs
  if ($exitCode -ne 0) {
    throw $FailureMessage
  }
}

function Copy-DirectoryContents {
  param(
    [string] $Source,
    [string] $Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Remove-ManagedInstallDir {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $marker = Join-Path $Path $InstallManagedMarker
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw "Install directory already exists and is not managed: $Path. Set CDX_INSTALL_DIR to another path or remove it manually."
  }

  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Update-ProjectCheckout {
  param([Parameter(Mandatory = $true)] [string] $Path)

  if ($InstallSkipUpdate -eq '1') {
    return
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container)) {
    return
  }

  $status = & git -C $Path status --porcelain 2>$null
  if ($status) {
    Write-Warn "skipping installer repo update because $Path has local changes"
    return
  }

  Write-Warn "updating $Path from $InstallRepo ($InstallRef)"
  Invoke-NativeQuiet 'git' @('-C', $Path, 'remote', 'set-url', 'origin', $InstallRepo) | Out-Null
  if ((Invoke-NativeQuiet 'git' @('-C', $Path, 'fetch', '--depth', '1', 'origin', $InstallRef)) -ne 0) {
    return
  }
  Invoke-NativeQuiet 'git' @('-C', $Path, 'checkout', '--force', 'FETCH_HEAD') | Out-Null
}

function Ensure-ProjectCheckout {
  param([Parameter(Mandatory = $true)] [string] $Path)

  if (Test-ProjectDir $Path) {
    Update-ProjectCheckout $Path
    return [System.IO.Path]::GetFullPath($Path)
  }

  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container)) {
    Remove-ManagedInstallDir $Path
  }

  $parentDir = Split-Path -Parent $Path
  if ([string]::IsNullOrWhiteSpace($parentDir)) {
    $parentDir = '.'
  }
  New-Item -ItemType Directory -Force -Path $parentDir | Out-Null

  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    if (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container) {
      Update-ProjectCheckout $Path
      if (-not (Test-ProjectDir $Path)) {
        throw "Git checkout is missing mcp-cdx files: $Path"
      }
    } else {
      Write-Warn "cloning $InstallRepo ($InstallRef) into $Path"
      Invoke-GitOrThrow `
        -GitArgs @('clone', '--depth', '1', '--branch', $InstallRef, $InstallRepo, $Path) `
        -FailureMessage 'git clone failed'
      if (-not (Test-ProjectDir $Path)) {
        throw "Clone did not produce an mcp-cdx checkout: $Path"
      }
    }

    New-Item -ItemType File -Force -Path (Join-Path $Path $InstallManagedMarker) | Out-Null
    return [System.IO.Path]::GetFullPath($Path)
  }

  $archiveUrl = Get-GitHubArchiveUrl
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-cdx-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  try {
    $archivePath = Join-Path $tempRoot 'source.zip'
    Write-Warn "downloading $archiveUrl into $Path"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempRoot -Force

    $sourceDir = Get-ChildItem -LiteralPath $tempRoot -Directory | Select-Object -First 1
    if (-not $sourceDir) {
      throw 'Downloaded archive did not contain a project directory.'
    }
    if (-not (Test-ProjectDir $sourceDir.FullName)) {
      throw 'Downloaded archive did not contain an mcp-cdx checkout.'
    }

    if (Test-Path -LiteralPath $Path) {
      Remove-ManagedInstallDir $Path
    }

    Copy-DirectoryContents -Source $sourceDir.FullName -Destination $Path
    New-Item -ItemType File -Force -Path (Join-Path $Path $InstallManagedMarker) | Out-Null
    return [System.IO.Path]::GetFullPath($Path)
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Bootstrap-ProjectDir {
  $targetDir = Get-DefaultInstallDir
  return Ensure-ProjectCheckout $targetDir
}

function Test-EnvEnabled {
  param(
    [string] $Name,
    [bool] $Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  $normalized = $value.Trim().ToLowerInvariant()
  if (@('1', 'true', 'yes', 'y', 'on') -contains $normalized) {
    return $true
  }
  if (@('0', 'false', 'no', 'n', 'off') -contains $normalized) {
    return $false
  }

  return $Default
}

function Split-ExtraArgs {
  param([string] $Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }

  return @($Value -split '\s+' | Where-Object { $_ })
}

function Get-NodeVersion {
  param([Parameter(Mandatory = $true)] [string] $NodeBin)

  try {
    $version = & $NodeBin -p 'process.versions.node' 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($version)) {
      return ($version | Select-Object -First 1).TrimStart('v')
    }
  } catch {
  }

  try {
    $version = & $NodeBin --version 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($version)) {
      return ($version | Select-Object -First 1).TrimStart('v')
    }
  } catch {
  }

  return $null
}

function Test-NodeRuntime {
  param(
    [Parameter(Mandatory = $true)] [string] $NodeBin,
    [Parameter(Mandatory = $true)] [string] $NpmBin,
    [bool] $RequireNpm = $true
  )

  if ($env:SKIP_NODE_CHECK -eq '1') {
    return $true
  }

  Update-SessionPath
  $version = Get-NodeVersion $NodeBin
  if ([string]::IsNullOrWhiteSpace($version)) {
    return $false
  }

  $parts = $version -split '\.'
  if ($parts.Count -lt 2) {
    return $false
  }

  $major = 0
  $minor = 0
  if (-not [int]::TryParse($parts[0], [ref] $major)) {
    return $false
  }
  if (-not [int]::TryParse($parts[1], [ref] $minor)) {
    return $false
  }
  if (-not (($major -gt 18) -or ($major -eq 18 -and $minor -ge 17))) {
    return $false
  }

  if ($RequireNpm) {
    try {
      & $NpmBin --version *> $null
      return $LASTEXITCODE -eq 0
    } catch {
      return $false
    }
  }

  return $true
}

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
$currentDir = (Get-Location).ProviderPath

if ($env:PROJECT_DIR) {
  $projectDir = [System.IO.Path]::GetFullPath($env:PROJECT_DIR)
} elseif (Test-ProjectDir $scriptDir) {
  $projectDir = $scriptDir
} elseif (Test-ProjectDir $currentDir) {
  $projectDir = $currentDir
} else {
  $projectDir = Bootstrap-ProjectDir
}

if ($InstallerArgs.Count -eq 0) {
  $InstallerArgs = @('install')
}

$env:PROJECT_DIR = $projectDir

$nodeBin = if ($env:INSTALL_NODE_BIN) { $env:INSTALL_NODE_BIN } else { 'node' }
$npmBin = if ($env:INSTALL_NPM_BIN) { $env:INSTALL_NPM_BIN } else { 'npm' }
$npmCommand = if ($env:INSTALL_NPM_COMMAND) { $env:INSTALL_NPM_COMMAND } else { 'install' }
$npmExtraArgsRaw = if ($env:INSTALL_NPM_EXTRA_ARGS) { $env:INSTALL_NPM_EXTRA_ARGS } else { '--no-fund --no-audit' }
$installer = Join-Path $projectDir 'src/install/cli.js'
$command = $InstallerArgs[0]
$installDepsEnabled = Test-EnvEnabled -Name 'INSTALL_DEPS' -Default $true

if ($command -eq 'install') {
  if (-not (Test-NodeRuntime -NodeBin $nodeBin -NpmBin $npmBin -RequireNpm $installDepsEnabled)) {
    if ($installDepsEnabled) {
      throw 'install.ps1: Node.js >= 18.17 with npm is required. Install Node.js, set INSTALL_NODE_BIN/INSTALL_NPM_BIN, or set SKIP_NODE_CHECK=1 to bypass this check.'
    }
    throw 'install.ps1: Node.js >= 18.17 is required. Install Node.js, set INSTALL_NODE_BIN, or set SKIP_NODE_CHECK=1 to bypass this check.'
  }
}

if ($command -eq 'install' -and $installDepsEnabled) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'package.json') -PathType Leaf)) {
    throw "install.ps1: package.json not found under PROJECT_DIR=$projectDir"
  }

  $npmExtraArgs = Split-ExtraArgs $npmExtraArgsRaw
  Write-Host "install.ps1: installing npm dependencies in $projectDir"
  Push-Location $projectDir
  try {
    & $npmBin $npmCommand @npmExtraArgs
    Assert-LastExitCode 'npm install'
  } finally {
    Pop-Location
  }
}

& $nodeBin $installer @InstallerArgs
Assert-LastExitCode 'node installer'

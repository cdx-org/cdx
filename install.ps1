[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $InstallerArgs
)

$ErrorActionPreference = 'Stop'

$DefaultInstallRepo = 'https://github.com/cdx-org/cdx.git'
$DefaultInstallRef = 'main'
$InstallRepo = if ($env:CDX_INSTALL_REPO) { $env:CDX_INSTALL_REPO } else { $DefaultInstallRepo }
$InstallRef = if ($env:CDX_INSTALL_REF) { $env:CDX_INSTALL_REF } else { $DefaultInstallRef }

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

  $marker = Join-Path $Path '.cdx-install-managed'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw "Install directory already exists and is not managed: $Path. Set CDX_INSTALL_DIR to another path or remove it manually."
  }

  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Bootstrap-ProjectDir {
  $targetDir = Get-DefaultInstallDir
  $parentDir = Split-Path -Parent $targetDir
  New-Item -ItemType Directory -Force -Path $parentDir | Out-Null

  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    if (Test-Path -LiteralPath (Join-Path $targetDir '.git') -PathType Container) {
      Write-Host "install.ps1: updating $targetDir from $InstallRepo ($InstallRef)"
      & git -C $targetDir remote set-url origin $InstallRepo
      Assert-LastExitCode 'git remote set-url'
      & git -C $targetDir fetch --depth 1 origin $InstallRef
      Assert-LastExitCode 'git fetch'
      & git -C $targetDir checkout --force FETCH_HEAD
      Assert-LastExitCode 'git checkout'
    } else {
      if (Test-Path -LiteralPath $targetDir) {
        Remove-ManagedInstallDir $targetDir
      }

      Write-Host "install.ps1: cloning $InstallRepo ($InstallRef) into $targetDir"
      & git clone --depth 1 --branch $InstallRef $InstallRepo $targetDir
      Assert-LastExitCode 'git clone'
    }

    New-Item -ItemType File -Force -Path (Join-Path $targetDir '.cdx-install-managed') | Out-Null
    return $targetDir
  }

  $archiveUrl = Get-GitHubArchiveUrl
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-cdx-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  try {
    $archivePath = Join-Path $tempRoot 'source.zip'
    Write-Host "install.ps1: downloading $archiveUrl into $targetDir"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempRoot -Force

    $sourceDir = Get-ChildItem -LiteralPath $tempRoot -Directory |
      Select-Object -First 1
    if (-not $sourceDir) {
      throw 'Downloaded archive did not contain a project directory.'
    }

    if (Test-Path -LiteralPath $targetDir) {
      Remove-ManagedInstallDir $targetDir
    }

    Copy-DirectoryContents -Source $sourceDir.FullName -Destination $targetDir
    New-Item -ItemType File -Force -Path (Join-Path $targetDir '.cdx-install-managed') | Out-Null
    return $targetDir
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
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

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
$remoteBootstrap = $false

if ($env:PROJECT_DIR) {
  $projectDir = [System.IO.Path]::GetFullPath($env:PROJECT_DIR)
} elseif (Test-ProjectDir $scriptDir) {
  $projectDir = $scriptDir
} else {
  $remoteBootstrap = $true
  $projectDir = Bootstrap-ProjectDir
}

if ($remoteBootstrap -and $InstallerArgs.Count -eq 0) {
  $InstallerArgs = @('install')
}

if ($InstallerArgs.Count -eq 0) {
  $InstallerArgs = @('help')
}

$env:PROJECT_DIR = $projectDir

$nodeBin = if ($env:INSTALL_NODE_BIN) { $env:INSTALL_NODE_BIN } else { 'node' }
$npmBin = if ($env:INSTALL_NPM_BIN) { $env:INSTALL_NPM_BIN } else { 'npm' }
$npmCommand = if ($env:INSTALL_NPM_COMMAND) { $env:INSTALL_NPM_COMMAND } else { 'install' }
$npmExtraArgsRaw = if ($env:INSTALL_NPM_EXTRA_ARGS) { $env:INSTALL_NPM_EXTRA_ARGS } else { '--no-fund --no-audit' }
$installer = Join-Path $projectDir 'src/install/cli.js'
$command = $InstallerArgs[0]

if ($command -eq 'install' -and (Test-EnvEnabled -Name 'INSTALL_DEPS' -Default $true)) {
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

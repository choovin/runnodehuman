# WeSight Windows distribution quickstart
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/windows-dist-quickstart.ps1
#
# Optional trusted-build Defender exclusion:
#   powershell -ExecutionPolicy Bypass -File scripts/windows-dist-quickstart.ps1 -EnableDefenderExclusion
#
# Optional bundled OpenClaw runtime build:
#   powershell -ExecutionPolicy Bypass -File scripts/windows-dist-quickstart.ps1 -BuildOpenClawRuntime

[CmdletBinding()]
param(
  [switch]$BuildOpenClawRuntime,
  [switch]$SkipPython,
  [switch]$NoSmokeChecklist,
  [switch]$EnableDefenderExclusion,
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $ProjectRoot

function Write-Section($Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Step($Command, [string[]]$Arguments, $FailureMessage) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

Write-Section 'Check Windows build environment'

$nodeVersion = (node --version) 2>$null
if (-not $nodeVersion) {
  throw 'Node.js was not found. Install Node.js 24 before packaging.'
}
$nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -ne 24) {
  throw "WeSight requires Node.js 24.x for packaging. Current version: $nodeVersion"
}
Write-Host "  Node: $nodeVersion" -ForegroundColor Green

$npmVersion = (npm --version) 2>$null
if (-not $npmVersion) {
  throw 'npm was not found.'
}
Write-Host "  npm:  $npmVersion" -ForegroundColor Green

$bashAvailable = (Test-Path 'resources/mingit/bin/bash.exe') -or (Test-Path 'resources/mingit/usr/bin/bash.exe')
if (-not $bashAvailable) {
  $systemBash = (where.exe bash 2>$null | Where-Object { $_ -notmatch 'WindowsApps' }) | Select-Object -First 1
  if ($systemBash) {
    Write-Host "  bash: $systemBash" -ForegroundColor Green
    $bashAvailable = $true
  }
}
if (-not $bashAvailable) {
  Write-Host '  bash: not found; setup:mingit will prepare PortableGit if OpenClaw runtime is requested.' -ForegroundColor Yellow
}

Write-Section '1/8 Install npm dependencies'
if (Test-Path 'node_modules') {
  Write-Host '  node_modules already exists; skipping npm install' -ForegroundColor Yellow
} else {
  Invoke-Step npm @('install') 'npm install failed.'
}

Write-Section '2/8 Prepare optional OpenClaw runtime'
if ($BuildOpenClawRuntime) {
  if (-not $bashAvailable) {
    Invoke-Step npm @('run', 'setup:mingit', '--', '--required') 'setup:mingit failed.'
  }
  Invoke-Step npm @('run', 'openclaw:runtime:win-x64') 'openclaw:runtime:win-x64 failed.'
  $env:WESIGHT_PACKAGE_OPENCLAW_RUNTIME = '1'
  Write-Host '  OpenClaw runtime will be bundled into this installer.' -ForegroundColor Yellow
} else {
  Remove-Item Env:\WESIGHT_PACKAGE_OPENCLAW_RUNTIME -ErrorAction SilentlyContinue
  Write-Host '  OpenClaw runtime bundling is disabled for this build.' -ForegroundColor Green
}

Write-Section '3/8 Prepare portable Python runtime'
$pythonExe = 'resources/python-win/python.exe'
if ($SkipPython -and (Test-Path $pythonExe)) {
  Write-Host "  --SkipPython and $pythonExe exists; skipping" -ForegroundColor Yellow
} else {
  Invoke-Step npm @('run', 'setup:python-runtime', '--', '--required') 'setup:python-runtime failed.'
}

Write-Section '4/8 Build renderer'
Invoke-Step npm @('run', 'build') 'build failed.'

Write-Section '5/8 Build skills'
Invoke-Step npm @('run', 'build:skills') 'build:skills failed.'

Write-Section '6/8 Compile Electron main process'
Invoke-Step npm @('run', 'compile:electron') 'compile:electron failed.'

Write-Section '7/8 Build Windows NSIS installer'
if ($EnableDefenderExclusion) {
  $env:WESIGHT_ENABLE_DEFENDER_EXCLUSION = '1'
  Write-Host '  Defender exclusion is enabled for this trusted build.' -ForegroundColor Yellow
} else {
  Remove-Item Env:\WESIGHT_ENABLE_DEFENDER_EXCLUSION -ErrorAction SilentlyContinue
  Write-Host '  Defender exclusion is disabled for this build.' -ForegroundColor Green
}
Invoke-Step npm @('run', 'dist:win') 'dist:win failed.'

Write-Section '8/8 Installer output'
$installer = if ($InstallerPath) {
  Resolve-Path $InstallerPath
} else {
  Get-ChildItem 'release/WeSight.Setup.*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if ($installer) {
  Write-Host "  Installer: $installer" -ForegroundColor Green
} else {
  Write-Host '  Installer was not found under release/.' -ForegroundColor Yellow
}

if (-not $NoSmokeChecklist) {
  Write-Section 'Manual smoke checklist'
  Write-Host '  1. Install the generated WeSight Setup executable and choose a non-default path once.'
  Write-Host '  2. Launch WeSight and confirm the app opens normally.'
  Write-Host '  3. If -EnableDefenderExclusion was used, confirm install-timing.log records defender-exclusion-add.'
  Write-Host '  4. Enable auto-launch in Settings, then uninstall WeSight.'
  Write-Host '  5. Confirm WeSight processes stop, the chosen install directory is removed, and auto-launch entries are gone.'
  Write-Host '  6. Confirm %TEMP%\WeSight-uninstall-cleanup.log records defender and auto-launch cleanup.'
}

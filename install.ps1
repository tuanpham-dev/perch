# Perch installer for Windows - clones the repo, builds it, puts the
# perch command on your PATH and adds a logon task so it starts when you
# sign in. No administrator rights; everything lives under your user profile.
# Safe to re-run: it updates an existing install instead of failing.
#
#   irm https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.ps1 | iex
#
# Override the source repo or install location for testing/forks:
#   $env:PERCH_REPO = 'C:\src\perch'; $env:PERCH_DIR = "$env:TEMP\tsv"; .\install.ps1
$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:PERCH_REPO) { $env:PERCH_REPO } else { 'https://github.com/tuanpham-dev/perch.git' }
$InstallDir = if ($env:PERCH_DIR) { $env:PERCH_DIR } else { Join-Path $env:LOCALAPPDATA 'perch\app' }

function Ok($msg) { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "[fail] $msg" -ForegroundColor Red; exit 1 }
function Heading($msg) { Write-Host ""; Write-Host $msg -ForegroundColor White }

Heading 'Checking dependencies'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git not found - install Git for Windows (https://git-scm.com/download/win)' }
Ok 'git found'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'node not found - install Node.js 23+ (https://nodejs.org)' }
$nodeVersion = (node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 23) { Die "node $nodeVersion found, but 23+ is required - install Node.js 23+ (https://nodejs.org)" }
Ok "node $nodeVersion"

if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
  Warn 'PowerShell 7 (pwsh) not found - terminals will use Windows PowerShell. Install it for a better shell: winget install Microsoft.PowerShell'
}

Heading "Installing to $InstallDir"

if (Test-Path (Join-Path $InstallDir '.git')) {
  Ok 'existing install found - updating'
  git -C $InstallDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Die 'git pull failed' }
} elseif (Test-Path $InstallDir) {
  Die "$InstallDir already exists and isn't a Perch checkout - remove it or set PERCH_DIR to a different path"
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  git clone --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
}
Ok 'source ready'

Heading 'Building'
Push-Location $InstallDir
try {
  npm install
  if ($LASTEXITCODE -ne 0) { Die 'npm install failed - if node-pty had to compile, install Visual Studio Build Tools with the C++ workload and try again' }
  npm run build
  if ($LASTEXITCODE -ne 0) { Die 'npm run build failed' }
} finally {
  Pop-Location
}
Ok 'build complete'

Heading 'Installing the perch command'
$binDir = Join-Path $InstallDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) | Where-Object { $_ }) -join ';', 'User')
  Ok "added $binDir to your PATH (new terminals will see it)"
} else {
  Ok "$binDir is already on your PATH"
}
$env:Path = "$env:Path;$binDir"

Heading 'Service'
node (Join-Path $binDir 'perch') enable

Heading 'Done'
Write-Host 'Perch is at http://127.0.0.1:3001'
Write-Host "Config (PORT, AUTH_TOKEN, ALLOWED_HOSTS, NEW_SESSION_CWD) goes in $InstallDir\server\.env - see docs/INSTALL.md."

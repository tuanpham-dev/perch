# Perch installer for Windows - clones the repo, builds it, puts the
# perch command on your PATH and adds a logon task so it starts when you
# sign in. No administrator rights; everything lives under your user profile.
# Safe to re-run: it updates an existing install instead of failing.
#
#   irm https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.ps1 | iex
#
# It installs the latest release. $env:PERCH_CHANNEL = 'beta' includes
# pre-releases, and $env:PERCH_REF = 'main' installs the main branch instead.
#
# Override the source repo or install location for testing/forks:
#   $env:PERCH_REPO = 'C:\src\perch'; $env:PERCH_DIR = "$env:TEMP\tsv"; .\install.ps1
$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:PERCH_REPO) { $env:PERCH_REPO } else { 'https://github.com/tuanpham-dev/perch.git' }
$InstallDir = if ($env:PERCH_DIR) { $env:PERCH_DIR } else { Join-Path $env:LOCALAPPDATA 'perch\app' }
$Channel = if ($env:PERCH_CHANNEL) { $env:PERCH_CHANNEL } else { 'stable' }
$Ref = $env:PERCH_REF

# The newest vX.Y.Z tag in `git ls-remote --tags` output on stdin (pre-releases
# only with 'beta'), by SemVer order - the same order perch update uses.
$PickTag = @'
const ch=process.argv[1];const P=/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;const key=t=>{const m=P.exec(t);return m&&{n:[+m[1],+m[2],+m[3]],p:m[4]?m[4].split('.'):[]}};const cmp=(a,b)=>{for(let i=0;i<3;i++)if(a.n[i]!==b.n[i])return a.n[i]-b.n[i];if(!a.p.length||!b.p.length)return b.p.length-a.p.length;for(let i=0;i<Math.max(a.p.length,b.p.length);i++){const x=a.p[i],y=b.p[i];if(x===undefined)return -1;if(y===undefined)return 1;if(x===y)continue;const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return x-y;if(xn)return -1;if(yn)return 1;return x<y?-1:1}return 0};let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{let best=null;for(const l of input.split('\n')){const r=(l.split('\t')[1]||'').trim().replace('refs/tags/','').replace('^{}','');const k=key(r);if(!k||(ch!=='beta'&&k.p.length))continue;if(!best||cmp(k,best.k)>0)best={r,k}}if(best)console.log(best.r)});
'@

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
  # perch update knows the rest: which release, never moving backwards,
  # reinstalling, rebuilding and restarting.
  $updateFlags = @()
  if ($Ref -eq 'main') { $updateFlags += '--main' }
  if ($Channel -eq 'beta') { $updateFlags += '--beta' }
  node (Join-Path $InstallDir 'bin\perch') update @updateFlags
  if ($LASTEXITCODE -ne 0) { Die 'perch update failed' }
} elseif (Test-Path $InstallDir) {
  Die "$InstallDir already exists and isn't a Perch checkout - remove it or set PERCH_DIR to a different path"
} else {
  if (-not $Ref) {
    $Ref = (git ls-remote --tags $RepoUrl | node -e $PickTag $Channel | Out-String).Trim()
    if (-not $Ref) {
      Warn "no $Channel release yet - installing the main branch"
      $Ref = 'main'
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  git -c advice.detachedHead=false clone --depth 1 --branch $Ref $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
  git -C $InstallDir config perch.track $(if ($Ref -eq 'main') { 'main' } else { 'release' })
  Ok "source ready ($Ref)"

  Heading 'Building'
  Push-Location $InstallDir
  try {
    # ci, not install: install rewrites package-lock.json, which perch update
    # would then see as a local change.
    npm ci
    if ($LASTEXITCODE -ne 0) { Die 'npm ci failed - if node-pty had to compile, install Visual Studio Build Tools with the C++ workload and try again' }
    npm run build
    if ($LASTEXITCODE -ne 0) { Die 'npm run build failed' }
  } finally {
    Pop-Location
  }
  Ok 'build complete'
}

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

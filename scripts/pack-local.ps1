# Pack → sync to release\local → restart Cursor Claw.
# Run DETACHED from Agent sessions, e.g.:
#   Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$PWD\scripts\pack-local.ps1" -WorkingDirectory $PWD
# Killing Cursor Claw will not kill this script if it was started detached.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDir = Join-Path $Root "temp"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ("pack-local-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))

function Write-Log([string]$msg) {
  $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-Log "=== pack-local start ==="
Write-Log "root=$Root log=$LogFile"

try {
  Write-Log "1/4 npm run pack:win"
  & npm run pack:win
  if ($LASTEXITCODE -ne 0) { throw "pack:win failed exit=$LASTEXITCODE" }

  $src = Join-Path $Root "release\win-unpacked"
  $dst = Join-Path $Root "release\local"
  if (-not (Test-Path (Join-Path $src "Cursor Claw.exe"))) {
    throw "missing packed exe: $src\Cursor Claw.exe"
  }

  Write-Log "2/4 stop Cursor Claw"
  Get-Process -Name "Cursor Claw" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "  stop pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  # retry if still alive
  Get-Process -Name "Cursor Claw" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "  force-kill pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1

  Write-Log "3/4 sync win-unpacked → local"
  if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null }
  # /MIR: mirror; /R:2 /W:2: retry locked files; /NFL /NDL: quieter
  & robocopy $src $dst /MIR /R:3 /W:2 /NFL /NDL /NJH /NJS
  $rc = $LASTEXITCODE
  # robocopy: 0-7 success-ish, >=8 failure
  if ($rc -ge 8) { throw "robocopy failed exit=$rc" }
  Write-Log "  robocopy exit=$rc"

  $exe = Join-Path $dst "Cursor Claw.exe"
  if (-not (Test-Path $exe)) { throw "sync missing exe: $exe" }

  Write-Log "4/4 start $exe"
  Start-Process -FilePath $exe -WorkingDirectory $dst
  Write-Log "=== pack-local done ==="
  exit 0
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
}

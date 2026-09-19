# Run / install Evabob locally with defines from dart_defines.json.
# This script intentionally produces no distributable APK.
# Usage:
#   .\run_prod.ps1
#   .\run_prod.ps1 -d emulator-5554
#   .\run_prod.ps1 install   # build APK + adb install
$ErrorActionPreference = "Stop"
$env:PATH = "C:\Users\victoren\develop\flutter\bin;C:\Users\victoren\AppData\Local\Android\sdk\platform-tools;$env:PATH"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
Set-Location $PSScriptRoot

if (-not (Test-Path ".\dart_defines.json")) {
  Write-Host "Missing dart_defines.json" -ForegroundColor Red
  exit 1
}

$defs = Get-Content dart_defines.json -Raw | ConvertFrom-Json
$defineArgs = @()
$defs.PSObject.Properties | ForEach-Object {
  $defineArgs += "--dart-define=$($_.Name)=$($_.Value)"
}

# API_BASE_URL was previously absent here, so builds silently fell back to the
# emulator loopback (10.0.2.2 is the emulator's alias for its own host). An APK
# built that way cannot reach a server from a real device.
$apiBase = $defs.API_BASE_URL
if ([string]::IsNullOrWhiteSpace($apiBase)) {
  Write-Host "API_BASE_URL is not set in dart_defines.json." -ForegroundColor Red
  Write-Host "Add it, or pass --dart-define=API_BASE_URL=https://<host> yourself." -ForegroundColor Red
  exit 1
}
if ($args.Count -ge 1 -and $args[0] -eq "install") {
  flutter build apk --debug @defineArgs
  $apk = "build\app\outputs\flutter-apk\app-debug.apk"
  if (-not (Test-Path $apk)) {
    Write-Host "APK missing: $apk" -ForegroundColor Red
    exit 1
  }
  # Prefer official AVD; fall back to every online android serial.
  $serials = @()
  $lines = adb devices | Select-Object -Skip 1
  foreach ($line in $lines) {
    if ($line -match '^(emulator-\d+)\s+device') { $serials += $Matches[1] }
    elseif ($line -match '^(\S+)\s+device') { $serials += $Matches[1] }
  }
  if ($serials.Count -eq 0) {
    Write-Host "No adb devices online" -ForegroundColor Red
    exit 1
  }
  foreach ($s in $serials) {
    Write-Host "Installing on $s ..."
    adb -s $s install -r $apk
    if ($LASTEXITCODE -eq 0) {
      adb -s $s shell am start -n com.evabob.evabob_mobile/.MainActivity
      Write-Host "Launched on $s" -ForegroundColor Green
    } else {
      Write-Host "Install failed on $s" -ForegroundColor Yellow
    }
  }
  Write-Host "Installed local debug build $apk. Do not distribute debug APKs."
  exit 0
}

flutter run @defineArgs @args

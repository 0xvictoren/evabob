# Open Evabob Flutter project in Android Studio with PATH fixed.
$ErrorActionPreference = "Stop"

$flutterBin = "C:\Users\victoren\develop\flutter\bin"
$projectDir = $PSScriptRoot
$studio = @(
  "$env:ProgramFiles\Android\Android Studio\bin\studio64.exe",
  "$env:LocalAppData\Programs\Android Studio\bin\studio64.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $studio) {
  Write-Host "Android Studio not found. Install it, then re-run." -ForegroundColor Red
  exit 1
}

$env:PATH = "$flutterBin;$env:PATH"
$env:FLUTTER_ROOT = "C:\Users\victoren\develop\flutter"
$env:ANDROID_HOME = "$env:LocalAppData\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Write-Host "Flutter: $env:FLUTTER_ROOT"
Write-Host "SDK:     $env:ANDROID_HOME"
Write-Host "Opening: $projectDir"
Write-Host ""
Write-Host "In Android Studio (do NOT use Windows desktop target):"
Write-Host "  1. Wait for Gradle sync / Flutter plugin indexing"
Write-Host "  2. Device Manager → start a Pixel emulator (API 34+)"
Write-Host "  3. Device dropdown → that Android emulator only"
Write-Host "  4. Run config: Evabob Android → Run ▶  (lib/main.dart)"
Write-Host "  5. Host API: cd server; npm run dev  (emulator uses 10.0.2.2:8787)"
Write-Host ""

# Ensure local.properties is correct (Gradle reads this)
$lp = Join-Path $projectDir "android\local.properties"
$flutterEsc = $env:FLUTTER_ROOT -replace '\\', '\\'
$sdkEsc = $env:ANDROID_HOME -replace '\\', '\\'
"flutter.sdk=$flutterEsc`nsdk.dir=$sdkEsc`n" | Set-Content $lp -Encoding ASCII
Write-Host "Wrote $lp"

# Prefetch packages so first AS sync is faster
Push-Location $projectDir
try {
  & "$flutterBin\flutter.bat" pub get 2>&1 | Out-Host
} finally {
  Pop-Location
}

Start-Process $studio -ArgumentList "`"$projectDir`""
Write-Host "Android Studio launching…"

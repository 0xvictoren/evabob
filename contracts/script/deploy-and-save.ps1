# Deploy IdentityRegistry + PaymentEscrow and write deployments/arc-testnet.json
# Loads PRIVATE_KEY from monorepo .env or environment (never logs the key).
$ErrorActionPreference = "Stop"
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$contracts = Resolve-Path (Join-Path $PSScriptRoot "..")
$envFile = Join-Path $root ".env"
function Get-EnvValue([string]$raw) {
  # Strip inline comments: KEY=value # comment
  $v = ($raw -split '#')[0]
  return $v.Trim().Trim('"').Trim("'").Trim()
}

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([^=]+)=(.*)$') {
      $k = $Matches[1].Trim()
      $v = Get-EnvValue $Matches[2]
      if ($k -and $v) {
        Set-Item -Path "Env:$k" -Value $v
      }
    }
  }
}

if (-not $env:PRIVATE_KEY) {
  Write-Host "ERROR: PRIVATE_KEY missing." -ForegroundColor Red
  Write-Host "Set a 32-byte hex EOA key: PRIVATE_KEY=0x + 64 hex chars"
  Write-Host "Fund it on Arc Testnet: https://faucet.circle.com (select Arc)"
  exit 1
}

$pk = (Get-EnvValue $env:PRIVATE_KEY) -replace '\s',''
if (-not $pk.StartsWith("0x") -and -not $pk.StartsWith("0X")) { $pk = "0x$pk" }
$hex = $pk.Substring(2)
if ($hex -notmatch '^[0-9a-fA-F]{64}$') {
  Write-Host "ERROR: PRIVATE_KEY is not a valid 64-hex-char EOA private key." -ForegroundColor Red
  Write-Host "Current length (hex body): $($hex.Length). Contains non-hex: $(-not ($hex -match '^[0-9a-fA-F]+$'))"
  Write-Host "Tip: remove inline comments after the key, or use PRIVATE_KEY=0x... with no spaces."
  exit 1
}
$env:PRIVATE_KEY = "0x$hex"

if (-not $env:ARC_TESTNET_RPC_URL) {
  if ($env:ARC_RPC_URL) {
    $env:ARC_TESTNET_RPC_URL = $env:ARC_RPC_URL
  } else {
    $env:ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network"
  }
}

$deployer = cast wallet address --private-key $env:PRIVATE_KEY
if (-not $env:CLAIM_ATTESTOR) { $env:CLAIM_ATTESTOR = $deployer }

Write-Host "RPC:      $($env:ARC_TESTNET_RPC_URL)"
Write-Host "Deployer: $deployer"
Write-Host "Attestor: $($env:CLAIM_ATTESTOR)"

$bal = cast balance $deployer --rpc-url $env:ARC_TESTNET_RPC_URL
Write-Host "Balance:  $bal wei"
if ([System.Numerics.BigInteger]::Parse($bal.ToString()) -lt 1000000000000000) {
  Write-Host "WARNING: very low balance - fund via https://faucet.circle.com (Arc Testnet USDC)" -ForegroundColor Yellow
}

Set-Location $contracts
forge build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

forge script script/Deploy.s.sol:Deploy --rpc-url $env:ARC_TESTNET_RPC_URL --broadcast --legacy -vvv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$broadcastDir = "broadcast/Deploy.s.sol/5042002"
if (-not (Test-Path $broadcastDir)) {
  Write-Host "No broadcast folder - deploy may have failed." -ForegroundColor Red
  exit 1
}
$run = Get-ChildItem $broadcastDir -Filter "run-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$json = Get-Content $run.FullName -Raw | ConvertFrom-Json

$registry = $null
$escrow = $null
foreach ($tx in $json.transactions) {
  if ($tx.contractName -eq "IdentityRegistry") { $registry = $tx.contractAddress }
  if ($tx.contractName -eq "PaymentEscrow") { $escrow = $tx.contractAddress }
}

$out = [ordered]@{
  network          = "arc-testnet"
  chainId          = 5042002
  rpc              = $env:ARC_TESTNET_RPC_URL
  explorer         = "https://testnet.arcscan.app"
  usdc             = "0x3600000000000000000000000000000000000000"
  eurc             = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"
  identityRegistry = $registry
  paymentEscrow    = $escrow
  deployer         = $deployer
  claimAttestor    = $env:CLAIM_ATTESTOR
  deployedAt       = (Get-Date).ToUniversalTime().ToString("o")
}

New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
$outPath = "deployments/arc-testnet.json"
($out | ConvertTo-Json) | Set-Content $outPath -Encoding UTF8
Write-Host "Wrote $outPath" -ForegroundColor Green
Write-Host "IdentityRegistry: $registry"
Write-Host "PaymentEscrow:    $escrow"
Write-Host ""
Write-Host "Add to monorepo .env:"
Write-Host "IDENTITY_REGISTRY=$registry"
Write-Host "PAYMENT_ESCROW=$escrow"

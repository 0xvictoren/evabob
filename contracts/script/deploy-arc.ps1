# Deploy IdentityRegistry + PaymentEscrow to Arc Testnet
# Prerequisites: Foundry, funded deployer key (https://faucet.circle.com)
#
# Usage:
#   $env:PRIVATE_KEY = "0x..."
#   $env:CLAIM_ATTESTOR = "0x..."   # optional; defaults to deployer
#   .\script\deploy-arc.ps1

$ErrorActionPreference = "Stop"
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"

if (-not $env:PRIVATE_KEY) {
  Write-Host "ERROR: Set PRIVATE_KEY to a funded Arc Testnet key." -ForegroundColor Red
  Write-Host "Get USDC: https://faucet.circle.com"
  exit 1
}

if (-not $env:ARC_TESTNET_RPC_URL) {
  $env:ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network"
}

# Derive deployer address for default attestor
$deployer = cast wallet address --private-key $env:PRIVATE_KEY
if (-not $env:CLAIM_ATTESTOR) {
  $env:CLAIM_ATTESTOR = $deployer
  Write-Host "CLAIM_ATTESTOR defaulted to deployer: $deployer"
}

Write-Host "RPC: $($env:ARC_TESTNET_RPC_URL)"
Write-Host "Deployer: $deployer"
Write-Host "Attestor: $($env:CLAIM_ATTESTOR)"

Push-Location $PSScriptRoot\..
try {
  forge build
  forge script script/Deploy.s.sol:Deploy `
    --rpc-url $env:ARC_TESTNET_RPC_URL `
    --broadcast `
    --legacy `
    -vvv

  # Parse latest broadcast for addresses
  $broadcastDir = "broadcast/Deploy.s.sol/5042002"
  if (Test-Path $broadcastDir) {
    $run = Get-ChildItem $broadcastDir -Filter "run-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($run) {
      Write-Host "Broadcast: $($run.FullName)"
      New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
      Copy-Item $run.FullName "deployments/arc-testnet-last-run.json" -Force
      Write-Host "Copied to deployments/arc-testnet-last-run.json"
    }
  }
} finally {
  Pop-Location
}

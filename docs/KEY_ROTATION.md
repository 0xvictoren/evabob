# Multisig and signer-separation runbook

Status: deployed and active on Arc Testnet on 2026-09-12.

## Current control map

The application has one 2-of-3 Safe for slow administrative decisions and
three separate hot wallets for routine work. Any two Safe owners must approve
an admin transaction.

| Role | Address | What it can do |
|---|---|---|
| Admin Safe | `0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2` | Rotate the identity linker, rotate the escrow attestor, disable a disputed identity, and manage Safe owners/threshold |
| Primary owner | `0xd72d85f18188EeE1ED8725721b3e54316F462cf7` | One Safe approval |
| Secondary owner | `0xF4Aa77A3cA4d8E5985ddf0Bbfa9dA3DA6a54111a` | One Safe approval |
| Recovery owner | `0xf7527C9929C420d6F6D0e0EF01b41E01c2E7a7d2` | One Safe approval; keep separate for recovery |
| Ops signer | `0x164d01fDa39aB22662bB2852231d0fB5DDF6A971` | Pays gas and moves the platform's working capital; no contract admin role |
| Identity linker | `0xDCE03B19533adBed83F4c75273A0ccef33a68832` | Creates verified identity links and unlinks only the exact current owner; cannot reassign a previously owned identity or rotate roles |
| Escrow attestor | `0x90447ca0c057120332DC141e4a68A7a684aEb8C2` | Releases a pending hold to the address resolved by the registry; cannot choose another recipient or rotate roles |

The Safe administers:

1. **Identity authority:** rotate the hot linker and perform emergency unlinks.
2. **Escrow authority:** rotate the hot release attestor.
3. **Governance recovery:** replace a lost Safe owner or change the approval threshold.

The Safe does not hold user money and does not sign normal payments. A lost or
offline Safe owner therefore cannot stop ordinary sends, onboarding, or valid
escrow releases as long as the hot role wallets are healthy.

## Deployed contracts

| Contract | Address | Admin |
|---|---|---|
| IdentityRegistryV2 | `0xb14355288fcE19811cccaF1589ea85e3791320a0` | Admin Safe |
| PaymentEscrowV2 | `0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805` | Admin Safe |

The replacement escrow held zero funds when activated. Six stored identities
were migrated to IdentityRegistryV2 with no conflicts. The previous contracts
remain readable for audit history but receive no new traffic.

## How 2-of-3 works

Use the primary and secondary wallets for planned changes. Keep the recovery
wallet signed out and on a separate device or browser profile. If either daily
wallet is lost, the remaining daily wallet and recovery wallet can replace it.

Using three soft wallets on the same device weakens this design because one
device compromise may expose enough owners to reach the threshold. Until
hardware wallets are available, use separate wallet apps or browser profiles,
different passwords, separate encrypted backups, and do not save all three
seed phrases in the same password manager or cloud account.

Each owner currently has `0.1` Arc Testnet USDC for approval gas. Arc Testnet
network settings:

```text
RPC: https://rpc.testnet.arc.network
Chain ID: 5042002
Currency symbol: USDC
Explorer: https://testnet.arcscan.app
```

## Review, approve, and execute an admin change

The repository manages the Safe directly because Arc Testnet is not listed by
Safe's hosted network interfaces. No transaction-service account is required.

### 1. Check the Safe

```powershell
cd server
npm run safe:admin -- status
```

Expected: threshold `2`, nonce equal to the next proposal nonce, and exactly
the three owner addresses above.

### 2. Prepare one operation

```powershell
# Rotate the automatic identity linker
npm run safe:admin -- prepare set-linker 0xNEW_LINKER

# Rotate the escrow release attestor
npm run safe:admin -- prepare set-attestor 0xNEW_ATTESTOR

# Disable a disputed identity key after an ownership review
npm run safe:admin -- prepare unlink 0xIDENTITY_KEY

# Replace a lost Safe owner while keeping 2-of-3
npm run safe:admin -- prepare replace-owner 0xOLD_OWNER 0xNEW_OWNER

# Change the Safe threshold (rare; keep it at 2 during normal operation)
npm run safe:admin -- prepare set-threshold 2
```

The command writes a public proposal under
`server/data/safe-transactions/` and prints the Safe address, chain ID, target,
calldata, nonce, transaction hash, and approval calldata. It does not sign or
send anything.

Both approving owners must independently compare the proposal with the intended
change. Reject it if the Safe, chain, target, new address, identity key, or nonce
is unexpected.

### 3. Approve from two owner wallets

Foundry can connect to a browser wallet without placing the owner's private key
in the command or repository. Run this once with each of two distinct owners,
using the `txHash` printed by the prepare step:

```powershell
$cast = "$env:USERPROFILE\.foundry\bin\cast.exe"
& $cast send 0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2 `
  "approveHash(bytes32)" 0xPROPOSAL_TX_HASH `
  --rpc-url https://rpc.testnet.arc.network --browser
```

The connected wallet must show one of the three owner addresses and Arc Testnet
before approval. Each approval is an on-chain transaction and uses a small
amount of that owner's testnet USDC balance.

### 4. Execute after two approvals

```powershell
cd server
npm run safe:admin -- execute data/safe-transactions/PROPOSAL_FILE.json
```

The executor validates the saved fields, recomputes the Safe transaction hash,
checks the current nonce, checks on-chain approvals, and simulates the call. It
then submits through the non-owner ops wallet, which pays gas. With fewer than
two approvals it fails before sending.

### 5. Verify

```powershell
npm run safe:admin -- status
```

Also check `GET /v1/health`. The healthy signer state is:

```json
{
  "identityLinkerMatches": true,
  "escrowAttestorMatches": true,
  "adminSafeMatches": true,
  "sharedKey": false,
  "safe": { "threshold": 2 }
}
```

After rotating a hot role, update its private key in `server/.env`, restart the
server, and require the matching health field to return `true`. Fund the new
role address with Arc Testnet USDC before removing the old role.

## Recovery rules

- If a primary or secondary owner is lost, use the other owner plus recovery to
  execute `replace-owner`. Do not lower the threshold just to avoid recovery.
- If the recovery owner is lost, primary plus secondary replace it immediately.
- If the linker is compromised, prepare `set-linker`, approve it with two
  owners, update the server key, and review identity events written since the
  suspected compromise. Sticky ownership prevents that linker from recycling a
  previously used identifier to an attacker.
- If the attestor is compromised, rotate it. It can release pending holds, but
  each release still pays only the registry-resolved recipient.
- If the ops signer is compromised, replace `PRIVATE_KEY` and move the remaining
  working balance. It holds no registry or escrow admin power.
- If two Safe owner wallets are lost without access to the third plus one
  recoverable key, the Safe cannot act. There is no administrator above it.

## Secret storage

Generated hot-role secrets are stored in the ignored file
`server/data/role-separation-secrets.json`. The pre-rotation environment backup
is `server/data/pre-role-separation.env`. Both contain private material, must
stay out of Git, and should be moved to encrypted operator storage after the
deployment has been independently verified. Never paste a private key or seed
phrase into an issue, chat, commit, or Safe proposal.

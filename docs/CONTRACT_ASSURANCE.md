# Contract assurance record

## Reproducible toolchain

- Foundry: `v1.3.5`
- Solidity: `0.8.24` (from `foundry.toml`)
- Slither: `0.11.6`
- CI runs `forge test` with the pinned Foundry release.

The Windows Foundry archive used for the local review matched the release
SHA-256 published by Foundry:
`c771e722b6cf497735d79c787bff3df6a3e77eca85bd51114c7eb15cf969c427`.

## 2026-09-21 result

`forge test` passed 79/79 tests. This includes 256-run fuzz properties for both
PaymentEscrowV2 and PaymentEscrowV3 covering the worker-or-payer settlement
invariant and claim/refund exclusivity.

Slither completed against 12 contracts and reported 46 findings. The material
items are reentrancy ordering warnings in legacy `MoneyCircles` and `GroupPots`.
Those contracts accept a token address but are intended to use Arc's known USDC
contract; this reduces exploitability but is not a general malicious-token
proof. The remaining output includes calls in loops, timestamp-dependent expiry
logic, event-after-transfer warnings, and style/interface observations.

No source-level contract remediation is represented as a production fix until
a replacement contract is independently reviewed and deployed. The application
continues to block new email-derived registry links, does not configure the
optional memo writer, and sends opaque random escrow references. Historical
on-chain identity/memo data is permanent.

## Release blockers outside this code change

- Independently audit any replacement contracts before mainnet.
- Verify deployed runtime bytecode against the exact reviewed source and
  constructor/immutable values.
- Put admin control in a multisig and separate linker, attestor, and operations
  roles before a production-chain launch.
- Resolve the known configured-attestor/deployed-attestor mismatch before escrow
  can be considered production-ready.

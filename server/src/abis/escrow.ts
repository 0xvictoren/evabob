/**
 * PaymentEscrowV2 on Arc.
 *
 * Differs from V1 in ways that matter to callers: `createTransfer` no longer
 * takes a password hash (the password claim path was front-runnable and is
 * gone), `transfers` therefore has one fewer field so `status` moved from
 * index 6 to 5, and `TransferCreated` carries the memo instead of a
 * password-protected flag.
 *
 * The events are declared here deliberately. Without them `TransferCreated`
 * cannot be decoded, and since the contract assigns the transfer id and it
 * appears nowhere but that event, a hold would be created with no id — which
 * means nobody could ever claim or refund it.
 */
export const paymentEscrowAbi = [
  {
    type: "function",
    name: "createTransfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipientKey", type: "bytes32" },
      { name: "amount", type: "uint128" },
      { name: "expirySeconds", type: "uint64" },
      { name: "memo", type: "string" },
    ],
    outputs: [{ name: "transferId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimWithAttestation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "transferId", type: "uint256" },
      { name: "claimer", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "transferId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transfers",
    stateMutability: "view",
    inputs: [{ name: "transferId", type: "uint256" }],
    outputs: [
      { name: "sender", type: "address" },
      { name: "recipientKey", type: "bytes32" },
      { name: "amount", type: "uint128" },
      { name: "createdAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "memo", type: "string" },
    ],
  },
  {
    type: "function",
    name: "claimTarget",
    stateMutability: "view",
    inputs: [{ name: "transferId", type: "uint256" }],
    outputs: [
      { name: "account", type: "address" },
      { name: "claimable", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "nextTransferId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimAttestor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setClaimAttestor",
    stateMutability: "nonpayable",
    inputs: [{ name: "next", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "TransferCreated",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "recipientKey", type: "bytes32", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
      { name: "expiresAt", type: "uint64", indexed: false },
      { name: "memo", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransferClaimed",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "claimer", type: "address", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TransferRefunded",
    inputs: [
      { name: "transferId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

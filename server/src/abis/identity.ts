export const identityRegistryAbi = [
  {
    type: "error",
    name: "NotAdmin",
    inputs: [],
  },
  {
    type: "error",
    name: "NotLinker",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyLinked",
    inputs: [],
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
    name: "linker",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "adminLink",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "idType", type: "uint8" },
      { name: "normalizedIdentifier", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveIdentifier",
    stateMutability: "view",
    inputs: [
      { name: "idType", type: "uint8" },
      { name: "normalizedIdentifier", type: "bytes" },
    ],
    outputs: [
      { name: "account", type: "address" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "linkerUnlink",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "adminUnlink",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setLinker",
    stateMutability: "nonpayable",
    inputs: [{ name: "next", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "identityKey",
    stateMutability: "pure",
    inputs: [
      { name: "idType", type: "uint8" },
      { name: "normalizedIdentifier", type: "bytes" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "keysOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

/**
 * IdType enum matching Solidity.
 *
 * These ordinals are hashed into every identity key already written on chain
 * (`keccak256(uint8(idType), identifier)`), so they can never be removed or
 * reordered — dropping Phone would renumber Email to 0 and silently break
 * every existing link. Add new types at the end only.
 *
 * Phone is retired: the product links email and handle only. The slot stays.
 */
export const IdType = {
  /** Retired — reserved so the remaining ordinals do not shift. */
  Phone: 0,
  Email: 1,
  Handle: 2,
} as const;

import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
} from "viem";
import { config } from "../config.js";
import { arcTransport } from "./arc-wallet.js";
import { readOrNull } from "../utils/read-or-null.js";

const erc20BalanceOf = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// The balance people see after every payment: quick to give up on a busy
// endpoint and move to the next, rather than waiting out a rate limit.
const client = createPublicClient({
  transport: arcTransport({ timeoutMs: 3_000, retryCount: 1 }),
});

export async function readTokenBalances(address: string): Promise<{
  usdc: number | null;
  eurc: number | null;
  cirbtc: number | null;
  nativeUsdcWei: string | null;
  /** True when at least one read failed, so the caller must not treat 0 as real. */
  partial: boolean;
}> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      usdc: 0,
      eurc: 0,
      cirbtc: 0,
      nativeUsdcWei: "0",
      partial: false,
    };
  }
  const addr = address as Address;

  const [usdcRaw, eurcRaw, cirbtcRaw, native] = await Promise.all([
    readOrNull(() =>
      client.readContract({
        address: config.arc.usdc,
        abi: erc20BalanceOf,
        functionName: "balanceOf",
        args: [addr],
      }),
    ),
    readOrNull(() =>
      client.readContract({
        address: config.arc.eurc,
        abi: erc20BalanceOf,
        functionName: "balanceOf",
        args: [addr],
      }),
    ),
    readOrNull(() =>
      client.readContract({
        address: config.arc.cirbtc,
        abi: erc20BalanceOf,
        functionName: "balanceOf",
        args: [addr],
      }),
    ),
    readOrNull(() => client.getBalance({ address: addr })),
  ]);

  return {
    usdc: usdcRaw === null ? null : Number(formatUnits(usdcRaw as bigint, 6)),
    eurc: eurcRaw === null ? null : Number(formatUnits(eurcRaw as bigint, 6)),
    // cirBTC uses 8 decimals (Bitcoin-style)
    cirbtc:
      cirbtcRaw === null ? null : Number(formatUnits(cirbtcRaw as bigint, 8)),
    // Arc native gas is USDC with 18 decimals
    nativeUsdcWei: native === null ? null : (native as bigint).toString(),
    partial:
      usdcRaw === null ||
      eurcRaw === null ||
      cirbtcRaw === null ||
      native === null,
  };
}

/** Public testnet RPCs + Circle USDC (and EURC when known) for multi-chain Assets. */
export const MULTICHAIN_ASSETS: Array<{
  id: string;
  name: string;
  domain: number | null;
  chainId: number;
  family: "evm" | "solana";
  rpcUrl: string;
  usdc?: Address;
  usdcDecimals?: number;
  eurc?: Address;
  eurcDecimals?: number;
  cirbtc?: Address;
  cirbtcDecimals?: number;
}> = [
  {
    id: "arc",
    name: "Arc Testnet",
    domain: 26,
    chainId: 5042002,
    family: "evm",
    rpcUrl: config.arc.rpcUrl,
    usdc: config.arc.usdc,
    usdcDecimals: 6,
    eurc: config.arc.eurc,
    eurcDecimals: 6,
    cirbtc: config.arc.cirbtc,
    cirbtcDecimals: 8,
  },
  {
    id: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    domain: 0,
    chainId: 11155111,
    family: "evm",
    rpcUrl:
      process.env.ETH_SEPOLIA_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdcDecimals: 6,
    eurc: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
    eurcDecimals: 6,
    cirbtc: "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3",
    cirbtcDecimals: 8,
  },
  {
    id: "base-sepolia",
    name: "Base Sepolia",
    domain: 6,
    chainId: 84532,
    family: "evm",
    rpcUrl:
      process.env.BASE_SEPOLIA_RPC_URL ||
      "https://base-sepolia-rpc.publicnode.com",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDecimals: 6,
    eurc: "0x808456652fdb597867f38412077A9182bf77359F",
    eurcDecimals: 6,
  },
  {
    id: "optimism-sepolia",
    name: "Optimism Sepolia",
    domain: 2,
    chainId: 11155420,
    family: "evm",
    rpcUrl:
      process.env.OP_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    usdcDecimals: 6,
  },
  {
    id: "arbitrum-sepolia",
    name: "Arbitrum Sepolia",
    domain: 3,
    chainId: 421614,
    family: "evm",
    rpcUrl:
      process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    usdcDecimals: 6,
  },
  {
    id: "avalanche-fuji",
    name: "Avalanche Fuji",
    domain: 1,
    chainId: 43113,
    family: "evm",
    rpcUrl:
      process.env.AVAX_FUJI_RPC_URL ||
      "https://api.avax-test.network/ext/bc/C/rpc",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    usdcDecimals: 6,
  },
  {
    id: "polygon-amoy",
    name: "Polygon Amoy",
    domain: 7,
    chainId: 80002,
    family: "evm",
    rpcUrl: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    usdcDecimals: 6,
  },
  {
    id: "linea-sepolia",
    name: "Linea Sepolia",
    domain: 11,
    chainId: 59141,
    family: "evm",
    rpcUrl: process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build",
    usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7",
    usdcDecimals: 6,
  },
  {
    id: "unichain-sepolia",
    name: "Unichain Sepolia",
    domain: 10,
    chainId: 1301,
    family: "evm",
    rpcUrl: process.env.UNICHAIN_SEPOLIA_RPC_URL || "https://sepolia.unichain.org",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    usdcDecimals: 6,
  },
  {
    id: "sonic-testnet",
    name: "Sonic Testnet",
    domain: 13,
    chainId: 14601,
    family: "evm",
    rpcUrl: process.env.SONIC_TESTNET_RPC_URL || "https://rpc.testnet.soniclabs.com",
  },
];

export type ChainBalanceRow = {
  id: string;
  name: string;
  domain: number | null;
  chainId: number;
  family: string;
  address: string;
  usdc: number;
  eurc: number;
  cirbtc: number;
  error?: string;
};

function rpcUrlsFor(ch: (typeof MULTICHAIN_ASSETS)[number]): string[] {
  const extra: string[] = [];
  if (ch.id === "ethereum-sepolia") {
    extra.push(
      process.env.ETH_SEPOLIA_RPC_URL || "",
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
    );
  } else if (ch.id === "base-sepolia") {
    extra.push(
      process.env.BASE_SEPOLIA_RPC_URL || "",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
      "https://sepolia.base.org",
    );
  } else if (ch.id === "arc") {
    extra.push(config.arc.rpcUrl, ...config.arc.rpcFallbackUrls);
  } else {
    extra.push(ch.rpcUrl);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of extra) {
    const u = raw.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.length > 0 ? out : [ch.rpcUrl];
}

async function readErc20(
  rpcUrl: string,
  token: Address,
  holder: Address,
  decimals: number,
  timeoutMs: number,
): Promise<number> {
  const c = createPublicClient({
    transport: http(rpcUrl, { timeout: timeoutMs }),
  });
  const raw = await c.readContract({
    address: token,
    abi: erc20BalanceOf,
    functionName: "balanceOf",
    args: [holder],
  });
  return Number(formatUnits(raw as bigint, decimals));
}

async function readErc20Fallback(
  urls: string[],
  token: Address,
  holder: Address,
  decimals: number,
  timeoutMs: number,
): Promise<number> {
  let last: unknown;
  for (const url of urls) {
    try {
      return await readErc20(url, token, holder, decimals, timeoutMs);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("all RPCs failed");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const APPKIT_TO_ASSET_ID: Record<string, string> = {
  Arc_Testnet: "arc",
  Arc: "arc",
  Ethereum_Sepolia: "ethereum-sepolia",
  Ethereum: "ethereum-sepolia",
  Base_Sepolia: "base-sepolia",
  Base: "base-sepolia",
};

/** One token's human units on a product chain (null if the RPC read failed). */
export async function readChainTokenBalance(input: {
  address: string;
  chain: string;
  token?: string;
}): Promise<number | null> {
  const id = APPKIT_TO_ASSET_ID[input.chain] || input.chain;
  const rows = await readMultiChainBalances(input.address, {
    ids: [id],
    timeoutMs: 6_000,
  });
  const row = rows[0];
  if (!row || row.error) return null;
  const token = (input.token || "USDC").trim().toUpperCase();
  if (token === "EURC") return row.eurc;
  if (token === "CIRBTC") return row.cirbtc;
  return row.usdc;
}

/** Parallel multi-chain USDC/EURC/cirBTC for an EVM address. */
export async function readMultiChainBalances(
  address: string,
  opts?: { ids?: string[]; timeoutMs?: number },
): Promise<ChainBalanceRow[]> {
  const evmOk = /^0x[a-fA-F0-9]{40}$/.test(address);
  if (!evmOk) return [];
  const holder = address as Address;
  const timeoutMs = opts?.timeoutMs ?? 4_000;
  const wanted = opts?.ids ? new Set(opts.ids) : null;
  const assets = wanted
    ? MULTICHAIN_ASSETS.filter((ch) => wanted.has(ch.id))
    : MULTICHAIN_ASSETS;

  const jobs = assets.map(async (ch): Promise<ChainBalanceRow> => {
    const base: ChainBalanceRow = {
      id: ch.id,
      name: ch.name,
      domain: ch.domain,
      chainId: ch.chainId,
      family: ch.family,
      address: holder,
      usdc: 0,
      eurc: 0,
      cirbtc: 0,
    };
    if (ch.family !== "evm") {
      return { ...base, error: "Unsupported chain family" };
    }
    try {
      const urls = rpcUrlsFor(ch);
      const perRpc = Math.min(4_000, timeoutMs);
      const reads: Promise<void>[] = [];
      if (ch.usdc) {
        reads.push(
          readErc20Fallback(
            urls,
            ch.usdc,
            holder,
            ch.usdcDecimals ?? 6,
            perRpc,
          ).then((v) => {
            base.usdc = v;
          }),
        );
      }
      if (ch.eurc) {
        reads.push(
          readErc20Fallback(
            urls,
            ch.eurc,
            holder,
            ch.eurcDecimals ?? 6,
            perRpc,
          ).then((v) => {
            base.eurc = v;
          }),
        );
      }
      if (ch.cirbtc) {
        reads.push(
          readErc20Fallback(
            urls,
            ch.cirbtc,
            holder,
            ch.cirbtcDecimals ?? 8,
            perRpc,
          ).then((v) => {
            base.cirbtc = v;
          }),
        );
      }
      await withTimeout(Promise.all(reads), Math.max(timeoutMs, 12_000), ch.id);
      return base;
    } catch (e) {
      return {
        ...base,
        error: e instanceof Error ? e.message : "balance read failed",
      };
    }
  });

  return Promise.all(jobs);
}

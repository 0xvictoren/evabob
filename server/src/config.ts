import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const candidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
  resolve(process.cwd(), "server/.env"),
];
for (const p of candidates) {
  if (existsSync(p)) {
    loadEnv({ path: p });
    break;
  }
}

function req(name: string, fallback = ""): string {
  const raw = process.env[name]?.trim() || "";
  const v = raw.split("#")[0]?.trim() || "";
  return v || fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = req(name);
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export const config = {
  port: Number(process.env.PORT || 8787),
  host: req("HOST", "0.0.0.0"),
  nodeEnv: req("NODE_ENV", "development"),
  deploymentEnv: (() => {
    const value = req(
      "EVABOB_ENV",
      req("NODE_ENV", "development") === "production" ? "production" : "local",
    );
    if (value !== "local" && value !== "testnet" && value !== "production") {
      throw new Error("EVABOB_ENV must be local, testnet, or production");
    }
    return value;
  })() as "local" | "testnet" | "production",
  productionLaunchEnabled: req("ENABLE_PRODUCTION_LAUNCH", "false") === "true",
  appName: req("APP_NAME", "evabob"),

  /**
   * Application auth. Callers are identified by a Dynamic JWT verified
   * against Dynamic's JWKS.
   *
   * `allowHeaderFallback` re-enables the legacy `x-user-id` header as an
   * identity claim. That header is attacker-controlled, so anyone can
   * impersonate anyone while it is on. It exists for local development and
   * demo-mode builds ONLY and must stay off anywhere reachable by others.
   */
  auth: {
    allowHeaderFallback: req("ALLOW_HEADER_AUTH", "false") === "true",
    operatorUserIds: req("OPERATOR_USER_IDS").split(",").map(s => s.trim()).filter(Boolean),
  },

  /**
   * Browser origins allowed to call the API. Native mobile clients are not
   * subject to CORS and are unaffected. "*" allows every site to issue
   * cross-origin calls — keep it to an explicit list outside development.
   */
  corsOrigins: req("CORS_ORIGINS", "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  /** Externally reachable API URL. Required and HTTPS in production. */
  publicApiUrl: req("API_PUBLIC_URL"),

  /** Dynamic Labs — app login only (JWT). API token stays server-side. */
  dynamic: {
    environmentId: req(
      "DYNAMIC_ENVIRONMENT_ID",
      "5be16cc5-2968-4265-a14b-86caf3963a72",
    ),
    apiToken: req("DYNAMIC_API_TOKEN"),
  },

  circle: {
    walletsAppId: req(
      "CIRCLE_WALLETS_APP_ID",
      "9aed57be-b4be-52a2-a9ce-610af36e6055",
    ),
    apiKey: req("CIRCLE_API_KEY"),
    entitySecret: req("CIRCLE_ENTITY_SECRET"),
    apiBase: req("CIRCLE_API_BASE", "https://api.circle.com"),
  },

  /**
   * Circle App Kit — Send / Bridge / Swap / Unified Balance.
   * Prefer App Kit for money movement; keep legacy CCTP/Gateway/Synthra
   * behind feature flags until parity is confirmed (see new.md).
   */
  appKit: {
    /** Master switch — when true, chat + API prefer App Kit paths. */
    enabled: req("USE_APP_KIT", "true") !== "false",
    /** Circle Console kit key (Swap rate limits / production). */
    kitKey: req("KIT_KEY") || req("CIRCLE_KIT_KEY"),
    /**
     * Default server adapter for ops/treasury:
     * circle-wallets (dev-controlled) | viem-ops (PRIVATE_KEY)
     */
    defaultAdapter: (req("APP_KIT_ADAPTER", "circle-wallets") === "viem-ops"
      ? "viem-ops"
      : "circle-wallets") as "circle-wallets" | "viem-ops",
    /**
     * Default developer-controlled Circle wallet (EVM) used when
     * `fromAddress` / `toAddress` are omitted on App Kit ops routes.
     * Per-chain DC wallets may share this address (SCA) or differ (EOA).
     */
    dcWalletAddress: (req("APP_KIT_DC_WALLET") ||
      req("CIRCLE_DC_WALLET") ||
      "0x61e6eb8f14569ca0d0d348e8aac5f32c04e16b0c") as `0x${string}`,
    /** Platform fee recipient (0x…) for bridge/swap monetization. */
    feeRecipient: req("APP_KIT_FEE_RECIPIENT"),
    /** Fee in basis points (100 = 1%). 0 disables custom fees. */
    feeBps: Number(process.env.APP_KIT_FEE_BPS || 0),
    /** Keep legacy /v1/cctp, /v1/gateway, /v1/synthra routes mounted. */
    keepLegacyRoutes: req("APP_KIT_KEEP_LEGACY", "true") !== "false",
  },

  /**
   * Agent spend wallets. Balances are credited only from verified on-chain
   * funding (see services/agentFunding.ts), so the ledger cannot exceed what
   * actually arrived. These are the secondary rails: a caller still chooses
   * their own daily limit at creation, so it is clamped, and a per-user
   * ceiling bounds the blast radius if a single agent is compromised.
   */
  agents: {
    maxDailyLimitUsdc: Number(process.env.AGENT_MAX_DAILY_LIMIT_USDC || 100),
    maxUserDailySpendUsdc: Number(
      process.env.AGENT_MAX_USER_DAILY_SPEND_USDC || 250,
    ),
    resourceOrigins: req("AGENT_RESOURCE_ORIGINS")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  },

  /**
   * Server-authoritative product capabilities. A hosted environment may only
   * advertise an action after its provider, credentials and route have been
   * proved there. Mobile treats an absent/false value as unavailable.
   */
  features: {
    directSend: envFlag("FEATURE_DIRECT_SEND", true),
    protectedSend: envFlag("FEATURE_PROTECTED_SEND", false),
    requests: envFlag("FEATURE_REQUESTS", true),
    gateway: envFlag("FEATURE_GATEWAY", false),
    conversion: envFlag("FEATURE_CONVERSION", false),
    bridgeRoutes: req("FEATURE_BRIDGE_ROUTES")
      .split(",")
      .map((route) => route.trim())
      .filter(Boolean),
    agentWallets: envFlag("FEATURE_AGENT_WALLETS", false),
    x402Execution: envFlag("FEATURE_X402_EXECUTION", false),
    /** Arc Multicall3From batch transfer. Kept off until direct EOA funding,
     * simulation and receipt verification are all wired end to end. */
    agentBatchSend: envFlag("FEATURE_AGENT_BATCH_SEND", false),
    bankTopUp: false,
    cardTopUp: false,
    cashOut: false,
    whatsappInvites: false,
  },

  arc: {
    rpcUrl: req("ARC_RPC_URL", "https://rpc.testnet.arc.network"),
    chainId: Number(process.env.ARC_CHAIN_ID || 5042002),
    usdc: "0x3600000000000000000000000000000000000000" as const,
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const,
    /** Circle Wrapped Bitcoin (cirBTC) on Arc Testnet — 8 decimals */
    cirbtc: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF" as const,
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const,
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const,
    cctpDomain: 26,
    identityRegistry: req("IDENTITY_REGISTRY"),
    paymentEscrow: req("PAYMENT_ESCROW"),
    /** Ops signer: gas + working-capital USDC. Holds no contract admin role. */
    privateKey: req("PRIVATE_KEY"),
    /** Hot IdentityRegistry linker. The registry admin is the Safe multisig. */
    identityLinkerPrivateKey: req(
      "IDENTITY_LINKER_PRIVATE_KEY",
      req("IDENTITY_ADMIN_PRIVATE_KEY"),
    ),
    /** Expected Safe address, used for startup/health verification. */
    adminSafeAddress: req("ADMIN_SAFE_ADDRESS"),
    /** Releases held payments. See getEscrowAttestorAccount(). */
    escrowAttestorPrivateKey: req("ESCROW_ATTESTOR_PRIVATE_KEY"),
  },

  gatewayApiBase: req(
    "GATEWAY_API_BASE",
    "https://gateway-api-testnet.circle.com/v1",
  ),

  pusher: {
    appId: req("PUSHER_APP_ID"),
    key: req("PUSHER_KEY"),
    secret: req("PUSHER_SECRET"),
    cluster: req("PUSHER_CLUSTER", "mt1"),
  },

  /** Mailtrap / SMTP for claim + receive notifications */
  smtp: {
    host: req("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT || 2525),
    user: req("SMTP_USER"),
    pass: req("SMTP_PASS"),
    from: req("SMTP_FROM", "Evabob <noreply@evabob.app>"),
    secure: req("SMTP_SECURE", "false") === "true",
  },

  /** Used in claim-link emails (deep link or web URL) */
  appPublicUrl: req("APP_PUBLIC_URL", "https://evabob.app"),

  /** Synthra trading API (server-only key) — https://docs.synthra.org/reference */
  synthra: {
    apiKey: req("SYNTHRA_API_KEY"),
    baseUrl: req("SYNTHRA_API_BASE", "https://trading-api.synthra.org"),
  },

  /**
   * ExchangeRate-API key for display FX (USD/USDC → NGN).
   * Server-only — mobile fetches via GET /v1/fx/rates.
   * https://www.exchangerate-api.com/docs/standard-requests
   */
  exchangeRateApiKey: req("EXCHANGE_RATE_API_KEY"),

  /** MongoDB for users, avatars, protected escrows (optional — JSON fallback). */
  mongo: {
    uri: req("MONGODB_URI"),
    dbName: req("MONGODB_DB", "evabob"),
  },

  /**
   * Groq LLM for Evabob Agent natural-language fallback.
   * Deterministic parser always runs first; key is server-only.
   */
  groq: {
    apiKey: req("GROQ_API_KEY"),
    // Must be a model that supports tool calling — the agent's read tools
    // depend on it. `llama-3.3-70b-versatile` was the default until Groq
    // decommissioned it, at which point every agent call 404'd and silently
    // fell back to the regex parser, which is why the assistant felt canned.
    model: req("GROQ_MODEL", "openai/gpt-oss-120b"),
  },

  /** WhatsApp Cloud API (optional until you provide credentials). */
  whatsapp: {
    token: req("WHATSAPP_TOKEN"),
    phoneNumberId: req("WHATSAPP_PHONE_NUMBER_ID"),
    apiBase: req(
      "WHATSAPP_API_BASE",
      "https://graph.facebook.com/v19.0",
    ),
  },
} as const;

/** Reserved @handles that cannot be claimed. */
export const RESERVED_HANDLES = new Set([
  "admin",
  "evabob",
  "sendit",
  "bob",
  "support",
  "help",
  "system",
  "root",
  "api",
  "null",
  "undefined",
  "official",
  "team",
  "security",
]);

/** Product-supported chains only: Arc Testnet, Ethereum Sepolia, Base Sepolia. */
export const DEPOSIT_CHAINS = [
  {
    id: "arc",
    name: "Arc Testnet",
    family: "evm",
    domain: 26,
    kind: "gateway" as const,
    appKit: "Arc_Testnet" as const,
  },
  {
    id: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    family: "evm",
    domain: 0,
    kind: "gateway" as const,
    appKit: "Ethereum_Sepolia" as const,
  },
  {
    id: "base-sepolia",
    name: "Base Sepolia",
    family: "evm",
    domain: 6,
    kind: "gateway" as const,
    appKit: "Base_Sepolia" as const,
  },
] as const;

export const SUPPORTED_APPKIT_CHAINS = [
  "Arc_Testnet",
  "Ethereum_Sepolia",
  "Base_Sepolia",
] as const;

export type ProductionSafetyConfig = {
  nodeEnv: string;
  deploymentEnv?: "local" | "testnet" | "production";
  productionLaunchEnabled?: boolean;
  allowHeaderAuth: boolean;
  corsOrigins: readonly string[];
  mongoUri: string;
  publicApiUrl: string;
  appPublicUrl: string;
  adminSafeAddress: string;
  opsPrivateKey: string;
  identityLinkerPrivateKey: string;
  escrowAttestorPrivateKey: string;
  onchainEmailLinks: boolean;
  onchainMemos: boolean;
  externalLlm: boolean;
};

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** Refuses production startup when identity or session traffic could be unsafe. */
export function assertProductionSafety(input: ProductionSafetyConfig): void {
  const environment = input.deploymentEnv ??
    (input.nodeEnv === "production" ? "production" : "local");
  if (environment === "local") return;
  const errors: string[] = [];
  if (environment === "production" && !input.productionLaunchEnabled) {
    errors.push("ENABLE_PRODUCTION_LAUNCH must be true after mainnet configuration is complete");
  }
  if (input.nodeEnv !== "production") {
    errors.push("NODE_ENV must be production for a hosted environment");
  }
  if (input.allowHeaderAuth) errors.push("ALLOW_HEADER_AUTH must be false");
  if (!input.mongoUri) errors.push("MONGODB_URI is required");
  if (!input.publicApiUrl || !exactHttpsOrigin(input.publicApiUrl)) {
    errors.push("API_PUBLIC_URL must be an exact HTTPS origin");
  }
  if (!exactHttpsOrigin(input.appPublicUrl)) {
    errors.push("APP_PUBLIC_URL must be an exact HTTPS origin");
  }
  if (input.onchainEmailLinks) {
    errors.push("FEATURE_ONCHAIN_EMAIL_LINKS must remain false until the privacy redesign is complete");
  }
  if (input.onchainMemos) {
    errors.push("FEATURE_ONCHAIN_MEMOS must remain false until free-text chain writes are removed");
  }
  if (input.externalLlm) {
    errors.push("FEATURE_EXTERNAL_LLM must remain false until privacy controls are approved");
  }
  if (
    input.corsOrigins.length === 0 ||
    input.corsOrigins.includes("*") ||
    input.corsOrigins.some((origin) => !exactHttpsOrigin(origin))
  ) {
    errors.push("CORS_ORIGINS must contain only explicit HTTPS origins");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.adminSafeAddress)) {
    errors.push("ADMIN_SAFE_ADDRESS is required");
  }
  const hotKeys = [
    input.opsPrivateKey,
    input.identityLinkerPrivateKey,
    input.escrowAttestorPrivateKey,
  ].map((key) => key.trim().toLowerCase().replace(/^0x/, ""));
  if (hotKeys.some((key) => !/^[0-9a-f]{64}$/.test(key))) {
    errors.push("all three hot signer keys must be explicitly configured");
  } else if (new Set(hotKeys).size !== hotKeys.length) {
    errors.push("ops, identity linker, and escrow attestor keys must be distinct");
  }
  if (errors.length) {
    throw new Error(`Unsafe ${environment} configuration: ${errors.join("; ")}`);
  }
}

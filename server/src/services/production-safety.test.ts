import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionSafety } from "./production-safety.js";

const safe = {
  nodeEnv: "production",
  deploymentEnv: "production" as const,
  productionLaunchEnabled: true,
  allowHeaderAuth: false,
  corsOrigins: ["https://evabob.app"],
  mongoUri: "mongodb://database/evabob",
  publicApiUrl: "https://api.evabob.app",
  appPublicUrl: "https://evabob.app",
  adminSafeAddress: "0x1111111111111111111111111111111111111111",
  opsPrivateKey: `0x${"11".repeat(32)}`,
  identityLinkerPrivateKey: `0x${"22".repeat(32)}`,
  escrowAttestorPrivateKey: `0x${"33".repeat(32)}`,
  onchainEmailLinks: false,
  onchainMemos: false,
  externalLlm: false,
} as const;

test("accepts an explicit HTTPS production configuration", () => {
  assert.doesNotThrow(() => assertProductionSafety(safe));
});

test("accepts testnet only when it uses hosted production runtime settings", () => {
  assert.doesNotThrow(() => assertProductionSafety({
    ...safe,
    deploymentEnv: "testnet",
    productionLaunchEnabled: false,
    onchainEmailLinks: true,
    onchainMemos: true,
    externalLlm: true,
  }));
  assert.throws(
    () => assertProductionSafety({
      ...safe,
      deploymentEnv: "testnet",
      nodeEnv: "development",
    }),
    /Unsafe testnet configuration/,
  );
});

test("production stays locked until the mainnet launch flag is explicit", () => {
  assert.throws(
    () => assertProductionSafety({ ...safe, productionLaunchEnabled: false }),
    /ENABLE_PRODUCTION_LAUNCH/,
  );
});

test("production fails closed for impersonation, wildcard CORS, HTTP, or no Mongo", () => {
  for (const patch of [
    { allowHeaderAuth: true },
    { corsOrigins: ["*"] },
    { publicApiUrl: "http://api.evabob.app" },
    { mongoUri: "" },
    { adminSafeAddress: "" },
    { identityLinkerPrivateKey: "" },
    { escrowAttestorPrivateKey: safe.opsPrivateKey },
    { onchainEmailLinks: true },
    { onchainMemos: true },
    { externalLlm: true },
  ]) {
    assert.throws(
      () => assertProductionSafety({ ...safe, ...patch }),
      /Unsafe production configuration/,
    );
  }
});

test("development remains usable with local defaults", () => {
  assert.doesNotThrow(() => assertProductionSafety({
    ...safe,
    deploymentEnv: "local",
    productionLaunchEnabled: false,
    nodeEnv: "development",
    allowHeaderAuth: true,
    corsOrigins: ["*"],
    mongoUri: "",
    publicApiUrl: "",
  }));
});

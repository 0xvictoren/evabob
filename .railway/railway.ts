import {
  defineRailway,
  github,
  group,
  mongo,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

const repository = "0xvictoren/evabob";
const region = "europe-west4-drams3a";

export default defineRailway((ctx) => {
  const production = ctx.environment === "production";
  const environment = production ? "production" : "testnet";
  const webDomain = production ? "evabob.app" : "testnet.evabob.app";
  const apiDomain = production ? "api.evabob.app" : "api-testnet.evabob.app";

  const database = mongo("mongo");
  const apiData = volume("api-data", {
    region,
    sizeMB: 1024,
  });

  const api = service("api", {
    source: github(repository, {
      branch: "main",
      rootDirectory: "server",
    }),
    healthcheck: "/health/ready",
    healthcheckTimeout: 300,
    replicas: { [region]: 1 },
    domains: [{ domain: apiDomain, port: 8787 }],
    volumeMounts: {
      "/data": apiData,
    },
    env: {
      NODE_ENV: "production",
      EVABOB_ENV: environment,
      ENABLE_PRODUCTION_LAUNCH: "false",
      HOST: "0.0.0.0",
      DATA_DIR: "/data",
      API_PUBLIC_URL: `https://${apiDomain}`,
      APP_PUBLIC_URL: `https://${webDomain}`,
      CORS_ORIGINS: `https://${webDomain}`,
      ALLOW_HEADER_AUTH: "false",
      MONGODB_URI: database.env.MONGO_URL,
      MONGODB_DB: production ? "evabob" : "evabob_testnet",
      ARC_RPC_URL: production
        ? preserve()
        : "https://rpc.testnet.arc.network",
      ARC_CHAIN_ID: production ? preserve() : "5042002",
      GATEWAY_API_BASE: production
        ? preserve()
        : "https://gateway-api-testnet.circle.com/v1",
      CIRCLE_API_KEY: preserve(),
      CIRCLE_ENTITY_SECRET: preserve(),
      CIRCLE_WALLETS_APP_ID: preserve(),
      DYNAMIC_ENVIRONMENT_ID: preserve(),
      DYNAMIC_API_TOKEN: preserve(),
      PRIVATE_KEY: preserve(),
      IDENTITY_LINKER_PRIVATE_KEY: preserve(),
      ESCROW_ATTESTOR_PRIVATE_KEY: preserve(),
      ADMIN_SAFE_ADDRESS: production
        ? preserve()
        : "0xe2Ef46038d30F80B39DA2E775F637BE2fa2635A2",
      IDENTITY_REGISTRY: production
        ? preserve()
        : "0xb14355288fcE19811cccaF1589ea85e3791320a0",
      PAYMENT_ESCROW: production
        ? preserve()
        : "0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39",
      OPERATOR_USER_IDS: preserve(),
      DEEPSEEK_API_KEY: preserve(),
      KIT_KEY: preserve(),
      APP_KIT_DC_WALLET: preserve(),
      APP_KIT_FEE_RECIPIENT: preserve(),
      AGENT_RESOURCE_ORIGINS: preserve(),
      EXCHANGE_RATE_API_KEY: preserve(),
      PUSHER_APP_ID: preserve(),
      PUSHER_KEY: preserve(),
      PUSHER_SECRET: preserve(),
      PUSHER_CLUSTER: preserve(),
      SMTP_HOST: preserve(),
      SMTP_PORT: preserve(),
      SMTP_USER: preserve(),
      SMTP_PASS: preserve(),
      SMTP_FROM: preserve(),
      SMTP_SECURE: preserve(),
    },
  });

  const web = service("web", {
    source: github(repository, { branch: "main" }),
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: { [region]: 1 },
    domains: [{ domain: webDomain, port: 3000 }],
    env: {
      NODE_ENV: "production",
      EVABOB_ENV: environment,
      NEXT_PUBLIC_API_BASE_URL: `https://${apiDomain}`,
    },
  });

  return project("evabob", {
    resources: [
      group("Application", [web, api]),
      group("Data", [database, apiData]),
    ],
  });
});

import { serve } from "@hono/node-server";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.js";
import { dataDir, dataPath } from "./utils/data-path.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  GENERAL,
  ONBOARDING,
  SENSITIVE,
  rateLimit,
} from "./middleware/rate-limit.js";
import { appKitConfigured } from "./services/appKit.js";
import { connectMongo, mongoReady } from "./services/mongo.js";
import { acquireFinancialWriterLease } from "./services/financial-writer-lease.js";
import {
  flushPrimaryStore,
  initializePrimaryStore,
  primaryStoreHealth,
} from "./services/primary-store.js";
import { assertProductionSafety } from "./services/production-safety.js";

export const app = new Hono();
// Vercel's native Hono framework adapter discovers this default export from
// src/index.ts. Local Node development continues to use `serve` at the end of
// this file when VERCEL is absent.
export default app;

assertProductionSafety({
  nodeEnv: config.nodeEnv,
  deploymentEnv: config.deploymentEnv,
  productionLaunchEnabled: config.productionLaunchEnabled,
  allowHeaderAuth: config.auth.allowHeaderFallback,
  corsOrigins: config.corsOrigins,
  mongoUri: config.mongo.uri,
  publicApiUrl: config.publicApiUrl,
  appPublicUrl: config.appPublicUrl,
  adminSafeAddress: config.arc.adminSafeAddress,
  opsPrivateKey: config.arc.privateKey,
  identityLinkerPrivateKey: config.arc.identityLinkerPrivateKey,
  escrowAttestorPrivateKey: config.arc.escrowAttestorPrivateKey,
});

app.use("*", secureHeaders({
  strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
}));
app.use("*", bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: "request_too_large" }, 413),
}));

const uploadsDir = dataPath("uploads");
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

app.use(
  "*",
  cors({
    origin: config.corsOrigins.includes("*") ? "*" : config.corsOrigins,
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-dynamic-token",
      "Idempotency-Key",
    ],
  }),
);

// A response that mutated local state is not released until the matching
// atomic Mongo snapshot is durable. JSON-only development remains a no-op.
app.use("*", async (c, next) => {
  await next();
  try {
    await flushPrimaryStore();
  } catch (error) {
    console.error("[store] primary Mongo flush failed", error);
    return c.json(
      {
        error: "persistence_unavailable",
        detail: "The operation could not be durably recorded. Retry later.",
      },
      503,
    );
  }
});

/**
 * Request log. User ids are pseudonymised and wallet addresses are dropped:
 * both are directly identifying and this file is plain text on disk.
 */
const httpLogPath = dataPath("http.jsonl");

function pseudonym(userId: string | undefined): string | null {
  if (!userId) return null;
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  const path = c.req.path;
  if (path === "/v1/health" || path === "/v1/fx/rates") return;
  const auth = c.get("auth") as { userId: string } | undefined;
  const user = pseudonym(auth?.userId);
  const line = JSON.stringify({
    at: new Date().toISOString(),
    method: c.req.method,
    path,
    status: c.res.status,
    ms: Date.now() - started,
    user,
  });
  console.log(
    `[http] ${c.req.method} ${path} ${c.res.status} ${Date.now() - started}ms user=${user || "-"}`,
  );
  try {
    appendFileSync(httpLogPath, `${line}\n`);
  } catch {
    /* ignore disk errors */
  }
});

// The general ceiling runs BEFORE auth so an unauthenticated flood is
// throttled too. Behind auth it would never see a request that 401s, which
// is exactly the traffic worth shedding. Unauthenticated callers are keyed
// by address; verified ones by user id.
app.use("/v1/*", rateLimit(GENERAL));

// Identity for every /v1 route. Must be mounted before the route groups.
app.use("/v1/*", authMiddleware);

// Per-route ceilings for calls that spend email quota, Circle quota, gas or
// USDC. These sit after auth so they key on the authenticated user.
app.use("/v1/notify/*", rateLimit(SENSITIVE));
app.use("/v1/identity/link", rateLimit(SENSITIVE));
app.use("/v1/users/handle", rateLimit(SENSITIVE));
app.use("/v1/x402/*", rateLimit(SENSITIVE));
app.use("/v1/synthra/*", rateLimit(SENSITIVE));
app.use("/v1/escrow/protected/*", rateLimit(SENSITIVE));
app.use("/v1/agents/*/deposit", rateLimit(SENSITIVE));
app.use("/v1/agents/*/withdraw", rateLimit(SENSITIVE));
app.use("/v1/agents", rateLimit(ONBOARDING));
app.use("/v1/agents/*/reveal-key", rateLimit(SENSITIVE));
app.use("/v1/users/me/avatar", rateLimit(SENSITIVE));
app.use("/v1/circle/create-user", rateLimit(ONBOARDING));
app.use("/v1/circle/session", rateLimit(ONBOARDING));
app.use("/v1/circle/prepare-pin", rateLimit(ONBOARDING));

app.use(
  "/uploads/*",
  serveStatic({
    root: dataDir,
    rewriteRequestPath: (p) => p.replace(/^\/uploads/, "/uploads"),
  }),
);

// Acquire the global writer lease and restore Mongo's authoritative snapshot
// before importing modules that load JSON into memory.
const mongoStatus = await connectMongo();
const writerLease = await acquireFinancialWriterLease();
const primaryStoreStatus = await initializePrimaryStore();
if (config.nodeEnv !== "production") {
  const { store } = await import("./store/db.js");
  store.resetSeedIfEmpty();
  await flushPrimaryStore();
}

app.get("/health/live", (c) => c.json({
  status: "ok",
  service: "evabob-api",
  environment: config.deploymentEnv,
  uptimeSeconds: Math.floor(process.uptime()),
}));

app.get("/health/ready", (c) => {
  const store = primaryStoreHealth();
  const mongoRequired = config.deploymentEnv !== "local";
  const ready =
    (!mongoRequired || mongoReady()) &&
    store.error == null &&
    (!mongoRequired || store.mode === "mongo");
  return c.json({
    status: ready ? "ready" : "unavailable",
    service: "evabob-api",
    environment: config.deploymentEnv,
    database: mongoReady() ? "connected" : "unavailable",
    persistence: store.mode,
  }, ready ? 200 : 503);
});

const [
  { api },
  { agentRoutes },
  { appKitRoutes },
  { cctpRoutes },
  { circleWallets },
  { gatewayRoutes },
  { identityRoutes },
  { startEscrowRefundJob, processExpiredEscrows },
] = await Promise.all([
  import("./routes/api.js"),
  import("./routes/agent.js"),
  import("./routes/app-kit.js"),
  import("./routes/cctp.js"),
  import("./routes/circle-wallets.js"),
  import("./routes/gateway.js"),
  import("./routes/identity.js"),
  import("./services/escrow-jobs.js"),
]);

app.route("/v1", api);
app.route("/v1/agent", agentRoutes);
app.route("/v1/circle", circleWallets);
app.route("/v1/identity", identityRoutes);
app.route("/v1/app-kit", appKitRoutes);
if (config.appKit.keepLegacyRoutes) {
  app.route("/v1/gateway", gatewayRoutes);
  app.route("/v1/cctp", cctpRoutes);
}

/**
 * Every route validates its body with `schema.parse()`, which throws. Without
 * a handler those became 500s, so a plainly invalid request looked like a
 * server fault. Report the field problems as a 400 and keep genuine faults 500.
 */
app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json(
      {
        error: "invalid_request",
        detail: err.issues.map((i) => ({
          field: i.path.join(".") || "(body)",
          message: i.message,
        })),
      },
      400,
    );
  }
  console.error("[unhandled]", c.req.method, c.req.path, err);
  return c.json(
    {
      error: "internal_error",
      detail:
        config.nodeEnv === "production"
          ? "Something went wrong."
          : err instanceof Error
            ? err.message
            : String(err),
    },
    500,
  );
});

app.get("/challenge", (c) => {
  const html = readFileSync(resolve(process.cwd(), "public/challenge.html"), "utf8");
  return c.html(html);
});

// Vercel does not keep background timers alive. Its hourly Cron invokes this
// route with CRON_SECRET; the ordinary Node deployment still uses the timer.
app.get("/internal/cron/escrow-refunds", async (c) => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return c.json({ error: "cron_not_configured" }, 503);
  if (c.req.header("authorization") !== `Bearer ${secret}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(await processExpiredEscrows());
});

// Advertises only what is actually mounted above. This list used to name
// /v1/chat, /v1/synthra, /v1/escrow and /v1/x402/pay as top-level route
// groups; they are paths inside the /v1 group, not separate mounts.
app.get("/", (c) =>
  c.json({
    name: "Evabob API",
    version: "0.7.0",
    docs: "/v1/health",
    auth: "dynamic-jwt",
    moneyMovement: "circle-app-kit",
    network: "arc-testnet",
    routeGroups: [
      "/v1",
      "/v1/agent",
      "/v1/circle",
      "/v1/identity",
      "/v1/app-kit",
      ...(config.appKit.keepLegacyRoutes
        ? ["/v1/gateway", "/v1/cctp"]
        : []),
    ],
    publicPaths: ["/v1/health", "/v1/config/public", "/v1/fx/rates"],
    stack: {
      mobile: "Dart / Flutter",
      auth: "Dynamic JWT (JWKS) — required on every /v1 route",
      backend: "TypeScript / Node / Hono",
      chain: "Arc Testnet + Circle App Kit (Send / Bridge / Swap / Unified Balance)",
      db: "MongoDB (users) + JSON fallback",
    },
    status: "testnet showcase — see docs/STATUS.md",
  }),
);

if (!process.env.VERCEL) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void flushPrimaryStore()
        .catch((error) => console.error("[store] shutdown flush failed", error))
        .finally(() => writerLease.release())
        .finally(() => process.exit(0));
    });
  }
  startEscrowRefundJob();
}

console.log(`Evabob API → http://${config.host}:${config.port}`);
console.log(`  Arc ${config.arc.chainId} ${config.arc.rpcUrl}`);
console.log(`  Identity: ${config.arc.identityRegistry || "unset"}`);
console.log(`  Escrow:   ${config.arc.paymentEscrow || "unset"}`);
console.log(
  `  Dynamic: ${config.dynamic.environmentId ? "set" : "missing"}`,
);
console.log(`  Circle API: ${config.circle.apiKey ? "set" : "missing"}`);
console.log(
  `  SMTP: ${config.smtp.host && config.smtp.user ? "set" : "missing"}`,
);
console.log(
  `  Pusher: ${config.pusher.key && config.pusher.secret ? "set" : "missing"}`,
);
console.log(`  Mongo: ${mongoStatus.detail}`);
console.log(
  `  Primary store: ${primaryStoreStatus.mode}` +
    (primaryStoreStatus.restored ? " (restored before route import)" : ""),
);
console.log(
  `  Synthra: ${config.synthra.apiKey ? "set" : "missing key"}`,
);
const ak = appKitConfigured();
console.log(
  `  App Kit: ${ak.enabled ? "enabled" : "disabled"} (circleWallets=${ak.circleWallets} viemOps=${ak.viemOps} kitKey=${ak.kitKey} fee=${ak.feeRecipient})`,
);
console.log(
  `  WhatsApp: ${config.whatsapp.token && config.whatsapp.phoneNumberId ? "set" : "stub"}`,
);
console.log(
  `  Auth: Dynamic JWT required${config.auth.allowHeaderFallback ? " + x-user-id fallback" : ""}`,
);
console.log(`  CORS: ${config.corsOrigins.join(", ")}`);
if (config.auth.allowHeaderFallback) {
  console.warn(
    "\n  !! ALLOW_HEADER_AUTH=true — the x-user-id header is accepted as an\n" +
      "     identity claim, so ANY caller can impersonate ANY user.\n" +
      "     Local development only. Never enable this on a reachable host.\n",
  );
}
if (config.corsOrigins.includes("*") && config.nodeEnv === "production") {
  console.warn(
    "  !! CORS_ORIGINS=* in production — set an explicit origin list.\n",
  );
}
if (config.auth.operatorUserIds.length === 0) {
  console.warn(
    "  !! OPERATOR_USER_IDS is empty — treasury and maintenance routes are fail-closed.\n",
  );
}

if (!process.env.VERCEL) {
  serve({ fetch: app.fetch, port: config.port, hostname: config.host });
}

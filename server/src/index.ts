import { serve } from "@hono/node-server";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
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
  refreshPrimaryStoreIfStale,
} from "./services/primary-store.js";
import { assertProductionSafety } from "./services/production-safety.js";

export const app = new Hono();
// Serverless adapters can use the default Hono export. Render and local Node
// run the long-lived HTTP server at the end of this file.
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
const smallBodies = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: "request_too_large" }, 413),
});
// A paywall carries the files it sells (up to 10 MB of them, base64).
const paywallBodies = bodyLimit({
  maxSize: 15 * 1024 * 1024,
  onError: (c) => c.json({ error: "Those files are too big. Up to 10 MB per link." }, 413),
});
app.use("*", (c, next) =>
  c.req.method === "POST" && c.req.path === "/v1/paywalls"
    ? paywallBodies(c, next)
    : smallBodies(c, next));

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

// Several instances may be running (every serverless host does this). If
// another has saved since this one last looked, catch up before handling, so
// the request neither acts on stale records nor loses a race when it saves.
app.use("*", async (_c, next) => {
  try {
    await refreshPrimaryStoreIfStale();
  } catch (error) {
    console.warn("[store] refresh before request failed", error);
  }
  await next();
});

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
// Actions that move held money or open a review. POST only: the app polls
// GET /v1/escrow/held/:id on a receipt, and that must not hit this ceiling.
app.on("POST", "/v1/escrow/held/*", rateLimit(SENSITIVE));
app.on("POST", "/v1/operator/*", rateLimit(SENSITIVE));
// Group money: each confirm reads the chain; the keeper does the rest.
app.on("POST", "/v1/groups/*", rateLimit(SENSITIVE));
// Sends email, and guards a 6-digit code against guessing.
app.use("/v1/family-check/*", rateLimit(SENSITIVE));
app.use("/v1/agents/*/deposit", rateLimit(SENSITIVE));
app.use("/v1/agents/*/withdraw", rateLimit(SENSITIVE));
app.use("/v1/agents", rateLimit(ONBOARDING));
app.use("/v1/agents/*/reveal-key", rateLimit(SENSITIVE));
// Agents hiring people move money; paywalls take payments from anyone.
app.on("POST", "/v1/agent-api/tasks", rateLimit(SENSITIVE));
app.on("POST", "/v1/paywalls", rateLimit(SENSITIVE));
app.on("POST", "/v1/agent-tasks/*/take", rateLimit(SENSITIVE));
app.use("/x/*", rateLimit(GENERAL));
app.use("/v1/users/me/avatar", rateLimit(SENSITIVE));
app.use("/v1/circle/create-user", rateLimit(ONBOARDING));
app.use("/v1/circle/session", rateLimit(ONBOARDING));
app.use("/v1/circle/prepare-pin", rateLimit(ONBOARDING));

/**
 * Profile photos. Served from Mongo, where uploads are stored, with this
 * instance's disk as a fallback for local development without Mongo. Only
 * the avatar filename shape is served, so nothing else on disk is reachable.
 */
const AVATAR_FILE = /^avatar_[a-f0-9]{32}\.(jpg|png|webp)$/;
// Review evidence and chat photos: random names, reachable only by those
// given the path.
const EVIDENCE_FILE = /^evidence_[a-f0-9]{32}\.(jpg|png|webp)$/;
const CHAT_PHOTO_FILE = /^chatphoto_[a-f0-9]{32}\.(jpg|png|webp)$/;
app.get("/uploads/:file", async (c) => {
  const file = c.req.param("file");
  if (!AVATAR_FILE.test(file) && !EVIDENCE_FILE.test(file) && !CHAT_PHOTO_FILE.test(file)) {
    return c.notFound();
  }
  const headers = {
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    const { mongoLoadAvatar } = await import("./services/mongo.js");
    const stored = await mongoLoadAvatar(file);
    if (stored) {
      return c.body(new Uint8Array(stored.bytes), 200, {
        ...headers,
        "Content-Type": stored.mime,
      });
    }
  } catch (error) {
    console.warn("[avatar] mongo read failed", error);
  }
  const onDisk = resolve(dataDir, "uploads", file);
  if (!existsSync(onDisk)) return c.notFound();
  const mime = file.endsWith(".png")
    ? "image/png"
    : file.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return c.body(new Uint8Array(readFileSync(onDisk)), 200, {
    ...headers,
    "Content-Type": mime,
  });
});

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
  { agentCommerceRoutes, agentApiRoutes, paywallResource },
  { agentRoutes },
  { appKitRoutes },
  { cctpRoutes },
  { circleWallets },
  { gatewayRoutes },
  { identityRoutes },
  { startEscrowRefundJob, processExpiredEscrows },
] = await Promise.all([
  import("./routes/api.js"),
  import("./routes/agentCommerce.js"),
  import("./routes/agent.js"),
  import("./routes/app-kit.js"),
  import("./routes/cctp.js"),
  import("./routes/circle-wallets.js"),
  import("./routes/gateway.js"),
  import("./routes/identity.js"),
  import("./services/escrow-jobs.js"),
]);

app.route("/v1", api);
app.route("/v1", agentCommerceRoutes);
app.route("/v1/agent-api", agentApiRoutes);
// Software pays for a person's paywall here: plain HTTP 402, no session.
app.route("/", paywallResource);
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

// One PIN host page for the app bundle and this route. It used to be copied
// into server/public by hand, and the two drifted (the copy kept the old
// cream-and-green theme). The server now reads the mobile asset directly.
const CHALLENGE_PAGE_CANDIDATES = [
  resolve(process.cwd(), "../mobile/assets/challenge.html"),
  resolve(process.cwd(), "mobile/assets/challenge.html"),
];

app.get("/challenge", (c) => {
  const path = CHALLENGE_PAGE_CANDIDATES.find((p) => existsSync(p));
  if (!path) return c.text("Challenge page unavailable", 503);
  return c.html(readFileSync(path, "utf8"));
});

// Hosted schedulers invoke these routes with CRON_SECRET (Vercel Cron sends
// it as a bearer token automatically). A local Node process runs the same
// work on in-process timers when RUN_INTERNAL_REFUND_JOB is not false.
function cronAuthorized(c: { req: { header: (n: string) => string | undefined } }) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return "cron_not_configured" as const;
  return c.req.header("authorization") === `Bearer ${secret}` ? null : ("unauthorized" as const);
}

app.get("/internal/cron/escrow-refunds", async (c) => {
  const denied = cronAuthorized(c);
  if (denied) return c.json({ error: denied }, denied === "unauthorized" ? 401 : 503);
  return c.json(await processExpiredEscrows());
});

/**
 * Everything that must happen on time without anyone watching: job holds
 * whose 7 days are up, cooling-off payments whose 10 minutes have passed,
 * bridges abandoned for more than 40 minutes, reminders. Add `refunds=1` to
 * also sweep expired holds (the chain walk is heavier, so hourly is plenty).
 *
 * Every step is idempotent and re-checks the chain before moving money, so a
 * scheduler that runs twice, or late, only repeats or delays work.
 */
app.get("/internal/cron/tick", async (c) => {
  const denied = cronAuthorized(c);
  if (denied) return c.json({ error: denied }, denied === "unauthorized" ? 401 : 503);
  const { runTickWork } = await import("./services/tick.js");
  const work = await runTickWork();
  const refunds =
    c.req.query("refunds") === "1" ? await processExpiredEscrows() : undefined;
  // Runs outside a user request; persist before answering.
  await flushPrimaryStore();
  return c.json({ ...work, ...(refunds ? { refunds } : {}) });
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
  if (process.env.RUN_INTERNAL_REFUND_JOB !== "false") {
    startEscrowRefundJob();
    // The same due work the hosted tick runs, once a minute.
    let ticking = false;
    const tick = async () => {
      // A slow tick (a round collected, refunds sent) must not overlap the next.
      if (ticking) return;
      ticking = true;
      try {
        const { runTickWork, tickWasBusy } = await import("./services/tick.js");
        const work = await runTickWork();
        if (tickWasBusy(work)) console.log("[tick]", JSON.stringify(work));
        await flushPrimaryStore();
      } catch (e) {
        console.warn("[tick]", e instanceof Error ? e.message : e);
      } finally {
        ticking = false;
      }
    };
    setTimeout(tick, 20_000);
    setInterval(tick, 60_000);
  }
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

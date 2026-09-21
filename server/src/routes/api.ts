import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { readTokenBalances } from "../services/arc-balances.js";
import { circleHealth } from "../services/circle.js";
import { circleMarketplaceHealth } from "../services/circle-x402.js";
import {
  depositAddressCatalog,
  fetchGatewayBalances,
} from "../services/gateway.js";
import {
  adminLinkIdentity,
  IdentityAdminMismatchError,
  IdentityConflictError,
  resolveIdentity,
} from "../services/identity.js";
import {
  authenticatePusherChannel,
  pusherConfigured,
  pusherTrigger,
} from "../services/pusher.js";
import {
  executeSend,
  normalizeRecipient,
} from "../services/transfers.js";
import {
  ensureAgentThread,
  pinAgentThreads,
} from "../services/evabobAgent.js";
import { store, type AgentWallet } from "../store/db.js";
import { USER_CHANNEL_PREFIX } from "../services/notifyUser.js";
import { allowanceView } from "../services/agentControls.js";
import { getUserId, getAuth, requireRecentAuth } from "../middleware/auth.js";
import { requireUser, operatorOnly } from "../middleware/authorization.js";
import { ucwSessionBoundary } from "../middleware/ucw-session.js";
import { syncInboundInBackground } from "../services/inbound.js";
import { clientError } from "../utils/http-error.js";
import { jsonSafe } from "../utils/json-safe.js";
import { flushPrimaryStore, primaryStoreHealth } from "../services/primary-store.js";
import { avatarFilename, decodeAvatar } from "../services/avatar.js";
import { dataPath } from "../utils/data-path.js";
import { llmConfigured } from "../services/llm.js";
import { safeError } from "../utils/safe-log.js";
import { consumeNamedRateLimit } from "../middleware/rate-limit.js";

export const api = new Hono();
api.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.path !== "/v1/x402/pay") {
    const denied = requireUser(c);
    if (denied) return denied;
  }
  return next();
});
api.use("*", ucwSessionBoundary);
api.use("/wallet/withdraw", operatorOnly);
api.use("/notify/test-email", operatorOnly);
api.use("/escrow/process-expired", operatorOnly);
// This legacy endpoint fabricates ledger payments. Customer sends use UCW.
api.use("/transfers/send", async c => c.json({ error: "Use the Circle UCW send flow." }, 410));
// This route only fabricated an exchange in activity history. Quotes remain
// available; execution must use the Circle UCW/App Kit swap flow.
api.use("/exchange", async c => c.json({ error: "Use the Circle UCW swap flow.", code: "LEDGER_EXCHANGE_RETIRED" }, 410));

/** The authenticated caller (see middleware/auth.ts). Never trusts headers. */
const userId = getUserId;

const identityLinked = new Set<string>();

/**
 * Links one identifier, reporting whether a retry could ever succeed.
 *
 * A conflict — the identifier is already bound to a different wallet — is
 * permanent: the registry reverts with AlreadyLinked() and only an explicit
 * adminUnlink can clear it. Retrying that on every login wastes gas on a
 * transaction guaranteed to revert and buries real errors in the log.
 */
async function linkOne(
  account: `0x${string}`,
  kind: "email" | "handle",
  identifier: string,
): Promise<{ retryable: boolean }> {
  try {
    const r = await adminLinkIdentity({ account, kind, identifier });
    if (r.status === "linked") {
      console.log(`[identity] linked ${kind}`);
    }
    return { retryable: false };
  } catch (e) {
    if (e instanceof IdentityConflictError) {
      console.warn(
        `[identity] ${kind} conflict. Not retrying. Resolve with an ` +
          `explicit unlink+relink; until then identity resolution reports ` +
          `the old wallet for this ${kind}.`,
      );
      return { retryable: false };
    }
    console.warn(
      `[identity] ${kind} link failed (will retry):`,
      safeError(e),
    );
    return { retryable: true };
  }
}

function scheduleIdentityLink(user: {
  id: string;
  email: string;
  handle?: string | null;
  evmAddress: string;
}): boolean {
  const key = `${user.id}:${user.evmAddress.toLowerCase()}`;
  if (identityLinked.has(key)) return false;
  identityLinked.add(key);
  const account = user.evmAddress as `0x${string}`;
  void (async () => {
    // Independent: a failing email link must not stop the handle from being
    // linked. Previously the email threw and the handle was never attempted.
    const results = await Promise.all([
      config.features.onchainEmailLinks && user.email.includes("@")
        ? linkOne(account, "email", user.email)
        : Promise.resolve({ retryable: false }),
      user.handle && user.handle.length >= 3
        ? linkOne(account, "handle", user.handle)
        : Promise.resolve({ retryable: false }),
    ]);
    // Only re-arm when something could actually succeed next time.
    if (results.some((r) => r.retryable)) identityLinked.delete(key);
  })();
  return true;
}

api.get("/health", async (c) => {
  const { smtpHealth, smtpConfigured } = await import("../services/notify.js");
  const [circle, marketplace, smtp] = await Promise.all([
    circleHealth().catch((e) => ({
      ok: false,
      detail: clientError(e, "fail"),
    })),
    circleMarketplaceHealth().catch((e) => ({
      ok: false,
      detail: clientError(e, "fail"),
    })),
    smtpHealth().catch((e) => ({
      ok: false,
      detail: clientError(e, "fail"),
    })),
  ]);
  return c.json({
    ok: true,
    service: "evabob-server",
    arcChainId: config.arc.chainId,
    contracts: {
      identityRegistry: config.arc.identityRegistry || null,
      paymentEscrow: config.arc.paymentEscrow || null,
    },
    // Addresses only, never keys. Lets a rotation be verified against the
    // on-chain admin/attestor without shell access — see docs/KEY_ROTATION.md.
    signers: await (async () => {
      try {
        const {
          getDeployerAddress,
          getEscrowAttestorAddress,
          getIdentityLinkerAddress,
          getPublicClient,
        } = await import(
          "../services/arc-wallet.js"
        );
        const { identityRegistryAbi } = await import("../abis/identity.js");
        const { paymentEscrowAbi } = await import("../abis/escrow.js");
        const ops = getDeployerAddress();
        const linker = getIdentityLinkerAddress();
        const attestor = getEscrowAttestorAddress();
        const publicClient = getPublicClient();
        const [registryAdmin, registryLinker, escrowAdmin, escrowAttestor] = await Promise.all([
          publicClient.readContract({
            address: config.arc.identityRegistry as `0x${string}`,
            abi: identityRegistryAbi,
            functionName: "admin",
          }),
          publicClient.readContract({
            address: config.arc.identityRegistry as `0x${string}`,
            abi: identityRegistryAbi,
            functionName: "linker",
          }),
          publicClient.readContract({
            address: config.arc.paymentEscrow as `0x${string}`,
            abi: paymentEscrowAbi,
            functionName: "admin",
          }),
          publicClient.readContract({
            address: config.arc.paymentEscrow as `0x${string}`,
            abi: paymentEscrowAbi,
            functionName: "claimAttestor",
          }),
        ]);
        const safeAddress = registryAdmin as `0x${string}`;
        const safeAbi = [
          { type: "function", name: "getThreshold", stateMutability: "view", inputs: [],
            outputs: [{ type: "uint256" }] },
          { type: "function", name: "getOwners", stateMutability: "view", inputs: [],
            outputs: [{ type: "address[]" }] },
        ] as const;
        const [safeThreshold, safeOwners] =
          safeAddress.toLowerCase() === String(escrowAdmin).toLowerCase()
            ? await Promise.all([
                publicClient.readContract({ address: safeAddress, abi: safeAbi,
                  functionName: "getThreshold" }),
                publicClient.readContract({ address: safeAddress, abi: safeAbi,
                  functionName: "getOwners" }),
              ])
            : [0n, [] as readonly `0x${string}`[]];
        return {
          opsSigner: ops,
          identityLinker: linker,
          escrowAttestor: attestor,
          onChainRegistryAdmin: registryAdmin,
          onChainRegistryLinker: registryLinker,
          onChainEscrowAdmin: escrowAdmin,
          onChainEscrowAttestor: escrowAttestor,
          identityLinkerMatches:
            linker.toLowerCase() === String(registryLinker).toLowerCase(),
          escrowAttestorMatches:
            attestor.toLowerCase() === String(escrowAttestor).toLowerCase(),
          adminSafeMatches:
            Boolean(config.arc.adminSafeAddress) &&
            config.arc.adminSafeAddress.toLowerCase() === safeAddress.toLowerCase() &&
            safeAddress.toLowerCase() === String(escrowAdmin).toLowerCase(),
          safe: {
            address: safeAddress,
            threshold: Number(safeThreshold),
            owners: safeOwners,
          },
          /** False once the roles are split, which is the goal. */
          sharedKey:
            ops.toLowerCase() === linker.toLowerCase() ||
            ops.toLowerCase() === attestor.toLowerCase() ||
            linker.toLowerCase() === attestor.toLowerCase(),
        };
      } catch {
        return null;
      }
    })(),
    auth: "dynamic+circle-ucw",
    dynamicConfigured: Boolean(config.dynamic.environmentId),
    circle,
    marketplace,
    smtpConfigured: smtpConfigured(),
    smtp,
    pusherConfigured: pusherConfigured(),
    pushConfigured: await import("../services/push.js").then((m) => m.pushConfigured()),
    /** Per bridge destination: can the server finish an abandoned bridge there? */
    bridgeRelay: await import("../services/appKitMoney.js")
      .then((m) => m.bridgeRelayHealth(config.features.bridgeRoutes))
      .catch(() => null),
    gatewayApi: config.gatewayApiBase,
    synthraConfigured: Boolean(config.synthra.apiKey),
    fxConfigured: Boolean(config.exchangeRateApiKey),
    mongoConfigured: Boolean(config.mongo.uri),
    primaryStore: primaryStoreHealth(),
    operatorsConfigured: config.auth.operatorUserIds.length > 0,
    x402PaidExecution: Boolean(
      (await import("../services/circle-x402.js").then((m) => m.resolvedAgentOrigins())).length &&
      config.circle.apiKey &&
      config.circle.entitySecret
    ),
    llmConfigured: llmConfigured(),
    llmModel: config.llm.model,
    whatsappConfigured: Boolean(
      config.whatsapp.token && config.whatsapp.phoneNumberId,
    ),
    appKit: {
      enabled: config.appKit.enabled,
      keepLegacyRoutes: config.appKit.keepLegacyRoutes,
      kitKey: Boolean(config.appKit.kitKey),
      circleWallets: Boolean(
        config.circle.apiKey && config.circle.entitySecret,
      ),
      viemOps: Boolean(config.arc.privateKey),
      feeBps: config.appKit.feeBps,
      endpoints: "/v1/app-kit",
    },
  });
});

/**
 * Send a test claim email (Mailtrap sandbox → Mailtrap inbox, not real Gmail).
 * Body: { "to": "you@example.com" }
 */
api.post("/notify/test-email", async (c) => {
  const body = z
    .object({
      to: z.string().email(),
      amountUsdc: z.number().positive().optional().default(1),
    })
    .parse(await c.req.json());
  const { notifySend, smtpConfigured, smtpHealth } = await import(
    "../services/notify.js"
  );
  const health = await smtpHealth();
  if (!smtpConfigured()) {
    return c.json(
      {
        ok: false,
        error: "SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)",
        smtp: health,
      },
      503,
    );
  }
  const result = await notifySend({
    toEmail: body.to,
    toHandle: body.to,
    fromName: "Evabob test",
    amountUsdc: body.amountUsdc,
    memo: "SMTP connectivity test",
    mode: "escrow",
    claimToken: "test-claim-token",
  });
  return c.json({
    ok: result.emailSent,
    ...result,
    smtp: health,
    hint: health.detail.includes("mailtrap")
      ? "Mailtrap sandbox does not deliver to real inboxes — open the Mailtrap Email Testing inbox."
      : undefined,
  });
});

/**
 * Live display rates: 1 USDC ≈ 1 USD → NGN / EUR.
 * Key stays on server (EXCHANGE_RATE_API_KEY).
 */
api.get("/fx/rates", async (c) => {
  const { fetchUsdRates, fxConfigured } = await import("../services/fx.js");
  const rates = await fetchUsdRates();
  return c.json({
    ok: true,
    configured: fxConfigured(),
    base: rates.base,
    /** Same as USD for display settlement */
    usdc: 1,
    ngn: rates.ngn,
    eur: rates.eur,
    rates: {
      USD: 1,
      USDC: 1,
      NGN: rates.ngn,
      EUR: rates.eur,
    },
    source: rates.source,
    updatedAt: rates.updatedAt,
  });
});

api.get("/config/public", async (c) => {
  // Paid agent calls are on only if some seller can actually be paid.
  const { resolvedAgentOrigins } = await import("../services/circle-x402.js");
  const agentOrigins = await resolvedAgentOrigins();
  return c.json({
    arc: {
      chainId: config.arc.chainId,
      rpcUrl: config.arc.rpcUrl,
      usdc: config.arc.usdc,
      eurc: config.arc.eurc,
      gatewayWallet: config.arc.gatewayWallet,
      gatewayMinter: config.arc.gatewayMinter,
      cctpDomain: config.arc.cctpDomain,
      identityRegistry: config.arc.identityRegistry || null,
      paymentEscrow: config.arc.paymentEscrow || null,
      explorer: "https://testnet.arcscan.app",
    },
    appName: config.appName,
    dynamic: {
      // Public client identifier. Serving it here keeps installed clients on
      // the same Dynamic project the API uses after an environment rotation.
      environmentId: config.dynamic.environmentId || null,
    },
    circleWalletsAppId: config.circle.walletsAppId,
    environment: config.deploymentEnv,
    /** Shown on review screens before the PIN; added on top, gas excluded. */
    platformFee: {
      enabled: Boolean(config.platformFee.recipient) && config.platformFee.bps > 0,
      bps: config.platformFee.recipient ? config.platformFee.bps : 0,
    },
    features: {
      ...config.features,
      // Routes cannot become available from a flag alone. The minimum
      // provider/contract configuration must also exist in this process.
      directSend: config.features.directSend && Boolean(config.circle.apiKey),
      protectedSend:
        config.features.protectedSend &&
        Boolean(config.circle.apiKey && config.arc.paymentEscrow && config.arc.identityRegistry),
      conversion: config.features.conversion && Boolean(config.synthra.apiKey),
      gateway: config.features.gateway && Boolean(config.circle.apiKey),
      agentWallets:
        config.features.agentWallets &&
        Boolean(config.circle.apiKey && config.circle.entitySecret),
      x402Execution:
        config.features.x402Execution &&
        agentOrigins.length > 0 &&
        Boolean(config.circle.apiKey && config.circle.entitySecret),
    },
    x402Pay: "POST /v1/x402/pay",
    pusher: {
      key: config.pusher.key || null,
      cluster: config.pusher.cluster,
    },
  });
});

/** Public, deliberately limited invoice view used by /pay/{requestId}. */
api.get("/public/payment-requests/:id", async (c) => {
  const { getPaymentRequest } = await import("../services/payment-requests.js");
  const row = getPaymentRequest(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const issuer = store.getUser(row.senderId || row.userId);
  const status =
    row.status === "open" && row.expiresAt && Date.parse(row.expiresAt) <= Date.now()
      ? "expired"
      : row.status;
  return c.json({
    id: row.id,
    status,
    amount: row.amount,
    total: row.total,
    token: row.token,
    description: row.description,
    note: row.note || "",
    items: row.items.map((item) => ({ description: item.description, amount: item.amount })),
    issuer: issuer?.handle
      ? `@${issuer.handle}`
      : issuer?.displayName || "Evabob user",
    expiresAt: row.expiresAt || null,
    paidAt: row.paidAt || null,
    paidTxHash: row.paidTxHash || row.escrowTxHash || null,
    deepLink: row.link,
  });
});

/** Public claim-link state. Recipient identity and sender wallet stay private. */
api.get("/public/claims/:transferId", async (c) => {
  const transferId = c.req.param("transferId");
  if (!/^\d+$/.test(transferId)) return c.json({ error: "invalid_claim" }, 400);
  try {
    const { readTransfer } = await import("../services/protectedEscrow.js");
    const row = await readTransfer(transferId);
    if (row.status === "None") return c.json({ error: "not_found" }, 404);
    return c.json({
      transferId,
      status: row.status.toLowerCase(),
      amount: row.amountUsdc,
      token: "USDC",
      expiresAt: new Date(row.expiresAt * 1000).toISOString(),
      expired: row.expired,
      deepLink: `evabob://claim?transferId=${encodeURIComponent(transferId)}`,
    });
  } catch (error) {
    return c.json(
      { error: "claim_unavailable", detail: clientError(error, "Could not read this claim") },
      503,
    );
  }
});

/**
 * A payment the payer chose to share: who, how much, when, where it is, and a
 * fresh on-chain check once it has landed. Opened from /r/{publicId}.
 */
api.get("/public/receipts/:publicId", async (c) => {
  const { publicReceipt } = await import("../services/publicReceipts.js");
  const view = await publicReceipt(c.req.param("publicId"));
  if (!view) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(view);
});

/** A seller's hold link, as a buyer sees it before paying. Opened from /h/{id}. */
api.get("/public/hold-links/:id", async (c) => {
  const { publicHoldLinkView } = await import("../services/holdLinks.js");
  const view = publicHoldLinkView(c.req.param("id"));
  if (!view) return c.json({ error: "not_found" }, 404);
  return c.json(view);
});

/** A group pot's progress, for its public page /g/{id}. Circles are private. */
api.get("/public/groups/:id", async (c) => {
  const { publicPotView } = await import("../services/groupMoney.js");
  const view = await publicPotView(c.req.param("id"));
  if (!view) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(jsonSafe(view));
});

// ─── Users ─────────────────────────────────────────────────────────────────

api.post("/users/session", async (c) => {
  const body = z
    .object({
      id: z.string().min(1),
      email: z.string().email().or(z.string().min(3)),
      displayName: z.string().optional(),
      evmAddress: z.string().optional(),
      solanaAddress: z.string().optional(),
    })
    .parse(await c.req.json());

  const auth = getAuth(c);
  // The app sends the sign-in id it knows: Dynamic's, or the account id the
  // server gave it before. Either names this same verified person.
  const knownIds = new Set([auth.userId, auth.subject].filter(Boolean));
  if (!auth.email || !knownIds.has(body.id) || body.email.trim().toLowerCase() !== auth.email.trim().toLowerCase()) {
    return c.json({ error: "Session identity does not match the authenticated user." }, 403);
  }
  const { createSession, listUserWallets, pickPrimaryArcWallet } = await import("../services/circle-ucw.js");
  // Persist the app account before looking up Circle. A first-time Dynamic
  // user does not have a Circle user yet, and that expected miss must not
  // prevent the client from learning that onboarding is required.
  let user = store.upsertUser({
    id: auth.userId,
    email: auth.email.trim().toLowerCase(),
    displayName: body.displayName,
  });
  try {
    // Read the wallet from Circle, never from a request or another email row.
    const session = await createSession(auth.userId);
    const wallets = await listUserWallets(session.userToken);
    const primary = pickPrimaryArcWallet(wallets.filter(w => w.blockchain === "ARC-TESTNET"));
    user = store.bindVerifiedWallet(user.id, primary?.address || "");
  } catch (error) {
    console.info(
      "[users/session] Circle wallet not ready",
      error instanceof Error ? error.message : error,
    );
  }

  // Identity writes are one-shot per process. Awaiting them on every session
  // (Home fires dozens in parallel) blocked /wallet/balances for 10–20s.
  let identity: unknown = null;
  if (user.evmAddress?.startsWith("0x") && user.evmAddress.length === 42) {
    identity = { queued: scheduleIdentityLink(user) };
  }

  // Money held for this person before they had an account can now be
  // delivered. The email comes from the verified session, never from the
  // request body: a caller able to name their own email could otherwise claim
  // anyone else's held money just by asking.
  const verifiedEmail = c.get("auth")?.email;
  if (verifiedEmail && user.evmAddress) {
    const { claimHeldPaymentsInBackground } = await import(
      "../services/protectedEscrow.js"
    );
    claimHeldPaymentsInBackground({
      userId: user.id,
      verifiedEmail,
      walletAddress: user.evmAddress,
    });
  }
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      handle: user.handle ?? null,
      evmAddress: user.evmAddress,
      avatarUrl: user.avatarUrl ?? null,
      onboardingRequired: user.onboardingCompletedAt === null,
    },
    identity,
  });
});

async function recoveryAction(c: Context, run: () => Promise<unknown> | unknown) {
  const { AccountRecoveryError } = await import("../services/account-recovery.js");
  try {
    return c.json(jsonSafe(await run()));
  } catch (error) {
    if (error instanceof AccountRecoveryError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
}

function recoveryView(record: import("../store/db.js").AccountRecoveryRequest) {
  return {
    id: record.id,
    codeExpiresAt: record.codeExpiresAt,
    confirmedAt: record.confirmedAt ?? null,
    executeAfter: record.executeAfter ?? null,
    cancelledAt: record.cancelledAt ?? null,
    completedAt: record.completedAt ?? null,
  };
}

/** Starts explicit account recovery; sign-in itself never merges by email. */
api.post("/users/recovery/start", async (c) => {
  const auth = getAuth(c);
  if (!auth.subject || !auth.email) {
    return c.json({ error: "A verified email sign-in is required" }, 403);
  }
  const { startAccountRecovery } = await import("../services/account-recovery.js");
  return recoveryAction(c, () =>
    startAccountRecovery({ subject: auth.subject!, verifiedEmail: auth.email! }),
  );
});

api.post("/users/recovery/:id/confirm", async (c) => {
  const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
  const auth = getAuth(c);
  const { confirmAccountRecovery } = await import("../services/account-recovery.js");
  return recoveryAction(c, () => ({
    recovery: recoveryView(confirmAccountRecovery({
      requestId: c.req.param("id"),
      subject: auth.subject ?? auth.userId,
      code: body.code,
    })),
  }));
});

api.post("/users/recovery/:id/cancel", async (c) => {
  const auth = getAuth(c);
  const { cancelAccountRecovery } = await import("../services/account-recovery.js");
  return recoveryAction(c, () => ({
    recovery: recoveryView(cancelAccountRecovery({
      requestId: c.req.param("id"),
      userId: auth.userId,
    })),
  }));
});

api.post("/users/recovery/:id/complete", async (c) => {
  const auth = getAuth(c);
  const { completeAccountRecovery } = await import("../services/account-recovery.js");
  return recoveryAction(c, () => {
    const recovery = completeAccountRecovery({
      requestId: c.req.param("id"),
      subject: auth.subject ?? auth.userId,
    });
    return { recovery: recoveryView(recovery), accountId: recovery.targetAccountId };
  });
});

api.get("/users/me", (c) => {
  const id = userId(c);
  const user = store.getUser(id);
  if (!user) return c.json({ error: "unknown user — POST /users/session first" }, 404);
  return c.json({
    user,
    /** Can decide held-payment reviews; the app shows the review screen. */
    operator: config.auth.operatorUserIds.includes(id),
  });
});

api.post("/users/me/ai-preference", async (c) => {
  const body = z.object({ externalAi: z.boolean() }).parse(await c.req.json());
  const user = store.setAiOptOut(userId(c), !body.externalAi);
  if (!user) return c.json({ error: "account_not_found" }, 404);
  return c.json({ externalAi: user.aiOptOut === false });
});

/** Portable authenticated export. A recently issued Dynamic token is step-up. */
api.get("/users/me/export", (c) => {
  const denied = requireRecentAuth(c);
  if (denied) return denied;
  const exported = store.exportForUser(userId(c));
  if (!exported) return c.json({ error: "account_not_found" }, 404);
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Disposition", `attachment; filename="evabob-export-${Date.now()}.json"`);
  return c.json(jsonSafe(exported));
});

/**
 * Deletes or anonymizes off-chain account data. Public-chain transaction
 * evidence remains, and provider-side legal records require their own
 * retention/deletion process.
 */
api.delete("/users/me", async (c) => {
  const denied = requireRecentAuth(c);
  if (denied) return denied;
  const body = z.object({ confirm: z.literal("DELETE") }).parse(
    await c.req.json().catch(() => ({})),
  );
  const uid = userId(c);
  const user = store.getUser(uid);
  if (!user) return c.json({ error: "account_not_found" }, 404);
  const filenames = store.mediaForUser(uid).map((row) => row.filename);
  const avatarFile = user.avatarUrl?.match(/\/uploads\/([^?/#]+)/)?.[1];
  if (avatarFile) filenames.push(avatarFile);
  const { deleteStoredMedia } = await import("../services/evidence.js");
  const { unregisterAllPushDevices } = await import("../services/push.js");
  const pushDevicesRemoved = unregisterAllPushDevices(uid);
  const result = store.anonymizeUser(uid);
  await deleteStoredMedia([...new Set(filenames)]);
  return c.json({
    ok: true,
    ...result,
    pushDevicesRemoved,
    publicLinksRevoked: true,
    processorPropagation: {
      dynamic: "session invalidation must be completed through Dynamic",
      circle: "wallet and legally retained transaction records remain",
      deepseek: "external AI processing is disabled",
      firebase: "device tokens removed from Evabob",
      pusher: "no retained user content",
    },
  });
});

// Tombstones. Phone was dropped as an identity type — payees are an email, a
// handle, or a 0x address. 410 rather than 404 so an older installed build
// gets a definite "this is gone" instead of looking like a routing fault.
/**
 * Registers this phone for push notifications, so money alerts and
 * held-payment reminders reach it while the app is closed. A token is one app
 * install; registering it here moves it from whoever had it before.
 */
api.post("/users/me/push-devices", async (c) => {
  const body = z
    .object({
      token: z.string().min(20).max(4096),
      platform: z.enum(["android", "ios"]),
    })
    .parse(await c.req.json());
  const { registerPushDevice, pushConfigured } = await import("../services/push.js");
  registerPushDevice({ userId: userId(c), token: body.token, platform: body.platform });
  return c.json({ ok: true, pushConfigured: pushConfigured() });
});

/** Stops push to this phone for this account — called on sign-out. */
api.delete("/users/me/push-devices", async (c) => {
  const body = z
    .object({ token: z.string().min(20).max(4096) })
    .parse(await c.req.json().catch(() => ({})));
  const { unregisterPushDevice } = await import("../services/push.js");
  return c.json({ ok: true, removed: unregisterPushDevice(userId(c), body.token) });
});

api.post("/users/me/phone/start", (c) =>
  c.json(
    { error: "Phone is not a payee or profile field", code: "PHONE_REMOVED" },
    410,
  ),
);

api.post("/users/me/phone/confirm", (c) =>
  c.json(
    { error: "Phone is not a payee or profile field", code: "PHONE_REMOVED" },
    410,
  ),
);

api.post("/users/me/avatar", async (c) => {
  const body = z
    .object({
      /** data:image/jpeg;base64,... or bare base64 */
      imageBase64: z.string().min(32).max(400_000),
      mime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    })
    .parse(await c.req.json());

  const uid = userId(c);
  let user = store.getUser(uid);
  if (!user) {
    return c.json({ error: "unknown user — POST /users/session first" }, 404);
  }

  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dir = dataPath("uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let avatar;
  try {
    avatar = decodeAvatar(body.imageBase64, body.mime || "image/jpeg");
  } catch (error) {
    return c.json({ error: clientError(error, "Invalid avatar") }, 400);
  }
  const filename = avatarFilename(uid, avatar.extension);
  const { mongoReady, mongoSaveAvatar } = await import("../services/mongo.js");
  if (mongoReady()) {
    // The durable copy. Local disk is only a per-instance cache.
    await mongoSaveAvatar(filename, avatar.mime, avatar.bytes);
  }
  writeFileSync(resolve(dir, filename), avatar.bytes);
  // The filename is fixed per person, so the version keeps an old copy from
  // being shown out of an image cache after they change their photo.
  const avatarUrl = `/uploads/${filename}?v=${Date.now()}`;
  // A photo replaces any built-in picture.
  user = store.updateProfile(uid, { avatarUrl, avatarBundleIndex: null }) ?? user;
  void announceProfileChange(uid);
  return c.json({ user, avatarUrl });
});

// ─── Escrow lifecycle ──────────────────────────────────────────────────────

api.get("/escrow/pending", async (c) => {
  const { listLocalPending } = await import("../services/escrow-jobs.js");
  const { mongoListPendingEscrows, mongoReady } = await import(
    "../services/mongo.js"
  );
  const uid = userId(c);
  const local = listLocalPending().filter((e) => e.fromUserId === uid);
  const remote = mongoReady() ? await mongoListPendingEscrows(uid) : [];
  const byId = new Map<string, (typeof local)[0]>();
  for (const e of [...remote, ...local]) byId.set(e.id, e);
  return c.json({ items: [...byId.values()] });
});

api.post("/escrow/process-expired", operatorOnly, async (c) => {
  const { processExpiredEscrows } = await import("../services/escrow-jobs.js");
  const result = await processExpiredEscrows();
  return c.json(result);
});

/**
 * Arc job escrow (ERC-8183-style) — create+fund, submit, complete/reject.
 * Real funds: client UCW-sends USDC to hold address, then creates job with fundTxHash.
 * Release/refund: ops App Kit send from hold wallet.
 * @see server/src/services/arcJobEscrow.ts
 */
api.get("/escrow/hold-address", async (c) => {
  try {
    const { escrowHoldAddress } = await import("../services/arcJobEscrow.js");
    const address = escrowHoldAddress();
    return c.json({
      address,
      token: "USDC",
      chain: "Arc_Testnet",
      note: "Send locked amount here with PIN, then POST /escrow/job with fundTxHash.",
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "hold address unavailable") },
      503,
    );
  }
});

/**
 * The transaction hash that locked escrow funds, or undefined.
 *
 * Clients post `fundTxHash` when the send returned one and `fundActivityId`
 * when it did not — a UCW send can settle after the response. An activity id
 * is only honoured when the row belongs to the caller and carries a hash, so
 * it resolves to on-chain evidence rather than standing in for it.
 */
async function resolveEscrowFundTx(input: {
  userId: string;
  fundTxHash?: string;
  fundActivityId?: string;
}): Promise<string | undefined> {
  if (input.fundTxHash && /^0x[a-fA-F0-9]{64}$/.test(input.fundTxHash)) {
    return input.fundTxHash;
  }
  if (!input.fundActivityId) return undefined;
  const row = store
    .listActivity(input.userId, 200)
    .find((a) => a.id === input.fundActivityId);
  if (!row?.txHash || !/^0x[a-fA-F0-9]{64}$/.test(row.txHash)) return undefined;
  return row.txHash;
}

/**
 * Whether a payee already has an account.
 *
 * The send flow asks before anything is locked, so a payer can be told the
 * person has no account yet and decide to hold the money for them — rather
 * than sending into a void and finding out afterwards.
 */
/**
 * Held payments this user is still waiting on.
 *
 * Activity rows cannot drive a release on their own: releasing needs the
 * on-chain transfer id, and that is not something an activity row carries.
 */
api.get("/escrow/protected", async (c) => {
  const uid = userId(c);
  const { listLocalPending } = await import("../services/escrow-jobs.js");
  const rows = listLocalPending()
    .filter((e) => e.fromUserId === uid && e.onChainTransferId)
    .map((e) => ({
      transferId: e.onChainTransferId,
      recipientId: e.recipientId,
      amountUsdc: e.amountUsdc,
      memo: e.memo ?? "",
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      expired: new Date(e.expiresAt).getTime() <= Date.now(),
      createTx: e.createTx,
    }));
  return c.json({ items: rows });
});

api.get("/escrow/recipient-status", async (c) => {
  const identifier = c.req.query("identifier") || "";
  const { escrowRecipientKey, isRegistered, EscrowError } = await import(
    "../services/protectedEscrow.js"
  );
  try {
    const { kind, normalized } = escrowRecipientKey(identifier);
    return c.json({
      identifier: normalized,
      kind,
      registered: isRegistered(identifier),
    });
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * The two calls the payer signs to lock money in the escrow contract.
 *
 * Nothing is recorded here. A plan abandoned at the PIN screen must leave no
 * record claiming money is held, so the hold only exists once /record reads
 * the created transfer back off the chain.
 */
api.post("/escrow/protected/plan", async (c) => {
  const body = z
    .object({
      recipient: z.string().min(1),
      amountUsdc: z.number().positive(),
      memo: z.string().max(120).optional(),
      purpose: z.enum(["claim_link", "job", "cooling_off"]).default("claim_link"),
      expirySeconds: z.number().int().positive().optional(),
    })
    .parse(await c.req.json());

  const { planProtectedEscrow, EscrowError } = await import(
    "../services/protectedEscrow.js"
  );
  try {
    const plan = planProtectedEscrow({
      recipientId: body.recipient,
      amountUsdc: body.amountUsdc,
      memo: body.memo,
      purpose: body.purpose,
      expirySeconds: body.expirySeconds,
    });
    return c.json(plan);
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * Records a hold the payer has just created on chain.
 *
 * Everything stored comes from the receipt rather than the request body: the
 * transfer id, the amount, the sender and the expiry are all read from the
 * contract event, so a client cannot claim a hold that does not exist or
 * overstate one that does.
 */
api.post("/escrow/protected/record", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      createTx: z.string().min(1),
      recipient: z.string().min(1),
      memo: z.string().max(120).optional(),
      purpose: z.enum(["claim_link", "job", "cooling_off"]).default("claim_link"),
      /** The seller's hold link this order was paid through. */
      holdLinkId: z.string().min(6).max(40).optional(),
    })
    .parse(await c.req.json());

  const {
    readCreatedTransferId,
    escrowRecipientKey,
    EscrowError,
    COOLING_OFF_SECONDS,
  } = await import("../services/protectedEscrow.js");
  const { trackProtectedEscrow } = await import("../services/escrow-jobs.js");

  try {
    const onChain = await readCreatedTransferId(body.createTx);
    const { kind, normalized, key } = escrowRecipientKey(body.recipient);

    // The recipient named in the request must be the one the money was
    // actually locked for, or the claim email would go to the wrong person.
    if (key.toLowerCase() !== onChain.recipientKey.toLowerCase()) {
      return c.json(
        { error: "That hold was not created for this recipient" },
        400,
      );
    }

    const payer = store.getUser(uid);
    if (
      !payer?.evmAddress ||
      payer.evmAddress.toLowerCase() !== onChain.sender.toLowerCase()
    ) {
      return c.json({ error: "That hold was funded by another wallet" }, 403);
    }

    // An order through a seller's link must be exactly what the link says:
    // this seller, this price, held for the delivery window.
    let holdLink: import("../services/holdLinks.js").HoldLink | null = null;
    if (body.holdLinkId) {
      const { assertHoldLinkOrder, HoldLinkError } = await import("../services/holdLinks.js");
      if (body.purpose !== "job") {
        return c.json({ error: "An order through a link is held until delivery" }, 400);
      }
      try {
        holdLink = assertHoldLinkOrder({
          holdLinkId: body.holdLinkId,
          buyerId: uid,
          recipientNormalized: normalized,
          amountUsdc: onChain.amountUsdc,
          expiresAtMs: new Date(onChain.expiresAt).getTime(),
        });
      } catch (error) {
        if (error instanceof HoldLinkError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    }

    const { quotePlatformFee } = await import("../services/platformFee.js");
    const record = trackProtectedEscrow({
      onChainTransferId: onChain.transferId,
      contractAddress: config.arc.paymentEscrow,
      purpose: body.purpose,
      ...(holdLink ? { holdLinkId: holdLink.id } : {}),
      ...(body.purpose === "cooling_off"
        ? {
            releaseAt: new Date(
              Date.now() + COOLING_OFF_SECONDS * 1000,
            ).toISOString(),
          }
        : {}),
      fromUserId: uid,
      recipientKind: kind === "email" ? "email" : "phone",
      recipientId: normalized,
      amountUsdc: onChain.amountUsdc,
      memo: body.memo,
      createTx: body.createTx,
      // The hold route adds the fee to the same batch whenever it applies.
      platformFee: Number(quotePlatformFee(onChain.amountUsdc, 6).fee),
      expiresInMs: Math.max(
        0,
        new Date(onChain.expiresAt).getTime() - Date.now(),
      ),
    });

    let emailed = false;
    if (kind === "email" && body.purpose === "claim_link") {
      try {
        const { notifySend } = await import("../services/notify.js");
        const res = await notifySend({
          toEmail: normalized,
          toHandle: normalized,
          fromName: payer?.displayName || payer?.email || "someone",
          amountUsdc: onChain.amountUsdc,
          memo: body.memo,
          mode: "escrow",
          claimToken: onChain.transferId,
        });
        emailed = res.emailSent === true;
      } catch (e) {
        console.warn("[escrow] claim email failed:", e);
      }
    }

    // Tell the worker money is set aside for them, and what to do next.
    if (body.purpose === "job") {
      const worker =
        kind === "email"
          ? store.findUserByEmail(normalized)
          : store.findUserByHandle(normalized);
      if (worker) {
        const { alertUser } = await import("../services/notifyUser.js");
        const buyer = payer?.handle ? `@${payer.handle}` : "Someone";
        alertUser(worker.id, {
          kind: "hold_waiting",
          title: holdLink ? `New order: ${holdLink.title}` : "Money set aside for your work",
          body: holdLink
            ? `${buyer} paid ${onChain.amountUsdc} USDC. It's set aside for you until they get their order. Mark it delivered when you've sent it.`
            : `${buyer} is holding ${onChain.amountUsdc} USDC for you. Mark the work delivered when it's done.`,
          amountUsdc: onChain.amountUsdc,
          token: "USDC",
          transferId: onChain.transferId,
        });
      }
    }

    return c.json({ ...record, transferId: onChain.transferId, emailed }, 201);
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * Releases a held payment to the person it was held for. Payer only.
 *
 * Kept for installed builds; it is the "confirm" action on /escrow/held and
 * follows the same rules — including that a claim link is released by the
 * recipient signing up, not by the payer.
 */
api.post("/escrow/protected/:transferId/release", async (c) => {
  const { confirmRelease, viewFor } = await import(
    "../services/heldPayments.js"
  );
  return heldAction(c, async (uid) => {
    const record = await confirmRelease({
      transferId: c.req.param("transferId"),
      userId: uid,
    });
    return {
      ok: true,
      claimTx: record.claimTx,
      amountUsdc: record.amountUsdc,
      hold: viewFor(record, "payer"),
    };
  });
});

// ─── Held payments: jobs, cooling-off, claim links ───────────────────────
//
// Rules (docs/HELD_PAYMENTS.md): the worker marks delivered; the payer has
// 7 days to confirm or object, and silence releases. Cancelling after
// delivery opens a reconciliation form that a person reviews. The server
// decides when money moves; PaymentEscrowV3 decides who it can reach.

async function heldAction(
  c: Context,
  run: (uid: string) => Promise<unknown> | unknown,
) {
  const { HeldPaymentError } = await import("../services/heldPayments.js");
  const { EscrowError } = await import("../services/protectedEscrow.js");
  try {
    return c.json(jsonSafe(await run(userId(c))));
  } catch (e) {
    if (e instanceof HeldPaymentError) {
      return c.json({ error: e.message }, e.status);
    }
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
}

const heldLinks = z.array(z.string().max(500)).max(5).optional();

/**
 * Every hold the caller pays or is paid by, newest first, with what they may
 * do next. Opening the list also runs anything due on those holds — a job
 * whose 7 days are up, a cooling-off payment whose window closed — so a
 * scheduler that runs late delays a release rather than losing it.
 */
api.get("/escrow/held", async (c) => {
  const uid = userId(c);
  const { listHoldsFor, runDueHeldPaymentWork, viewFor } = await import(
    "../services/heldPayments.js"
  );
  await runDueHeldPaymentWork({ onlyUserId: uid }).catch((e) =>
    console.warn("[held] due work:", e instanceof Error ? e.message : e),
  );
  return c.json({
    items: listHoldsFor(uid).map(({ record, role }) => viewFor(record, role)),
  });
});

api.get("/escrow/held/:transferId", async (c) => {
  const { holdFor, runDueHeldPaymentWork, viewFor } = await import(
    "../services/heldPayments.js"
  );
  return heldAction(c, async (uid) => {
    await runDueHeldPaymentWork({ onlyUserId: uid }).catch(() => undefined);
    const { record, role } = holdFor(c.req.param("transferId"), uid);
    return { hold: viewFor(record, role) };
  });
});

/** Worker: the work is done. Starts the payer's 7 days. */
api.post("/escrow/held/:transferId/deliver", async (c) => {
  const body = z
    .object({ note: z.string().min(1).max(500), links: heldLinks })
    .parse(await c.req.json());
  const { markDelivered, viewFor } = await import("../services/heldPayments.js");
  return heldAction(c, async (uid) => ({
    hold: viewFor(
      await markDelivered({
        transferId: c.req.param("transferId"),
        userId: uid,
        note: body.note,
        links: body.links,
      }),
      "worker",
    ),
  }));
});

/** Payer: pay the worker now. */
api.post("/escrow/held/:transferId/confirm", async (c) => {
  const { confirmRelease, viewFor } = await import("../services/heldPayments.js");
  return heldAction(c, async (uid) => ({
    hold: viewFor(
      await confirmRelease({ transferId: c.req.param("transferId"), userId: uid }),
      "payer",
    ),
  }));
});

/**
 * Payer: cancel. Before delivery (and for cooling-off and claim links) the
 * money comes straight back. After delivery the reconciliation form is
 * required — `reason` and `details` — and a person reviews it.
 */
api.post("/escrow/held/:transferId/cancel", async (c) => {
  const body = z
    .object({
      reason: z
        .enum(["no_longer_needed", "not_as_agreed", "not_received", "other"])
        .optional(),
      details: z.string().max(2000).optional(),
      links: heldLinks,
    })
    .parse(await c.req.json().catch(() => ({})));
  const { cancelHold, viewFor } = await import("../services/heldPayments.js");
  return heldAction(c, async (uid) => {
    const out = await cancelHold({
      transferId: c.req.param("transferId"),
      userId: uid,
      ...body,
    });
    return { hold: viewFor(out.record, "payer"), underReview: out.review };
  });
});

/** Worker: give the money back. Settles the hold and any open review. */
api.post("/escrow/held/:transferId/give-back", async (c) => {
  const { giveBack, viewFor } = await import("../services/heldPayments.js");
  return heldAction(c, async (uid) => ({
    hold: viewFor(
      await giveBack({ transferId: c.req.param("transferId"), userId: uid }),
      "worker",
    ),
  }));
});

/** Worker: their side of a review. */
api.post("/escrow/held/:transferId/respond", async (c) => {
  const body = z
    .object({ statement: z.string().min(1).max(2000), links: heldLinks })
    .parse(await c.req.json());
  const { respondToReview, viewFor } = await import(
    "../services/heldPayments.js"
  );
  return heldAction(c, async (uid) => ({
    hold: viewFor(
      respondToReview({
        transferId: c.req.param("transferId"),
        userId: uid,
        statement: body.statement,
        links: body.links,
      }),
      "worker",
    ),
  }));
});

/**
 * Either person writes in the conversation on an open review, with links and
 * up to 3 photos as evidence. The reviewer and the other person are told.
 */
api.post("/escrow/held/:transferId/messages", async (c) => {
  const body = z
    .object({
      text: z.string().min(1).max(2000),
      links: heldLinks,
      photos: evidencePhotos,
    })
    .parse(await c.req.json());
  const { addReviewMessage, viewFor, roleFor } = await import("../services/heldPayments.js");
  const { findTrackedByTransferId } = await import("../services/escrow-jobs.js");
  return heldAction(c, async (uid) => {
    const transferId = c.req.param("transferId");
    const beforeUpload = findTrackedByTransferId(transferId);
    if (!beforeUpload) throw new (await import("../services/heldPayments.js")).HeldPaymentError("Held payment not found", 404);
    if (!roleFor(beforeUpload, uid)) {
      throw new (await import("../services/heldPayments.js")).HeldPaymentError("This payment is not yours", 403);
    }
    if (beforeUpload.review?.status !== "under_review") {
      throw new (await import("../services/heldPayments.js")).HeldPaymentError("This review is closed", 409);
    }
    const photos = await storePhotos(body.photos, {
      ownerUserId: uid,
      contextId: transferId,
      participants: reviewParticipants(beforeUpload, uid),
    });
    const { record, message } = addReviewMessage({
      transferId,
      userId: uid,
      text: body.text,
      links: body.links,
      photos,
    });
    return { message, hold: viewFor(record, roleFor(record, uid)!) };
  });
});

/** What an operator sees of one review: both sides, and the work itself. */
function operatorReviewView(r: import("../services/mongo.js").ProtectedEscrowRecord) {
  return {
    transferId: r.onChainTransferId,
    amountUsdc: r.amountUsdc,
    memo: r.memo ?? "",
    payerUserId: r.fromUserId,
    payer: store.getUser(r.fromUserId)?.handle ?? null,
    recipient: r.recipientId,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    deliveredAt: r.deliveredAt,
    deliveryNote: r.deliveryNote,
    deliveryLinks: r.deliveryLinks ?? [],
    review: r.review,
  };
}

/** Operators: cancellations after delivery waiting for a decision. */
api.get("/operator/reviews", operatorOnly, async (c) => {
  const { listOpenReviews } = await import("../services/heldPayments.js");
  return c.json(jsonSafe({ items: listOpenReviews().map(operatorReviewView) }));
});

/** Operators: one review, open or already decided. */
api.get("/operator/reviews/:transferId", operatorOnly, async (c) => {
  const { findTrackedByTransferId } = await import("../services/escrow-jobs.js");
  const r = findTrackedByTransferId(c.req.param("transferId"));
  if (!r?.review) return c.json({ error: "No review for that payment" }, 404);
  return c.json(jsonSafe({ item: operatorReviewView(r) }));
});

const evidencePhotos = z
  .array(
    z.object({
      imageBase64: z.string().min(32).max(400_000),
      mime: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
    }),
  )
  .max(3)
  .optional();

function reviewParticipants(
  record: import("../services/mongo.js").ProtectedEscrowRecord,
  uploaderId: string,
): string[] {
  const recipient = record.recipientId.includes("@")
    ? store.findUserByEmail(record.recipientId)
    : store.findUserByHandle(record.recipientId);
  return [record.fromUserId, recipient?.id, uploaderId].filter(
    (value): value is string => Boolean(value),
  );
}

async function storePhotos(
  photos: z.infer<typeof evidencePhotos>,
  context: import("../services/evidence.js").PrivateMediaContext,
): Promise<string[]> {
  const { storeEvidencePhoto } = await import("../services/evidence.js");
  const out: string[] = [];
  for (const p of photos ?? []) {
    out.push(await storeEvidencePhoto(p.imageBase64, p.mime, context));
  }
  return out;
}

/** Operators: write in a review's conversation, as "Reviewer". */
api.post("/operator/reviews/:transferId/messages", operatorOnly, async (c) => {
  const body = z
    .object({
      text: z.string().min(1).max(2000),
      links: z.array(z.string()).max(5).optional(),
      photos: evidencePhotos,
    })
    .parse(await c.req.json());
  const { addReviewMessage } = await import("../services/heldPayments.js");
  const { findTrackedByTransferId } = await import("../services/escrow-jobs.js");
  return heldAction(c, async (uid) => {
    const transferId = c.req.param("transferId");
    const beforeUpload = findTrackedByTransferId(transferId);
    if (!beforeUpload?.review || beforeUpload.review.status !== "under_review") {
      return Promise.reject(new Error("Open review not found"));
    }
    const photos = await storePhotos(body.photos, {
      ownerUserId: uid,
      contextId: transferId,
      participants: reviewParticipants(beforeUpload, uid),
    });
    const { record, message } = addReviewMessage({
      transferId,
      userId: uid,
      asReviewer: true,
      text: body.text,
      links: body.links,
      photos,
    });
    return { message, item: operatorReviewView(record) };
  });
});

/** Operators: decide a review. Both people see the note. */
api.post("/operator/reviews/:transferId/decide", operatorOnly, async (c) => {
  const body = z
    .object({
      outcome: z.enum(["release", "refund"]),
      note: z.string().min(1).max(1000),
    })
    .parse(await c.req.json());
  const { decideReview, viewFor } = await import("../services/heldPayments.js");
  return heldAction(c, async (uid) => ({
    hold: viewFor(
      await decideReview({
        transferId: c.req.param("transferId"),
        operatorId: uid,
        outcome: body.outcome,
        note: body.note,
      }),
      "payer",
    ),
  }));
});

/**
 * Before a payment: who this really is, whether the sender has paid them
 * before, and whether to offer the ten-minute cooling-off hold.
 */
api.get("/payees/check", async (c) => {
  const to = (c.req.query("to") || "").trim();
  if (!to) return c.json({ error: "Who is this payment for?" }, 400);
  const { checkPayee } = await import("../services/safeSend.js");
  const { COOLING_OFF_SECONDS } = await import("../services/protectedEscrow.js");
  const result = checkPayee({
    userId: userId(c),
    to,
    coolingOffMinutes: Math.round(COOLING_OFF_SECONDS / 60),
    holdsEnabled:
      config.features.protectedSend && Boolean(config.arc.paymentEscrow),
  });
  if (!result.ok) return c.json(result, 400);
  // Whether this payee is marked as family, and above what the emailed code
  // is asked for, so the app can say so on the review sheet.
  const { familyCheckAbove } = await import("../services/familyCheck.js");
  const family = store
    .listContacts(userId(c))
    .some((k) => k.family && k.address.toLowerCase() === result.address.toLowerCase());
  return c.json({ ...result, family, familyCheckAbove: familyCheckAbove(userId(c)) });
});

// ─── Hold links (sellers: buyers' money set aside until delivery) ─────────

async function holdLinkAction(c: Context, run: () => unknown) {
  const { HoldLinkError } = await import("../services/holdLinks.js");
  try {
    return c.json((await run()) as object);
  } catch (error) {
    if (error instanceof HoldLinkError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

api.get("/hold-links", async (c) => {
  const { listHoldLinksFor, sellerRecord } = await import("../services/holdLinks.js");
  const uid = userId(c);
  return c.json({ items: listHoldLinksFor(uid), record: sellerRecord(uid) });
});

api.post("/hold-links", async (c) => {
  const body = z
    .object({
      title: z.string().min(1).max(120),
      description: z.string().max(600).optional(),
      amount: z.number().positive(),
      deliveryDays: z.number().int().min(1).max(60).optional(),
    })
    .parse(await c.req.json());
  const { createHoldLink, holdLinkUrl } = await import("../services/holdLinks.js");
  return holdLinkAction(c, () => {
    const link = createHoldLink(userId(c), body);
    return { item: { ...link, url: holdLinkUrl(link.id) } };
  });
});

api.post("/hold-links/:id/close", async (c) => {
  const { setHoldLinkActive } = await import("../services/holdLinks.js");
  return holdLinkAction(c, () => ({ item: setHoldLinkActive(userId(c), c.req.param("id"), false) }));
});

api.post("/hold-links/:id/open", async (c) => {
  const { setHoldLinkActive } = await import("../services/holdLinks.js");
  return holdLinkAction(c, () => ({ item: setHoldLinkActive(userId(c), c.req.param("id"), true) }));
});

// ─── Money circles and group pots ────────────────────────────────────────

async function groupAction(c: Context, run: () => unknown) {
  const { GroupMoneyError } = await import("../services/groupMoney.js");
  try {
    return c.json(jsonSafe(await run()));
  } catch (error) {
    if (error instanceof GroupMoneyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

const txBody = z.object({ txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) });

api.get("/groups", async (c) => {
  const { listGroupsFor } = await import("../services/groupMoney.js");
  return c.json(jsonSafe({ items: listGroupsFor(userId(c)) }));
});

api.get("/groups/:id", async (c) => {
  const { groupFor } = await import("../services/groupMoney.js");
  return groupAction(c, async () => ({ item: await groupFor(c.req.param("id"), userId(c)) }));
});

api.post("/groups/circles/:id/confirm", async (c) => {
  const { txHash } = txBody.parse(await c.req.json());
  const { confirmCircle, circleView } = await import("../services/groupMoney.js");
  return groupAction(c, async () => ({
    item: circleView(await confirmCircle(userId(c), c.req.param("id"), txHash as `0x${string}`), userId(c)),
  }));
});

/** After joining: refresh from the chain (the circle may have just started). */
api.post("/groups/circles/:id/sync", async (c) => {
  const { getGroup, syncCircle, circleView, GroupMoneyError } = await import("../services/groupMoney.js");
  return groupAction(c, async () => {
    const g = getGroup(c.req.param("id"));
    if (!g || g.kind !== "circle" || !g.memberIds.includes(userId(c))) throw new GroupMoneyError("No such circle", 404);
    return { item: circleView(await syncCircle(g), userId(c)) };
  });
});

api.post("/groups/pots/:id/confirm", async (c) => {
  const { txHash } = txBody.parse(await c.req.json());
  const { confirmPot, potView } = await import("../services/groupMoney.js");
  return groupAction(c, async () => ({
    item: potView(await confirmPot(userId(c), c.req.param("id"), txHash as `0x${string}`), userId(c)),
  }));
});

api.post("/groups/pots/:id/contributed", async (c) => {
  const { txHash } = txBody.parse(await c.req.json());
  const { confirmContribution, potView } = await import("../services/groupMoney.js");
  return groupAction(c, async () => ({
    item: potView(await confirmContribution(userId(c), c.req.param("id"), txHash as `0x${string}`), userId(c)),
  }));
});

// ─── Family check (emailed code before paying family) ─────────────────────

/** Emails a code for this payment when it needs one; says so when it does not. */
api.post("/family-check/start", async (c) => {
  const body = z
    .object({
      to: z.string().min(1),
      amount: z.number().positive(),
      token: z.enum(["USDC", "EURC", "CIRBTC"]).optional().default("USDC"),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  const { resolvePayee } = await import("../services/resolvePayee.js");
  const payee = resolvePayee(uid, body.to.trim());
  if (!payee.ok) return c.json({ error: payee.error, code: payee.code }, 404);
  const { startFamilyCheck, FamilyCheckError } = await import("../services/familyCheck.js");
  try {
    return c.json(
      await startFamilyCheck({ userId: uid, dest: payee.address, amount: body.amount, token: body.token }),
    );
  } catch (error) {
    if (error instanceof FamilyCheckError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
});

api.post("/family-check/verify", async (c) => {
  const body = z.object({ code: z.string().regex(/^\s*\d{6}\s*$/) }).parse(await c.req.json());
  const { verifyFamilyCode, FamilyCheckError } = await import("../services/familyCheck.js");
  try {
    return c.json(verifyFamilyCode(userId(c), body.code));
  } catch (error) {
    if (error instanceof FamilyCheckError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
});

/** The amount above which a payment to family needs the emailed code. */
api.get("/users/me/family-check", async (c) => {
  const { familyCheckAbove } = await import("../services/familyCheck.js");
  const uid = userId(c);
  return c.json({
    above: familyCheckAbove(uid),
    familyContacts: store.listContacts(uid).filter((k) => k.family).length,
  });
});

api.post("/users/me/family-check", async (c) => {
  const body = z.object({ above: z.number().min(0).max(1_000_000) }).parse(await c.req.json());
  const user = store.setFamilyCheckAbove(userId(c), body.above);
  if (!user) return c.json({ error: "unknown user" }, 404);
  return c.json({ above: body.above });
});

/**
 * Retired /escrow/job.
 *
 * Holds live in the escrow contract now: the payer funds them and the
 * contract refunds them if nobody releases. This path recorded a hold in a
 * JSON ledger and released it with an ops-wallet transfer, so the platform
 * paid out money it had never actually received.
 *
 * 410 rather than deletion, so an older installed build gets a definite
 * answer instead of something that looks like a routing fault.
 */
api.post("/escrow/job", (c) =>
  c.json(
    {
      error:
        "Held payments moved to the escrow contract. Use POST /v1/circle/escrow/hold, then POST /v1/escrow/protected/record.",
      code: "ESCROW_LEDGER_RETIRED",
    },
    410,
  ),
);

api.post("/escrow/job/:id/submit", async (c) => {
  const body = z
    .object({
      summary: z.string().optional(),
      deliverableUri: z.string().optional(),
      deliverable: z.unknown().optional(),
      threadId: z.string().optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  const { submitDeliverable } = await import("../services/arcJobEscrow.js");
  try {
    const job = submitDeliverable(c.req.param("id"), {
      ...body,
      userId: userId(c),
    });
    if (body.threadId) {
      try {
        store.addMessage({
          threadId: body.threadId,
          senderId: userId(c),
          kind: "system",
          text: `Escrow · delivered · ${job.id.slice(0, 8)}…`,
          meta: {
            type: "escrow_status",
            status: "Escrow · submitted",
            escrowJobId: job.id,
          },
        });
      } catch (_) {}
    }
    return c.json({ job });
  } catch (e) {
    return c.json(
      { error: clientError(e, "submit failed") },
      400,
    );
  }
});

async function resolvePayeeAddress(
  recipient: string,
): Promise<`0x${string}` | null> {
  const raw = recipient.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw as `0x${string}`;
  const handle = normalizeRecipient(raw).replace(/^@/, "");
  try {
    const r = await resolveIdentity("handle", handle);
    if (r?.account && /^0x[a-fA-F0-9]{40}$/.test(r.account)) {
      return r.account as `0x${string}`;
    }
  } catch (_) {}
  const byHandle = store.findUserByHandle(handle);
  if (
    byHandle?.evmAddress?.startsWith("0x") &&
    byHandle.evmAddress.length === 42
  ) {
    return byHandle.evmAddress as `0x${string}`;
  }
  const byId = store.getUser(raw);
  if (byId?.evmAddress?.startsWith("0x") && byId.evmAddress.length === 42) {
    return byId.evmAddress as `0x${string}`;
  }
  const byEmail = store.findUserByEmail(raw);
  if (
    byEmail?.evmAddress?.startsWith("0x") &&
    byEmail.evmAddress.length === 42
  ) {
    return byEmail.evmAddress as `0x${string}`;
  }
  return null;
}

/**
 * Retired /escrow/job/:id/complete.
 *
 * Holds live in the escrow contract now: the payer funds them and the
 * contract refunds them if nobody releases. This path recorded a hold in a
 * JSON ledger and released it with an ops-wallet transfer, so the platform
 * paid out money it had never actually received.
 *
 * 410 rather than deletion, so an older installed build gets a definite
 * answer instead of something that looks like a routing fault.
 */
api.post("/escrow/job/:id/complete", (c) =>
  c.json(
    {
      error:
        "Held payments moved to the escrow contract. Use POST /v1/escrow/protected/:transferId/release.",
      code: "ESCROW_LEDGER_RETIRED",
    },
    410,
  ),
);

/**
 * Retired /escrow/job/:id/reject.
 *
 * Holds live in the escrow contract now: the payer funds them and the
 * contract refunds them if nobody releases. This path recorded a hold in a
 * JSON ledger and released it with an ops-wallet transfer, so the platform
 * paid out money it had never actually received.
 *
 * 410 rather than deletion, so an older installed build gets a definite
 * answer instead of something that looks like a routing fault.
 */
api.post("/escrow/job/:id/reject", (c) =>
  c.json(
    {
      error:
        "Held payments moved to the escrow contract. An unreleased hold refunds itself once it expires.",
      code: "ESCROW_LEDGER_RETIRED",
    },
    410,
  ),
);

api.get("/escrow/job/:id", async (c) => {
  const { getJob, isJobPayer, isJobRecipient } = await import("../services/arcJobEscrow.js");
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const uid = userId(c);
  if (!isJobPayer(job, uid) && !isJobRecipient(job, uid)) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ job });
});

// ─── Payment requests (invoice links) ────────────────────────────────────

api.get("/payment-requests", async (c) => {
  const { listPaymentRequests } = await import(
    "../services/payment-requests.js"
  );
  return c.json({ items: listPaymentRequests(userId(c)) });
});

/**
 * Create a payment request.
 *
 * The caller is always the one to be paid — `createInvoice` records them as
 * the issuer, and paying it sends money to them. That was the missing piece
 * behind the assistant asking "who should I send it to?" when handed an
 * invoice link: nothing on the invoice said who the money was for.
 *
 * Accepts either a single amount or a list of priced lines. Lines are how
 * someone bills for three things at once and gets one total, which is what an
 * invoice is for.
 */
api.post("/payment-requests", async (c) => {
  const body = z
    .object({
      amount: z.number().positive().optional(),
      items: z
        .array(
          z.object({
            description: z.string().max(200).optional(),
            amount: z.number().positive(),
          }),
        )
        .max(20)
        .optional(),
      token: z.string().default("USDC"),
      description: z.string().optional().default(""),
      note: z.string().max(500).optional(),
      threadId: z.string().optional(),
      /** When payment is due; the payer is reminded around it. */
      dueAt: z.string().datetime().optional(),
      /** One hold per line, released as each is delivered. */
      milestones: z.boolean().optional(),
      /** Who should pay (@handle or email), so reminders reach them. */
      payer: z.string().max(120).optional(),
    })
    .refine((b) => b.amount != null || (b.items && b.items.length > 0), {
      message: "Needs an amount, or at least one priced line",
    })
    .parse(await c.req.json());

  const { createPaymentRequest } = await import(
    "../services/payment-requests.js"
  );
  const payer = body.payer ? store.findUserByRecipient(body.payer.trim()) : undefined;
  if (body.payer && !payer) {
    return c.json({ error: `No Evabob account for ${body.payer}` }, 404);
  }
  try {
    const row = createPaymentRequest({
      userId: userId(c),
      amount: body.amount ?? 0,
      items: body.items,
      token: body.token,
      description: body.description,
      note: body.note,
      threadId: body.threadId,
      dueAt: body.dueAt,
      milestones: body.milestones,
      ...(payer
        ? { receiverId: payer.id, receiverHandle: payer.handle ? `@${payer.handle}` : payer.email }
        : {}),
    });
    return c.json(row, 201);
  } catch (e) {
    return c.json({ error: clientError(e, "Could not create the request") }, 400);
  }
});

api.get("/payment-requests/:id", async (c) => {
  const { getPaymentRequest } = await import(
    "../services/payment-requests.js"
  );
  const row = getPaymentRequest(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const issuer = store.getUser(row.senderId || row.userId);
  return c.json({
    ...row,
    payee: {
      label: issuer?.handle
        ? `@${issuer.handle}`
        : issuer?.displayName || issuer?.email || "Evabob user",
      address: issuer?.evmAddress || null,
    },
  });
});

/**
 * Records an invoice paid by milestone: one hold per line item, all locked in
 * one transaction. Each hold is checked against its line — payer, the
 * issuer as recipient, the exact amount, in order — before any is tracked.
 */
api.post("/payment-requests/:id/milestones-held", async (c) => {
  const body = z.object({ createTx: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(await c.req.json());
  const uid = userId(c);
  const requests = await import("../services/payment-requests.js");
  const invoice = requests.getPaymentRequest(c.req.param("id"));
  if (!invoice) return c.json({ error: "not found" }, 404);
  if (!invoice.allowedStructures.includes("milestones")) {
    return c.json({ error: "This invoice is not paid by milestone" }, 409);
  }
  if (invoice.status !== "open") return c.json({ error: `This invoice is already ${invoice.status}` }, 409);
  const payer = store.getUser(uid);
  const issuer = store.getUser(invoice.senderId || invoice.userId);
  if (!payer?.evmAddress || !issuer) return c.json({ error: "unknown user" }, 404);
  if (issuer.id === uid) return c.json({ error: "You cannot pay your own invoice" }, 400);

  const { readCreatedTransferIds, escrowRecipientKey, EscrowError } = await import("../services/protectedEscrow.js");
  const { trackProtectedEscrow } = await import("../services/escrow-jobs.js");
  try {
    const created = await readCreatedTransferIds(body.createTx);
    const recipient = issuer.handle ? `@${issuer.handle}` : issuer.email;
    const { kind, normalized, key } = escrowRecipientKey(recipient);
    const units = (n: number) => Math.round(n * 1e6);
    const matches =
      created.length === invoice.items.length &&
      created.every(
        (t, i) =>
          t.sender.toLowerCase() === payer.evmAddress.toLowerCase() &&
          t.recipientKey.toLowerCase() === key.toLowerCase() &&
          units(t.amountUsdc) === units(invoice.items[i]!.amount),
      );
    if (!matches) {
      return c.json({ error: "Those holds do not match this invoice", code: "PAYMENT_UNVERIFIED" }, 409);
    }
    const { quotePlatformFee } = await import("../services/platformFee.js");
    const n = created.length;
    const tracked = created.map((t, i) =>
      trackProtectedEscrow({
        onChainTransferId: t.transferId,
        contractAddress: config.arc.paymentEscrow,
        purpose: "job",
        fromUserId: uid,
        recipientKind: kind === "email" ? "email" : "phone",
        recipientId: normalized,
        amountUsdc: t.amountUsdc,
        memo: `Milestone ${i + 1} of ${n}: ${invoice.items[i]!.description}`.slice(0, 120),
        createTx: body.createTx,
        // The fee on the whole invoice was charged once, in the same batch.
        platformFee: i === 0 ? Number(quotePlatformFee(invoice.total, 6).fee) : 0,
        expiresInMs: Math.max(0, Date.parse(t.expiresAt) - Date.now()),
      }),
    );
    const updated = requests.markPaymentRequest(invoice.id, "escrow", uid, {
      chosenStructure: "milestones",
      escrowTxHash: body.createTx,
      escrowLockedUsdc: invoice.total,
      milestoneTransferIds: created.map((t) => t.transferId),
      paidBy: uid,
      paidByLabel: payer.handle ? `@${payer.handle}` : payer.displayName,
    });
    const { alertUser } = await import("../services/notifyUser.js");
    alertUser(issuer.id, {
      kind: "hold_waiting",
      title: `${n} milestones set aside for you`,
      body: `${payer.handle ? `@${payer.handle}` : "Your client"} set aside ${invoice.total} USDC in ${n} parts. Mark each one delivered as you finish it.`,
      amountUsdc: invoice.total,
      token: "USDC",
      transferId: created[0]!.transferId,
    });
    return c.json(jsonSafe({ invoice: updated, transferIds: tracked.map((t) => t.onChainTransferId) }), 201);
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    return c.json({ error: clientError(e, "Could not record the milestones") }, 400);
  }
});

/**
 * The person a request was sent to says no. The card closes for both, and
 * the person who asked is told.
 */
api.post("/payment-requests/:id/decline", async (c) => {
  const uid = userId(c);
  const { declineInvoice, InvoicePermissionError } = await import("../services/payment-requests.js");
  try {
    const inv = declineInvoice(c.req.param("id"), uid);
    const me = store.getUser(uid);
    const who = me?.handle ? `@${me.handle}` : me?.displayName || "They";
    const symbol = (inv.token || "USDC").toUpperCase() === "EURC" ? "€" : "$";
    const amount = `${symbol}${inv.total.toFixed(2)}`;
    const issuerId = inv.senderId || inv.userId;
    if (inv.threadId) {
      const thread = store.listThreads().find((t) => t.id === inv.threadId);
      if (thread?.members.includes(uid)) {
        const note = store.addMessage({
          threadId: thread.id,
          senderId: "system",
          kind: "system",
          text: `${who} declined the request for ${amount}`,
        });
        try {
          await pusherTrigger(`private-chat-${thread.id}`, "message", note);
        } catch {
          // The alert below still reaches them.
        }
      }
    }
    const { alertUser } = await import("../services/notifyUser.js");
    alertUser(issuerId, {
      kind: "request_update",
      title: "Request declined",
      body: `${who} declined your request for ${amount}${inv.description ? ` · ${inv.description}` : ""}.`,
      link: inv.threadId ? `evabob://chat/${inv.threadId}` : inv.link,
      ...(inv.threadId ? { threadId: inv.threadId } : {}),
    });
    return c.json({ invoice: inv });
  } catch (e) {
    if (e instanceof InvoicePermissionError) return c.json({ error: e.message }, 403);
    throw e;
  }
});

api.post("/payment-requests/:id/mark", async (c) => {
  const body = z
    .object({
      status: z.enum(["open", "paid", "escrow", "cancelled"]),
      threadId: z.string().optional(),
      chosenStructure: z.enum(["full", "split", "escrow"]).optional(),
      paidTxHash: z.string().optional(),
      escrowTxHash: z.string().optional(),
      instantPaidUsdc: z.number().nonnegative().optional(),
      escrowLockedUsdc: z.number().nonnegative().optional(),
    })
    .parse(await c.req.json());
  const { markPaymentRequest, InvoicePermissionError } = await import(
    "../services/payment-requests.js"
  );
  try {
    const requested = (await import("../services/payment-requests.js")).getPaymentRequest(c.req.param("id"));
    if (!requested) return c.json({ error: "not found" }, 404);
    if (body.status === "paid") {
      // A client flag is not settlement evidence. Require the exact transfer
      // hash and verify the ERC-20 receipt before changing the invoice state.
      if (!body.paidTxHash) return c.json({ error: "paidTxHash is required" , code: "PAYMENT_PROOF_REQUIRED" }, 409);
      const payer = store.getUser(userId(c));
      const issuer = store.getUser(requested.userId);
      const { verifyPaymentEvidence } = await import("../services/payment-evidence.js");
      const verified = await verifyPaymentEvidence({
        txHash: body.paidTxHash,
        sender: payer?.evmAddress || "",
        recipient: issuer?.evmAddress || "",
        amount: requested.amount,
        token: requested.token,
        notBefore: requested.createdAt,
      });
      if (!verified) return c.json({ error: "Payment is not verified on chain.", code: "PAYMENT_UNVERIFIED" }, 409);
    }
    if (body.status === "escrow") {
      const structure = body.chosenStructure ?? "escrow";
      if (structure !== "escrow" && structure !== "split") {
        return c.json({ error: "Invalid escrow payment structure" }, 409);
      }
      if (!requested.allowedStructures.includes(structure)) {
        return c.json({ error: "That payment structure is not allowed" }, 409);
      }
      const escrowHash = body.escrowTxHash || (structure === "escrow" ? body.paidTxHash : undefined);
      if (!escrowHash) return c.json({ error: "escrowTxHash is required", code: "PAYMENT_PROOF_REQUIRED" }, 409);
      const locked = structure === "split"
        ? body.escrowLockedUsdc ?? Number((requested.amount / 2).toFixed(6))
        : requested.amount;
      const instant = structure === "split"
        ? body.instantPaidUsdc ?? Number((requested.amount - locked).toFixed(6))
        : 0;
      const units = (amount: number) => Math.round(amount * 1_000_000);
      if (locked <= 0 || instant < 0 || units(locked + instant) !== units(requested.amount)) {
        return c.json({ error: "Escrow portions do not equal the invoice total" }, 409);
      }
      const payer = store.getUser(userId(c));
      const issuer = store.getUser(requested.userId);
      const { readCreatedTransferId, readTransfer, escrowRecipientKey } = await import("../services/protectedEscrow.js");
      const held = await readCreatedTransferId(escrowHash);
      const heldState = await readTransfer(held.transferId);
      const expectedKeys = [issuer?.email, issuer?.handle]
        .filter((value): value is string => Boolean(value))
        .map(value => escrowRecipientKey(value).key.toLowerCase());
      if (!payer?.evmAddress || held.sender.toLowerCase() !== payer.evmAddress.toLowerCase()
        || units(held.amountUsdc) !== units(locked)
        || heldState.status !== "Pending" || heldState.expired
        || heldState.createdAt * 1000 + 60_000 < Date.parse(requested.createdAt)
        || !expectedKeys.includes(held.recipientKey.toLowerCase())) {
        return c.json({ error: "Held payment does not match this invoice", code: "PAYMENT_UNVERIFIED" }, 409);
      }
      if (structure === "split") {
        if (!body.paidTxHash) return c.json({ error: "paidTxHash is required for the instant portion", code: "PAYMENT_PROOF_REQUIRED" }, 409);
        const { verifyPaymentEvidence } = await import("../services/payment-evidence.js");
        const direct = await verifyPaymentEvidence({ txHash: body.paidTxHash,
          sender: payer.evmAddress, recipient: issuer?.evmAddress || "",
          amount: instant, token: requested.token,
          notBefore: requested.createdAt });
        if (!direct) return c.json({ error: "Instant portion is not verified on chain", code: "PAYMENT_UNVERIFIED" }, 409);
      }
    }
    // Who paid and when comes from the verified session and the clock, not
    // from the request body — a payer could otherwise credit the payment to
    // someone else, or backdate it.
    const payer = store.getUser(userId(c));
    const row = markPaymentRequest(c.req.param("id"), body.status, userId(c), {
      chosenStructure: body.chosenStructure,
      paidTxHash: body.paidTxHash,
      escrowTxHash: body.escrowTxHash || (body.status === "escrow" && body.chosenStructure !== "split" ? body.paidTxHash : undefined),
      instantPaidUsdc: body.instantPaidUsdc,
      escrowLockedUsdc: body.escrowLockedUsdc,
      ...(body.status === "paid" || body.status === "escrow"
        ? {
            paidBy: userId(c),
            paidByLabel: payer?.handle
              ? `@${payer.handle}`
              : payer?.displayName || payer?.email || undefined,
            paidAt: new Date().toISOString(),
          }
        : {}),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    // Patch original invoice messages so Pay button disappears after reload.
    if (body.status === "paid" || body.status === "escrow") {
      const statusLabel =
        body.status === "paid" ? "Request · paid" : "Request · escrow";
      for (const m of store.findMessagesByRequestId(
        c.req.param("id"),
        body.threadId,
      )) {
        store.updateMessageMeta(m.id, { status: statusLabel });
      }
    }
    return c.json(row);
  } catch (e) {
    // Not the caller's invoice to change — distinct from a state conflict.
    if (e instanceof InvoicePermissionError) {
      return c.json({ error: e.message, code: e.code }, 403);
    }
    return c.json(
      { error: clientError(e, "mark failed") },
      409,
    );
  }
});

// ─── Balances ──────────────────────────────────────────────────────────────

api.get("/wallet/balances", async (c) => {
  const uid = userId(c);
  const row = store.getUser(uid);
  const byEmail =
    row?.email && row.email.includes("@")
      ? store.findUserByEmail(row.email)
      : undefined;
  const address =
    c.req.query("address") ||
    row?.evmAddress ||
    byEmail?.evmAddress;
  if (!address) {
    return c.json({
      usdcWallet: 0,
      eurcWallet: 0,
      cirbtcWallet: 0,
      gatewayUsdc: 0,
      totalUsdc: 0,
      gatewayBalances: [],
      chainBalances: [],
      source: "empty",
    });
  }

  // Refreshing balances is the natural moment to look for USDC that arrived
  // from outside the app. Nothing used to watch the chain, so those transfers
  // never appeared anywhere. Deliberately not awaited: a catch-up scan can
  // take seconds, and anything it finds shows up in the activity feed the app
  // loads next.
  syncInboundInBackground({ userId: uid, address });

  let gatewayUsdc = 0;
  let gatewayPendingUsdc = 0;
  let gatewayConfirmedUsdc = 0;
  let gatewayBalances: Array<{
    domain: number;
    balance: string;
    balanceUsdc: number;
    pendingUsdc?: number;
    confirmedUsdc?: number;
    chainId?: string;
    name?: string;
  }> = [];
  let gatewayError: string | undefined;
  let appKitOk = false;
  try {
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
      const { DEPOSIT_CHAINS } = await import("../config.js");
      const nameByDomain = new Map(
        DEPOSIT_CHAINS.map((ch) => [ch.domain as number, ch.name]),
      );
      const idByDomain = new Map(
        DEPOSIT_CHAINS.map((ch) => [ch.domain as number, ch.id]),
      );

      // Prefer App Kit unified balance (correct field parse + testnet + pending).
      try {
        const { appKitGetBalances } = await import("../services/appKitMoney.js");
        const ub = await appKitGetBalances({
          address,
          includePending: true,
        });
        gatewayConfirmedUsdc = ub.confirmedUsdc;
        gatewayPendingUsdc = ub.pendingUsdc;
        gatewayUsdc =
          ub.totalUsdc > 0 ? ub.totalUsdc : ub.confirmedUsdc + ub.pendingUsdc;
        if (Array.isArray(ub.balances) && ub.balances.length > 0) {
          gatewayBalances = ub.balances
            .map((b) => {
              const domain =
                typeof b.domain === "number"
                  ? b.domain
                  : b.chain
                    ? ({
                        Arc_Testnet: 26,
                        Ethereum_Sepolia: 0,
                        Base_Sepolia: 6,
                        Ethereum: 0,
                        Base: 6,
                      } as Record<string, number>)[String(b.chain)]
                    : undefined;
              if (domain == null) return null;
              const conf =
                typeof b.confirmedUsdc === "number"
                  ? b.confirmedUsdc
                  : typeof b.balanceUsdc === "number"
                    ? b.balanceUsdc
                    : 0;
              const pend =
                typeof b.pendingUsdc === "number" ? b.pendingUsdc : 0;
              return {
                domain,
                balance: String(Math.round((conf + pend) * 1e6)),
                balanceUsdc: conf + pend,
                confirmedUsdc: conf,
                pendingUsdc: pend,
                chainId: idByDomain.get(domain),
                name:
                  nameByDomain.get(domain) ||
                  (b.name as string | undefined) ||
                  (b.chain as string | undefined),
              };
            })
            .filter((x): x is NonNullable<typeof x> => x != null);
        }
        appKitOk =
          gatewayUsdc > 0 ||
          gatewayPendingUsdc > 0 ||
          gatewayBalances.length > 0 ||
          Boolean(ub.raw);
      } catch (e) {
        gatewayError =
          clientError(e, "app kit balances failed");
      }

      // Legacy Gateway API when App Kit is empty or failed. It reports
      // pendingBatch per domain, so a deposit that has landed on chain but is
      // not yet final still shows up rather than reading as nothing happened.
      if (!appKitOk || (gatewayUsdc <= 0 && gatewayPendingUsdc <= 0)) {
        try {
          const g = await fetchGatewayBalances(address as `0x${string}`);
          if (gatewayUsdc <= 0 && gatewayPendingUsdc <= 0) {
            gatewayUsdc = g.totalUsdc;
            gatewayConfirmedUsdc = g.totalUsdc;
            gatewayPendingUsdc = g.pendingUsdc;
          }
          if (gatewayBalances.length === 0) {
            const toUsdc = (raw: string | undefined) => {
              const s = String(raw ?? "0").trim();
              if (!s) return 0;
              return s.includes(".") ? Number(s) || 0 : (Number(s) || 0) / 1e6;
            };
            gatewayBalances = (g.balances || []).map((b) => ({
              domain: b.domain,
              balance: b.balance,
              balanceUsdc: toUsdc(b.balance),
              confirmedUsdc: toUsdc(b.balance),
              pendingUsdc: toUsdc(b.pendingBatch),
              chainId: idByDomain.get(b.domain),
              name: nameByDomain.get(b.domain),
            }));
          }
        } catch (e) {
          if (!gatewayError) {
            gatewayError =
              clientError(e, "gateway balances failed");
          }
        }
      }
    }
  } catch (e) {
    gatewayError = clientError(e, "gateway error");
  }

  const { readMultiChainBalances } = await import("../services/arc-balances.js");
  let onchainError: string | undefined;
  const [onchain, chainBalances] = await Promise.all([
    readTokenBalances(address).catch((e) => {
      onchainError = clientError(e, "onchain balances failed");
      return {
        usdc: null,
        eurc: null,
        cirbtc: null,
        nativeUsdcWei: null,
        partial: true,
      };
    }),
    // null (not []) on failure — an empty list would erase the client's assets.
    readMultiChainBalances(address, {
      ids: ["arc", "ethereum-sepolia", "base-sepolia"],
      timeoutMs: 8_000,
    }).catch((e) => {
      console.warn("multi-chain balances:", e);
      return null;
    }),
  ]);
  if (chainBalances) {
    const arcRow = chainBalances.find((r) => r.id === "arc" || r.domain === 26);
    if (arcRow) {
      if (!(onchain.usdc != null && onchain.usdc > 0) && arcRow.usdc > 0) {
        onchain.usdc = arcRow.usdc;
      }
      if (!(onchain.eurc != null && onchain.eurc > 0) && arcRow.eurc > 0) {
        onchain.eurc = arcRow.eurc;
      }
      if (!(onchain.cirbtc != null && onchain.cirbtc > 0) && arcRow.cirbtc > 0) {
        onchain.cirbtc = arcRow.cirbtc;
      }
    }
  }
  // Failed wallet read stays null so the client keeps its last painted amount.
  const totalUsdc =
    onchain.usdc == null ? null : onchain.usdc + gatewayUsdc;

  return c.json({
    address,
    // null means "could not read this round" — clients must keep their previous
    // value instead of rendering zero.
    usdcWallet: onchain.usdc,
    eurcWallet: onchain.eurc,
    cirbtcWallet: onchain.cirbtc,
    gatewayUsdc,
    gatewayConfirmedUsdc,
    gatewayPendingUsdc,
    gatewayBalances,
    chainBalances,
    totalUsdc,
    balancesPartial: onchain.partial,
    gatewayError,
    onchainError,
    source: "arc+multichain+appkit",
  });
});

api.get("/wallet/deposit-addresses", (c) => {
  const uid = userId(c);
  const user = store.getUser(uid);
  const evm =
    c.req.query("evm") ||
    user?.evmAddress ||
    "";
  // Single EVM deposit address (same SCA across EVM testnets / Gateway path)
  return c.json({
    address: evm && evm.startsWith("0x") ? evm : null,
    asset: "USDC",
    networks: "EVM (Arc, Ethereum, Base, Arbitrum, Avalanche testnets)",
    note:
      "Send USDC on any supported EVM network to this address. ETH is not auto-converted — use USDC. Funds land in your wallet; use Deposit to Gateway to unify balance.",
    chains: evm
      ? depositAddressCatalog({ evmAddress: evm })
      : [],
  });
});

/**
 * Ops / treasury Gateway withdraw (server PRIVATE_KEY as depositor).
 * End-user Pay must use POST /v1/circle/gateway/pay (user SCA + delegate).
 */
api.post("/wallet/withdraw", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int().nonnegative(),
      destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      sourceDomain: z.number().int().optional(),
      /** Explicit ops flag — user pay is /v1/circle/gateway/pay */
      ops: z.boolean().optional(),
    })
    .parse(await c.req.json());

  if (!body.ops) {
    return c.json(
      {
        error: "User Gateway Pay must use Circle UCW path",
        use: "POST /v1/circle/gateway/pay with userToken + walletId",
        hint: "This endpoint only allows ops:true (treasury tests).",
      },
      400,
    );
  }

  try {
    const { gatewayWithdrawUsdc } = await import("../services/gateway-e2e.js");
    const result = await gatewayWithdrawUsdc({
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      destinationAddress: body.destinationAddress as `0x${string}`,
      sourceDomain: body.sourceDomain,
    });
    store.addActivity({
      userId: userId(c),
      kind: "withdraw",
      title: `Withdraw domain ${body.destinationDomain} (ops)`,
      description: `${body.amountUsdc} USDC → ${body.destinationAddress.slice(0, 10)}…`,
      amountUsdc: -body.amountUsdc,
      txHash: result.mintTx,
    });
    return c.json(jsonSafe(result));
  } catch (e) {
    return c.json(
      { error: clientError(e, "withdraw failed") },
      400,
    );
  }
});

api.post("/pusher/config", (c) =>
  c.json({
    key: config.pusher.key || null,
    cluster: config.pusher.cluster,
    configured: pusherConfigured(),
  }),
);

// ─── Contacts (named EVM addresses) ────────────────────────────────────────

api.get("/contacts", (c) => {
  const uid = userId(c);
  return c.json({ contacts: store.listContacts(uid) });
});

api.post("/contacts", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      name: z.string().min(1).max(64),
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      email: z.string().email().optional(),
      family: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const row = store.addContact({
    ownerUserId: uid,
    name: body.name,
    address: body.address,
    email: body.email,
    family: body.family,
  });
  return c.json({ contact: row });
});

/** Mark or unmark a contact as family (see /family-check). */
api.post("/contacts/:id/family", async (c) => {
  const body = z.object({ family: z.boolean() }).parse(await c.req.json());
  const row = store.setContactFamily(userId(c), c.req.param("id"), body.family);
  if (!row) return c.json({ error: "No such contact" }, 404);
  return c.json({ contact: row });
});

api.post("/contacts/:id/delete", async (c) => {
  const uid = userId(c);
  const ok = store.deleteContact(uid, c.req.param("id"));
  return c.json({ ok });
});

// ─── Transfers & exchange ──────────────────────────────────────────────────

api.post("/transfers/send", async (c) => {
  return c.json({
    error: "This legacy ledger route is disabled. Use Circle UCW send and confirm the on-chain receipt.",
    code: "USE_UCW",
  }, 410);
  /*
  const body = z
    .object({
      to: z.string().min(1),
      amountUsdc: z.number().positive(),
      amountNgn: z.number().nonnegative().default(0),
      memo: z.string().optional(),
      onChain: z.boolean().optional().default(true),
    })
    .parse(await c.req.json());

  try {
    const fromId = userId(c);
    const fromUser = store.getUser(fromId);
    const toRaw = body.to.trim();
    const { resolvePayee } = await import("../services/resolvePayee.js");
    const payee = resolvePayee(fromId, toRaw);
    if (!payee.ok) {
      return c.json({ error: payee.error, code: payee.code }, 404);
    }
    const peer = payee.user;
    const to = payee.label;

    const transfer = executeSend({
      fromUserId: fromId,
      toHandle: payee.label,
      amountUsdc: body.amountUsdc,
      amountNgn: body.amountNgn,
      memo: body.memo,
    });

    // In-app activity for recipient if they have an account
    if (peer) {
      store.addActivity({
        userId: peer.id,
        kind: "receive",
        title: fromUser?.displayName || "evabob user",
        description: body.memo || "Payment received",
        amountUsdc: body.amountUsdc,
        amountNgnHint: body.amountNgn || undefined,
        counterparty: fromUser?.email,
      });
      // Chat system message
      const threadId = `t_${peer.id.slice(0, 12)}`;
      let thread = store.listThreads().find((t) => t.id === threadId);
      if (!thread) {
        // soft: use existing chat seed path via messages store helpers if present
      }
      try {
        store.addMessage({
          threadId: store.listThreads()[0]?.id || "t_adaobi",
          senderId: "system",
          kind: "receipt",
          text: `Received ${body.amountUsdc} USDC from ${fromUser?.displayName || "someone"}`,
          meta: { amountUsdc: body.amountUsdc, mode: "instant" },
        });
      } catch {
        // optional
      }
    }

    return c.json({
      transfer,
      destinationAddress: payee.address,
      promptSave: payee.promptSave,
      mode: "instant",
      recipientHasAccount: Boolean(peer),
      message: `Delivered to ${payee.label}`,
    });
  } catch (e) {
    return c.json({ error: clientError(e, "send failed") }, 400);
  }
  */
});

// ─── Profile / handle ──────────────────────────────────────────────────────

async function patchMe(c: Context) {
  const body = z
    .object({
      displayName: z.string().min(1).max(48).optional(),
      // Custom images must pass the bounded upload endpoint. This field only
      // supports clearing an existing server-owned avatar.
      avatarUrl: z.literal("").optional(),
      /** A built-in picture (its index), or null to stop using one. */
      avatarBundle: z.number().int().min(0).max(63).nullable().optional(),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  if (!store.getUser(uid)) {
    return { status: 404 as const, body: { error: "unknown user — POST /users/session first" } };
  }
  if (body.displayName) {
    const r = store.updateDisplayName(uid, body.displayName);
    if (!r.ok) {
      return {
        status: 400 as const,
        body: { error: r.error, nextChangeAt: r.nextChangeAt ?? null },
      };
    }
  }
  const user = store.updateProfile(uid, {
    avatarUrl: body.avatarUrl,
    ...(body.avatarBundle !== undefined ? { avatarBundleIndex: body.avatarBundle } : {}),
  });
  if (body.displayName || body.avatarBundle !== undefined || body.avatarUrl !== undefined) {
    void announceProfileChange(uid);
  }
  return { status: 200 as const, body: { user } };
}

/**
 * Tells everyone this person chats with that their name or picture changed,
 * so it updates on their screens at once. A new name used to reach nobody:
 * the other phone kept the old one until it happened to reload.
 */
async function announceProfileChange(uid: string) {
  const user = store.getUser(uid);
  if (!user) return;
  const peers = new Set<string>();
  for (const t of store.listThreadsForUser(uid)) {
    for (const m of t.members) if (m && m !== uid) peers.add(m);
  }
  const payload = {
    kind: "profile_updated",
    userId: uid,
    displayName: user.displayName,
    handle: user.handle ?? null,
    avatarUrl: user.avatarUrl ?? null,
    avatarBundle: user.avatarBundleIndex ?? null,
    title: "",
    body: "",
  };
  for (const peer of peers) {
    // Straight to the app, no notification: nothing for anyone to read.
    void pusherTrigger(`${USER_CHANNEL_PREFIX}${peer}`, "alert", payload).catch(() => undefined);
  }
}

api.patch("/users/me", async (c) => {
  const r = await patchMe(c);
  return c.json(r.body, r.status);
});

/** Mobile client uses POST; same as PATCH /users/me */
api.post("/users/me", async (c) => {
  const r = await patchMe(c);
  return c.json(r.body, r.status);
});

api.get("/users/handle/check", (c) => {
  const handle = (c.req.query("handle") || "").trim().replace(/^@/, "");
  if (!handle) return c.json({ error: "handle required" }, 400);
  const taken = store.isHandleTaken(handle, userId(c));
  return c.json({ handle: handle.toLowerCase(), available: !taken });
});

api.post("/users/handle", async (c) => {
  const body = z
    .object({
      handle: z.string().min(3).max(24),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  const before = store.getUser(uid);
  const previousState = before
    ? {
        handle: before.handle,
        handleChangedAt: before.handleChangedAt,
        handleChangeCount: before.handleChangeCount,
      }
    : null;
  const result = store.updateHandle(uid, body.handle);
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        nextChangeAt: result.nextChangeAt ?? null,
      },
      400,
    );
  }
  const user = result.user;
  void announceProfileChange(uid);
  if (user.evmAddress && /^0x[a-fA-F0-9]{40}$/.test(user.evmAddress)) {
    try {
      const { adminUnlinkIdentity } = await import("../services/identity.js");
      // Link the new handle first. A conflict must not erase the old working
      // identity and leave this account unreachable on chain.
      await adminLinkIdentity({
        account: user.evmAddress as `0x${string}`,
        kind: "handle",
        identifier: user.handle || body.handle,
      });
      if (result.previousHandle && result.previousHandle !== user.handle) {
        try {
          await adminUnlinkIdentity({
            kind: "handle",
            identifier: result.previousHandle,
          });
        } catch (error) {
          // Both handles still resolve to the same owner. Cleanup can retry;
          // this is safer than rolling back a confirmed new identity.
          console.warn(
            "[identity] old handle cleanup pending",
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (e) {
      if (
        previousState &&
        (e instanceof IdentityConflictError ||
          e instanceof IdentityAdminMismatchError)
      ) {
        store.restoreHandleState(uid, previousState);
        return c.json(
          {
            error: "That handle could not be linked securely.",
            code: e.code,
          },
          409,
        );
      }
      console.warn(
        "[identity] handle link pending",
        e instanceof Error ? e.message : e,
      );
      return c.json(
        {
          user,
          message: "Handle saved; on-chain link is still pending.",
          code: "IDENTITY_LINK_PENDING",
        },
        202,
      );
    }
  }
  return c.json({ user, message: "Handle updated" });
});

api.post("/users/onboarding/complete", (c) => {
  const uid = userId(c);
  const user = store.getUser(uid);
  if (!user) {
    return c.json({ error: "unknown user — POST /users/session first" }, 404);
  }
  if (!user.evmAddress || !/^0x[a-fA-F0-9]{40}$/.test(user.evmAddress)) {
    return c.json({ error: "Finish wallet setup before continuing." }, 409);
  }
  // A generated email-prefix handle is only a suggestion. At least one
  // successful handle submission proves the person explicitly chose it.
  if (!user.handle || (user.handleChangeCount ?? 0) < 1) {
    return c.json({ error: "Choose your preferred handle before continuing." }, 409);
  }
  const completed = store.completeOnboarding(uid)!;
  return c.json({
    user: {
      ...completed,
      onboardingRequired: false,
    },
  });
});

// ─── Synthra quote / swap / bridge ─────────────────────────────────────────

api.get("/synthra/health", async (c) => {
  const { synthraHealth } = await import("../services/synthra.js");
  return c.json(synthraHealth());
});

api.post("/synthra/quote", async (c) => {
  const body = z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      amountIn: z.number().positive(),
      slippageBps: z.number().int().min(1).max(5000).optional(),
      fromDecimals: z.number().int().min(0).max(24).optional(),
      toDecimals: z.number().int().min(0).max(24).optional(),
    })
    .parse(await c.req.json());
  if (body.from.toLowerCase() === body.to.toLowerCase()) {
    return c.json({ error: "from and to must differ" }, 400);
  }
  const { synthraQuote, synthraConfigured } = await import(
    "../services/synthra.js"
  );
  if (!synthraConfigured()) {
    // Dev fallback: FX-style quote so UI can develop without key
    const { fxApprox } = await import("../services/transfers.js");
    const amountOut = fxApprox(
      body.from as "USDC" | "EURC" | "CIRBTC",
      body.to as "USDC" | "EURC" | "CIRBTC",
      body.amountIn,
    );
    return c.json({
      source: "fallback-fx",
      warning: "SYNTHRA_API_KEY not set — using approximate rate",
      from: body.from,
      to: body.to,
      amountIn: body.amountIn,
      amountOut,
      quote: null,
    });
  }
  const res = await synthraQuote({
    fromToken: body.from,
    toToken: body.to,
    amountIn: body.amountIn,
    slippageBps: body.slippageBps,
    fromDecimals: body.fromDecimals,
    toDecimals: body.toDecimals,
  });
  if (!res.ok) {
    return c.json(
      {
        error: res.error || "Synthra quote failed",
        status: res.status,
        data: res.quote,
      },
      502,
    );
  }
  return c.json({
    source: "synthra",
    quote: res.quote,
    from: body.from,
    to: body.to,
    amountIn: body.amountIn,
    amountOut: res.amountOut,
    amountOutRaw: res.amountOutRaw,
    amountInRaw: res.amountInRaw,
    routeString: res.routeString,
  });
});

api.post("/synthra/bridge/quote", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int(),
      mintRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    })
    .parse(await c.req.json());
  const { synthraBridgeQuote, synthraConfigured } = await import(
    "../services/synthra.js"
  );
  if (!synthraConfigured()) {
    return c.json({
      source: "cctp-local",
      warning: "SYNTHRA_API_KEY not set — use /v1/cctp burn path",
      ...body,
    });
  }
  const res = await synthraBridgeQuote(body);
  return c.json({ source: "synthra", ok: res.ok, status: res.status, data: res.data });
});

// ─── Activity ──────────────────────────────────────────────────────────────

api.get("/activity", (c) => {
  const items = store.listActivity(userId(c), Number(c.req.query("limit") || 50));
  return c.json({ items: withPeople(items) });
});

/**
 * Adds who is on the other side of each payment — name and picture — so a
 * row can show their face instead of a generic icon. Looked up from the
 * account behind the handle, email or address; nothing for rows that are not
 * with a person (conversions, moves between networks, top-ups).
 */
function withPeople<T extends { kind: string; counterparty?: string; receiver?: string; sender?: string }>(items: T[]) {
  const cache = new Map<string, Record<string, unknown> | null>();
  const personFor = (raw: string | undefined) => {
    const key = (raw ?? "").trim();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key)!;
    let person: Record<string, unknown> | null = null;
    const user = store.findUserByRecipient(key);
    if (user) {
      const url = user.avatarUrl && !user.avatarUrl.startsWith("data:") ? user.avatarUrl : null;
      person = {
        name: user.displayName || (user.handle ? `@${user.handle}` : user.email),
        handle: user.handle ? `@${user.handle}` : null,
        avatarUrl: url,
        avatarBundle: user.avatarBundleIndex ?? null,
      };
    } else {
      const agent = store.findAgentByHandle(key.replace(/^@/, ""));
      if (agent?.handle) person = { name: agent.label, handle: `@${agent.handle}`, avatarUrl: null, avatarBundle: null, agent: true };
    }
    cache.set(key, person);
    return person;
  };
  return items.map((row) => {
    if (!["send", "receive", "escrow"].includes(row.kind)) return row;
    const person = personFor(row.counterparty) ??
      personFor(row.kind === "receive" ? row.sender : row.receiver);
    return person ? { ...row, person } : row;
  });
}

/**
 * Money that has come in, newest first, for the seller's "Money in" screen.
 * `since` (ISO time) returns only what arrived after it, so the app can poll
 * cheaply and chime once per new payment.
 */
api.get("/activity/incoming", (c) => {
  const uid = userId(c);
  const address = store.getUser(uid)?.evmAddress;
  if (address) syncInboundInBackground({ userId: uid, address });
  const since = Date.parse(c.req.query("since") || "");
  const items = store
    .listActivity(uid, 200)
    .filter((a) => a.kind === "receive" && (a.status ?? "completed") === "completed")
    .filter((a) => !Number.isFinite(since) || Date.parse(a.createdAt) > since)
    .slice(0, Math.min(Number(c.req.query("limit") || 50), 100));
  return c.json({ items });
});

/** Make a payment shareable and return its public link. Payer only. */
api.post("/activity/:id/share", async (c) => {
  const { sharePayment, ReceiptError } = await import("../services/publicReceipts.js");
  try {
    const body = z
      .object({ expiresAt: z.string().datetime().optional(), rotate: z.boolean().optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(sharePayment(userId(c), c.req.param("id"), body));
  } catch (error) {
    if (error instanceof ReceiptError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

api.delete("/activity/:id/share", async (c) => {
  const { revokePublicReceipt, ReceiptError } = await import("../services/publicReceipts.js");
  try {
    return c.json({ ok: revokePublicReceipt(userId(c), c.req.param("id")) });
  } catch (error) {
    if (error instanceof ReceiptError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// ─── Chat ──────────────────────────────────────────────────────────────────

/** Threads for the current user only; title/handle = the other party. */
api.get("/chat/threads", (c) => {
  const uid = userId(c);
  ensureAgentThread(uid);
  const threads = pinAgentThreads(
    store.listThreadsForUser(uid).map((t) => store.threadForViewer(t, uid)),
  );
  return c.json({ threads });
});

api.get("/chat/threads/:id/messages", async (c) => {
  const uid = userId(c);
  const thread = store.listThreads().find((t) => t.id === c.req.param("id"));
  if (!thread || !thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before messages are available" }, 403);
  }
  // Request cards show where the request stands now — paid, declined,
  // cancelled — not what it was when it was posted.
  const { getPaymentRequest, invoiceCardMeta } = await import("../services/payment-requests.js");
  const { cardForLink } = await import("../services/evabobLinks.js");
  const messages = await Promise.all(store.messagesFor(c.req.param("id")).map(async (m) => {
    if (m.meta?.type === "link_card" && m.meta.link) {
      const fresh = await cardForLink(m.meta.link as never, uid).catch(() => null);
      return fresh ? { ...m, meta: { ...m.meta, ...fresh } } : m;
    }
    const requestId = m.meta?.type === "invoice_card" ? String(m.meta.requestId ?? "") : "";
    const inv = requestId ? getPaymentRequest(requestId) : undefined;
    return inv ? { ...m, meta: { ...m.meta, ...invoiceCardMeta(inv) } } : m;
  }));
  return c.json({ messages });
});

api.post("/chat/threads/:id/messages", async (c) => {
  const body = z
    .object({
      text: z.string().min(1),
      senderId: z.string().optional(),
      // Receipt/system messages are server-authored after on-chain evidence;
      // accepting them from the client lets anyone mint a fake payment UI.
      kind: z.literal("text").default("text"),
    })
    .parse(await c.req.json());

  const uid = userId(c);
  const thread = store.listThreads().find((t) => t.id === c.req.param("id"));
  if (!thread || !thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before sending messages" }, 403);
  }

  // A pasted pay link becomes a request card. The card is built here from the
  // request itself — never from anything the client sent — and a request its
  // owner shares in a chat is addressed to the other person.
  const { payLinkIds, getPaymentRequest, invoiceCardMeta, assignInvoiceReceiver } = await import(
    "../services/payment-requests.js"
  );
  const peerId = thread.members.find((m) => m && m !== uid);
  let card: Record<string, unknown> | undefined;
  for (const requestId of payLinkIds(body.text)) {
    let inv = getPaymentRequest(requestId);
    if (!inv) continue;
    const peer = peerId ? store.getUser(peerId) : undefined;
    if (peer && (inv.senderId || inv.userId) === uid) {
      inv = assignInvoiceReceiver(inv.id, { id: peer.id, handle: peer.handle }, thread.id) ?? inv;
    }
    card = invoiceCardMeta(inv);
    break;
  }
  // Any other Evabob link — sell with a link, a collection, a task, an agent,
  // a claim, a proof of payment — becomes the card for it.
  if (!card) {
    const { firstCardIn } = await import("../services/evabobLinks.js");
    card = (await firstCardIn(body.text, uid)) ?? undefined;
  }

  // Always stamp sender as authenticated user (never trust client "me").
  const msg = store.addMessage({
    threadId: c.req.param("id"),
    senderId: uid,
    kind: body.kind,
    text: body.text,
    ...(card ? { meta: card } : {}),
  });
  await announceChatMessage(thread, uid, msg);
  return c.json({ message: msg });
});

/**
 * A photo sent in a chat. Checked and stored like a profile photo (256 KB at
 * most, JPEG/PNG/WebP whose bytes match), under a random name only the chat
 * is given.
 */
api.post("/chat/threads/:id/photo", async (c) => {
  const body = z
    .object({
      imageBase64: z.string().min(32).max(400_000),
      mime: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
      caption: z.string().max(500).optional(),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  const thread = store.listThreads().find((t) => t.id === c.req.param("id"));
  if (!thread || !thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before sending photos" }, 403);
  }
  const { storeChatPhoto } = await import("../services/evidence.js");
  let url: string;
  try {
    url = await storeChatPhoto(body.imageBase64, body.mime, {
      ownerUserId: uid,
      contextId: thread.id,
      participants: thread.members,
    });
  } catch (error) {
    return c.json({ error: clientError(error, "That photo could not be sent") }, 400);
  }
  const caption = body.caption?.trim() ?? "";
  const msg = store.addMessage({
    threadId: thread.id,
    senderId: uid,
    kind: "text",
    text: caption || "📷 Photo",
    meta: { type: "photo", url, caption },
  });
  await announceChatMessage(thread, uid, msg);
  return c.json({ message: msg });
});

/**
 * Tells everyone else in a chat that a message arrived: live in the open
 * thread, and on their own channel (and by push) so the Chat tab can show it
 * and a closed app still hears about it.
 */
async function announceChatMessage(
  thread: { id: string; members: string[] },
  senderId: string,
  msg: { id: string; text: string; kind: string; meta?: Record<string, unknown> },
) {
  try {
    await pusherTrigger(`private-chat-${thread.id}`, "message", msg);
  } catch (e) {
    console.warn("pusher message", e);
  }
  const sender = store.getUser(senderId);
  const name = sender?.displayName || (sender?.handle ? `@${sender.handle}` : "Someone");
  const { alertUser } = await import("../services/notifyUser.js");
  for (const member of thread.members) {
    if (!member || member === senderId || member.startsWith("peer_") || member.endsWith("-agent")) continue;
    alertUser(member, {
      kind: "chat_message",
      title: name,
      body:
        msg.meta?.type === "invoice_card"
          ? `Sent you a request for ${String(msg.meta.amount ?? "")} ${String(msg.meta.token ?? "USDC")}`.trim()
          : msg.meta?.type === "photo"
            ? "Sent you a photo"
            : msg.text.slice(0, 140),
      link: `evabob://chat/${thread.id}`,
      threadId: thread.id,
    });
  }
}

/**
 * Posts a payment request into a chat as a card the other person can pay or
 * decline. Only the person who raised the request may post it.
 */
api.post("/chat/threads/:id/request", async (c) => {
  const body = z.object({ requestId: z.string().min(8).max(64) }).parse(await c.req.json());
  const uid = userId(c);
  const thread = store.listThreads().find((t) => t.id === c.req.param("id"));
  if (!thread || !thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before sending requests" }, 403);
  }
  const { getPaymentRequest, invoiceCardMeta, assignInvoiceReceiver } = await import(
    "../services/payment-requests.js"
  );
  let inv = getPaymentRequest(body.requestId);
  if (!inv) return c.json({ error: "No such request" }, 404);
  if ((inv.senderId || inv.userId) !== uid) {
    return c.json({ error: "Only the person who raised a request can post it" }, 403);
  }
  const peerId = thread.members.find((m) => m && m !== uid);
  const peer = peerId ? store.getUser(peerId) : undefined;
  if (peer) inv = assignInvoiceReceiver(inv.id, { id: peer.id, handle: peer.handle }, thread.id) ?? inv;
  const card = invoiceCardMeta(inv);
  const symbol = (inv.token || "USDC").toUpperCase() === "EURC" ? "€" : "$";
  const msg = store.addMessage({
    threadId: thread.id,
    senderId: uid,
    kind: "receipt",
    text: `Payment request · ${symbol}${inv.total.toFixed(2)}${inv.description ? ` · ${inv.description}` : ""}`,
    meta: card,
  });
  await announceChatMessage(thread, uid, msg);
  return c.json({ message: msg }, 201);
});

/**
 * Chat money command — **does not** move funds by itself for UCW user sends.
 * Client must run Circle UCW send (PIN) or App Kit UCW job, then call with
 * confirmed:true to post the receipt into the thread.
 *
 * Preferred client flows:
 * - User send: POST /v1/circle/send OR /v1/app-kit/ucw/send → PIN → confirmed
 * - Buy/swap:  POST /v1/app-kit/ucw/swap (or legacy /v1/circle/swap)
 * - Bridge:    POST /v1/app-kit/ucw/bridge (or legacy /v1/circle/cctp/burn)
 * - Compose:   POST /v1/app-kit/ucw/compose (spend → swap → bridge)
 */
api.post("/chat/threads/:id/send-command", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      amountNgn: z.number().nonnegative().optional().default(0),
      memo: z.string().optional(),
      peerHandle: z.string().min(1),
      myId: z.string().default("me"),
      token: z.enum(["USDC", "EURC", "CIRBTC"]).optional().default("USDC"),
      /** Must be true only after on-chain UCW send succeeds */
      confirmed: z.boolean().optional().default(false),
      activityId: z.string().optional(),
      txHash: z.string().optional(),
      destinationAddress: z.string().optional(),
    })
    .parse(await c.req.json());

  const thread = store.listThreads().find(t => t.id === c.req.param("id"));
  if (!thread || !thread.members.includes(userId(c))) return c.json({ error: "Chat not found" }, 404);
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before attaching payments" }, 403);
  }
  const fromId = userId(c);
  const fromUser = store.getUser(fromId);
  const receiverHandle = normalizeRecipient(body.peerHandle);
  const senderLabel =
    fromUser?.handle
      ? `@${fromUser.handle}`
      : fromUser?.displayName || fromUser?.email || fromId;

  if (!body.confirmed) {
    // Resolve peer for client convenience — no ledger mock transfer
    const peer =
      store.findUserByHandle(receiverHandle) ||
      store.findUserByRecipient(body.peerHandle);
    return c.json({
      needsOnchain: true,
      token: body.token,
      amount: body.amountUsdc,
      peerHandle: receiverHandle,
      peerAddress: peer?.evmAddress ?? null,
      message:
        "Complete Circle UCW send with PIN, then call again with confirmed:true",
    });
  }

  const { verifyPaymentEvidence } = await import("../services/payment-evidence.js");
  const { resolvePayee } = await import("../services/resolvePayee.js");
  const payee = resolvePayee(fromId, body.peerHandle);
  if (!payee.ok || !await verifyPaymentEvidence({ txHash: body.txHash || "",
    sender: fromUser?.evmAddress || "", recipient: payee.address,
    amount: body.amountUsdc, token: body.token,
    notBefore: Date.now() - 30 * 60_000 })) {
    return c.json({ error: "Payment is not verified on chain." }, 409);
  }
  const existingReceipt = store.findReceiptByTxHash(body.txHash!);
  if (existingReceipt) {
    if (existingReceipt.threadId !== c.req.param("id")) {
      return c.json({ error: "That transaction is already attached to another receipt." }, 409);
    }
    return c.json({ receipt: existingReceipt, onchain: true, idempotent: true });
  }
  // The money already moved on chain and was already recorded by the send
  // route and the App Kit job. This call is here for the transfer record the
  // chat receipt refers to, not to record the payment a second time.
  const transfer = executeSend({
    fromUserId: fromId,
    toHandle: body.peerHandle,
    amountUsdc: body.token === "USDC" ? body.amountUsdc : 0,
    amountNgn: body.amountNgn ?? 0,
    memo: body.memo,
    recordActivity: false,
  });

  const amountLine = `${body.amountUsdc} ${body.token}`;
  const when = new Date().toISOString();
  const hash =
    body.txHash && body.txHash.startsWith("0x") ? body.txHash : undefined;

  const receipt = store.addMessage({
    threadId: c.req.param("id"),
    senderId: "system",
    kind: "receipt",
    text: `Sent ${amountLine} to @${receiverHandle}`,
    meta: {
      transferId: transfer.id,
      amountUsdc: body.token === "USDC" ? body.amountUsdc : 0,
      amountNgn: body.amountNgn,
      amount: body.amountUsdc,
      memo: body.memo,
      sender: senderLabel,
      receiver: `@${receiverHandle}`,
      token: body.token,
      date: when,
      hash,
      txHash: hash,
      mode: "onchain_ucw",
      destinationAddress: body.destinationAddress,
    },
  });

  try {
    await pusherTrigger(`private-chat-${c.req.param("id")}`, "message", receipt);
  } catch (e) {
    console.warn("pusher receipt", e);
  }

  return c.json({ transfer, receipt, onchain: true, rail: "app-kit-or-ucw" });
});

/**
 * Chat command router for App Kit money movement.
 * Parses action + params and starts the appropriate App Kit UCW job
 * (or ops path when mode is server-signed).
 *
 * Body examples:
 *   { action: "send", userToken, walletId, to, amount, token }
 *   { action: "swap", userToken, amountIn, tokenIn, tokenOut }
 *   { action: "bridge", userToken, amount, fromChain, toChain }
 *   { action: "compose", userToken, spend, swap, bridge }
 */
api.post("/chat/threads/:id/money-command", async (c) => {
  const body = z
    .object({
      action: z.enum([
        "send",
        "swap",
        "buy",
        "bridge",
        "deposit",
        "spend",
        "compose",
      ]),
      userToken: z.string().min(10).optional(),
      walletId: z.string().optional(),
      walletAddress: z.string().optional(),
      /** ops | ucw — default ucw when userToken present */
      signing: z.enum(["ucw", "ops"]).optional(),
      mode: z.enum(["circle-wallets", "viem-ops"]).optional(),
      to: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      amountIn: z.union([z.string(), z.number()]).optional(),
      token: z.string().optional(),
      tokenIn: z.string().optional(),
      tokenOut: z.string().optional(),
      chain: z.string().optional(),
      fromChain: z.union([z.string(), z.number()]).optional(),
      toChain: z.union([z.string(), z.number()]).optional(),
      recipientAddress: z.string().optional(),
      fromAddress: z.string().optional(),
      toAddress: z.string().optional(),
      memo: z.string().optional(),
      spend: z
        .object({
          amountIn: z.union([z.string(), z.number()]),
          recipientAddress: z.string().optional(),
          toChain: z.string().optional(),
        })
        .optional(),
      swap: z
        .object({
          tokenIn: z.string().optional(),
          tokenOut: z.string().optional(),
          amountIn: z.union([z.string(), z.number()]).optional(),
          chain: z.string().optional(),
        })
        .optional(),
      bridge: z
        .object({
          fromChain: z.string().optional(),
          toChain: z.union([z.string(), z.number()]),
          toAddress: z.string().optional(),
          amount: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());

  const uid = userId(c);
  const threadId = c.req.param("id");
  const thread = store.listThreads().find((t) => t.id === threadId);
  if (!thread || !thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (thread.state === "pending" || thread.state === "blocked") {
    return c.json({ error: "Chat must be accepted before payment commands" }, 403);
  }

  if (!config.appKit.enabled) {
    return c.json(
      {
        error: "App Kit disabled (USE_APP_KIT=false)",
        fallback: {
          send: "POST /v1/circle/send",
          swap: "POST /v1/circle/swap",
          bridge: "POST /v1/circle/cctp/burn",
        },
      },
      503,
    );
  }

  if (body.signing === "ops" || body.mode || body.fromAddress || !body.userToken) {
    return c.json({ error: "Customer payments require Circle UCW authorization." }, 403);
  }
  const useUcw = true;

  try {
    if (useUcw) {
      if (!body.userToken) {
        return c.json({ error: "userToken required for UCW App Kit jobs" }, 400);
      }
      const {
        startUcwSendJob,
        startUcwSwapJob,
        startUcwBridgeJob,
        startUcwDepositJob,
        startUcwSpendJob,
        startUcwComposeJob,
        getAppKitJob,
      } = await import("../services/appKitMoney.js");
      const { circleAppId } = await import("../services/circle-ucw.js");

      let job;
      const action = body.action === "buy" ? "swap" : body.action;
      const walletAddress = body.walletAddress as `0x${string}` | undefined;

      if (action === "send") {
        if (!body.to || body.amount == null) {
          return c.json({ error: "to and amount required" }, 400);
        }
        job = startUcwSendJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          to: body.to,
          amount: body.amount,
          token: body.token || "USDC",
          chain: body.chain || "Arc_Testnet",
        });
      } else if (action === "swap") {
        if (body.amountIn == null && body.amount == null) {
          return c.json({ error: "amountIn required" }, 400);
        }
        job = startUcwSwapJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          amountIn: body.amountIn ?? body.amount!,
          tokenIn: body.tokenIn || "USDC",
          tokenOut: body.tokenOut || body.token || "EURC",
          chain: body.chain || "Arc_Testnet",
        });
      } else if (action === "bridge") {
        if (body.amount == null || body.toChain == null) {
          return c.json({ error: "amount and toChain required" }, 400);
        }
        const { warnIfRelayUnfunded } = await import("../services/appKitMoney.js");
        void warnIfRelayUnfunded(body.toChain);
        job = startUcwBridgeJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          amount: body.amount,
          fromChain: body.fromChain || "Arc_Testnet",
          toChain: body.toChain,
          toAddress: body.toAddress || walletAddress,
        });
      } else if (action === "deposit") {
        if (body.amount == null) {
          return c.json({ error: "amount required" }, 400);
        }
        job = startUcwDepositJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          amount: body.amount,
          chain: body.chain || "Arc_Testnet",
        });
      } else if (action === "spend") {
        if (body.amountIn == null || !body.recipientAddress) {
          return c.json(
            { error: "amountIn and recipientAddress required" },
            400,
          );
        }
        job = startUcwSpendJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          amountIn: body.amountIn,
          recipientAddress: body.recipientAddress,
          toChain: body.toChain?.toString() || "Arc_Testnet",
        });
      } else {
        job = startUcwComposeJob({
          userId: uid,
          userToken: body.userToken,
          walletId: body.walletId,
          walletAddress,
          spend: body.spend,
          swap: body.swap,
          bridge: body.bridge,
        });
      }

      // Short wait for first challenge
      await new Promise((r) => setTimeout(r, 400));
      const latest = getAppKitJob(job.id)!;

      // System note in chat (not a receipt yet)
      try {
        const note = store.addMessage({
          threadId,
          senderId: "system",
          kind: "system",
          text: `App Kit ${action} started — confirm with PIN`,
          meta: {
            jobId: job.id,
            action,
            rail: "app-kit",
          },
        });
        await pusherTrigger(`private-chat-${threadId}`, "message", note).catch(
          () => undefined,
        );
      } catch {
        /* optional */
      }

      return c.json({
        ok: true,
        rail: "app-kit-ucw",
        action,
        jobId: latest.id,
        status: latest.status,
        challenges: latest.challenges.map((ch) => ({
          step: action,
          challengeId: ch.challengeId,
        })),
        appId: circleAppId(),
        message:
          "Complete PIN challenges, poll GET /v1/app-kit/jobs/:jobId, then POST send-command with confirmed:true for receipt",
      });
    }

  } catch (e) {
    return c.json(
      { error: clientError(e, "money-command failed") },
      400,
    );
  }
});

/**
 * Finalize or discard a receipt after PIN challenge.
 * Only `status: completed` receipts appear in history / exports.
 */
api.patch("/activity/:id", async (c) => {
  const body = z
    .object({
      txHash: z.string().min(8).max(128).optional(),
      mode: z.string().optional(),
      /** completed = show receipt; cancelled|failed = hide forever */
      status: z.enum(["completed", "cancelled", "failed"]).optional(),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  const row = store.getActivity(c.req.param("id"));
  if (!row || row.userId !== uid) {
    return c.json({ error: "Activity not found" }, 404);
  }
  const { confirmPaymentActivity } = await import("../services/confirm-payment.js");
  if (body.status === "cancelled" || body.status === "failed") {
    return c.json({ error: "Payment status must be reconciled server-side." }, 409);
  }
  try {
    const result = await confirmPaymentActivity(uid, row.id, body.txHash);
    return c.json({ item: result.row });
  } catch {
    return c.json({ error: "Payment is not yet verified on chain." }, 409);
  }
});

/** Create a pending chat invitation by public handle. Emails are never probed. */
api.post("/chat/threads", async (c) => {
  const body = z
    .object({
      peer: z.string().min(1),
      title: z.string().optional(),
    })
    .parse(await c.req.json());
  const uid = userId(c);
  const raw = body.peer.trim();
  if (raw.includes("@") && !raw.startsWith("@")) {
    return c.json(
      {
        status: "invite_required",
        detail: "Use an @handle or share an invite link.",
      },
      202,
    );
  }
  const handle = raw.replace(/^@/, "").toLowerCase();
  const account = store.getUser(uid);
  const accountAgeMs = account ? Date.now() - Date.parse(account.createdAt) : 0;
  const inviteLimit = accountAgeMs < 24 * 60 * 60_000 ? 3 : 20;
  const actorLimit = await consumeNamedRateLimit(
    "chat-invite-account",
    uid,
    inviteLimit,
    24 * 60 * 60_000,
  );
  const targetLimit = await consumeNamedRateLimit(
    "chat-invite-target",
    `${uid}:${handle}`,
    3,
    24 * 60 * 60_000,
  );
  if (!actorLimit.allowed || !targetLimit.allowed) {
    const retryAfter = Math.max(
      actorLimit.allowed ? 0 : actorLimit.retryAfterSeconds,
      targetLimit.allowed ? 0 : targetLimit.retryAfterSeconds,
    );
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "Too many chat invitations. Try again later." }, 429);
  }
  const peer =
    store.findUserByHandle(handle);
  if (!peer) {
    return c.json(
      { error: "That handle cannot receive a chat invitation.", code: "INVITE_UNAVAILABLE" },
      404,
    );
  }
  if (peer.id === uid) {
    return c.json({ error: "Cannot start a chat with yourself" }, 400);
  }
  const peerHandle = peer.handle || handle;
  const title = body.title || peer.displayName || peer.handle || raw;
  const thread = store.addThread({
    members: [uid, peer.id],
    title,
    subtitle: "Say hello",
    handle: peerHandle,
    state: "pending",
    invitedBy: uid,
  });
  // Always return peer-relative view for the creator
  return c.json({
    thread: store.threadForViewer(thread, uid),
    requiresAcceptance: thread.state === "pending",
  });
});

api.post("/chat/threads/:id/accept", (c) => {
  const thread = store.acceptThread(c.req.param("id"), userId(c));
  return thread
    ? c.json({ thread: store.threadForViewer(thread, userId(c)) })
    : c.json({ error: "Chat invitation not found" }, 404);
});

api.post("/chat/threads/:id/block", (c) => {
  const thread = store.blockThread(c.req.param("id"), userId(c));
  return thread ? c.json({ ok: true }) : c.json({ error: "Chat not found" }, 404);
});

api.post("/chat/threads/:id/report", async (c) => {
  const body = z.object({ reason: z.string().min(3).max(500) }).parse(await c.req.json());
  const thread = store.reportThread(c.req.param("id"), userId(c), body.reason);
  return thread ? c.json({ ok: true }) : c.json({ error: "Chat not found" }, 404);
});

// ─── Agent wallets + x402 nanopayments ─────────────────────────────────

export const allowanceBody = z.object({
  amountUsdc: z.number().positive(),
  window: z.enum(["day", "week", "month"]),
  categories: z.array(z.enum(["research", "data", "media", "ai", "finance", "people", "tools"])).max(7).default([]),
  askAboveUsdc: z.number().min(0),
  proofOnly: z.boolean().default(true),
});

/**
 * What an agent wallet can pay for on this network, from Circle's catalog.
 *
 * Only sellers the payer can settle with are listed: GET, Gateway-batched, on
 * this deployment's network, and allowed by AGENT_RESOURCE_ORIGINS. On Arc
 * Testnet the catalog has none, and the response says so plainly instead of
 * listing services an agent could never pay.
 */
api.get("/agents/services", async (c) => {
  const { payableServices, resolvedAgentOrigins, agentPaymentNetwork } =
    await import("../services/circle-x402.js");
  const network = agentPaymentNetwork();
  let services: Awaited<ReturnType<typeof payableServices>> = [];
  let catalogError: string | null = null;
  try {
    services = await payableServices();
  } catch (e) {
    catalogError = e instanceof Error ? e.message : "catalog unavailable";
  }
  const allowed = new Set(await resolvedAgentOrigins());
  const items = services.map((s) => ({ ...s, allowed: allowed.has(s.origin) }));
  const payable = items.filter((s) => s.allowed);
  return c.json({
    network,
    paidExecution:
      config.features.x402Execution &&
      payable.length > 0 &&
      Boolean(config.circle.apiKey && config.circle.entitySecret),
    items,
    note: catalogError
      ? "The service catalog is unavailable right now."
      : services.length === 0
        ? "No services accept agent payments on this network yet."
        : payable.length === 0
          ? "Services exist on this network but none are allowed for agents here yet."
          : null,
  });
});

api.post("/x402/pay", async (c) => {
  const body = z
    .object({
      url: z.string().url().optional(),
      query: z.string().optional(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      maxAmountUsdc: z.number().positive().optional(),
      idempotencyKey: z.string().min(16).max(100).optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  const principal = getAuth(c);
  if (principal.principal !== "agent" || !principal.agentId) {
    return c.json(
      {
        error: "API key required",
        code: "API_KEY_REQUIRED",
        hint: "Authorization: Bearer sk_evabob_…",
      },
      401,
    );
  }
  const { x402PayForAgent, x402DiscoverAndPay } =
    await import("../services/x402Pay.js");
  const agent = store.getAgentById(principal.agentId);
  if (!agent) {
    return c.json({ error: "Invalid API key", code: "INVALID_API_KEY" }, 401);
  }
  try {
    const result = body.url
      ? await x402PayForAgent({
          agent,
          url: body.url,
          method: body.method,
          headers: body.headers,
          body: body.body,
          maxAmountUsdc: body.maxAmountUsdc,
          idempotencyKey:
            c.req.header("idempotency-key") || body.idempotencyKey,
        })
      : await x402DiscoverAndPay({
          agent,
          query: body.query || "polymarket",
        });
    return c.json(
      result,
      result.ok ? 200 : result.reconciliationRequired ? 202 : 400,
    );
  } catch (e) {
    return c.json(
      { error: clientError(e, "x402 pay failed") },
      400,
    );
  }
});

api.get("/agents", async (c) => {
  const uid = userId(c);
  return c.json({ wallets: store.listAgents(uid).map(publicAgent) });
});

api.get("/agents/:id/payments", (c) => {
  const w = store.getAgent(userId(c), c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);
  return c.json({
    payments: [...(w.paymentHistory || [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
    reconciliationRequired: (w.paymentHistory || []).some(
      (row) => row.status === "authorized" || row.status === "ambiguous",
    ),
  });
});

api.post("/agents", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      label: z.string().default("Agent fund"),
      // Clamped server-side: the caller picks this, so an unbounded value
      // would make the daily rail meaningless.
      dailyLimitUsdc: z
        .number()
        .positive()
        .max(config.agents.maxDailyLimitUsdc)
        .default(Math.min(50, config.agents.maxDailyLimitUsdc)),
      /**
       * Ceiling for a single x402 call. Without it, one expensive resource can
       * consume the entire daily budget in one request.
       */
      perCallLimitUsdc: z
        .number()
        .positive()
        .max(config.agents.maxDailyLimitUsdc)
        .optional(),
      /** "$20 this week, research services only", ask me above $2. */
      allowance: allowanceBody.optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  if (body.allowance) {
    const { validateAllowance } = await import("../services/agentAllowance.js");
    const problem = validateAllowance(body.allowance, config.agents.maxDailyLimitUsdc * 31);
    if (problem) return c.json({ error: problem }, 400);
  }

  const rawKey = `sk_evabob_${randomUUID().replace(/-/g, "")}`;
  const prefix = rawKey.slice(0, 16);
  const hash = createHash("sha256").update(rawKey).digest("hex");
  let provisioned;
  try {
    const { provisionAgentWallet } = await import("../services/agentWallet.js");
    provisioned = await provisionAgentWallet();
  } catch (e) {
    return c.json(
      { error: clientError(e, "Could not provision a dedicated Circle agent wallet") },
      503,
    );
  }
  const wallet = store.createAgent({
    userId: uid,
    label: body.label,
    dailyLimitUsdc: body.dailyLimitUsdc,
    perCallLimitUsdc: body.perCallLimitUsdc,
    apiKeyHash: hash,
    apiKeyPrefix: prefix,
    // apiKeyFull is deliberately not passed: the key is shown once here and
    // never persisted in a readable form. Lost keys are rotated, not revealed.
    custodyAddress: provisioned.address,
    custodyMode: "circle-eoa",
    circleWalletId: provisioned.walletId,
    chain: "Arc_Testnet",
  });
  if (body.allowance) {
    wallet.allowance = body.allowance;
    store.save();
  }
  store.addActivity({
    userId: uid,
    kind: "agent",
    title: wallet.label,
    description: "Agent payment wallet created",
    amountUsdc: 0,
    status: "completed",
  });
  return c.json({
    wallet: publicAgent(wallet),
    // Shown once. Not recoverable — use /agents/:id/rotate-key if lost.
    apiKey: rawKey,
    warning: "Copy this now — it is not stored and cannot be shown again.",
    custody: {
      address: provisioned.address,
      mode: "circle-eoa",
      chain: "Arc_Testnet",
      note: "UCW-send USDC here; Evabob then deposits it into this agent's Gateway balance",
    },
    docs: {
      agentWallets: "https://developers.circle.com/agent-stack/agent-wallets",
      circleCli: "https://developers.circle.com/agent-stack/circle-cli",
      x402: "POST /v1/x402/pay with Authorization: Bearer sk_evabob_…",
    },
  });
});

// The reveal-key route lived here. It returned a stored plaintext copy of the
// API key, gated on a client-supplied `pinVerified: true` boolean that the
// server never checked — any valid session could lift an agent's spending
// credential. Keys are now shown once at issue time and rotated if lost:
// POST /agents/:id/rotate-key.

api.get("/agents/:id/custody", async (c) => {
  const uid = userId(c);
  const w = store.getAgent(uid, c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);
  if (!w.custodyAddress || !w.circleWalletId || w.custodyMode !== "circle-eoa") {
    return c.json({
      error: "This legacy shared-custody agent needs migration to a dedicated Circle EOA.",
      code: "AGENT_WALLET_MIGRATION_REQUIRED",
    }, 409);
  }
  return c.json({
    address: w.custodyAddress,
    mode: w.custodyMode,
    chain: w.chain || "Arc_Testnet",
    gatewayDeposits: w.gatewayDeposits || [],
    note: "Fund this EOA from the owner's UCW wallet, then submit the transaction hash to deposit into Gateway.",
  });
});

/**
 * Credits an agent's spendable ledger from a real on-chain USDC transfer.
 *
 * The balance this writes is spendable through POST /v1/x402/pay, which
 * settles from the shared ops wallet, so it has to be backed by funds that
 * actually arrived. The former `fundActivityId` and `allowLedgerOnly`
 * shortcuts, and the unverified `fundTxHash`, all let a caller credit
 * themselves any amount; they are gone.
 */
api.post("/agents/:id/deposit", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      fundTxHash: z.string().optional(),
    })
    .parse(await c.req.json());

  const w = store.getAgent(uid, c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);

  if (!w.custodyAddress || !w.circleWalletId || w.custodyMode !== "circle-eoa") {
    return c.json({
      error: "This agent predates dedicated Circle EOAs and cannot accept new funding.",
      code: "AGENT_WALLET_MIGRATION_REQUIRED",
    }, 409);
  }

  if (!body.fundTxHash) {
    return c.json(
      {
        error:
          "Send USDC to the agent custody address first, then retry with fundTxHash",
        code: "FUND_TX_REQUIRED",
        custodyAddress: w.custodyAddress,
        amountUsdc: body.amountUsdc,
        hint: "circle.send(to: custodyAddress) → POST deposit with fundTxHash",
      },
      400,
    );
  }

  if (store.isFundTxUsed(body.fundTxHash)) {
    const creditedHere = (w.fundTxHashes || []).some(
      (hash) => hash.toLowerCase() === body.fundTxHash!.toLowerCase(),
    );
    if (creditedHere) {
      return c.json({ wallet: publicAgent(w), creditedUsdc: 0, idempotent: true });
    }
    return c.json(
      {
        error: "That transaction has already funded an agent",
        code: "FUND_TX_ALREADY_USED",
      },
      409,
    );
  }

  const sender = store.getUser(uid)?.evmAddress || "";
  const { verifyAgentFunding } = await import("../services/agentFunding.js");
  const verified = await verifyAgentFunding({
    txHash: body.fundTxHash,
    custodyAddress: w.custodyAddress,
    expectedSender: sender,
    minAmountUsdc: body.amountUsdc,
  });

  if (!verified.ok) {
    return c.json(
      { error: verified.reason, code: "FUND_TX_UNVERIFIED" },
      400,
    );
  }

  const deposits = w.gatewayDeposits ?? (w.gatewayDeposits = []);
  let deposit = deposits.find((row) =>
    row.fundTxHash.toLowerCase() === verified.txHash.toLowerCase()
  );
  if (!deposit) {
    deposit = {
      fundTxHash: verified.txHash,
      amountUsdc: verified.creditedUsdc,
      status: "approving",
      approveIdempotencyKey: randomUUID(),
      depositIdempotencyKey: randomUUID(),
    };
    deposits.push(deposit);
    store.save();
    await flushPrimaryStore();
  } else if (deposit.amountUsdc !== verified.creditedUsdc) {
    return c.json({ error: "Stored Gateway deposit amount does not match chain evidence." }, 409);
  }

  if (deposit.status !== "ready") {
    try {
      const { depositAgentWalletToGateway } = await import("../services/agentWallet.js");
      const result = await depositAgentWalletToGateway({
        walletAddress: w.custodyAddress as `0x${string}`,
        amountUsdc: deposit.amountUsdc,
        approveTransactionId: deposit.status === "failed" ? undefined : deposit.approveTransactionId,
        depositTransactionId: deposit.status === "failed" ? undefined : deposit.depositTransactionId,
        approveIdempotencyKey: deposit.approveIdempotencyKey || (deposit.approveIdempotencyKey = randomUUID()),
        depositIdempotencyKey: deposit.depositIdempotencyKey || (deposit.depositIdempotencyKey = randomUUID()),
        async onApproveCreated(id) {
          deposit!.approveTransactionId = id;
          deposit!.depositTransactionId = undefined;
          deposit!.status = "approving";
          delete deposit!.error;
          store.save();
          await flushPrimaryStore();
        },
        async onDepositCreated(id, amountUsdc) {
          deposit!.depositTransactionId = id;
          // What actually goes in: the top-up less the network fee reserve.
          deposit!.amountUsdc = amountUsdc;
          deposit!.status = "depositing";
          store.save();
          await flushPrimaryStore();
        },
      });
      deposit.approveTransactionId = result.approveTransactionId;
      deposit.depositTransactionId = result.depositTransactionId;
      deposit.depositTxHash = result.depositTxHash;
      deposit.amountUsdc = result.depositedUsdc;
      const { fetchGatewayBalances } = await import("../services/gateway.js");
      const gateway = await fetchGatewayBalances(w.custodyAddress as `0x${string}`);
      // Circle may confirm the deposit transaction before Gateway's source
      // finality window credits the unified balance. Do not expose spendable
      // ledger funds until the Gateway API itself reports them available.
      if (gateway.totalUsdc + 0.000001 < w.balanceUsdc + deposit.amountUsdc) {
        deposit.status = "depositing";
        delete deposit.error;
        store.save();
        await flushPrimaryStore();
        return c.json({
          wallet: publicAgent(w),
          gatewayDeposit: deposit,
          pending: true,
          gatewayAvailableUsdc: gateway.totalUsdc,
          gatewayPendingUsdc: gateway.pendingUsdc,
        }, 202);
      }
      deposit.status = "ready";
      delete deposit.error;
      store.save();
      await flushPrimaryStore();
    } catch (error) {
      const { CircleTransactionFailedError, GatewayDepositPendingError } = await import("../services/agentWallet.js");
      if (error instanceof GatewayDepositPendingError) {
        store.save();
        await flushPrimaryStore();
        return c.json({ wallet: publicAgent(w), gatewayDeposit: deposit, pending: true }, 202);
      }
      const safelyFailed = error instanceof CircleTransactionFailedError ||
        (!deposit.approveTransactionId && !deposit.depositTransactionId);
      deposit.status = safelyFailed
        ? "failed"
        : deposit.depositTransactionId ? "depositing" : "approving";
      deposit.error = clientError(
        error,
        safelyFailed ? "Gateway deposit failed" : "Gateway deposit needs reconciliation",
      );
      store.save();
      await flushPrimaryStore();
      return c.json(
        { error: deposit.error, gatewayDeposit: deposit, pending: !safelyFailed },
        safelyFailed ? 409 : 202,
      );
    }
  }

  // Credit only after Gateway accepted the deposit. A retry after a crash is
  // idempotent because the funding hash is globally unique.
  store.completeAgentGatewayFunding(w, verified.txHash, deposit.amountUsdc);
  await flushPrimaryStore();
  return c.json({
    wallet: publicAgent(w),
    creditedUsdc: deposit.amountUsdc,
    gatewayDeposit: deposit,
  });
});

/**
 * Withdraw from an agent wallet back to the owner's own wallet.
 *
 * Funding was one-way until now: a user could PIN-send USDC into agent
 * custody and had no way to get the remainder back. The balance is only
 * meaningful if it can leave again.
 *
 * The payout goes to the owner's wallet from the store — never to an address
 * supplied in the request — so this route cannot be turned into a transfer to
 * an attacker. Agent API keys cannot reach it at all: they only authenticate
 * on /v1/x402/pay, so an agent can spend its budget but never drain it.
 */
api.post("/agents/:id/withdraw", async (c) => {
  const uid = userId(c);
  const body = z.object({ amountUsdc: z.number().positive(), idempotencyKey: z.string().min(16).max(100) }).parse(await c.req.json());
  const w = store.getAgent(uid, c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);
  const to = store.getUser(uid)?.evmAddress || "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return c.json({ error: "Finish wallet setup before withdrawing." }, 409);
  try {
    const dedicated = w.custodyMode === "circle-eoa" &&
      Boolean(w.circleWalletId && w.custodyAddress);
    let custodyAddress = w.custodyAddress || "";
    let legacyMode: "circle-wallets" | "viem-ops" | null = null;
    if (!dedicated) {
      const { resolveAgentCustodyAddress } = await import("../services/agentCustody.js");
      const custody = resolveAgentCustodyAddress();
      if (custody.address.toLowerCase() !== w.custodyAddress?.toLowerCase()) {
        return c.json({ error: "Custody configuration changed; reconcile before withdrawing." }, 409);
      }
      custodyAddress = custody.address;
      legacyMode = custody.mode === "circle-dc" ? "circle-wallets" : "viem-ops";
    }
    const reservation = store.reserveAgentWithdrawal(w, body.idempotencyKey, body.amountUsdc, to);
    const reconcile = async (withdrawal: typeof reservation.withdrawal) => {
      if (withdrawal.status === "complete") {
        return c.json({ wallet: publicAgent(w), withdrawal, idempotent: true }, 200);
      }
      if (!withdrawal.txHash && withdrawal.transferId) {
        const { pollGatewayTransfer } = await import("../services/gateway-e2e.js");
        const polled = await pollGatewayTransfer(withdrawal.transferId);
        if (polled.mintTx) {
          withdrawal.txHash = polled.mintTx;
          store.save();
          await flushPrimaryStore();
        } else {
          return c.json({ wallet: publicAgent(w), withdrawal, pending: true,
            gatewayStatus: polled.status }, 202);
        }
      }
      if (!withdrawal.txHash) {
        return c.json({ wallet: publicAgent(w), withdrawal, pending: true,
          error: "Withdrawal was reserved before a transaction hash was recorded; operator reconciliation is required." }, 409);
      }
      const { verifyPaymentEvidence } = await import("../services/payment-evidence.js");
      const evidenceSender = withdrawal.rail === "gateway"
        ? "0x0000000000000000000000000000000000000000"
        : custodyAddress;
      const settled = await verifyPaymentEvidence({ txHash: withdrawal.txHash, sender: evidenceSender,
        recipient: withdrawal.to, amount: withdrawal.amount, token: "USDC" });
      if (!settled) return c.json({ wallet: publicAgent(w), withdrawal, pending: true }, 202);
      if (dedicated) {
        try {
          const { fetchGatewayBalances } = await import("../services/gateway.js");
          const gateway = await fetchGatewayBalances(w.custodyAddress as `0x${string}`);
          // Gateway fees and concurrent paid calls can make the remote balance
          // lower than our reservation ledger. It is authoritative downward;
          // never credit a local wallet merely because a remote query is higher.
          const authoritative = Number(Math.max(0, gateway.totalUsdc).toFixed(6));
          if (authoritative < w.balanceUsdc) w.balanceUsdc = authoritative;
        } catch (e) {
          console.warn(
            `[agent ${w.id}] post-withdraw Gateway balance reconciliation failed:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      withdrawal.status = "complete";
      if (w.withdrawal?.key === withdrawal.key) w.withdrawal = withdrawal;
      store.save();
      if (!store.hasActivityTxHash(uid, withdrawal.txHash, "agent_withdraw")) {
        store.addActivity({ userId: uid, kind: "agent", title: w.label,
          description: `Withdrew ${withdrawal.amount} USDC from agent wallet`, amountUsdc: withdrawal.amount,
          txHash: withdrawal.txHash, mode: "agent_withdraw", status: "completed" });
      }
      await flushPrimaryStore();
      return c.json({ wallet: publicAgent(w), withdrawal, txHash: withdrawal.txHash,
        reconciled: !reservation.fresh });
    };
    if (!reservation.fresh) return reconcile(reservation.withdrawal);
    // Persisted debit precedes the external side effect. Ambiguous failures stay
    // reserved until reconciliation; never automatically spend or refund twice.
    await flushPrimaryStore();
    if (dedicated) {
      const { gatewayWithdrawFromAgent } = await import("../services/gateway-e2e.js");
      const sent = await gatewayWithdrawFromAgent({
        walletId: w.circleWalletId!,
        address: w.custodyAddress as `0x${string}`,
        amountUsdc: body.amountUsdc,
        destinationAddress: to as `0x${string}`,
      });
      w.withdrawal!.rail = "gateway";
      w.withdrawal!.transferId = sent.transferId;
      w.withdrawal!.txHash = sent.mintTx;
    } else {
      const { appKitSend } = await import("../services/appKitMoney.js");
      const sent = await appKitSend({ userId: uid, to, amount: body.amountUsdc,
        token: "USDC", chain: "Arc_Testnet", mode: legacyMode! });
      w.withdrawal!.rail = "legacy";
      w.withdrawal!.txHash = sent.txHash;
    }
    store.save();
    await flushPrimaryStore();
    return reconcile(w.withdrawal!);
  } catch (e) {
    return c.json({ error: clientError(e, "Withdrawal needs reconciliation"), withdrawal: w.withdrawal,
      pending: w.withdrawal?.status === "reserved" }, 409);
  }
});

/**
 * Revoke the agent's API key. Spending stops immediately; the row and any
 * remaining balance survive so the owner can still withdraw.
 */
api.post("/agents/:id/revoke", async (c) => {
  const uid = userId(c);
  const w = store.getAgent(uid, c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);
  store.revokeAgentKey(w);
  store.addActivity({
    userId: uid,
    kind: "agent",
    title: w.label,
    description: "Agent API key revoked",
    amountUsdc: 0,
    mode: "agent_revoke",
    status: "completed",
  });
  return c.json({ wallet: publicAgent(w) });
});

/**
 * Issue a replacement API key, shown once.
 *
 * This replaces the old reveal-key route. Keys are no longer stored in a
 * readable form, so they cannot be shown again later — the same contract every
 * API-key system uses. It is also the recovery path for a leaked key: rotating
 * stops the old one resolving while keeping the balance and history.
 */
api.post("/agents/:id/rotate-key", async (c) => {
  const uid = userId(c);
  const w = store.getAgent(uid, c.req.param("id"));
  if (!w) return c.json({ error: "not found" }, 404);

  const rawKey = `sk_evabob_${randomUUID().replace(/-/g, "")}`;
  store.rotateAgentKey(w, {
    apiKeyHash: createHash("sha256").update(rawKey).digest("hex"),
    apiKeyPrefix: rawKey.slice(0, 16),
  });
  store.addActivity({
    userId: uid,
    kind: "agent",
    title: w.label,
    description: "Agent API key rotated",
    amountUsdc: 0,
    mode: "agent_rotate_key",
    status: "completed",
  });
  return c.json({
    wallet: publicAgent(w),
    apiKey: rawKey,
    warning: "Copy this now — it is not stored and cannot be shown again.",
  });
});

export function publicAgent(w: AgentWallet) {
  const latestGatewayDeposit = w.gatewayDeposits?.at(-1);
  return {
    // The allowance, its live meter, pause state and anything waiting on the
    // owner (services/agentControls.ts).
    ...allowanceView(w),
    handle: w.handle ? `@${w.handle}` : null,
    handleOnChain: Boolean(w.handleLinkTx),
    id: w.id,
    label: w.label,
    balanceUsdc: w.balanceUsdc,
    dailyLimitUsdc: w.dailyLimitUsdc,
    perCallLimitUsdc: w.perCallLimitUsdc ?? null,
    spentTodayUsdc: w.spentTodayUsdc,
    // Prefix only — the key itself is never stored in a readable form.
    apiKeyPrefix: w.apiKeyPrefix,
    createdAt: w.createdAt,
    custodyAddress: w.custodyAddress ?? null,
    custodyMode: w.custodyMode ?? null,
    chain: w.chain ?? "Arc_Testnet",
    lastFundTxHash: w.lastFundTxHash ?? null,
    revokedAt: w.revokedAt ?? null,
    dedicatedPayer: Boolean(w.circleWalletId && w.custodyMode === "circle-eoa"),
    gatewayStatus: latestGatewayDeposit?.status ?? "unfunded",
    /** Convenience for the UI: revoked keys cannot spend, but can withdraw. */
    active: !w.revokedAt,
  };
}

// ─── Pusher ────────────────────────────────────────────────────────────────

/**
 * Signing a channel grants live read access to everything published on it,
 * so membership must be checked here. Thread ids are guessable
 * (`t_<handle>_…`), and without this any caller could subscribe to another
 * user's conversation and watch their messages, receipts and money commands.
 */
export function canJoinChannel(channel: string, uid: string): boolean {
  // A user's own alert channel. The channel name IS their id and the caller's
  // id comes from the verified session, so an exact match is the whole check —
  // there is no way to name someone else's channel and pass it.
  if (channel.startsWith(USER_CHANNEL_PREFIX)) {
    return channel.slice(USER_CHANNEL_PREFIX.length) === uid;
  }

  const threadId = channel.startsWith("private-chat-")
    ? channel.slice("private-chat-".length)
    : null;
  if (!threadId) return false; // only chat and user channels are issuable
  const thread = store.listThreads().find((t) => t.id === threadId);
  if (!thread) return false;
  return thread.members.includes(uid);
}

api.post("/pusher/auth", async (c) => {
  if (!pusherConfigured()) {
    return c.json({ error: "Pusher not configured" }, 503);
  }
  const body = await c.req.parseBody();
  const socketId = String(body.socket_id || "");
  const channel = String(body.channel_name || "");
  if (!socketId || !channel) {
    return c.json({ error: "socket_id and channel_name required" }, 400);
  }
  if (!canJoinChannel(channel, userId(c))) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  try {
    return c.json(authenticatePusherChannel(socketId, channel));
  } catch (e) {
    console.error("pusher auth failed:", e);
    return c.json({ error: "auth failed" }, 500);
  }
});

/**
 * Circle App Kit HTTP surface.
 *
 * Ops / treasury (server-signed):
 *   POST /v1/app-kit/send|bridge|swap|deposit|spend|compose
 *
 * End-user UCW (PIN challenges via existing WebView):
 *   POST /v1/app-kit/ucw/send|bridge|swap|deposit|spend|compose
 *   → returns { jobId, challenges[] }; poll GET /v1/app-kit/jobs/:id
 *
 * Legacy CCTP / Gateway / Synthra remain mounted when APP_KIT_KEEP_LEGACY=true.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import {
  APP_KIT_CHAINS,
  DOMAIN_TO_APPKIT_CHAIN,
  appKitConfigured,
  getAppKit,
  getRecentAppKitEvents,
} from "../services/appKit.js";
import {
  appKitBridge,
  appKitCompose,
  appKitDeposit,
  appKitGetBalances,
  appKitSend,
  appKitSpend,
  appKitSwap,
  estimateAppKitSwap,
  getAppKitJob,
  isJobLive,
  jobStage,
  listAppKitJobsForUser,
  quoteAppKitBridge,
  reconcileStaleAppKitJobs,
  recoverAppKitJob,
  startUcwBridgeJob,
  warnIfRelayUnfunded,
  startUcwComposeJob,
  startUcwDepositJob,
  startUcwSendJob,
  startUcwSpendJob,
  startUcwSwapJob,
  noteJobPinEntered,
  submitChallengeSignature,
} from "../services/appKitMoney.js";
import { circleAppId } from "../services/circle-ucw.js";
import { getUserId } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";

export const appKitRoutes = new Hono();
import { operatorOnly, userOnly } from "../middleware/authorization.js";
import { ucwSessionBoundary } from "../middleware/ucw-session.js";
appKitRoutes.use("*", userOnly, ucwSessionBoundary);
for (const path of ["/send", "/bridge", "/swap", "/deposit", "/spend", "/compose", "/events"]) {
  appKitRoutes.use(path, operatorOnly);
}

/**
 * The authenticated caller (see middleware/auth.ts). The former
 * `x-user-id` header / `?userId=` query fallbacks let any caller act as any
 * user and have been removed.
 */
const userId = getUserId;

const adapterMode = z.enum(["circle-wallets", "viem-ops"]).optional();
const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const amountField = z.union([z.string().min(1), z.number().positive()]);

// ─── Health / catalog ──────────────────────────────────────────────────────

appKitRoutes.get("/health", async (c) => {
  const configured = appKitConfigured();
  let supportedChains: unknown = null;
  try {
    if (configured.enabled) {
      const kit = getAppKit();
      // Method exists on AppKit; cast for TS version variance
      const anyKit = kit as unknown as {
        getSupportedChains?: (op?: string) => unknown;
      };
      supportedChains = anyKit.getSupportedChains
        ? await Promise.resolve(anyKit.getSupportedChains())
        : Object.values(APP_KIT_CHAINS);
    }
  } catch (e) {
    supportedChains = {
      error: clientError(e, "failed to list chains"),
    };
  }
  return c.json({
    ok: true,
    service: "app-kit",
    ...configured,
    keepLegacyRoutes: config.appKit.keepLegacyRoutes,
    defaultAdapter: config.appKit.defaultAdapter,
    dcWalletAddress: config.appKit.dcWalletAddress,
    appId: circleAppId(),
    chainAliases: APP_KIT_CHAINS,
    domainMap: DOMAIN_TO_APPKIT_CHAIN,
    feeBps: config.appKit.feeBps,
    feeRecipient: config.appKit.feeRecipient || null,
    supportedChains,
    gasNotes: {
      Arc_Testnet: "Gas paid in USDC (no separate native token)",
      otherEvm:
        "Source-chain txs need native gas (ETH/AVAX/…) unless gas-sponsored. Destination mint uses Circle Forwarder by default so dest native gas is not required.",
      EVM: "Source-chain txs need native gas unless gas-sponsored. Destination mint uses Circle Forwarder by default.",
    },
    note:
      "Ops: Circle Wallets adapter + APP_KIT_DC_WALLET (or fromAddress). Fallback: viem PRIVATE_KEY. User funds: UCW PIN jobs.",
  });
});

appKitRoutes.get("/events", (c) => {
  const limit = Number(c.req.query("limit") || 50);
  return c.json({ events: getRecentAppKitEvents(limit) });
});

appKitRoutes.get("/balances", async (c) => {
  // Poll with includePending=true after deposit until funds appear.
  const address = c.req.query("address");
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ error: "address query required (0x…)" }, 400);
  }
  const includePending =
    c.req.query("includePending") !== "false" &&
    c.req.query("includePending") !== "0";
  try {
    const balances = await appKitGetBalances({
      address,
      token: c.req.query("token") || "USDC",
      includePending,
    });
    return c.json({
      ok: true,
      ...balances,
      source: "app-kit-unified-balance",
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "balances failed") },
      400,
    );
  }
});

// ─── Ops / treasury (server-signed, synchronous) ───────────────────────────

appKitRoutes.post("/send", async (c) => {
  const body = z
    .object({
      to: z.string().min(1),
      amount: amountField,
      token: z.string().optional().default("USDC"),
      chain: z.string().optional().default("Arc_Testnet"),
      fromAddress: z.string().optional(),
      mode: adapterMode,
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitSend({
      userId: userId(c),
      to: body.to,
      amount: body.amount,
      token: body.token,
      chain: body.chain,
      fromAddress: body.fromAddress,
      mode: body.mode,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit send failed") },
      400,
    );
  }
});

appKitRoutes.post("/bridge", async (c) => {
  const body = z
    .object({
      amount: amountField,
      fromChain: z.union([z.string(), z.number()]),
      toChain: z.union([z.string(), z.number()]),
      fromAddress: z.string().optional(),
      toAddress: z.string().optional(),
      mode: adapterMode,
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitBridge({
      userId: userId(c),
      amount: body.amount,
      fromChain: body.fromChain,
      toChain: body.toChain,
      fromAddress: body.fromAddress,
      toAddress: body.toAddress,
      mode: body.mode,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit bridge failed") },
      400,
    );
  }
});

appKitRoutes.post("/swap", async (c) => {
  const body = z
    .object({
      amountIn: amountField,
      tokenIn: z.string().optional().default("USDC"),
      tokenOut: z.string().optional().default("EURC"),
      chain: z.string().optional().default("Arc_Testnet"),
      fromAddress: z.string().optional(),
      mode: adapterMode,
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitSwap({
      userId: userId(c),
      amountIn: body.amountIn,
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      chain: body.chain,
      fromAddress: body.fromAddress,
      mode: body.mode,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit swap failed") },
      400,
    );
  }
});

appKitRoutes.post("/deposit", async (c) => {
  const body = z
    .object({
      amount: amountField,
      chain: z.string().optional().default("Base_Sepolia"),
      token: z.string().optional().default("USDC"),
      fromAddress: z.string().optional(),
      mode: adapterMode,
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitDeposit({
      userId: userId(c),
      amount: body.amount,
      chain: body.chain,
      token: body.token,
      fromAddress: body.fromAddress,
      mode: body.mode,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit deposit failed") },
      400,
    );
  }
});

appKitRoutes.post("/spend", async (c) => {
  const body = z
    .object({
      amountIn: amountField,
      recipientAddress: evmAddress,
      toChain: z.string().optional().default("Arc_Testnet"),
      fromAddress: z.string().optional(),
      token: z.string().optional().default("USDC"),
      mode: adapterMode,
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitSpend({
      userId: userId(c),
      amountIn: body.amountIn,
      recipientAddress: body.recipientAddress,
      toChain: body.toChain,
      fromAddress: body.fromAddress,
      token: body.token,
      mode: body.mode,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit spend failed") },
      400,
    );
  }
});

appKitRoutes.post("/compose", async (c) => {
  const body = z
    .object({
      fromAddress: z.string().optional(),
      mode: adapterMode,
      userId: z.string().optional(),
      spend: z
        .object({
          amountIn: amountField,
          recipientAddress: z.string().optional(),
          toChain: z.string().optional(),
        })
        .optional(),
      swap: z
        .object({
          tokenIn: z.string().optional(),
          tokenOut: z.string().optional(),
          amountIn: amountField.optional(),
          chain: z.string().optional(),
        })
        .optional(),
      bridge: z
        .object({
          fromChain: z.string().optional(),
          toChain: z.union([z.string(), z.number()]),
          toAddress: z.string().optional(),
          amount: amountField.optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await appKitCompose({
      userId: userId(c),
      fromAddress: body.fromAddress,
      mode: body.mode,
      spend: body.spend,
      swap: body.swap,
      bridge: body.bridge,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "app-kit compose failed") },
      400,
    );
  }
});

// ─── UCW jobs (PIN challenge relay) ────────────────────────────────────────

const ucwBase = z.object({
  userToken: z.string().min(10),
  walletId: z.string().optional(),
  walletAddress: evmAddress.optional(),
  userId: z.string().optional(),
});

function jobResponse(job: ReturnType<typeof getAppKitJob>) {
  if (!job) return null;
  const live = isJobLive(job.id);
  return {
    jobId: job.id,
    op: job.op,
    status: job.status,
    live,
    resumable: job.status === "running",
    /** waiting_pin · sent · confirming · arrived · failed */
    stage: jobStage(job),
    challenges: job.challenges.map((ch) => ({
      step: job.op,
      challengeId: ch.challengeId,
      type: ch.type,
      needsSignature: ch.needsSignature === true,
    })),
    challengeIds: job.challenges.map((ch) => ch.challengeId),
    /** Challenges blocked on a typed-data signature from the W3S SDK result. */
    awaitingSignature: job.challenges
      .filter((ch) => ch.needsSignature === true)
      .map((ch) => ch.challengeId),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    meta: job.meta || null,
    abandoned: job.meta?.abandoned === true,
    fundsIntact: job.meta?.fundsIntact === true,
    appId: circleAppId(),
    message:
      job.meta?.abandoned && job.meta.fundsIntact
        ? job.meta.recoverHint ||
          "PIN expired — funds were not moved"
        : job.status === "running"
          ? live
            ? "Complete pending PIN challenges in the app, then poll this job"
            : job.meta?.recoverHint ||
              "Job paused — open Continue in Activity to finish or recover"
          : job.status === "succeeded"
            ? "App Kit operation succeeded"
            : "App Kit operation failed",
  };
}

appKitRoutes.get("/jobs", (c) => {
  const uid = userId(c);
  const status = c.req.query("status");
  const list = listAppKitJobsForUser(uid).filter((j) =>
    status ? j.status === status : true,
  );
  return c.json({
    jobs: list.map((j) => jobResponse(j)),
  });
});

/**
 * Drop expired PIN jobs whose source funds never left, then return what's
 * still actually incomplete. Home calls this instead of listing blindly.
 */
appKitRoutes.post("/jobs/reconcile", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const userToken =
    typeof (body as { userToken?: unknown }).userToken === "string"
      ? (body as { userToken: string }).userToken
      : undefined;
  const jobId =
    typeof (body as { jobId?: unknown }).jobId === "string"
      ? (body as { jobId: string }).jobId
      : undefined;
  const result = await reconcileStaleAppKitJobs({
    userId: userId(c),
    userToken,
    jobId,
  });
  return c.json({
    jobs: result.jobs.map((j) => jobResponse(j)),
    dismissed: result.dismissed,
  });
});

appKitRoutes.get("/jobs/:id", (c) => {
  const job = getAppKitJob(c.req.param("id"));
  if (!job || job.userId !== userId(c)) return c.json({ error: "Job not found" }, 404);
  return c.json(jobResponse(job));
});

appKitRoutes.post("/jobs/:id/recover", async (c) => {
  const job = getAppKitJob(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.userId !== userId(c)) {
    return c.json({ error: "not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const userToken =
    typeof (body as { userToken?: unknown }).userToken === "string"
      ? (body as { userToken: string }).userToken
      : undefined;
  try {
    const recovered = await recoverAppKitJob(job.id, { userToken });
    return c.json({
      ...recovered,
      ...jobResponse(getAppKitJob(job.id)),
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "recover failed") },
      400,
    );
  }
});

/**
 * The app reports a PIN for this job went through. The first report starts
 * the hold: from then on the job is shown as on hold, and a bridge left
 * unfinished is completed by the server 40 minutes later.
 */
appKitRoutes.post("/jobs/:id/pin", (c) => {
  const r = noteJobPinEntered({ jobId: c.req.param("id"), userId: userId(c) });
  if (!r.ok) return c.json({ error: "Job not found" }, 404);
  return c.json({ ok: true, firstPinAt: r.firstPinAt });
});

/**
 * Relay the typed-data signature from the W3S browser SDK back to the job.
 *
 * A signature is only ever delivered to the client that executed the
 * challenge — reading the challenge back from Circle gives id/status/type and
 * nothing else. Without this call a typed-data step stays PENDING until the
 * strategy times out, and the CCTP job never reaches attestation.
 */
appKitRoutes.post("/jobs/:id/signature", async (c) => {
  const jobId = c.req.param("id");
  const job = getAppKitJob(jobId);
  if (!job || job.userId !== userId(c)) return c.json({ error: "Job not found" }, 404);

  const body = z
    .object({
      challengeId: z.string().min(1),
      signature: z
        .string()
        .regex(/^0x[a-fA-F0-9]+$/)
        .optional(),
      rejectedReason: z.string().min(1).optional(),
    })
    .refine((v) => Boolean(v.signature || v.rejectedReason), {
      message: "signature or rejectedReason is required",
    })
    .parse(await c.req.json());

  const result = submitChallengeSignature({
    jobId,
    challengeId: body.challengeId,
    signature: body.signature,
    rejectedReason: body.rejectedReason,
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
  return c.json({ ok: true, jobId, challengeId: body.challengeId });
});

appKitRoutes.post("/ucw/send", async (c) => {
  const body = ucwBase
    .extend({
      to: z.string().min(1),
      amount: amountField,
      token: z.string().optional().default("USDC"),
      chain: z.string().optional().default("Arc_Testnet"),
    })
    .parse(await c.req.json());
  const familyDenied = await familyCheckDenied(c, {
    to: body.to,
    amount: body.amount,
    token: body.token,
  });
  if (familyDenied) return familyDenied;
  try {
    const job = startUcwSendJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      to: body.to,
      amount: body.amount,
      token: body.token,
      chain: body.chain,
    });
    // Brief wait so first challenge may appear
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "ucw send failed") },
      400,
    );
  }
});

/** The rate a swap would get now, priced by App Kit — the route it then takes. */
appKitRoutes.post("/swap/quote", async (c) => {
  try {
    const body = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        amountIn: z.number().positive(),
        chain: z.string().optional().default("Arc_Testnet"),
      })
      .parse(await c.req.json());
    if (body.from.toLowerCase() === body.to.toLowerCase()) {
      return c.json({ error: "from and to must differ" }, 400);
    }
    return c.json(
      await estimateAppKitSwap({
        tokenIn: body.from,
        tokenOut: body.to,
        amountIn: body.amountIn,
        chain: body.chain,
      }),
    );
  } catch (e) {
    return c.json({ error: clientError(e, "No rate for that swap right now") }, 400);
  }
});

appKitRoutes.post("/bridge/quote", async (c) => {
  try {
    const body = z
      .object({
        amount: z.union([z.string().min(1), z.number()]),
        fromChain: z.union([z.string(), z.number()]),
        toChain: z.union([z.string(), z.number()]),
        token: z.string().optional().default("USDC"),
      })
      .parse(await c.req.json());
    const quote = await quoteAppKitBridge({
      amount: body.amount,
      fromChain: body.fromChain,
      toChain: body.toChain,
      token: body.token,
    });
    return c.json(quote);
  } catch (e) {
    const msg =
      e instanceof z.ZodError
        ? e.issues[0]?.message || "invalid quote request"
        : e instanceof Error
          ? e.message
          : "bridge quote failed";
    return c.json({ ok: false, bridgeable: false, error: msg }, 400);
  }
});

appKitRoutes.post("/ucw/bridge", async (c) => {
  try {
    const body = ucwBase
      .extend({
        amount: z.union([z.string().min(1), z.number()]),
        fromChain: z.union([z.string(), z.number()]),
        toChain: z.union([z.string(), z.number()]),
        toAddress: z.string().optional(),
        token: z.string().optional().default("USDC"),
      })
      .parse(await c.req.json());
    void warnIfRelayUnfunded(body.toChain);
    const job = startUcwBridgeJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      amount: body.amount,
      fromChain: body.fromChain,
      toChain: body.toChain,
      toAddress: body.toAddress,
      token: "USDC",
    });
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    const msg =
      e instanceof z.ZodError
        ? e.issues[0]?.message || "invalid bridge request"
        : e instanceof Error
          ? e.message
          : "ucw bridge failed";
    return c.json({ error: msg }, 400);
  }
});

appKitRoutes.post("/ucw/swap", async (c) => {
  const body = ucwBase
    .extend({
      amountIn: amountField,
      tokenIn: z.string().optional().default("USDC"),
      tokenOut: z.string().optional().default("EURC"),
      chain: z.string().optional().default("Arc_Testnet"),
    })
    .parse(await c.req.json());
  try {
    const job = startUcwSwapJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      amountIn: body.amountIn,
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      chain: body.chain,
    });
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "ucw swap failed") },
      400,
    );
  }
});

appKitRoutes.post("/ucw/deposit", async (c) => {
  const body = ucwBase
    .extend({
      amount: amountField,
      chain: z.string().optional().default("Arc_Testnet"),
    })
    .parse(await c.req.json());
  try {
    const job = startUcwDepositJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      amount: body.amount,
      chain: body.chain,
    });
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "ucw deposit failed") },
      400,
    );
  }
});

appKitRoutes.post("/ucw/spend", async (c) => {
  const body = ucwBase
    .extend({
      amountIn: amountField,
      recipientAddress: z.string().min(32).max(64),
      toChain: z.string().optional().default("Arc_Testnet"),
      sourceChains: z.array(z.string()).optional(),
    })
    .parse(await c.req.json());
  const familyDenied = await familyCheckDenied(c, {
    to: body.recipientAddress,
    amount: body.amountIn,
    token: "USDC",
  });
  if (familyDenied) return familyDenied;
  try {
    const job = startUcwSpendJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      amountIn: body.amountIn,
      recipientAddress: body.recipientAddress,
      toChain: body.toChain,
      sourceChains: body.sourceChains,
    });
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "ucw spend failed") },
      400,
    );
  }
});

appKitRoutes.post("/ucw/compose", async (c) => {
  const body = ucwBase
    .extend({
      spend: z
        .object({
          amountIn: amountField,
          recipientAddress: z.string().optional(),
          toChain: z.string().optional(),
        })
        .optional(),
      swap: z
        .object({
          tokenIn: z.string().optional(),
          tokenOut: z.string().optional(),
          amountIn: amountField.optional(),
          chain: z.string().optional(),
        })
        .optional(),
      bridge: z
        .object({
          fromChain: z.string().optional(),
          toChain: z.union([z.string(), z.number()]),
          toAddress: z.string().optional(),
          amount: amountField.optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());
  try {
    const job = startUcwComposeJob({
      userId: userId(c),
      userToken: body.userToken,
      walletId: body.walletId,
      walletAddress: body.walletAddress as `0x${string}` | undefined,
      spend: body.spend,
      swap: body.swap,
      bridge: body.bridge,
    });
    await sleep(400);
    return c.json(jobResponse(getAppKitJob(job.id)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "ucw compose failed") },
      400,
    );
  }
});

/**
 * The family check the send screen's route applies (/v1/circle/send), for the
 * App Kit routes that reach the same people. Returns a response when the
 * payment needs the emailed code first.
 */
async function familyCheckDenied(
  c: Context,
  input: { to: string; amount: number | string; token: string },
): Promise<Response | null> {
  const { requireFamilyPass, FamilyCheckError } = await import("../services/familyCheck.js");
  let dest = input.to.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(dest)) {
    const { resolvePayee } = await import("../services/resolvePayee.js");
    const payee = resolvePayee(userId(c), dest);
    if (!payee.ok) return null; // the job refuses an unknown payee on its own
    dest = payee.address;
  }
  try {
    requireFamilyPass({
      userId: userId(c),
      dest,
      amount: Number(input.amount),
      token: input.token.toUpperCase(),
    });
    return null;
  } catch (error) {
    if (error instanceof FamilyCheckError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

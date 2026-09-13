import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import {
  circleAppId,
  createAdditionalWalletsChallenge,
  createAddGatewayDelegateChallenges,
  createCctpBurnChallenges,
  createGatewayDepositChallenges,
  createPinWalletChallenge,
  createSession,
  createSynthraSwapChallenges,
  createTransferChallenge,
  ensureUser,
  getWalletBalances,
  listUserWallets,
  mapWalletsForDeposit,
  pickPrimaryArcWallet,
  waitForChallengeTxHash,
  waitForChallengesComplete,
} from "../services/circle-ucw.js";
import {
  cctpCompleteBridge,
  cctpMintDomainName,
  isCctpMintSupported,
} from "../services/cctp.js";
import { store } from "../store/db.js";
import { getUserId } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";

export const circleWallets = new Hono();
import { userOnly } from "../middleware/authorization.js";
import { ucwSessionBoundary } from "../middleware/ucw-session.js";
circleWallets.use("*", userOnly, ucwSessionBoundary);

/**
 * The authenticated caller (see middleware/auth.ts). The former
 * `x-user-id` header / `?userId=` query fallbacks let any caller act as any
 * user and have been removed.
 */
const appUserId = getUserId;

function bindUser(
  userId: string,
  wallets: Awaited<ReturnType<typeof listUserWallets>>,
) {
  const mapped = mapWalletsForDeposit(wallets);
  const primary = pickPrimaryArcWallet(wallets);
  store.upsertUser({
    id: userId,
    email: store.getUser(userId)?.email || `${userId}@evabob.app`,
    displayName: store.getUser(userId)?.displayName || userId,
    solanaAddress: mapped.solanaAddress || undefined,
  });
  store.bindVerifiedWallet(userId, wallets.find(w => w.blockchain === "ARC-TESTNET")?.address || "");
  return { mapped, primary };
}

circleWallets.get("/config", (c) =>
  c.json({
    appId: circleAppId(),
    apiKeyConfigured: Boolean(config.circle.apiKey),
    mode: "ucw+app-kit",
    accountType: "SCA (EVM)",
    blockchains: ["ARC-TESTNET", "ETH-SEPOLIA", "BASE-SEPOLIA"],
    appKitEnabled: config.appKit.enabled,
    note: "All user spends require PIN challenge execution in the app",
  }),
);

circleWallets.post("/create-user", async (c) => {
  const body = z
    .object({ userId: z.string().min(1).optional() })
    .parse(await c.req.json().catch(() => ({})));
  try {
    // Idempotent: existing Circle users are success, not 400
    return c.json(await ensureUser(appUserId(c)));
  } catch (e) {
    const msg = clientError(e, "create-user failed");
    // Never block onboarding on re-create races
    if (
      /already|existing user/i.test(msg)
    ) {
      const uid = appUserId(c);
      return c.json({
        userId: uid,
        created: false,
        alreadyExists: true,
      });
    }
    return c.json({ error: msg }, 400);
  }
});

circleWallets.post("/session", async (c) => {
  const body = z
    .object({ userId: z.string().min(1).optional() })
    .parse(await c.req.json().catch(() => ({})));
  try {
    return c.json(await createSession(appUserId(c)));
  } catch (e) {
    return c.json(
      { error: clientError(e, "session failed") },
      400,
    );
  }
});

circleWallets.post("/initialize", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await createPinWalletChallenge(body.userToken);
    if (result.alreadyInitialized) {
      const wallets = await listUserWallets(body.userToken);
      const uid = appUserId(c);
      const { mapped, primary } = bindUser(uid, wallets);
      // Offer extra-chain challenges for missing product EVM wallets.
      const extra = await createAdditionalWalletsChallenge(body.userToken);
      return c.json({
        alreadyInitialized: true,
        challengeId: null,
        wallets,
        addresses: mapped,
        primaryAddress: primary?.address ?? null,
        primaryWalletId: primary?.id ?? null,
        followUpChallenges: extra.challenges,
        appId: circleAppId(),
      });
    }
    return c.json({
      alreadyInitialized: false,
      challengeId: result.challengeId,
      appId: circleAppId(),
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "initialize failed") },
      400,
    );
  }
});

/**
 * Atomic onboard package: ensure user + fresh session + PIN challenge
 * (or wallets if already initialized). One response so mobile never
 * pairs a challengeId with a mismatched encryptionKey.
 */
circleWallets.post("/prepare-pin", async (c) => {
  const body = z
    .object({ userId: z.string().min(1).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const uid = appUserId(c);
  try {
    await ensureUser(uid);
    const session = await createSession(uid);
    const result = await createPinWalletChallenge(session.userToken);

    if (result.alreadyInitialized) {
      const wallets = await listUserWallets(session.userToken);
      const { mapped, primary } = bindUser(uid, wallets);
      const extra = await createAdditionalWalletsChallenge(session.userToken);
      return c.json({
        alreadyInitialized: true,
        userId: session.userId,
        userToken: session.userToken,
        encryptionKey: session.encryptionKey,
        challengeId: null,
        wallets,
        addresses: mapped,
        primaryAddress: primary?.address ?? null,
        primaryWalletId: primary?.id ?? null,
        followUpChallenges: extra.challenges,
        appId: circleAppId(),
        encryptionKeyLen: session.encryptionKey?.length ?? 0,
      });
    }

    return c.json({
      alreadyInitialized: false,
      userId: session.userId,
      userToken: session.userToken,
      encryptionKey: session.encryptionKey,
      challengeId: result.challengeId,
      appId: circleAppId(),
      encryptionKeyLen: session.encryptionKey?.length ?? 0,
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "prepare-pin failed") },
      400,
    );
  }
});

circleWallets.post("/wallets", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      userId: z.string().optional(),
      ensureChains: z.boolean().optional(),
    })
    .parse(await c.req.json());
  try {
    let followUpChallenges: Array<{ chain: string; challengeId: string }> = [];
    if (body.ensureChains) {
      const extra = await createAdditionalWalletsChallenge(body.userToken);
      followUpChallenges = extra.challenges;
    }
    const wallets = await listUserWallets(body.userToken);
    const uid = appUserId(c);
    const { mapped, primary } = bindUser(uid, wallets);
    return c.json({
      wallets,
      addresses: mapped,
      primaryAddress: primary?.address ?? null,
      primaryWalletId: primary?.id ?? null,
      followUpChallenges,
      appId: circleAppId(),
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "list wallets failed") },
      400,
    );
  }
});

circleWallets.post("/balances", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
    })
    .parse(await c.req.json());
  try {
    return c.json({
      tokenBalances: await getWalletBalances(body.userToken, body.walletId),
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "balances failed") },
      400,
    );
  }
});

/** PIN challenge before revealing sensitive secrets (agent API keys). */
circleWallets.post("/verify-pin", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      purpose: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const { createVerifyPinChallenge } = await import(
      "../services/circle-ucw.js"
    );
    const result = await createVerifyPinChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      purpose: body.purpose,
    });
    return c.json({
      ...result,
      challenges: result.challengeId
        ? [{ step: "verify_pin", challengeId: result.challengeId }]
        : [],
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "verify pin failed") },
      400,
    );
  }
});

/** Direct USDC transfer (P2P when recipient has on-chain address). */
circleWallets.post("/transfer", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      amount: z.string().min(1),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await createTransferChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      destinationAddress: body.destinationAddress,
      amountUsdc: body.amount,
    });
    store.addActivity({
      userId: appUserId(c),
      kind: "send",
      title: body.destinationAddress.slice(0, 10) + "…",
      description: `UCW transfer challenge ${body.amount} USDC`,
      amountUsdc: -Number(body.amount),
    });
    return c.json({
      ...result,
      challenges: result.challengeId
        ? [{ step: "transfer", challengeId: result.challengeId }]
        : [],
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "transfer challenge failed") },
      400,
    );
  }
});

/**
 * Unified send routing (no phone, no unknown-email escrow):
 * 0x → direct (client prompts Save / Skip)
 * saved contact name → that 0x
 * email / @username → only if the user exists AND has a wallet
 */
circleWallets.post("/send", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      to: z.string().min(1),
      amountUsdc: z.number().positive(),
      /** Optional token; defaults to USDC. EURC / CIRBTC on Arc. */
      token: z.enum(["USDC", "EURC", "CIRBTC"]).optional().default("USDC"),
      amountNgn: z.number().nonnegative().optional(),
      memo: z.string().optional(),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());

  const { resolvePayee } = await import("../services/resolvePayee.js");
  const fromId = appUserId(c);
  const fromUser = store.getUser(fromId);
  const raw = body.to.trim();
  const payee = resolvePayee(fromId, raw);
  if (!payee.ok) {
    return c.json({ error: payee.error, code: payee.code }, 404);
  }
  const destAddress = payee.address;
  const mode = payee.kind === "address" ? "direct_evm" : "direct_user";
  const peer = payee.user;
  const toLower = raw.replace(/^@/, "").toLowerCase();
  const promptSave = payee.promptSave;

  try {
      const sendToken = body.token ?? "USDC";
      const senderLabel =
        fromUser?.handle
          ? `@${fromUser.handle}`
          : fromUser?.displayName ||
            fromUser?.email ||
            fromUser?.evmAddress ||
            fromId;
      const receiverLabel =
        peer?.handle
          ? `@${peer.handle}`
          : peer?.displayName || destAddress;
      // Draft only — becomes a receipt after PIN succeeds (client confirms).
      const sendActivity = store.addActivity({
        userId: fromId,
        kind: "send",
        title: mode === "direct_evm" ? destAddress.slice(0, 10) + "…" : toLower,
        description:
          body.memo ||
          (mode === "direct_evm"
            ? `Direct ${sendToken} send`
            : `Send ${sendToken} to Evabob user`),
        amountUsdc: sendToken === "USDC" ? -body.amountUsdc : 0,
        amountNgnHint: body.amountNgn ? -body.amountNgn : undefined,
        counterparty: destAddress,
        sender: senderLabel,
        receiver: receiverLabel,
        token: sendToken,
        amountToken: body.amountUsdc,
        mode: mode === "direct_evm" ? "direct" : "direct_user",
        status: "pending",
      });

      // Prefer App Kit UCW for same-chain USDC/EURC (PIN via existing WebView).
      if (config.appKit.enabled && (sendToken === "USDC" || sendToken === "EURC")) {
        try {
          const { startUcwSendJob, getAppKitJob } = await import(
            "../services/appKitMoney.js"
          );
          const wallets = await listUserWallets(body.userToken);
          const primary = pickPrimaryArcWallet(wallets);
          const walletAddress = (primary?.address ||
            fromUser?.evmAddress) as `0x${string}` | undefined;
          const job = startUcwSendJob({
            userId: fromId,
            userToken: body.userToken,
            walletId: body.walletId,
            walletAddress,
            to: destAddress,
            amount: body.amountUsdc,
            token: sendToken,
            chain: "Arc_Testnet",
            // Fill in the pending row opened above rather than adding a second.
            activityId: sendActivity.id,
          });
          // Brief wait so first PIN challenge appears
          await new Promise((r) => setTimeout(r, 500));
          const latest = getAppKitJob(job.id);
          const challenges =
            latest?.challenges.map((ch) => ({
              step: "app_kit_send",
              challengeId: ch.challengeId,
            })) ?? [];
          return c.json({
            mode,
            rail: "app-kit-ucw",
            jobId: job.id,
            destinationAddress: destAddress,
            recipientHasAccount: mode === "direct_user",
            activityId: sendActivity.id,
            peerUserId: peer?.id,
            sender: senderLabel,
            receiver: receiverLabel,
            token: sendToken,
            amount: body.amountUsdc,
            amountNgn: body.amountNgn,
            memo: body.memo,
            notify: { emailSent: false, detail: "not required for direct send" },
            appId: circleAppId(),
            challenges,
            challengeIds: challenges.map((c) => c.challengeId),
            promptSave,
            message:
              challenges.length > 0
                ? "Direct transfer via App Kit — confirm with PIN"
                : "App Kit send started — poll job or complete PIN when prompted",
          });
        } catch (e) {
          console.warn(
            "App Kit UCW send fallback to transfer challenge:",
            e instanceof Error ? e.message : e,
          );
        }
      }

      const t = await createTransferChallenge({
        userToken: body.userToken,
        walletId: body.walletId,
        destinationAddress: destAddress,
        amountUsdc: String(body.amountUsdc),
        tokenAddress: tokenFor(sendToken),
      });
      return c.json({
        mode,
        rail: "ucw-transfer",
        destinationAddress: destAddress,
        recipientHasAccount: mode === "direct_user",
        activityId: sendActivity.id,
        peerUserId: peer?.id,
        sender: senderLabel,
        receiver: receiverLabel,
        token: sendToken,
        amount: body.amountUsdc,
        amountNgn: body.amountNgn,
        memo: body.memo,
        notify: { emailSent: false, detail: "not required for direct send" },
        appId: circleAppId(),
        challenges: t.challengeId
          ? [{ step: "transfer", challengeId: t.challengeId }]
          : [],
        promptSave,
        message: "Direct transfer — confirm with PIN",
      });
  } catch (e) {
    return c.json(
      { error: clientError(e, "send failed") },
      400,
    );
  }
});

/** Gateway deposit — user-signed approve + deposit on the source chain. */
circleWallets.post("/gateway/deposit", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      amountUsdc: z.number().positive(),
      chain: z.string().optional(),
      domain: z.number().int().optional(),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const wallets = await listUserWallets(body.userToken);
    const result = await createGatewayDepositChallenges({
      ...body,
      wallets,
    });
    store.addActivity({
      userId: appUserId(c),
      kind: "fund",
      title: `Gateway deposit · ${result.chain || "Arc"}`,
      description: `UCW deposit ${body.amountUsdc} USDC`,
      amountUsdc: body.amountUsdc,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "gateway deposit failed") },
      400,
    );
  }
});

/**
 * Gateway Pay — spend **user** unified USDC balance.
 *
 * SCA path (Evabob UCW):
 * 1) First call may return PIN challenges for `addDelegate` (one-time).
 * 2) After delegate is on-chain, burn intent uses:
 *    - sourceDepositor = user SCA
 *    - sourceSigner = platform EOA (PRIVATE_KEY)
 * 3) Server submits signed intent to Circle Gateway API.
 *
 * Body: userToken, walletId, amountUsdc, destinationDomain, destinationAddress
 */
circleWallets.post("/gateway/pay", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int().nonnegative(),
      destinationAddress: z.string().min(32).max(64),
      sourceDomain: z.number().int().optional(),
      /** After client finishes addDelegate challenge, set true to skip re-check races. */
      delegateReady: z.boolean().optional(),
      userId: z.string().optional(),
      enableForwarder: z.boolean().optional(),
    })
    .parse(await c.req.json());

  const uid = appUserId(c);

  try {
    const {
      gatewayPayFromUserDepositor,
      getGatewayPayDelegateAddress,
      planGatewayPay,
      GATEWAY_DOMAIN_NAME,
    } = await import("../services/gateway-e2e.js");
    const { jsonSafe } = await import("../utils/json-safe.js");

    const wallets = await listUserWallets(body.userToken);
    const primary =
      wallets.find((w) => w.id === body.walletId) ||
      pickPrimaryArcWallet(wallets);
    const depositor = (primary?.address || "") as `0x${string}`;
    if (!depositor || !depositor.startsWith("0x")) {
      return c.json(
        { error: "No Circle wallet address — complete wallet setup first" },
        400,
      );
    }

    const delegate = getGatewayPayDelegateAddress();
    const plan = await planGatewayPay({
      depositor,
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      sourceDomain: body.sourceDomain,
      delegate,
    });

    if (plan.missingDomains.length > 0 && !body.delegateReady) {
      const setup = await createAddGatewayDelegateChallenges({
        userToken: body.userToken,
        walletId: body.walletId,
        wallets,
        domains: plan.missingDomains,
        delegateAddress: delegate,
      });
      if (setup.missingWallets.length > 0 && setup.challenges.length === 0) {
        const names = setup.missingWallets
          .map((d) => GATEWAY_DOMAIN_NAME[d] || String(d))
          .join(", ");
        return c.json(
          {
            error: `Finish Circle wallet setup for ${names} in Profile, then retry Pay`,
            missingWallets: setup.missingWallets,
          },
          400,
        );
      }
      // jsonSafe is required: plan.slices carries `raw` as a bigint, and
      // JSON.stringify throws on BigInt. Without it this response — the one
      // that hands the app its delegate-setup PIN challenges — died in
      // serialisation and surfaced as a generic "gateway pay failed" 400,
      // which is why cross-chain Gateway pay never once got past planning.
      return c.json(
        jsonSafe({
          ...setup,
          mode: "delegate_setup",
          depositor,
          amountUsdc: body.amountUsdc,
          destinationDomain: body.destinationDomain,
          destinationAddress: body.destinationAddress,
          sources: plan.slices,
          retryHint:
            "Complete each PIN, wait a few seconds, then call again. Do not skip remaining chains.",
        }),
      );
    }

    if (plan.missingDomains.length > 0) {
      const names = plan.missingDomains
        .map((d) => GATEWAY_DOMAIN_NAME[d] || String(d))
        .join(", ");
      return c.json(
        {
          error: `Delegate not yet confirmed on ${names}. Wait a few seconds after PIN and retry.`,
          missingDomains: plan.missingDomains,
          mode: "delegate_pending",
        },
        400,
      );
    }

    const result = await gatewayPayFromUserDepositor({
      depositor,
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      destinationAddress: body.destinationAddress,
      sourceDomain: body.sourceDomain,
      enableForwarder: body.enableForwarder ?? true,
      slices: plan.slices,
    });

    if (result.status === "complete" && result.mintTx) {
      // success path below
    } else if (
      result.status === "in_transit" ||
      result.status === "forwarded" ||
      result.status === "attestation_pending"
    ) {
      store.addActivity({
        userId: uid,
        kind: "withdraw",
        title: `Gateway pay · domain ${body.destinationDomain}`,
        description: `${body.amountUsdc} USDC in transit → ${body.destinationAddress.slice(0, 10)}…`,
        amountUsdc: -body.amountUsdc,
        txHash: result.transferId,
        status: "pending",
        receiver: body.destinationAddress,
      });
      return c.json(
        jsonSafe({
          ok: false,
          doNotRetry: true,
          mode: "user_gateway_pay",
          error:
            result.note ||
            "Gateway burn accepted. Destination mint is in transit — do not retry.",
          ...result,
        }),
        202,
      );
    } else {
      // 200 so the app can read doNotRetry without treating this as a retryable HTTP error.
      return c.json(
        jsonSafe({
          ok: false,
          doNotRetry: true,
          mode: "user_gateway_pay",
          error:
            result.note ||
            "Gateway burn submitted but destination mint failed. Do not retry — funds may already be in transit.",
          ...result,
        }),
      );
    }

    const srcNote = (result.sources || [])
      .map((s) => `${s.amountUsdc} ${s.name}`)
      .join(" + ");
    store.addActivity({
      userId: uid,
      kind: "withdraw",
      title: `Gateway pay · domain ${body.destinationDomain}`,
      description: `${body.amountUsdc} USDC from unified balance${srcNote ? ` (${srcNote})` : ""} → ${body.destinationAddress.slice(0, 10)}…`,
      amountUsdc: -body.amountUsdc,
      txHash: result.mintTx || result.transferId,
      status: "completed",
      receiver: body.destinationAddress,
    });

    // Keep user profile linked to SCA for balance queries
    store.upsertUser({
      id: uid,
      email: `${uid}@evabob.app`,
      displayName: uid,
      evmAddress: depositor,
    });

    return c.json(
      jsonSafe({
        ok: true,
        mode: "user_gateway_pay",
        ...result,
      }),
    );
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e
        ? String((e as { code?: string }).code)
        : undefined;
    if (code === "INSUFFICIENT_GATEWAY") {
      return c.json(
        { error: clientError(e, "Insufficient unified USDC") },
        400,
      );
    }
    if (code === "DELEGATE_REQUIRED") {
      try {
        const missing =
          e && typeof e === "object" && "missingDomains" in e
            ? (e as { missingDomains?: number[] }).missingDomains
            : [26];
        const wallets = await listUserWallets(body.userToken);
        const setup = await createAddGatewayDelegateChallenges({
          userToken: body.userToken,
          walletId: body.walletId,
          wallets,
          domains: missing && missing.length > 0 ? missing : [26],
        });
        return c.json({
          ...setup,
          mode: "delegate_setup",
          error: clientError(e, "delegate required"),
        });
      } catch (inner) {
        return c.json(
          {
            error:
              clientError(inner, "delegate setup failed"),
          },
          400,
        );
      }
    }
    return c.json(
      { error: clientError(e, "gateway pay failed") },
      400,
    );
  }
});

/** CCTP burn — user-signed (bridge USDC off Arc). Default: approve only first. */
circleWallets.post("/cctp/burn", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int(),
      mintRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      userId: z.string().optional(),
      /** sequential (default) | all (legacy both challenges) */
      step: z.enum(["sequential", "approve", "burn", "all"]).optional(),
    })
    .parse(await c.req.json());

  if (body.destinationDomain === config.arc.cctpDomain) {
    return c.json(
      { error: "Destination must differ from Arc (source domain 26)" },
      400,
    );
  }
  if (!isCctpMintSupported(body.destinationDomain)) {
    return c.json(
      {
        error: `Mint not configured for domain ${body.destinationDomain}`,
        hint: "Use Base (6), Arbitrum (3), Ethereum (0), or Avalanche (1) Sepolia/Fuji",
      },
      400,
    );
  }

  try {
    const destName = cctpMintDomainName(body.destinationDomain);
    const act = store.addActivity({
      userId: appUserId(c),
      kind: "bridge",
      title: `Bridge → ${destName}`,
      description: `Burn ${body.amountUsdc} USDC on Arc → ${destName} (awaiting PIN)`,
      amountUsdc: -body.amountUsdc,
      amountToken: body.amountUsdc,
      token: "USDC",
      sender: "Arc Testnet",
      receiver: body.mintRecipient,
      mode: "cctp_burn",
      status: "pending",
    });
    const result = await createCctpBurnChallenges({
      userToken: body.userToken,
      walletId: body.walletId,
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      mintRecipient: body.mintRecipient as `0x${string}`,
      step: body.step || "sequential",
      intentId: act.id,
    });
    return c.json({
      ...result,
      activityId: act.id,
      intentId: act.id,
      sourceDomain: config.arc.cctpDomain,
      destinationDomain: body.destinationDomain,
      destinationName: destName,
      amountUsdc: body.amountUsdc,
      mintRecipient: body.mintRecipient,
      sequential: (body.step || "sequential") !== "all",
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "cctp burn failed") },
      400,
    );
  }
});

/**
 * After approve COMPLETE — create depositForBurn challenge only.
 * Prevents PENDING race when both challenges were created up front.
 */
circleWallets.post("/cctp/burn/continue", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      intentId: z.string().min(1),
      activityId: z.string().optional(),
      amountUsdc: z.number().positive().optional(),
      destinationDomain: z.number().int().optional(),
      mintRecipient: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional(),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());

  try {
    const { createCctpBurnOnlyChallenge } = await import(
      "../services/circle-ucw.js"
    );
    const result = await createCctpBurnOnlyChallenge({
      intentId: body.intentId,
      userToken: body.userToken,
      walletId: body.walletId,
      amountUsdc: body.amountUsdc ?? 0,
      destinationDomain: body.destinationDomain ?? 0,
      mintRecipient: (body.mintRecipient ||
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
    });
    return c.json({
      ...result,
      activityId: body.activityId || body.intentId,
      intentId: body.intentId,
      sequential: true,
    });
  } catch (e) {
    return c.json(
      {
        error: clientError(e, "cctp burn continue failed"),
        code: "BURN_CONTINUE_FAILED",
      },
      400,
    );
  }
});

/**
 * After PIN succeeds: resolve burn txHash from UCW challenge, mark activity burned,
 * then poll Iris + mint on destination (ops wallet pays dest gas).
 *
 * Call with either burnTxHash (if known) or burnChallengeId (preferred after PIN).
 */
circleWallets.post("/cctp/finish", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      burnChallengeId: z.string().min(1).optional(),
      burnTxHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/)
        .optional(),
      destinationDomain: z.number().int().nonnegative(),
      sourceDomain: z.number().int().nonnegative().optional(),
      activityId: z.string().optional(),
      userId: z.string().optional(),
      /** Skip mint (resolve + confirm burn only). */
      burnOnly: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(180_000).optional(),
    })
    .parse(await c.req.json());

  if (!body.burnTxHash && !body.burnChallengeId) {
    return c.json(
      { error: "burnTxHash or burnChallengeId is required" },
      400,
    );
  }
  if (!isCctpMintSupported(body.destinationDomain) && !body.burnOnly) {
    return c.json(
      {
        error: `Mint not configured for domain ${body.destinationDomain}`,
      },
      400,
    );
  }

  const uid = appUserId(c);
  const destName = cctpMintDomainName(body.destinationDomain);
  let burnTxHash = body.burnTxHash;

  // 1) Resolve burn hash from Circle challenge if needed
  if (!burnTxHash && body.burnChallengeId) {
    // The burn hash is the entry point to attestation — give Circle the same
    // room its own strategy takes rather than capping at 90s.
    const resolved = await waitForChallengeTxHash({
      userToken: body.userToken,
      challengeId: body.burnChallengeId,
      timeoutMs: Math.min(body.timeoutMs ?? 180_000, 180_000),
    });
    if (!resolved.ok) {
      if (body.activityId) {
        store.updateActivity(body.activityId, {
          status: "failed",
          description: `Burn PIN ok but tx hash not found: ${resolved.error}`,
          mode: "cctp_burn_pending_hash",
        });
      }
      // 200 so mobile can read structured stage without transport error
      return c.json({
        ok: false,
        stage: "resolve_burn",
        error: resolved.error,
        challengeStatus: resolved.challengeStatus,
        transactionId: resolved.transactionId,
        state: resolved.state,
      });
    }
    burnTxHash = resolved.txHash;
  }

  if (!burnTxHash) {
    return c.json({
      ok: false,
      stage: "resolve_burn",
      error: "Could not resolve burn tx hash",
    });
  }

  // 2) Confirm burn activity
  if (body.activityId) {
    const row = store.getActivity(body.activityId);
    if (row && row.userId === uid) {
      store.updateActivity(body.activityId, {
        status: "completed",
        txHash: burnTxHash,
        mode: "cctp_burn",
        description: `Burned on Arc → ${destName} · minting…`,
      });
    }
  }

  if (body.burnOnly) {
    return c.json({
      ok: true,
      stage: "burned",
      burnTxHash,
      destinationDomain: body.destinationDomain,
      destinationName: destName,
      irisHint: `https://iris-api-sandbox.circle.com/v2/messages/${body.sourceDomain ?? config.arc.cctpDomain}?transactionHash=${burnTxHash}`,
    });
  }

  // 3) Iris attestation + mint on destination
  const mint = await cctpCompleteBridge({
    burnTxHash,
    destinationDomain: body.destinationDomain,
    sourceDomain: body.sourceDomain ?? config.arc.cctpDomain,
    timeoutMs: body.timeoutMs ?? 120_000,
  });

  if (mint.ok) {
    if (body.activityId) {
      store.updateActivity(body.activityId, {
        status: "completed",
        txHash: mint.mintTx,
        mode: "cctp_complete",
        description: `Bridged to ${mint.chain} · burn ${burnTxHash.slice(0, 10)}… · mint ${String(mint.mintTx).slice(0, 10)}…`,
      });
    } else {
      store.addActivity({
        userId: uid,
        kind: "bridge",
        title: `Mint on ${mint.chain}`,
        description: `CCTP mint complete on ${mint.chain}`,
        amountUsdc: 0,
        token: "USDC",
        txHash: mint.mintTx,
        mode: "cctp_mint",
        status: "completed",
      });
    }
    return c.json({
      ok: true,
      stage: "minted",
      burnTxHash,
      mintTx: mint.mintTx,
      chain: mint.chain,
      destinationDomain: body.destinationDomain,
      destinationName: destName,
      blockNumber: mint.blockNumber,
    });
  }

  // Burn succeeded; mint pending or failed — keep burn hash on receipt.
  // HTTP 200 so mobile can parse burnTxHash without treating as transport error.
  if (body.activityId) {
    store.updateActivity(body.activityId, {
      status: "completed",
      txHash: burnTxHash,
      mode:
        mint.status === "attested_mint_failed"
          ? "cctp_burn_mint_failed"
          : "cctp_burn_attesting",
      description:
        mint.status === "attested_mint_failed"
          ? `Burned on Arc; mint failed on ${destName}: ${mint.error}. Ops may need gas on destination.`
          : `Burned on Arc; attestation pending on ${destName}. Retry finish with burnTxHash.`,
    });
  }

  return c.json({
    ok: false,
    stage:
      mint.status === "attested_mint_failed" ? "mint_failed" : "attesting",
    burnTxHash,
    destinationDomain: body.destinationDomain,
    destinationName: destName,
    status: mint.status,
    error: mint.error,
    hint:
      "hint" in mint
        ? mint.hint
        : "irisHint" in mint
          ? mint.irisHint
          : undefined,
    message: "message" in mint ? mint.message : undefined,
    attestation: "attestation" in mint ? mint.attestation : undefined,
  });
});

/**
 * Buy / swap on Arc via Synthra (USDC ↔ EURC ↔ cirBTC).
 * Returns UCW challenges: approve router + execute swap calldata.
 */
/**
 * Two PIN challenges that lock money in the escrow contract.
 *
 * The contract pulls funds with `transferFrom`, so the payer approves and then
 * creates — the same approve-then-execute shape the Synthra swap uses, run by
 * the same multi-challenge runner on the client.
 *
 * The `create` challenge id is returned separately because the caller needs
 * that transaction specifically: its receipt carries the `TransferCreated`
 * event, and the transfer id lives nowhere else. A hold whose id is never read
 * is a hold nobody can claim or refund.
 */
circleWallets.post("/escrow/hold", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(1),
      walletId: z.string().min(1),
      recipient: z.string().min(1),
      amountUsdc: z.number().positive(),
      memo: z.string().max(120).optional(),
      purpose: z.enum(["claim_link", "job"]).default("claim_link"),
      expirySeconds: z.number().int().positive().optional(),
    })
    .parse(await c.req.json());

  const { planProtectedEscrow, EscrowError } = await import(
    "../services/protectedEscrow.js"
  );
  const { createCalldataChallenge } = await import(
    "../services/circle-ucw.js"
  );

  try {
    const plan = planProtectedEscrow({
      recipientId: body.recipient,
      amountUsdc: body.amountUsdc,
      memo: body.memo,
      purpose: body.purpose,
      expirySeconds: body.expirySeconds,
    });

    const approve = await createCalldataChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      contractAddress: plan.steps[0]!.to,
      callData: plan.steps[0]!.data,
    });
    const create = await createCalldataChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      contractAddress: plan.steps[1]!.to,
      callData: plan.steps[1]!.data,
    });

    return c.json({
      appId: create.appId,
      challenges: [
        {
          step: "approve",
          challengeId: approve.challengeId,
          description: "Allow the hold to take the funds",
        },
        {
          step: "create",
          challengeId: create.challengeId,
          description: "Lock the funds",
        },
      ],
      createChallengeId: create.challengeId,
      plan: {
        recipientId: plan.recipientId,
        recipientKind: plan.recipientKind,
        amountUsdc: plan.amountUsdc,
        expiresAt: plan.expiresAt,
        purpose: plan.purpose,
      },
    });
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

circleWallets.post("/swap", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      /** Symbol (USDC/EURC/CIRBTC) or 0x contract address */
      from: z.string().min(1),
      to: z.string().min(1),
      amountIn: z.number().positive(),
      recipient: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional(),
      slippageBps: z.number().int().min(1).max(5000).optional(),
      fromDecimals: z.number().int().min(0).max(24).optional(),
      toDecimals: z.number().int().min(0).max(24).optional(),
      userId: z.string().optional(),
    })
    .parse(await c.req.json());

  if (body.from.toLowerCase() === body.to.toLowerCase()) {
    return c.json({ error: "from and to must differ" }, 400);
  }

  try {
    const { synthraSwap, synthraConfigured } = await import(
      "../services/synthra.js"
    );
    if (!synthraConfigured()) {
      return c.json(
        {
          error: "SYNTHRA_API_KEY not configured",
          hint: "Set SYNTHRA_API_KEY in server/.env for on-chain swaps",
        },
        503,
      );
    }

    // Resolve recipient from linked wallet when omitted
    let recipient = body.recipient;
    if (!recipient) {
      const wallets = await listUserWallets(body.userToken);
      const primary = pickPrimaryArcWallet(wallets);
      recipient = primary?.address;
    }
    if (!recipient?.startsWith("0x")) {
      return c.json({ error: "Could not resolve swap recipient address" }, 400);
    }

    const plan = await synthraSwap({
      fromToken: body.from,
      toToken: body.to,
      amountIn: body.amountIn,
      recipient,
      slippageBps: body.slippageBps ?? 50,
      approvalMode: "erc20",
      fromDecimals: body.fromDecimals,
      toDecimals: body.toDecimals,
    });

    if (!plan.ok || !plan.transaction?.to || !plan.transaction.data) {
      return c.json(
        {
          error: plan.error || "Synthra swap plan failed",
          synthra: plan.raw,
        },
        502,
      );
    }

    const approveTo =
      plan.approval?.approveTo ||
      (/^0x[a-fA-F0-9]{40}$/.test(body.from)
        ? body.from
        : tokenFor(
            (["USDC", "EURC", "CIRBTC"].includes(body.from.toUpperCase())
              ? body.from.toUpperCase()
              : "USDC") as "USDC" | "EURC" | "CIRBTC",
          ));
    const approveData = plan.approval?.approveData;
    if (!approveData?.startsWith("0x")) {
      return c.json(
        { error: "Synthra did not return approve calldata", plan },
        502,
      );
    }

    const challenges = await createSynthraSwapChallenges({
      userToken: body.userToken,
      walletId: body.walletId,
      approveTo,
      approveData: approveData as `0x${string}`,
      swapTo: plan.transaction.to,
      swapData: plan.transaction.data as `0x${string}`,
      swapValue: plan.transaction.value,
    });

    const act = store.addActivity({
      userId: appUserId(c),
      kind: "exchange",
      title: `Swap ${body.from} → ${body.to}`,
      description: `Swap ${body.amountIn} ${body.from} → ~${plan.amountOut?.toFixed(6) ?? "?"} ${body.to} via Synthra`,
      amountUsdc:
        body.from === "USDC"
          ? -body.amountIn
          : body.to === "USDC"
            ? plan.amountOut ?? 0
            : 0,
      token: body.from,
      amountToken: body.amountIn,
      mode: "synthra",
      status: "pending",
    });

    return c.json({
      ...challenges,
      activityId: act.id,
      plan: {
        from: body.from,
        to: body.to,
        amountIn: body.amountIn,
        amountOut: plan.amountOut,
        amountOutRaw: plan.amountOutRaw,
        routeString: plan.routeString,
        recipient,
        source: "synthra",
      },
    });
  } catch (e) {
    return c.json(
      { error: clientError(e, "swap failed") },
      400,
    );
  }
});

function tokenFor(sym: "USDC" | "EURC" | "CIRBTC") {
  if (sym === "EURC") return config.arc.eurc;
  if (sym === "CIRBTC") return config.arc.cirbtc;
  return config.arc.usdc;
}

/**
 * Verify Circle challenges reached COMPLETE (after WebView PIN UI).
 * Call before confirming activity so fake receipts are not created.
 */
circleWallets.post("/verify-challenges", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      challengeIds: z.array(z.string().min(1)).min(1),
      // Circle's UCW signing strategy waits 10 minutes by default. Capping at
      // 2 minutes here is what turned slow-but-healthy burns into "PENDING".
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      /** Also resolve on-chain tx hash from the last challenge when possible. */
      resolveTxHash: z.boolean().optional().default(true),
    })
    .parse(await c.req.json());

  const verified = await waitForChallengesComplete({
    userToken: body.userToken,
    challengeIds: body.challengeIds,
    timeoutMs: body.timeoutMs ?? 300_000,
  });

  let txHash: string | undefined = verified.txHash;
  if (!txHash && body.resolveTxHash) {
    const last = body.challengeIds[body.challengeIds.length - 1]!;
    const resolved = await waitForChallengeTxHash({
      userToken: body.userToken,
      challengeId: last,
      timeoutMs: 45_000,
    });
    if (resolved.ok) txHash = resolved.txHash;
  }

  // `settled` steps are irreversible even when the challenge record still
  // reads PENDING, so the client can continue the pipeline (attest → mint)
  // instead of aborting on a lagging status.
  return c.json({
    ok: verified.ok,
    error: verified.ok ? undefined : verified.error,
    statuses: verified.statuses,
    anySettled: verified.anySettled,
    allSettled: verified.statuses.every((s) => s.settled),
    dead: verified.statuses.some((s) => s.dead),
    txHash: txHash ?? null,
  });
});

/**
 * After PIN succeeds: promote pending send to completed receipt + peer receive.
 * After cancel: discard pending so no receipt appears.
 */
circleWallets.post("/confirm-activity", async (c) => {
  const body = z
    .object({
      activityId: z.string().min(1),
      ok: z.boolean(),
      txHash: z.string().optional(),
      userId: z.string().optional(),
      /** When true, refuse placeholder hash for on-chain modes (swap/bridge). */
      requireTxHash: z.boolean().optional(),
    })
    .parse(await c.req.json());
  const uid = appUserId(c);
  const row = store.getActivity(body.activityId);
  if (!row || row.userId !== uid) {
    return c.json({ error: "Activity not found" }, 404);
  }
  if (!body.ok) {
    // The device cannot know whether an in-flight transaction was broadcast.
    return c.json({ ok: false, pending: true, error: "Reconcile the payment before changing its status." }, 409);
  }
  const { confirmPaymentActivity } = await import("../services/confirm-payment.js");
  let confirmation;
  try {
    confirmation = await confirmPaymentActivity(uid, row.id, body.txHash);
  } catch {
    return c.json({ ok: false, pending: true, error: "Payment is not yet verified on chain." }, 409);
  }
  if (!confirmation.newlyVerified) return c.json({ ok: true, item: confirmation.row });
  // Mirror receive for peer sends
  if (row.kind === "send" && row.counterparty) {
    const peer =
      store.findUserByRecipient(row.counterparty) ||
      (row.receiver ? store.findUserByHandle(row.receiver.replace(/^@/, "")) : null);
    if (peer && peer.id !== uid) {
      store.addActivity({
        userId: peer.id,
        kind: "receive",
        title: row.sender || "Evabob user",
        description: row.description || "Payment received",
        amountUsdc: row.token === "USDC" ? Math.abs(row.amountUsdc) : 0,
        amountNgnHint: row.amountNgnHint
          ? Math.abs(row.amountNgnHint)
          : undefined,
        counterparty: row.sender || uid,
        sender: row.sender,
        receiver: row.receiver,
        token: row.token,
        amountToken: row.amountToken,
        mode: row.mode,
        status: "completed",
        txHash: body.txHash,
      });
    }
  }
  return c.json({ ok: true, item: store.getActivity(row.id) });
});

/** Public self-linking is retired; the server links only verified identities. */
circleWallets.post("/identity/link", c =>
  c.json({ error: "Use /v1/identity/link with verified identity ownership." }, 410),
);

circleWallets.get("/challenge-bootstrap", (c) =>
  c.json({
    appId: circleAppId(),
    usdc: config.arc.usdc,
    chain: "ARC-TESTNET",
    mode: "ucw-only",
  }),
);

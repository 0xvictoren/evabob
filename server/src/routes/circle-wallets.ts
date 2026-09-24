import { Hono, type Context } from "hono";
import { formatUnits } from "viem";
import { z } from "zod";
import { config } from "../config.js";
import {
  circleAppId,
  createAdditionalWalletsChallenge,
  createAddGatewayDelegateChallenges,
  createCctpBurnChallenges,
  createGatewayDepositChallenges,
  walletForGatewayDomain,
  createPinWalletChallenge,
  createSession,
  createSynthraSwapChallenges,
  createTransferChallenge,
  createWalletBatchChallenge,
  ensureUser,
  getWalletBalances,
  listUserWallets,
  mapWalletsForDeposit,
  pickPrimaryArcWallet,
  waitForChallengeTxHash,
  waitForChallengesComplete,
} from "../services/circle-ucw.js";
import {
  burnBelongsTo,
  cctpCompleteBridge,
  cctpMintDomainName,
  isCctpMintSupported,
} from "../services/cctp.js";
import {
  erc20TransferCall,
  feeActivityFields,
  feeTransferCall,
  quotePlatformFee,
} from "../services/platformFee.js";
import {
  memoIdFor,
  memoRecordCall,
  normalizeMemo,
} from "../services/memo.js";
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
  // Same family check as /send: this route reaches the same people.
  {
    const { requireFamilyPass, FamilyCheckError } = await import("../services/familyCheck.js");
    try {
      requireFamilyPass({
        userId: appUserId(c),
        dest: body.destinationAddress,
        amount: Number(body.amount),
        token: "USDC",
      });
    } catch (error) {
      if (error instanceof FamilyCheckError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }
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

  const memoCheck = normalizeMemo(body.memo);
  if (!memoCheck.ok) {
    return c.json({ error: memoCheck.error, code: "INVALID_MEMO" }, 400);
  }
  const memo = memoCheck.memo;

  const { resolvePayee } = await import("../services/resolvePayee.js");
  const fromId = appUserId(c);
  const fromUser = store.getUser(fromId);
  const raw = body.to.trim();
  const payee = resolvePayee(fromId, raw);
  if (!payee.ok) {
    return c.json({ error: payee.error, code: payee.code }, 404);
  }
  const destAddress = payee.address;
  // Large payments to family need the code emailed to the sender first.
  {
    const { requireFamilyPass, FamilyCheckError } = await import("../services/familyCheck.js");
    try {
      requireFamilyPass({ userId: fromId, dest: destAddress, amount: body.amountUsdc, token: body.token ?? "USDC" });
    } catch (error) {
      if (error instanceof FamilyCheckError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }
  const mode = payee.kind === "address" ? "direct_evm" : "direct_user";
  const peer = payee.user;
  const toLower = raw.replace(/^@/, "").toLowerCase();
  const promptSave = payee.promptSave;

  try {
      const sendToken = body.token ?? "USDC";
      const sendDecimals = tokenDecimals(sendToken);
      const feeQuote = quotePlatformFee(body.amountUsdc, sendDecimals);
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
          mode === "direct_evm"
            ? `Direct ${sendToken} send`
            : `Send ${sendToken} to Evabob user`,
        memo,
        amountUsdc: sendToken === "USDC" ? -body.amountUsdc : 0,
        amountNgnHint: body.amountNgn ? -body.amountNgn : undefined,
        counterparty: destAddress,
        sender: senderLabel,
        receiver: receiverLabel,
        token: sendToken,
        amountToken: body.amountUsdc,
        ...feeActivityFields(feeQuote, sendToken, sendDecimals),
        mode: mode === "direct_evm" ? "direct" : "direct_user",
        status: "pending",
      });

      // The memo is written on chain beside the transfer when the memo
      // contract is configured. That needs the wallet batch, so a memo takes
      // this send down the batch path just as a fee does.
      const tokenAddress = tokenFor(sendToken) as `0x${string}`;
      const transferCall = erc20TransferCall(
        tokenAddress,
        destAddress as `0x${string}`,
        feeQuote.amountUnits,
      );
      const memoId = memo ? memoIdFor(sendActivity.id) : undefined;
      const memoCall =
        memo && memoId
          ? memoRecordCall({
              target: tokenAddress,
              transferData: transferCall.data,
              memoId,
              memo,
            })
          : null;
      if (memoId) store.updateActivity(sendActivity.id, { memoId });

      const sendResponse = (extra: Record<string, unknown>) => ({
        mode,
        destinationAddress: destAddress,
        recipientHasAccount: mode === "direct_user",
        activityId: sendActivity.id,
        peerUserId: peer?.id,
        sender: senderLabel,
        receiver: receiverLabel,
        token: sendToken,
        amount: body.amountUsdc,
        platformFee: feeQuote.fee,
        amountNgn: body.amountNgn,
        memo,
        memoOnchain: Boolean(memoCall),
        notify: { emailSent: false, detail: "not required for direct send" },
        appId: circleAppId(),
        promptSave,
        ...extra,
      });

      // Platform fee or on-chain memo: the payment, the fee and the memo go in
      // ONE wallet batch — one PIN, and none of them lands without the others.
      // App Kit's send has neither option, so this path takes priority.
      const feeCall = feeTransferCall(tokenAddress, feeQuote);
      if (feeCall || memoCall) {
        const batch = await createWalletBatchChallenge({
          userToken: body.userToken,
          walletId: body.walletId,
          calls: [
            transferCall,
            ...(feeCall ? [feeCall] : []),
            ...(memoCall ? [memoCall] : []),
          ],
        });
        return c.json(
          sendResponse({
            rail: "ucw-batch",
            challenges: batch.challengeId
              ? [{ step: "transfer", challengeId: batch.challengeId }]
              : [],
            message: "Direct transfer — confirm with PIN",
          }),
        );
      }

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
            memo,
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
        memo,
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
    // No activity row yet. It used to be written here, before the PIN, so a
    // cancelled top-up still read "Gateway deposit". The watch writes the row
    // once the person has signed (confirm below) or once the money is seen
    // arriving, and marks it arrived when Gateway credits it.
    const depositor =
      walletForGatewayDomain(wallets, result.domain)?.address ||
      wallets.find((w) => w.id === body.walletId)?.address;
    const { startTopUpWatch } = await import("../services/gatewayTracker.js");
    const watchId = depositor
      ? await startTopUpWatch({
          userId: appUserId(c),
          depositor,
          domain: result.domain,
          amountUsdc: body.amountUsdc,
        })
      : undefined;
    return c.json({ ...result, ...(watchId ? { watchId } : {}) });
  } catch (e) {
    return c.json(
      { error: clientError(e, "gateway deposit failed") },
      400,
    );
  }
});

/**
 * The person signed a top-up: show it as on its way. Only the watch's owner.
 */
circleWallets.post("/gateway/deposit/confirm", async (c) => {
  const body = z
    .object({
      watchId: z.string().min(1),
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
    })
    .parse(await c.req.json());
  const { confirmTopUpSigned } = await import("../services/gatewayTracker.js");
  const watch = confirmTopUpSigned({
    userId: appUserId(c),
    watchId: body.watchId,
    txHash: body.txHash,
  });
  if (!watch) return c.json({ error: "No such top-up" }, 404);
  return c.json({ ok: true, status: watch.status });
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
    const { GATEWAY_DOMAIN_NAME } = await import("../services/gateway-e2e.js");
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

    const { planGatewayPayment, sendGatewayPayment } = await import(
      "../services/gatewayPayFlow.js"
    );
    const { plan, delegate } = await planGatewayPayment({
      depositor,
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      sourceDomain: body.sourceDomain,
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
      // serialisation and surfaced as a generic "gateway pay failed" 400.
      return c.json(
        jsonSafe({
          ...setup,
          mode: "delegate_setup",
          depositor,
          amountUsdc: body.amountUsdc,
          destinationDomain: body.destinationDomain,
          destinationAddress: body.destinationAddress,
          sources: plan.slices,
        }),
      );
    }

    // GATEWAY_PAY_REQUIRE_PIN: the server signs GA payments as the person's
    // delegate, so with the switch on nothing is sent or scheduled until the
    // person confirms this payment with their PIN. The app runs the returned
    // challenge and reports it through /verify-challenges, which releases it.
    const { gatewayPayNeedsPin, parkForPin, pinMessageFor } = await import(
      "../services/gatewayPinGate.js"
    );
    if (gatewayPayNeedsPin()) {
      const { createVerifyPinChallenge } = await import("../services/circle-ucw.js");
      const message = pinMessageFor({
        amountUsdc: body.amountUsdc,
        destinationAddress: body.destinationAddress,
      });
      const pin = await createVerifyPinChallenge({
        userToken: body.userToken,
        walletId: body.walletId,
        purpose: message,
      });
      if (!pin.challengeId) {
        return c.json(
          {
            error: "Confirming GA payments with your PIN is not available right now. Nothing was sent.",
            code: "GA_PIN_UNAVAILABLE",
          },
          503,
        );
      }
      parkForPin(pin.challengeId, {
        userId: uid,
        depositor,
        amountUsdc: body.amountUsdc,
        destinationDomain: body.destinationDomain,
        destinationAddress: body.destinationAddress,
        sourceDomain: body.sourceDomain,
        enableForwarder: body.enableForwarder,
      });
      return c.json({
        mode: "user_gateway_pay",
        status: "awaiting_pin",
        appId: circleAppId(),
        message,
        challenges: [{ step: "confirm_payment", challengeId: pin.challengeId }],
      });
    }

    // Approved, but Circle will not accept the approval until it is final on
    // that network (or it was signed seconds ago and is not even mined). The
    // payment is scheduled and goes through by itself — it used to be sent
    // straight away and refused with "Signer is not authorized".
    if (plan.missingDomains.length > 0 || plan.confirmingDomains.length > 0) {
      const { scheduleGatewayPay } = await import("../services/gatewayTracker.js");
      const waitingFor = [...new Set([...plan.missingDomains, ...plan.confirmingDomains])];
      const scheduled = scheduleGatewayPay({
        userId: uid,
        depositor,
        amountUsdc: body.amountUsdc,
        destinationDomain: body.destinationDomain,
        destinationAddress: body.destinationAddress,
        sourceDomain: body.sourceDomain,
        waitingFor,
        justApproved: body.delegateReady === true || plan.missingDomains.length > 0,
      });
      const names = waitingFor.map((d) => GATEWAY_DOMAIN_NAME[d] || String(d)).join(" and ");
      return c.json(
        {
          ok: false,
          doNotRetry: true,
          mode: "user_gateway_pay",
          status: "scheduled",
          paymentId: scheduled.id,
          waitingFor,
          error:
            `Your approval on ${names} is being confirmed by the network — this takes about ` +
            `${scheduled.minutes} minutes the first time. Your payment will go through by itself ` +
            `then, and we will tell you. Nothing has left your GA yet.`,
        },
        202,
      );
    }

    const sent = await sendGatewayPayment({
      userId: uid,
      depositor,
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      destinationAddress: body.destinationAddress,
      sourceDomain: body.sourceDomain,
      slices: plan.slices,
      enableForwarder: body.enableForwarder,
    });
    return c.json(sent.body, sent.httpStatus);
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

  // A hash the caller typed in (rather than one read from their own PIN
  // challenge) must be a burn from their own wallet: finishing it spends the
  // ops wallet's gas, and must not be available for anyone else's transfers.
  if (body.burnTxHash) {
    const wallets = await listUserWallets(body.userToken).catch(() => []);
    const mine = await burnBelongsTo(
      body.sourceDomain ?? config.arc.cctpDomain,
      burnTxHash,
      [...wallets.map((w) => w.address || ""), store.getUser(uid)?.evmAddress || ""],
    );
    if (mine === null) {
      // The public RPC refuses reads when busy. A person retrying their own
      // bridge must not be stuck on that, so an unreadable receipt carries on
      // as before; only a readable burn from someone else's wallet is refused.
      console.warn("[cctp/finish] burn ownership unreadable; continuing", burnTxHash.slice(0, 12));
    } else if (!mine) {
      return c.json(
        {
          ok: false,
          stage: "resolve_burn",
          error: "This transfer was not sent from your wallet, so Evabob cannot finish it.",
        },
        403,
      );
    }
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
      purpose: z.enum(["claim_link", "job", "cooling_off"]).default("claim_link"),
      expirySeconds: z.number().int().positive().optional(),
      /** Paying through a seller's hold link: the link sets who, how much and how long. */
      holdLinkId: z.string().min(6).max(40).optional(),
    })
    .parse(await c.req.json());

  const { planProtectedEscrow, isRegistered, EscrowError } = await import(
    "../services/protectedEscrow.js"
  );

  if (body.holdLinkId) {
    const { getHoldLink } = await import("../services/holdLinks.js");
    const link = getHoldLink(body.holdLinkId);
    const seller = link ? store.getUser(link.sellerId) : null;
    if (!link || !seller?.handle) return c.json({ error: "That link does not exist" }, 404);
    if (!link.active) return c.json({ error: "The seller has closed this link" }, 409);
    if (link.sellerId === appUserId(c)) {
      return c.json({ error: "You cannot buy from your own link" }, 400);
    }
    body.recipient = `@${seller.handle}`;
    body.amountUsdc = link.amount;
    body.purpose = "job";
    body.expirySeconds = link.deliveryDays * 24 * 60 * 60;
  }

  try {
    // A cooling-off hold pays an existing account after ten minutes. Someone
    // with no account yet needs a claim link instead, which waits for them.
    if (body.purpose === "cooling_off" && !isRegistered(body.recipient)) {
      return c.json(
        {
          error: `${body.recipient} doesn't have an Evabob account yet. Send it as a claim link instead.`,
          code: "RECIPIENT_NOT_REGISTERED",
        },
        400,
      );
    }

    // Holding money for family is still paying family: the same emailed
    // code applies when the recipient's wallet is a family contact.
    const recipientAddress = store.findUserByRecipient(body.recipient)?.evmAddress;
    if (recipientAddress) {
      const { requireFamilyPass, FamilyCheckError } = await import("../services/familyCheck.js");
      try {
        requireFamilyPass({
          userId: appUserId(c),
          dest: recipientAddress,
          amount: body.amountUsdc,
          token: "USDC",
        });
      } catch (error) {
        if (error instanceof FamilyCheckError) {
          return c.json({ error: error.message, code: error.code }, error.status);
        }
        throw error;
      }
    }

    const plan = planProtectedEscrow({
      recipientId: body.recipient,
      amountUsdc: body.amountUsdc,
      memo: body.memo,
      purpose: body.purpose,
      expirySeconds: body.expirySeconds,
    });

    const planSummary = {
      recipientId: plan.recipientId,
      recipientKind: plan.recipientKind,
      amountUsdc: plan.amountUsdc,
      expiresAt: plan.expiresAt,
      purpose: plan.purpose,
    };

    // Approve, lock and (when it applies) the platform fee go in ONE wallet
    // batch: a single PIN, and the fee is never taken for a hold that did not
    // lock. This used to fall back to two separate PINs when no fee applied,
    // which made holding money — including the cooling-off hold a first
    // payment to someone new now gets — more work than just sending it. The
    // batch receipt still carries TransferCreated, so the same challenge is
    // the "create" the app reads the transfer id from.
    const feeQuote = quotePlatformFee(body.amountUsdc, 6);
    const feeCall =
      feeQuote.feeUnits > 0n
        ? feeTransferCall(config.arc.usdc as `0x${string}`, feeQuote)
        : null;
    const batch = await createWalletBatchChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      calls: [
        { to: plan.steps[0]!.to as `0x${string}`, data: plan.steps[0]!.data },
        { to: plan.steps[1]!.to as `0x${string}`, data: plan.steps[1]!.data },
        ...(feeCall ? [feeCall] : []),
      ],
    });
    return c.json({
      appId: batch.appId,
      challenges: [
        {
          step: "create",
          challengeId: batch.challengeId,
          description: "Lock the funds",
        },
      ],
      createChallengeId: batch.challengeId,
      ...(feeCall ? { platformFee: feeQuote.fee } : {}),
      plan: planSummary,
    });
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * Locks one hold per invoice line under a single PIN, for an invoice paid by
 * milestone. Approve the total, create each hold, and take the Evabob fee on
 * the total, all in one wallet batch: none of it lands without the rest.
 */
circleWallets.post("/escrow/hold-milestones", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(1),
      walletId: z.string().min(1),
      paymentRequestId: z.string().min(1),
    })
    .parse(await c.req.json());
  const { getPaymentRequest } = await import("../services/payment-requests.js");
  const invoice = getPaymentRequest(body.paymentRequestId);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);
  if (!invoice.allowedStructures.includes("milestones")) {
    return c.json({ error: "This invoice is not paid by milestone" }, 409);
  }
  if (invoice.status !== "open") return c.json({ error: `This invoice is already ${invoice.status}` }, 409);
  if ((invoice.token || "USDC") !== "USDC") {
    return c.json({ error: "Milestones are held in dollars only" }, 400);
  }
  const issuer = store.getUser(invoice.senderId || invoice.userId);
  const recipient = issuer?.handle ? `@${issuer.handle}` : issuer?.email;
  if (!issuer || !recipient) return c.json({ error: "The invoice has no one to pay" }, 404);
  if (issuer.id === appUserId(c)) return c.json({ error: "You cannot pay your own invoice" }, 400);

  // Family check applies to the whole invoice, as to any payment.
  {
    const { requireFamilyPass, FamilyCheckError } = await import("../services/familyCheck.js");
    try {
      requireFamilyPass({ userId: appUserId(c), dest: issuer.evmAddress, amount: invoice.total, token: "USDC" });
    } catch (error) {
      if (error instanceof FamilyCheckError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  }

  const { planMilestoneHolds, EscrowError } = await import("../services/protectedEscrow.js");
  try {
    const plan = planMilestoneHolds({
      recipientId: recipient,
      milestones: invoice.items.map((it, i) => ({
        amountUsdc: it.amount,
        memo: `Milestone ${i + 1}: ${it.description}`,
      })),
    });
    const feeQuote = quotePlatformFee(plan.totalUsdc, 6);
    const feeCall =
      feeQuote.feeUnits > 0n ? feeTransferCall(config.arc.usdc as `0x${string}`, feeQuote) : null;
    const batch = await createWalletBatchChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      calls: [...plan.calls, ...(feeCall ? [feeCall] : [])],
    });
    return c.json({
      appId: batch.appId,
      challenges: [{ step: "create", challengeId: batch.challengeId, description: "Set aside each milestone" }],
      createChallengeId: batch.challengeId,
      milestones: invoice.items.length,
      totalUsdc: plan.totalUsdc,
      ...(feeCall ? { platformFee: feeQuote.fee } : {}),
    });
  } catch (e) {
    if (e instanceof EscrowError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ─── Money circles and group pots ────────────────────────────────────────
// Each route builds one wallet batch (one PIN). The app confirms with the
// resulting transaction on /v1/groups/…, which reads the chain.

const walletBody = { userToken: z.string().min(1), walletId: z.string().min(1) };

async function groupBatch(
  c: Context,
  build: () => Promise<{ calls: Array<{ to: `0x${string}`; data: `0x${string}` }>; groupId: string }>,
) {
  const body = z.object(walletBody).passthrough().parse(await c.req.json().catch(() => ({})));
  const { GroupMoneyError } = await import("../services/groupMoney.js");
  try {
    const { calls, groupId } = await build();
    const batch = await createWalletBatchChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      calls,
    });
    return c.json({
      appId: batch.appId,
      challenges: [{ step: "create", challengeId: batch.challengeId, description: "Confirm" }],
      createChallengeId: batch.challengeId,
      groupId,
    });
  } catch (e) {
    if (e instanceof GroupMoneyError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

circleWallets.post("/groups/circles", async (c) => {
  const body = z
    .object({
      ...walletBody,
      name: z.string().min(1).max(80),
      contributionUsdc: z.number().positive(),
      every: z.enum(["ten_minutes", "day", "week", "two_weeks", "month"]),
      members: z.array(z.string().min(1).max(120)).min(2).max(20),
      startAt: z.string().datetime().optional(),
    })
    .parse(await c.req.raw.clone().json());
  const { prepareCircle } = await import("../services/groupMoney.js");
  return groupBatch(c, async () => {
    const { record, calls } = await prepareCircle(appUserId(c), body);
    return { calls, groupId: record.id };
  });
});

circleWallets.post("/groups/circles/:id/join", async (c) => {
  const { joinCircleCalls } = await import("../services/groupMoney.js");
  return groupBatch(c, async () => ({
    calls: await joinCircleCalls(appUserId(c), c.req.param("id")),
    groupId: c.req.param("id"),
  }));
});

circleWallets.post("/groups/pots", async (c) => {
  const body = z
    .object({
      ...walletBody,
      title: z.string().min(1).max(120),
      description: z.string().max(600).optional(),
      targetUsdc: z.number().positive(),
      deadline: z.string().datetime(),
      beneficiary: z.string().max(120).optional(),
    })
    .parse(await c.req.raw.clone().json());
  const { preparePot } = await import("../services/groupMoney.js");
  return groupBatch(c, async () => {
    const { record, calls } = preparePot(appUserId(c), body);
    return { calls, groupId: record.id };
  });
});

circleWallets.post("/groups/pots/:id/contribute", async (c) => {
  const body = z
    .object({ ...walletBody, amountUsdc: z.number().positive() })
    .parse(await c.req.raw.clone().json());
  const { contributeCalls } = await import("../services/groupMoney.js");
  return groupBatch(c, async () => ({
    calls: contributeCalls(appUserId(c), c.req.param("id"), body.amountUsdc),
    groupId: c.req.param("id"),
  }));
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

    const fromSymbol = body.from.toUpperCase();
    const fromAddress = (/^0x[a-fA-F0-9]{40}$/.test(body.from)
      ? body.from
      : tokenFor(
          (["USDC", "EURC", "CIRBTC"].includes(fromSymbol)
            ? fromSymbol
            : "USDC") as "USDC" | "EURC" | "CIRBTC",
        )) as `0x${string}`;
    const fromDecimals = body.fromDecimals ?? tokenDecimals(fromSymbol);
    const feeQuote = quotePlatformFee(body.amountIn, fromDecimals);
    const challenges = await createSynthraSwapChallenges({
      userToken: body.userToken,
      walletId: body.walletId,
      approveTo,
      approveData: approveData as `0x${string}`,
      swapTo: plan.transaction.to,
      swapData: plan.transaction.data as `0x${string}`,
      swapValue: plan.transaction.value,
      feeCall: feeTransferCall(fromAddress, feeQuote),
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
      ...(challenges.feeBatched
        ? feeActivityFields(feeQuote, fromSymbol, fromDecimals)
        : {}),
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

/** USDC and EURC use 6 decimals; cirBTC uses 8. */
function tokenDecimals(sym: string) {
  return sym.toUpperCase() === "CIRBTC" ? 8 : 6;
}

/**
 * Sends the GA payments whose PIN the person just confirmed. Runs after the
 * response: a payment is planned again (balances may have moved), then sent,
 * or scheduled when an approval is still becoming final. Each parked payment
 * is released once, so a repeated report cannot send it twice.
 */
async function releaseGatewayPayments(userId: string, challengeIds: string[]) {
  const { releaseConfirmed } = await import("../services/gatewayPinGate.js");
  const { planGatewayPayment, sendGatewayPayment } = await import(
    "../services/gatewayPayFlow.js"
  );
  const { alertUser } = await import("../services/notifyUser.js");
  const { flushPrimaryStore } = await import("../services/primary-store.js");
  for (const p of releaseConfirmed(userId, challengeIds)) {
    try {
      const { plan } = await planGatewayPayment({
        depositor: p.depositor,
        amountUsdc: p.amountUsdc,
        destinationDomain: p.destinationDomain,
        sourceDomain: p.sourceDomain,
      });
      if (plan.missingDomains.length > 0 || plan.confirmingDomains.length > 0) {
        const { scheduleGatewayPay } = await import("../services/gatewayTracker.js");
        scheduleGatewayPay({
          userId,
          depositor: p.depositor,
          amountUsdc: p.amountUsdc,
          destinationDomain: p.destinationDomain,
          destinationAddress: p.destinationAddress,
          sourceDomain: p.sourceDomain,
          waitingFor: [...new Set([...plan.missingDomains, ...plan.confirmingDomains])],
          justApproved: true,
        });
      } else {
        await sendGatewayPayment({
          userId,
          depositor: p.depositor,
          amountUsdc: p.amountUsdc,
          destinationDomain: p.destinationDomain,
          destinationAddress: p.destinationAddress,
          sourceDomain: p.sourceDomain,
          slices: plan.slices,
          enableForwarder: p.enableForwarder,
        });
      }
    } catch (error) {
      alertUser(userId, {
        kind: "ga_payment_failed",
        title: "GA payment not sent",
        body: `${p.amountUsdc} USDC could not be sent (${clientError(error, "it did not go through")}). Check your GA before trying again.`,
        amountUsdc: p.amountUsdc,
        token: "USDC",
      });
    } finally {
      await flushPrimaryStore().catch(() => undefined);
    }
  }
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

  // A PIN that confirms a parked GA payment has no transaction of its own:
  // do not wait for a hash, and release the payment it confirmed.
  const { isParkedChallenge } = await import("../services/gatewayPinGate.js");
  const confirmsGaPayment = body.challengeIds.every(isParkedChallenge);
  if (confirmsGaPayment) {
    const completed = verified.statuses
      .filter((s) => /^COMPLETE/i.test(String(s.status ?? "")))
      .map((s) => String(s.challengeId));
    if (completed.length > 0) void releaseGatewayPayments(appUserId(c), completed);
  }

  let txHash: string | undefined = verified.txHash;
  if (!txHash && body.resolveTxHash && !confirmsGaPayment) {
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
  const { confirmPaymentActivity, recordPeerReceipt } = await import(
    "../services/confirm-payment.js"
  );
  let confirmation;
  try {
    confirmation = await confirmPaymentActivity(uid, row.id, body.txHash);
  } catch {
    return c.json({ ok: false, pending: true, error: "Payment is not yet verified on chain." }, 409);
  }
  if (!confirmation.newlyVerified) return c.json({ ok: true, item: confirmation.row });
  recordPeerReceipt(confirmation.row, body.txHash);
  return c.json({ ok: true, item: store.getActivity(row.id) });
});

/** Most people one payment can go to. Keeps one PIN readable and gas bounded. */
const BATCH_MAX_RECIPIENTS = 10;

/**
 * One payment to several people, approved with one PIN.
 *
 * Arc's batch tutorial uses Multicall3From, which — like Arc's memo contract —
 * requires msg.sender == tx.origin and so reverts for Evabob's smart contract
 * wallets. The wallet batches the transfers itself instead, with its own
 * atomic `executeBatch`: every person is paid or nobody is, which is the
 * promise the confirmation card makes. The platform fee and any memo ride in
 * the same batch.
 *
 * Each person gets their own activity row, joined by `batchId`, and each row
 * is verified against its own Transfer event in the receipt (confirm-batch).
 */
circleWallets.post("/send-batch", async (c) => {
  const body = z
    .object({
      userToken: z.string().min(10),
      walletId: z.string().min(1),
      token: z.enum(["USDC", "EURC"]).optional().default("USDC"),
      payments: z
        .array(
          z.object({
            to: z.string().min(1),
            amount: z.number().positive(),
          }),
        )
        .min(2)
        .max(BATCH_MAX_RECIPIENTS),
      memo: z.string().optional(),
    })
    .parse(await c.req.json());

  if (!config.features.agentBatchSend) {
    return c.json(
      {
        error: "Paying several people at once is not switched on yet. Nothing was sent.",
        code: "BATCH_SEND_DISABLED",
      },
      403,
    );
  }
  const memoCheck = normalizeMemo(body.memo);
  if (!memoCheck.ok) {
    return c.json({ error: memoCheck.error, code: "INVALID_MEMO" }, 400);
  }
  const memo = memoCheck.memo;

  const { resolvePayee } = await import("../services/resolvePayee.js");
  const fromId = appUserId(c);
  const fromUser = store.getUser(fromId);
  const token = body.token;
  const decimals = tokenDecimals(token);
  const tokenAddress = tokenFor(token) as `0x${string}`;

  // Resolve everyone before anything is written, so one bad payee fails the
  // whole request instead of leaving drafts for the people who did resolve.
  const legs: Array<{
    payee: Extract<ReturnType<typeof resolvePayee>, { ok: true }>;
    amount: number;
    quote: ReturnType<typeof quotePlatformFee>;
  }> = [];
  const seen = new Set<string>();
  for (const p of body.payments) {
    const payee = resolvePayee(fromId, p.to.trim());
    if (!payee.ok) {
      return c.json({ error: `${p.to}: ${payee.error}`, code: payee.code }, 404);
    }
    const key = payee.address.toLowerCase();
    // Receipts are verified per recipient address, so two legs to one address
    // could not be told apart. Asking once for the combined amount is clearer.
    if (seen.has(key)) {
      return c.json(
        {
          error: `${payee.label} is in the list twice. Send them one combined amount instead.`,
          code: "DUPLICATE_RECIPIENT",
        },
        400,
      );
    }
    seen.add(key);
    let quote;
    try {
      quote = quotePlatformFee(p.amount, decimals);
    } catch {
      return c.json({ error: `The amount for ${payee.label} is not valid.` }, 400);
    }
    legs.push({ payee, amount: p.amount, quote });
  }

  const senderLabel = fromUser?.handle
    ? `@${fromUser.handle}`
    : fromUser?.displayName || fromUser?.email || fromUser?.evmAddress || fromId;
  const { randomUUID } = await import("node:crypto");
  const batchId = randomUUID();

  try {
    const rows = legs.map((leg) =>
      store.addActivity({
        userId: fromId,
        kind: "send",
        title: leg.payee.label,
        description: `Payment to ${legs.length} people`,
        amountUsdc: token === "USDC" ? -leg.amount : 0,
        counterparty: leg.payee.address,
        sender: senderLabel,
        receiver: leg.payee.label,
        token,
        amountToken: leg.amount,
        ...feeActivityFields(leg.quote, token, decimals),
        mode: "batch",
        status: "pending",
        batchId,
        memo,
      }),
    );

    const transfers = legs.map((leg) =>
      erc20TransferCall(tokenAddress, leg.payee.address, leg.quote.amountUnits),
    );
    const memoCalls = memo
      ? rows.map((row, i) => {
          const memoId = memoIdFor(row.id);
          store.updateActivity(row.id, { memoId });
          return memoRecordCall({
            target: tokenAddress,
            transferData: transfers[i]!.data,
            memoId,
            memo,
          });
        })
      : [];
    const feeUnits = legs.reduce((sum, leg) => sum + leg.quote.feeUnits, 0n);
    const feeRecipient = legs[0]!.quote.recipient;
    const feeCall =
      feeUnits > 0n && feeRecipient
        ? erc20TransferCall(tokenAddress, feeRecipient, feeUnits)
        : null;

    const batch = await createWalletBatchChallenge({
      userToken: body.userToken,
      walletId: body.walletId,
      calls: [
        ...transfers,
        ...(feeCall ? [feeCall] : []),
        ...memoCalls.filter((call): call is NonNullable<typeof call> => call != null),
      ],
    });

    const total = legs.reduce((sum, leg) => sum + leg.quote.amountUnits, 0n);
    return c.json({
      rail: "ucw-batch",
      mode: "batch",
      batchId,
      token,
      total: Number(formatUnits(total, decimals)),
      platformFee: formatUnits(feeUnits, decimals),
      memo,
      memoOnchain: memoCalls.some((call) => call != null),
      legs: rows.map((row, i) => ({
        activityId: row.id,
        to: legs[i]!.payee.address,
        label: legs[i]!.payee.label,
        amount: legs[i]!.amount,
      })),
      appId: circleAppId(),
      challenges: batch.challengeId
        ? [{ step: "transfer", challengeId: batch.challengeId }]
        : [],
      message: `Pay ${legs.length} people — confirm with PIN`,
    });
  } catch (e) {
    return c.json({ error: clientError(e, "batch send failed") }, 400);
  }
});

/**
 * After the batch PIN: verify every row of the batch against the receipt.
 *
 * The batch is atomic on chain, so either every leg verifies or the
 * transaction failed. A row that does not verify yet (an RPC hiccup, a
 * receipt not indexed) stays pending and the call can be repeated — rows
 * already verified are left as they are.
 */
circleWallets.post("/confirm-batch", async (c) => {
  const body = z
    .object({
      batchId: z.string().min(1),
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      /** Agent thread to post the receipt into, when the batch came from chat. */
      threadId: z.string().optional(),
    })
    .parse(await c.req.json());
  const uid = appUserId(c);
  const rows = store.listBatchActivity(uid, body.batchId);
  if (rows.length === 0) return c.json({ error: "Payment not found" }, 404);

  const { confirmPaymentActivity, recordPeerReceipt } = await import(
    "../services/confirm-payment.js"
  );
  const items = [];
  let verified = 0;
  for (const row of rows) {
    try {
      const result = await confirmPaymentActivity(uid, row.id, body.txHash);
      if (result.newlyVerified) recordPeerReceipt(result.row, body.txHash);
      verified++;
      items.push(result.row);
    } catch {
      items.push(store.getActivity(row.id));
    }
  }
  const ok = verified === rows.length;

  if (ok && body.threadId) {
    const thread = store.listThreads().find((t) => t.id === body.threadId);
    if (thread?.members.includes(uid) && !store.findReceiptByTxHash(body.txHash)) {
      const first = rows[0]!;
      const token = first.token || "USDC";
      const total = rows.reduce((sum, r) => sum + (r.amountToken ?? 0), 0);
      const receipt = store.addMessage({
        threadId: thread.id,
        senderId: uid,
        kind: "receipt",
        text: `Sent ${total} ${token} to ${rows.length} people`,
        meta: {
          type: "batch_send",
          batchId: body.batchId,
          amount: Number(total.toFixed(6)),
          amountUsdc: token === "USDC" ? Number(total.toFixed(6)) : 0,
          token,
          memo: first.memo,
          sender: first.sender,
          receiver: rows.map((r) => r.receiver).join(", "),
          recipients: rows.map((r) => ({
            label: r.receiver,
            address: r.counterparty,
            amount: r.amountToken,
          })),
          date: new Date().toISOString(),
          hash: body.txHash,
          txHash: body.txHash,
          mode: "batch",
        },
      });
      try {
        const { pusherTrigger } = await import("../services/pusher.js");
        await pusherTrigger(`private-chat-${thread.id}`, "message", receipt);
      } catch {
        /* optional */
      }
    }
  }

  return c.json(
    {
      ok,
      pending: !ok,
      verified,
      total: rows.length,
      items,
      ...(ok ? {} : { error: "Not every payment is verified on chain yet. Try again shortly." }),
    },
    ok ? 200 : 409,
  );
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

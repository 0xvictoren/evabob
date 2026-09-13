import { Hono } from "hono";
import { z } from "zod";
import {
  buildCctpBurnCalldata,
  cctpBurnFromArc,
  cctpCompleteBridge,
  CCTP_SUPPORTED_MINT_DOMAINS,
  cctpReceiveOnArc,
  cctpReceiveOnDomain,
  fetchCctpAttestation,
} from "../services/cctp.js";
import { store } from "../store/db.js";
import { getUserId } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";

export const cctpRoutes = new Hono();
import { operatorOnly } from "../middleware/authorization.js";
cctpRoutes.use("/burn", operatorOnly);
cctpRoutes.use("/complete", operatorOnly);
cctpRoutes.use("/receive", operatorOnly);

/** Domains product bridge can mint on (ops receiveMessage). */
cctpRoutes.get("/domains", (c) => {
  return c.json({
    sourceDomain: 26,
    sourceName: "Arc Testnet",
    destinations: Object.entries(CCTP_SUPPORTED_MINT_DOMAINS).map(
      ([domain, name]) => ({ domain: Number(domain), name }),
    ),
  });
});

/** The authenticated caller (see middleware/auth.ts). Never trusts headers. */
const uid = getUserId;

cctpRoutes.post("/burn", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int().nonnegative(),
      mintRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      maxFeeUsdc: z.number().nonnegative().optional(),
      /** When true, poll Iris and mint on destination after burn (ops gas). */
      complete: z.boolean().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await cctpBurnFromArc({
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      mintRecipient: body.mintRecipient as `0x${string}`,
      maxFeeUsdc: body.maxFeeUsdc,
    });
    store.addActivity({
      userId: uid(c),
      kind: "bridge",
      title: `Bridge → domain ${body.destinationDomain}`,
      description: `Burn ${body.amountUsdc} USDC on Arc → domain ${body.destinationDomain}`,
      amountUsdc: -body.amountUsdc,
      amountToken: body.amountUsdc,
      token: "USDC",
      sender: "Arc",
      receiver: body.mintRecipient,
      txHash: result.burnTx,
      mode: "cctp_burn",
    });

    if (!body.complete) {
      return c.json(result);
    }

    const mint = await cctpCompleteBridge({
      burnTxHash: result.burnTx,
      destinationDomain: body.destinationDomain,
    });
    if (mint.ok) {
      store.addActivity({
        userId: uid(c),
        kind: "bridge",
        title: `Mint on ${mint.chain}`,
        description: `CCTP mint ${body.amountUsdc} USDC on ${mint.chain}`,
        amountUsdc: 0,
        amountToken: body.amountUsdc,
        token: "USDC",
        sender: "Arc",
        receiver: body.mintRecipient,
        txHash: mint.mintTx,
        mode: "cctp_mint",
      });
    }
    return c.json({ ...result, mint });
  } catch (e) {
    return c.json(
      { error: clientError(e, "burn failed") },
      400,
    );
  }
});

cctpRoutes.get("/attestation", async (c) => {
  const domain = Number(c.req.query("domain") || 26);
  const txHash = c.req.query("txHash");
  if (!txHash) return c.json({ error: "txHash required" }, 400);
  try {
    const data = await fetchCctpAttestation(domain, txHash);
    return c.json(data);
  } catch (e) {
    return c.json(
      { error: clientError(e, "attestation failed") },
      502,
    );
  }
});

/** Complete bridge: poll attestation + mint on destination (default Base Sepolia). */
cctpRoutes.post("/complete", async (c) => {
  const body = z
    .object({
      burnTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      destinationDomain: z.number().int().nonnegative().default(6),
      sourceDomain: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().positive().max(180_000).optional(),
      activityId: z.string().optional(),
    })
    .parse(await c.req.json());
  try {
    const result = await cctpCompleteBridge({
      burnTxHash: body.burnTxHash,
      destinationDomain: body.destinationDomain,
      sourceDomain: body.sourceDomain,
      timeoutMs: body.timeoutMs ?? 120_000,
    });
    if (result.ok) {
      if (body.activityId) {
        const activity = store.getActivity(body.activityId);
        if (!activity || activity.userId !== uid(c)) {
          return c.json({ error: "Activity not found" }, 404);
        }
        store.updateActivity(body.activityId, {
          status: "completed",
          txHash: result.mintTx,
          mode: "cctp_complete",
          description: `CCTP mint complete on ${result.chain}`,
        });
      } else {
        store.addActivity({
          userId: uid(c),
          kind: "bridge",
          title: `Mint on ${result.chain}`,
          description: `CCTP mint complete on ${result.chain}`,
          amountUsdc: 0,
          token: "USDC",
          txHash: result.mintTx,
          mode: "cctp_mint",
          status: "completed",
        });
      }
    }
    return c.json(result, result.ok ? 200 : 502);
  } catch (e) {
    return c.json(
      { error: clientError(e, "complete failed") },
      400,
    );
  }
});

cctpRoutes.post("/receive", async (c) => {
  const body = z
    .object({
      message: z.string().startsWith("0x"),
      attestation: z.string().startsWith("0x"),
      /** CCTP domain to mint on (26 = Arc, 6 = Base Sepolia). Default Arc. */
      destinationDomain: z.number().int().nonnegative().optional(),
    })
    .parse(await c.req.json());
  try {
    const domain = body.destinationDomain ?? 26;
    const result =
      domain === 26
        ? await cctpReceiveOnArc(
            body.message as `0x${string}`,
            body.attestation as `0x${string}`,
          )
        : await cctpReceiveOnDomain({
            destinationDomain: domain,
            message: body.message as `0x${string}`,
            attestation: body.attestation as `0x${string}`,
          });
    store.addActivity({
      userId: uid(c),
      kind: "bridge",
      title: "CCTP mint",
      description: `Received USDC via CCTP on domain ${domain}`,
      amountUsdc: 0,
      token: "USDC",
      txHash: result.mintTx,
      mode: "cctp_mint",
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: clientError(e, "receive failed") },
      400,
    );
  }
});

cctpRoutes.post("/burn-calldata", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int(),
      mintRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    })
    .parse(await c.req.json());
  return c.json(
    buildCctpBurnCalldata({
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      mintRecipient: body.mintRecipient as `0x${string}`,
    }),
  );
});

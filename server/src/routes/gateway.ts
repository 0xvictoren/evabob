import { Hono } from "hono";
import { z } from "zod";
import {
  buildDepositCalldata,
  gatewayDepositArc,
  gatewayWithdrawUsdc,
} from "../services/gateway-e2e.js";
import {
  depositAddressCatalog,
  fetchGatewayBalances,
} from "../services/gateway.js";
import { store } from "../store/db.js";
import { jsonSafe } from "../utils/json-safe.js";
import { getUserId } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";

export const gatewayRoutes = new Hono();
import { operatorOnly } from "../middleware/authorization.js";
gatewayRoutes.use("/deposit", operatorOnly);
gatewayRoutes.use("/withdraw", operatorOnly);

/** The authenticated caller (see middleware/auth.ts). Never trusts headers. */
const uid = getUserId;

gatewayRoutes.get("/balances", async (c) => {
  const depositor = c.req.query("depositor");
  if (!depositor || !/^0x[a-fA-F0-9]{40}$/.test(depositor)) {
    return c.json({ error: "depositor 0x address required" }, 400);
  }
  try {
    const result = await fetchGatewayBalances(depositor as `0x${string}`);
    return c.json(jsonSafe(result));
  } catch (e) {
    return c.json(
      {
        error: clientError(e, "gateway error"),
        balances: [],
        totalUsdc: 0,
      },
      502,
    );
  }
});

gatewayRoutes.get("/deposit-addresses", (c) => {
  const user = store.getUser(uid(c));
  const evm =
    c.req.query("evm") ||
    user?.evmAddress ||
    "0x0000000000000000000000000000000000000000";
  return c.json({
    chains: depositAddressCatalog({ evmAddress: evm }),
    depositNote:
      "EVM testnets only. Prefer in-app Fund (UCW PIN deposit on Arc). Gateway needs approve + deposit().",
  });
});

/**
 * Ops-only: deposit with server PRIVATE_KEY (treasury tests).
 * User deposits must use POST /v1/circle/gateway/deposit (UCW PIN challenges).
 */
gatewayRoutes.post("/deposit", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      ops: z.boolean().optional(),
    })
    .parse(await c.req.json());
  if (!body.ops) {
    return c.json(
      {
        error: "User deposits must use Circle UCW",
        use: "POST /v1/circle/gateway/deposit with userToken + walletId",
      },
      400,
    );
  }
  try {
    const result = await gatewayDepositArc(body.amountUsdc);
    store.addActivity({
      userId: uid(c),
      kind: "fund",
      title: "Gateway deposit (ops)",
      description: `Ops deposited ${body.amountUsdc} USDC`,
      amountUsdc: body.amountUsdc,
      txHash: result.depositTx,
    });
    return c.json(jsonSafe(result));
  } catch (e) {
    return c.json(
      { error: clientError(e, "deposit failed") },
      400,
    );
  }
});

/** Calldata for user-controlled wallet to deposit. */
gatewayRoutes.post("/deposit-calldata", async (c) => {
  const body = z
    .object({ amountUsdc: z.number().positive() })
    .parse(await c.req.json());
  return c.json(jsonSafe(buildDepositCalldata(body.amountUsdc)));
});

/**
 * Ops-only Gateway withdraw (server key as depositor).
 * End users: POST /v1/circle/gateway/pay
 */
gatewayRoutes.post("/withdraw", async (c) => {
  const body = z
    .object({
      amountUsdc: z.number().positive(),
      destinationDomain: z.number().int().nonnegative(),
      destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      sourceDomain: z.number().int().optional(),
      ops: z.boolean().optional(),
    })
    .parse(await c.req.json());
  if (!body.ops) {
    return c.json(
      {
        error: "User Gateway Pay must use Circle UCW path",
        use: "POST /v1/circle/gateway/pay with userToken + walletId",
      },
      400,
    );
  }
  try {
    const result = await gatewayWithdrawUsdc({
      amountUsdc: body.amountUsdc,
      destinationDomain: body.destinationDomain,
      destinationAddress: body.destinationAddress as `0x${string}`,
      sourceDomain: body.sourceDomain,
    });
    store.addActivity({
      userId: uid(c),
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

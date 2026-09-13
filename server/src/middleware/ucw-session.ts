import type { MiddlewareHandler } from "hono";
import { getUserId } from "./auth.js";
import { requireUser } from "./authorization.js";
import { ownsUcwSession } from "../services/ucw-sessions.js";

export const ucwSessionBoundary: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const body = await c.req.raw.clone().json().catch(() => null);
  if (!body || body.userToken === undefined) return next();
  const denied = requireUser(c);
  if (denied) return denied;
  if (typeof body.userToken !== "string" || !await ownsUcwSession(getUserId(c), body.userToken)) {
    return c.json({ error: "Refresh your Circle session before continuing.", code: "UCW_SESSION_EXPIRED" }, 401);
  }
  if (body.walletAddress) {
    const { listUserWallets } = await import("../services/circle-ucw.js");
    const wallets = await listUserWallets(body.userToken);
    if (!wallets.some(w => w.address?.toLowerCase() === String(body.walletAddress).toLowerCase()
      && (!body.walletId || w.id === body.walletId))) {
      return c.json({ error: "wallet_not_owned" }, 403);
    }
  }
  return next();
};

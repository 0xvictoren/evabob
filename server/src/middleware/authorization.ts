import type { Context, MiddlewareHandler } from "hono";
import { getAuth } from "./auth.js";
import { config } from "../config.js";

export function requireUser(c: Context): Response | null {
  const auth = getAuth(c);
  return auth.verified && auth.principal === "user"
    ? null
    : c.json({ error: "verified_user_required" }, 401);
}

export function requireOperator(c: Context): Response | null {
  const denied = requireUser(c);
  if (denied) return denied;
  return config.auth.operatorUserIds.includes(getAuth(c).userId)
    ? null
    : c.json({ error: "operator_required" }, 403);
}

export const userOnly: MiddlewareHandler = async (c, next) => {
  const denied = requireUser(c);
  if (denied) return denied;
  await next();
};

export const operatorOnly: MiddlewareHandler = async (c, next) => {
  const denied = requireOperator(c);
  if (denied) return denied;
  await next();
};

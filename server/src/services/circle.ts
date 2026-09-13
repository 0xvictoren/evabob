import { config } from "../config.js";

/**
 * Thin Circle REST helper.
 * User-controlled wallet challenge flows are multi-step; this module exposes
 * health checks and wallet listing when CIRCLE_API_KEY is present.
 */
export async function circleGet(path: string) {
  if (!config.circle.apiKey) {
    throw new Error("CIRCLE_API_KEY not configured");
  }
  const res = await fetch(`${config.circle.apiBase}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.circle.apiKey}`,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    throw new Error(
      `Circle ${path} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function circleHealth(): Promise<{
  ok: boolean;
  detail: string;
}> {
  if (!config.circle.apiKey) {
    return { ok: false, detail: "CIRCLE_API_KEY missing" };
  }
  try {
    // Lightweight probe — wallets list (may be empty)
    await circleGet("/v1/w3s/wallets?pageSize=1");
    return { ok: true, detail: "Circle Wallets API reachable" };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "Circle probe failed",
    };
  }
}

/**
 * What an error nobody caught should look like to the app.
 *
 * Everything unexpected used to leave as a bare 500 "internal_error", which
 * the app shows as "Something went wrong on our side". Creating a sell link,
 * starting a circle or collection, and paying an invoice all hand work to
 * Circle's wallet service or read the chain first — and when either of those
 * says no, the reason was thrown away. Those are not faults in this server,
 * and most of them have a plain answer the person can act on.
 */

export type UnhandledReply = {
  status: 400 | 401 | 409 | 503 | 500;
  body: { error: string; code?: string };
};

type CircleLike = {
  code?: number | string;
  status?: number;
  response?: { status?: number; data?: { code?: number | string; message?: string } };
  data?: { code?: number | string; message?: string };
};

function circleCode(e: unknown): { code?: string; status?: number } | null {
  if (!e || typeof e !== "object") return null;
  const any = e as CircleLike;
  const code = any.response?.data?.code ?? any.data?.code;
  const status = any.response?.status;
  // Only an HTTP answer from Circle counts — a plain Error with a `code`
  // (ECONNRESET and friends) is a network problem, handled below.
  if (code == null && status == null) return null;
  return { code: code == null ? undefined : String(code), status };
}

/** viem's RPC / contract errors carry a `shortMessage` and a named class. */
function isChainError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const name = e.name || "";
  return (
    "shortMessage" in e ||
    /^(HttpRequest|RpcRequest|Timeout|ContractFunctionExecution|ContractFunctionRevert|CallExecution|InternalRpc|LimitExceededRpc)Error$/.test(
      name,
    )
  );
}

function isNetworkError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)
  );
}

/** Circle's documented user-token failures: the PIN session has run out. */
const CIRCLE_SESSION_CODES = new Set(["155104", "155105", "155108", "156001"]);
/** Circle's "not enough money" family. */
const CIRCLE_FUNDS_CODES = new Set(["155201", "155202", "177003"]);

export function classifyUnhandled(err: unknown, ref: string): UnhandledReply {
  const circle = circleCode(err);
  if (circle) {
    if (
      (circle.code && CIRCLE_SESSION_CODES.has(circle.code)) ||
      circle.status === 401 ||
      circle.status === 403
    ) {
      return {
        status: 401,
        body: {
          error: "Your wallet session expired. Open the app again and retry — nothing was sent.",
          code: "UCW_SESSION_EXPIRED",
        },
      };
    }
    if (circle.code && CIRCLE_FUNDS_CODES.has(circle.code)) {
      return { status: 400, body: { error: "insufficient_balance" } };
    }
    if (circle.status === 429) {
      return {
        status: 503,
        body: { error: "Too many tries just now. Wait a moment and try again.", code: "CIRCLE_BUSY" },
      };
    }
    return {
      status: 409,
      body: {
        error: `Circle could not prepare this just now. Nothing was sent — try again. (Ref ${ref})`,
        code: "CIRCLE_REJECTED",
      },
    };
  }
  if (isChainError(err) || isNetworkError(err)) {
    return {
      status: 503,
      body: {
        error: "The network is busy right now. Nothing was sent — try again in a moment.",
        code: "NETWORK_BUSY",
      },
    };
  }
  return { status: 500, body: { error: "internal_error", code: ref } };
}

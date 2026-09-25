/**
 * Evabob Agent HTTP API.
 *
 * POST /v1/agent/parse     — structured intent only (never executes)
 * POST /v1/agent/message   — chat turn: parse → read-only reply OR confirm card
 *
 * Money never moves here. The client runs existing PIN flows after Confirm.
 */

import { Hono } from "hono";
import { z } from "zod";
import { refineAgentIntent } from "../services/agentLlm.js";
import {
  parseSendIntent,
  toAppKitChain,
  toOnchainToken,
  type AgentIntent,
} from "../services/intentParser.js";
import {
  AGENT_USER_ID,
  ensureAgentThread,
  isAgentThread,
} from "../services/evabobAgent.js";
import { pusherTrigger } from "../services/pusher.js";
import { store } from "../store/db.js";
import { getUserId } from "../middleware/auth.js";
import { clientError } from "../utils/http-error.js";
import { runAgentTurn } from "../services/agentChat.js";
import { config } from "../config.js";

export const agentRoutes = new Hono();

/** The authenticated caller (see middleware/auth.ts). Never trusts headers. */
const userId = getUserId;

/**
 * The text on a confirmation card.
 *
 * This is now the whole card — the model's paraphrase is no longer shown — so
 * it has to be both exact and readable. Exact because it is the last thing
 * someone sees before money moves, readable because "This is CCTP, not
 * Gateway Pay" told a person nothing they could act on.
 */
function confirmCopy(intent: {
  intent: string;
  amount: number | null;
  asset: string;
  chain: string;
  to: string | null;
  toChain?: string;
  fromChain?: string;
  tokenIn?: string;
  tokenOut?: string;
  resolvedLabel?: string;
  resolvedAddress?: string;
  recipients?: string[];
  memo?: string;
}): string {
  const name = (t?: string) =>
    t === "EURC" ? "euros" : t === "CBTC" ? "bitcoin" : "dollars";
  const money = (amount: number, token?: string) => {
    const symbol = token === "EURC" ? "€" : token === "CBTC" ? "₿" : "$";
    return `${symbol}${new Intl.NumberFormat("en", {
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: token === "CBTC" ? 6 : 2,
    }).format(amount)}`;
  };
  const amt =
    intent.amount != null
      ? money(intent.amount, intent.asset)
      : name(intent.asset);
  const who = intent.resolvedLabel || intent.to || null;
  // The address is shown short, as confirmation that the name resolved to
  // something — not as the thing to read.
  const addr = intent.resolvedAddress
    ? ` (${intent.resolvedAddress.slice(0, 8)}…${intent.resolvedAddress.slice(-4)})`
    : "";

  switch (intent.intent) {
    case "send": {
      const memo = intent.memo?.trim() ? `\nMemo: ${intent.memo.trim()}` : "";
      if (intent.recipients && intent.recipients.length > 1) {
        const list = intent.recipients
          .map((a, i) => `${i + 1}. ${a.slice(0, 8)}…${a.slice(-4)}`)
          .join("\n");
        return `Send ${amt} to each of these ${intent.recipients.length} addresses?\n${list}${memo}`;
      }
      return who
        ? `Send ${amt} to ${who}${addr}?${memo}`
        : `Send ${amt} — who should receive it?`;
    }
    case "bridge":
      return intent.toChain
        ? `Move ${amt} from ${intent.fromChain || intent.chain} to ${intent.toChain}?`
        : "Move it to which network — Base or Ethereum?";
    case "buy":
    case "swap":
      return `Change ${
        intent.amount != null
          ? money(intent.amount, intent.tokenIn || "USDC")
          : name(intent.tokenIn || "USDC")
      } into ${name(intent.tokenOut || "EURC")}?`.replace(
        /\s+/g,
        " ",
      );
    case "deposit":
      return `Move ${amt} from ${intent.chain} into your Gateway Account?`;
    case "escrow":
      return who
        ? `Hold ${amt} for ${who}${addr} until you say the work arrived?`
        : `Hold ${amt} — for whom?`;
    case "invoice":
      return `Create a request for ${amt}?`;
    default:
      return `Confirm ${intent.intent}?`;
  }
}

async function replyInThread(opts: {
  threadId: string;
  text: string;
  kind?: "text" | "system" | "receipt";
  meta?: Record<string, unknown>;
}) {
  const msg = store.addMessage({
    threadId: opts.threadId,
    senderId: AGENT_USER_ID,
    kind: opts.kind || "text",
    text: opts.text,
    meta: opts.meta,
  });
  try {
    await pusherTrigger(`private-chat-${opts.threadId}`, "message", msg);
  } catch {
    /* optional */
  }
  return msg;
}

const two = (n: number) =>
  (Math.round((Number.isFinite(n) ? n : 0) * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * "What's my balance" is answered here without the model. It used to read
 * only the unified Gateway balance, so someone whose money sat in their
 * wallet — which is where it all starts — was told about a pot they may not
 * even use. Two reports now, in the order people spend from them: the
 * wallet (Arc), then the Gateway unified balance with its networks under it.
 * Dollars and euros stay separate; euros are never added into a dollar total.
 */
async function formatBalances(uid: string): Promise<string> {
  const user = store.getUser(uid);
  const address = user?.evmAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return "I don't see a wallet on your account yet. Open Profile and finish Circle PIN setup.";
  }
  const [arc, ub] = await Promise.all([
    import("../services/arc-balances.js")
      .then((m) => m.readTokenBalances(address as `0x${string}`))
      .catch(() => null),
    import("../services/appKitMoney.js")
      .then((m) => m.appKitGetBalances({ address, includePending: true }))
      .catch(() => null),
  ]);

  const lines: string[] = [];
  lines.push("Spendable balance");
  if (arc && arc.usdc != null) {
    lines.push(`• Dollars: $${two(arc.usdc)}`);
    if (arc.eurc) lines.push(`• Euros: €${two(arc.eurc)}`);
    if (arc.cirbtc) lines.push(`• Bitcoin: ${arc.cirbtc} CBTC`);
  } else {
    lines.push("• I couldn't read your wallet just now — try again in a moment.");
  }

  lines.push("", "Gateway unified balance");
  if (ub) {
    lines.push(`• Total: $${two(Number(ub.totalUsdc ?? 0))}`);
    if (ub.pendingUsdc) lines.push(`• Still arriving: $${two(Number(ub.pendingUsdc))}`);
    for (const r of (ub.balances || []).slice(0, 8)) {
      const amt = Number(r.balanceUsdc ?? 0);
      if (amt > 0) lines.push(`   – ${r.name || r.chain || "Network"}: $${two(amt)}`);
    }
  } else {
    lines.push("• I couldn't read your unified balance just now.");
  }
  return lines.join("\n");
}

function formatActivity(uid: string): string {
  const items = store.listActivity(uid, 8);
  if (!items.length) return "No recent transactions yet.";
  return [
    "Recent activity:",
    ...items.map((a) => {
      const amt =
        a.amountToken != null
          ? `${a.amountToken} ${a.token || "USDC"}`
          : `${a.amountUsdc} USDC`;
      return `• ${a.title} · ${amt} · ${a.status || "completed"}`;
    }),
  ].join("\n");
}

async function formatInvoices(uid: string): Promise<string> {
  try {
    const { listInvoicesForUser } = await import(
      "../services/payment-requests.js"
    );
    const rows = listInvoicesForUser(uid);
    if (!rows.length) {
      return "No invoices yet. Say “send an invoice for $50” to create one.";
    }
    const open = rows.filter(
      (r) =>
        !["paid", "released", "refunded", "cancelled", "expired"].includes(
          r.invoice.status || "",
        ),
    );
    return (
      `You have ${rows.length} invoice${rows.length === 1 ? "" : "s"} (${open.length} unpaid).\n` +
      rows
        .slice(0, 8)
        .map((r) => {
          const inv = r.invoice;
          const amt = inv.total ?? inv.amount ?? "?";
          return `• ${r.role} ${amt} ${inv.token || "USDC"} · ${inv.status || "open"}`;
        })
        .join("\n")
    );
  } catch (e) {
    return `I couldn't load invoices: ${clientError(e, "error")}`;
  }
}

/**
 * What the agent said before it could call tools.
 *
 * Still the answer whenever the model is unreachable, rate-limited, or returns
 * nothing usable — a degraded reply beats an empty chat bubble, and these
 * three lookups cover the questions people actually ask most.
 */
async function fallbackReply(uid: string, intent: AgentIntent): Promise<string> {
  switch (intent.intent) {
    case "balance":
      return formatBalances(uid);
    case "activity":
      return formatActivity(uid);
    case "invoices":
      return formatInvoices(uid);
    default:
      return (
        intent.reply ||
        intent.clarification ||
        "Could you rephrase that? Payees are @username, email, or 0x."
      );
  }
}

/**
 * Intents that are a question rather than an instruction to move money.
 *
 * These go to the tool-calling agent. Money intents never do: they fall
 * through to the Confirm-card path, so the model has no route to a transfer
 * even if it is confused or steered by a hostile message.
 */
const CONVERSATIONAL: ReadonlySet<AgentIntent["intent"]> = new Set([
  "balance",
  "activity",
  "invoices",
  "help",
  "chat",
  "clarification_needed",
]);

agentRoutes.post("/parse", async (c) => {
  const body = z
    .object({
      message: z.string().min(1),
      peerHandle: z.string().optional(),
      peerAddress: z.string().optional(),
      threadId: z.string().optional(),
      isAgent: z.boolean().optional(),
      mode: z.enum(["send", "agent"]).optional().default("agent"),
    })
    .parse(await c.req.json());
  const ctx = {
    peerHandle: body.peerHandle,
    peerAddress: body.peerAddress,
    threadId: body.threadId,
    isAgent: body.isAgent,
  };
  if (body.mode === "send") {
    return c.json({ intent: parseSendIntent(body.message, ctx) });
  }
  const intent = await refineAgentIntent(body.message, ctx);
  return c.json({
    intent,
    route: {
      appKitChain: toAppKitChain(intent.chain),
      token: toOnchainToken(intent.asset),
    },
  });
});

agentRoutes.get("/thread", (c) => {
  const uid = userId(c);
  const thread = ensureAgentThread(uid);
  return c.json({
    thread: {
      ...store.threadForViewer(thread, uid),
      isAgent: true,
    },
  });
});

agentRoutes.post("/message", async (c) => {
  const body = z
    .object({
      text: z.string().min(1),
      threadId: z.string().optional(),
      history: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        )
        .optional(),
    })
    .parse(await c.req.json());

  const uid = userId(c);
  const thread = body.threadId
    ? store.listThreads().find((t) => t.id === body.threadId)
    : ensureAgentThread(uid);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (!thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (!isAgentThread(thread)) {
    return c.json(
      { error: "This endpoint is only for the evabob Agent thread" },
      400,
    );
  }

  const userMsg = store.addMessage({
    threadId: thread.id,
    senderId: uid,
    kind: "text",
    text: body.text,
  });
  try {
    await pusherTrigger(`private-chat-${thread.id}`, "message", userMsg);
  } catch {
    /* optional */
  }

  // An Evabob link given to the assistant opens as its card — sell with a
  // link, a request, a collection, a task, an agent, a claim — with the action
  // it is for, instead of the assistant guessing at a URL.
  {
    const { findEvabobLinks, cardForLink, sayCard } = await import("../services/evabobLinks.js");
    const cards: Array<Record<string, unknown>> = [];
    for (const link of findEvabobLinks(body.text).slice(0, 3)) {
      const found = await cardForLink(link, uid).catch(() => null);
      if (found) cards.push(found);
    }
    if (cards.length > 0) {
      let agentMsg: unknown = null;
      for (const found of cards) {
        agentMsg = await replyInThread({ threadId: thread.id, text: sayCard(found), meta: found });
      }
      return c.json({ ok: true, userMessage: userMsg, agentMessage: agentMsg });
    }
  }

  const recent = store.messagesFor(thread.id).slice(-10);
  const history =
    body.history ||
    recent.map((m) => ({
      role: (m.senderId === AGENT_USER_ID ? "assistant" : "user") as
        | "user"
        | "assistant",
      content: m.text,
    }));

  const pending = thread.pendingIntent as AgentIntent | undefined;
  const intent = await refineAgentIntent(
    body.text,
    { isAgent: true, threadId: thread.id, pendingIntent: pending },
    history,
  );

  const savePending = (keep: boolean) => {
    store.setThreadPendingIntent(
      thread.id,
      keep ? ({ ...intent } as unknown as Record<string, unknown>) : null,
    );
  };

  const talk = async (text: string, extra?: Record<string, unknown>) => {
    const missingPayee =
      (intent.intent === "send" ||
        intent.intent === "escrow" ||
        intent.intent === "invoice") &&
      !intent.to &&
      !(intent.recipients && intent.recipients.length);
    const missingBridge = intent.intent === "bridge" && !intent.toChain;
    const missingAmt = intent.needsConfirmation && intent.amount == null;
    savePending(
      intent.intent === "clarification_needed" ||
        missingPayee ||
        missingBridge ||
        missingAmt,
    );
    const agentMsg = await replyInThread({
      threadId: thread.id,
      text,
      meta: extra,
    });
    return c.json({ ok: true, intent, userMessage: userMsg, agentMessage: agentMsg });
  };

  // The current client would otherwise execute a multi-recipient instruction
  // as several independent transfers. That can leave a batch half-complete,
  // which is not the atomic Arc Multicall3From flow advertised to the user.
  // Keep it fail-closed until the direct-wallet funding, simulation and receipt
  // verification path is implemented end to end.
  if (
    intent.intent === "send" &&
    intent.recipients &&
    intent.recipients.length > 1 &&
    !config.features.agentBatchSend
  ) {
    savePending(false);
    return talk(
      "Atomic batch sending is not available yet. Please send to one recipient at a time so a partial batch can never be reported as complete.",
    );
  }

  // Every message goes to the tool-calling agent first. It answers questions
  // from the read tools, and for money it calls a propose_ tool, which
  // validates and resolves the action but moves nothing — the card below is
  // what the user approves. When the model is unreachable the deterministic parser
  // below still handles the turn, so a money instruction never depends on the
  // model being up.
  // External AI is explicit opt-in. Undefined and true both stay local.
  const externalAiAllowed = store.getUser(uid)?.aiOptOut === false;
  const turn = externalAiAllowed
    ? await runAgentTurn({
        ctx: { userId: uid },
        message: body.text,
        // Do not disclose earlier chat turns to the processor.
        history: [],
      })
    : { reply: "", toolsUsed: [], answered: false as const };

  if (turn.proposal) {
    const p = turn.proposal;
    savePending(false);
    const card = {
      ...intent,
      intent: p.intent,
      amount: p.amount,
      asset: p.asset,
      chain: p.chain,
      to: p.to ?? null,
      toType: p.toType ?? intent.toType,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fromChain: p.fromChain,
      toChain: p.toChain,
      description: p.description ?? intent.description,
      invoiceId: p.invoiceId,
      needsConfirmation: true,
      recipients: undefined,
      memo: p.memo,
    } as AgentIntent;

    const prompt = confirmCopy({
      ...card,
      resolvedLabel: p.resolvedLabel,
      resolvedAddress: p.resolvedAddress,
    });
    // The card says only what the proposal actually is.
    //
    // The model's own sentence used to lead here, and it got a real payment
    // backwards: "This will request 4 USDC from ekumanzubechi.com" above a
    // card that was sending 4 USDC *to* that person, with the name mangled
    // for good measure. A paraphrase is a nice thing to have and a bad thing
    // to trust, and this is the one screen where being wrong costs money —
    // so the confirmation is built from the resolved proposal alone. The
    // model's prose is kept on the message for debugging, not shown.
    const agentMsg = await replyInThread({
      threadId: thread.id,
      kind: "system",
      text: `${prompt}\nConfirm to continue — I'll ask for your PIN before anything moves.`,
      meta: {
        type: "agent_confirm",
        // Not rendered — kept so a wrong paraphrase can be traced later.
        modelSaid: turn.reply || undefined,
        intent: {
          ...card,
          resolvedLabel: p.resolvedLabel,
          resolvedAddress: p.resolvedAddress,
        },
        route: {
          appKitChain: toAppKitChain(p.fromChain || p.chain),
          toAppKitChain: p.toChain ? toAppKitChain(p.toChain) : undefined,
          token: toOnchainToken(p.asset),
          tokenIn: p.tokenIn ? toOnchainToken(p.tokenIn) : undefined,
          tokenOut: p.tokenOut ? toOnchainToken(p.tokenOut) : undefined,
        },
      },
    });
    return c.json({
      ok: true,
      needsConfirmation: true,
      intent: card,
      userMessage: userMsg,
      agentMessage: agentMsg,
    });
  }

  if (turn.answered) {
    // A clarification keeps a half-finished money intent alive so a short
    // follow-up ("@john", "Ethereum") still merges on the next turn.
    savePending(intent.intent === "clarification_needed");
    const agentMsg = await replyInThread({
      threadId: thread.id,
      text: turn.reply,
      meta: turn.toolsUsed.length ? { toolsUsed: turn.toolsUsed } : undefined,
    });
    return c.json({
      ok: true,
      intent,
      userMessage: userMsg,
      agentMessage: agentMsg,
    });
  }

  // The model was unreachable. Fall back to the deterministic parser: reads and
  // chatter get their pre-tool canned answers, money instructions carry on to
  // the original Confirm-card path below.
  if (CONVERSATIONAL.has(intent.intent)) {
    savePending(intent.intent === "clarification_needed");
    const agentMsg = await replyInThread({
      threadId: thread.id,
      text: await fallbackReply(uid, intent),
    });
    return c.json({
      ok: true,
      intent,
      userMessage: userMsg,
      agentMessage: agentMsg,
    });
  }

  if (
    (intent.intent === "send" ||
      intent.intent === "escrow" ||
      intent.intent === "invoice") &&
    !intent.to &&
    !(intent.recipients && intent.recipients.length)
  ) {
    return talk(
      intent.reply ||
        `Who should this ${intent.intent} go to? Use @username, email, or a 0x address.`,
    );
  }

  if (intent.intent === "bridge" && !intent.toChain) {
    return talk(
      intent.reply ||
        "Bridge to which chain — Base or Ethereum? I will not guess.",
    );
  }

  const { resolvePayee } = await import("../services/resolvePayee.js");
  let resolvedLabel: string | undefined;
  let resolvedAddress: string | undefined;
  if (
    (intent.intent === "send" || intent.intent === "escrow") &&
    intent.recipients &&
    intent.recipients.length > 1
  ) {
    const resolved: string[] = [];
    for (const raw of intent.recipients) {
      const payee = resolvePayee(uid, raw);
      if (!payee.ok) {
        return talk(`Can't send to ${raw}: ${payee.error}`);
      }
      resolved.push(payee.address);
    }
    intent.recipients = resolved;
    intent.to = resolved[0];
    intent.toType = "address";
    resolvedAddress = resolved[0];
    resolvedLabel = `${resolved.length} addresses`;
  } else if (
    (intent.intent === "send" || intent.intent === "escrow") &&
    intent.to
  ) {
    const payee = resolvePayee(uid, intent.to);
    if (!payee.ok) {
      return talk(payee.error);
    }
    resolvedLabel = payee.label;
    resolvedAddress = payee.address;
    intent.to = payee.kind === "handle" ? payee.label : payee.address;
    intent.toType = payee.kind === "address" ? "address" : payee.kind === "email" ? "email" : "handle";
  }

  savePending(false);
  const explained = intent.reply ? `${intent.reply}\n\n` : "";
  const prompt = confirmCopy({
    ...intent,
    resolvedLabel,
    resolvedAddress,
  });
  const agentMsg = await replyInThread({
    threadId: thread.id,
    kind: "system",
    text: `${explained}${prompt}\nConfirm to continue — I'll ask for your PIN before anything moves.`,
    meta: {
      type: "agent_confirm",
      intent: { ...intent, resolvedLabel, resolvedAddress },
      route: {
        appKitChain: toAppKitChain(intent.fromChain || intent.chain),
        toAppKitChain: intent.toChain
          ? toAppKitChain(intent.toChain)
          : undefined,
        token: toOnchainToken(intent.asset),
        tokenIn: intent.tokenIn ? toOnchainToken(intent.tokenIn) : undefined,
        tokenOut: intent.tokenOut ? toOnchainToken(intent.tokenOut) : undefined,
      },
    },
  });

  return c.json({
    ok: true,
    needsConfirmation: true,
    intent,
    userMessage: userMsg,
    agentMessage: agentMsg,
  });
});

/** Claim / finish / release a Confirm card so it cannot run twice. */
agentRoutes.post("/confirm", async (c) => {
  const body = z
    .object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      action: z.enum(["claim", "done", "release"]).optional().default("done"),
    })
    .parse(await c.req.json());

  const uid = userId(c);
  const thread = store.listThreads().find((t) => t.id === body.threadId);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (!thread.members.includes(uid)) {
    return c.json({ error: "Not a member of this chat" }, 403);
  }
  if (!isAgentThread(thread)) {
    return c.json(
      { error: "This endpoint is only for the evabob Agent thread" },
      400,
    );
  }

  const msg = store
    .messagesFor(body.threadId)
    .find((m) => m.id === body.messageId);
  if (!msg) return c.json({ error: "Message not found" }, 404);
  const meta = (msg.meta || {}) as Record<string, unknown>;
  if (meta.type !== "agent_confirm") {
    return c.json({ error: "Not a confirmation card" }, 400);
  }

  const status = String(meta.status || "").toLowerCase();
  const alreadyLocked =
    meta.confirmed === true || status === "executing" || status === "done";

  if (body.action === "claim") {
    if (alreadyLocked) {
      return c.json({ ok: false, already: true, message: msg });
    }
    const updated = store.updateMessageMeta(body.messageId, {
      status: "executing",
      claimedAt: new Date().toISOString(),
    });
    try {
      await pusherTrigger(`private-chat-${body.threadId}`, "message", updated);
    } catch {
      /* optional */
    }
    return c.json({ ok: true, message: updated });
  }

  if (body.action === "release") {
    if (meta.confirmed === true || status === "done") {
      return c.json({ ok: false, already: true, message: msg });
    }
    const updated = store.updateMessageMeta(body.messageId, {
      status: "open",
      claimedAt: null,
    });
    try {
      await pusherTrigger(`private-chat-${body.threadId}`, "message", updated);
    } catch {
      /* optional */
    }
    return c.json({ ok: true, message: updated });
  }

  if (alreadyLocked && body.action === "done" && meta.confirmed === true) {
    return c.json({ ok: false, already: true, message: msg });
  }

  const updated = store.updateMessageMeta(body.messageId, {
    confirmed: true,
    status: "done",
  });
  try {
    await pusherTrigger(`private-chat-${body.threadId}`, "message", updated);
  } catch {
    /* optional */
  }
  return c.json({ ok: true, message: updated });
});

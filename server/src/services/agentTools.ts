/**
 * Read-only tools for the Evabob Agent.
 *
 * The agent used to be a classifier: one model call produced an `intent`
 * string, and the server ran one of three canned lookups (balance, activity,
 * invoices) or replied with a hardcoded help menu. It could not decide to look
 * something up, so it could not answer "did Maya pay me?" or "why is my bridge
 * stuck?".
 *
 * These are the things it may look at. Every tool here is a *read*: nothing in
 * this file moves money, changes a record, or reveals a credential. Writes stay
 * on the Confirm-card path in routes/agent.ts, where a human taps and a PIN
 * challenge runs — the model can propose a payment but can never make one.
 *
 * Two rules hold for every tool and are enforced here rather than in the
 * prompt, because a prompt is a request and this is a boundary:
 *
 *   1. The user is the authenticated caller. Tool arguments cannot name a
 *      user, so a model that is confused, or steered by a hostile message in a
 *      chat thread, still cannot read another account.
 *   2. Nothing returns a secret. Agent wallets report their key *prefix* so a
 *      user can tell two keys apart, never the key or its hash.
 */

import { store } from "../store/db.js";
import { searchKb } from "../knowledge/evabob-kb.js";

export type ToolContext = { userId: string };

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** OpenAI-compatible function schema plus its executor. */
type ReadTool = {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

const NO_ARGS = {
  type: "object" as const,
  properties: {},
  additionalProperties: false as const,
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Two decimals is what a person reads; six is what a ledger stores. */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function requireWallet(ctx: ToolContext): string | null {
  const address = store.getUser(ctx.userId)?.evmAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return address;
}

const NO_WALLET =
  "This account has no wallet yet — the user needs to finish wallet setup in Profile first.";

export const READ_TOOLS: Record<string, ReadTool> = {
  search_help: {
    description:
      "How Evabob works: adding money, sending, requesting, swapping, moving " +
      "between networks, fees, PINs, waiting times, agent wallets, and what " +
      "payment terms mean. Call this for ANY question about how to do " +
      "something in the app or what something means, before answering. Do not " +
      "answer such questions from general knowledge — this app does not work " +
      "like other payment apps.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What the user wants to know, in their own words. For example " +
            "'how do I add money' or 'what is a bridge'.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(_ctx, args) {
      const query = str(args.query);
      if (!query) return { ok: false, error: "Needs something to look up." };
      const hits = searchKb(query, 3);
      if (hits.length === 0) {
        return {
          ok: false,
          error:
            "Nothing in the help content covers that. Say you are not sure " +
            "rather than guessing at how the app behaves.",
        };
      }
      return {
        ok: true,
        data: hits.map((h) => ({ topic: h.title, content: h.body })),
      };
    },
  },

  get_balance: {
    description:
      "The user's money: what is in their wallet on each network, plus their " +
      "GA (the pooled balance they spend from) if they have one. Call this " +
      "before answering anything about how much they have, or whether they " +
      "can afford something.",
    parameters: NO_ARGS,
    async run(ctx) {
      const address = requireWallet(ctx);
      if (!address) return { ok: false, error: NO_WALLET };

      // Wallet first, GA second — and they are genuinely different pots.
      //
      // This tool used to return only the unified Gateway balance and describe
      // it as everything the user had. Someone holding 52.98 USDC in their Arc
      // wallet who had never topped up was told they had nothing, which is
      // both wrong and the most alarming thing a payments app can say.
      const [arc, others] = await Promise.all([
        import("./arc-balances.js").then((m) =>
          m.readTokenBalances(address as `0x${string}`).catch(() => null),
        ),
        import("./arc-balances.js").then((m) =>
          m
            .readMultiChainBalances(address, {
              ids: ["ethereum-sepolia", "base-sepolia"],
            })
            .catch(() => []),
        ),
      ]);

      const wallet: Array<Record<string, unknown>> = [];
      if (arc) {
        const holdings: Record<string, number> = {};
        if (arc.usdc) holdings.USDC = money(arc.usdc);
        if (arc.eurc) holdings.EURC = money(arc.eurc);
        if (arc.cirbtc) holdings.CBTC = arc.cirbtc;
        if (Object.keys(holdings).length) {
          wallet.push({ network: "Arc", ...holdings });
        }
      }
      for (const row of others) {
        const usdc = Number((row as { usdc?: number }).usdc ?? 0);
        if (usdc > 0) {
          wallet.push({ network: (row as { name?: string }).name, USDC: money(usdc) });
        }
      }

      // The GA is a separate pot and is often zero, which is normal rather
      // than a problem — so it is reported alongside, never instead.
      let ga = 0;
      let gaPending = 0;
      try {
        const { appKitGetBalances } = await import("./appKitMoney.js");
        const ub = await appKitGetBalances({ address, includePending: true });
        ga = money(Number(ub.totalUsdc ?? 0));
        gaPending = money(Number(ub.pendingUsdc ?? 0));
      } catch {
        /* the GA is a bonus reading; a wallet total still answers the question */
      }

      if (wallet.length === 0 && ga === 0) {
        return {
          ok: true,
          data: {
            empty: true,
            note: "This account holds no money yet on any network.",
          },
        };
      }

      return {
        ok: true,
        data: {
          wallet,
          ga,
          gaPending,
          note:
            ga === 0 && wallet.length > 0
              ? "Their Gateway Account is empty, but the wallet amounts above are real and spendable. Do not tell them they have nothing."
              : undefined,
        },
      };
    },
  },

  get_activity: {
    description:
      "The user's recent transactions — money in, money out, swaps, bridges, " +
      "top-ups. Use this to answer 'did X pay me', 'what did I spend', or to " +
      "find a specific past transaction.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many to return, 1-25. Defaults to 10.",
        },
        kind: {
          type: "string",
          enum: [
            "send",
            "receive",
            "exchange",
            "fund",
            "withdraw",
            "bridge",
            "escrow",
            "agent",
          ],
          description: "Optional filter to one type of transaction.",
        },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const limit = Math.min(25, Math.max(1, num(args.limit, 10)));
      const kind = str(args.kind);
      let rows = store.listActivity(ctx.userId, 60);
      if (kind) rows = rows.filter((a) => a.kind === kind);
      return {
        ok: true,
        data: rows.slice(0, limit).map((a) => ({
          id: a.id,
          kind: a.kind,
          title: a.title,
          amount: money(a.amountToken ?? a.amountUsdc ?? 0),
          token: a.token || "USDC",
          status: a.status || "completed",
          counterparty: a.counterparty,
          settled: Boolean(a.txHash),
          at: a.createdAt,
        })),
      };
    },
  },

  get_transaction_status: {
    description:
      "Look up one transaction in detail by its id or its blockchain hash, " +
      "including whether it settled and any error. Use this when the user " +
      "asks why something is stuck, pending, or missing.",
    parameters: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description:
            "The transaction id or blockchain hash, as shown in activity.",
        },
      },
      required: ["reference"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const ref = str(args.reference);
      if (!ref) return { ok: false, error: "Needs a transaction id or hash." };
      const needle = ref.toLowerCase();

      const hit = store
        .listActivity(ctx.userId, 200)
        .find(
          (a) =>
            a.id.toLowerCase() === needle ||
            (a.txHash || "").toLowerCase() === needle,
        );
      if (hit) {
        return {
          ok: true,
          data: {
            kind: hit.kind,
            title: hit.title,
            amount: money(hit.amountToken ?? hit.amountUsdc ?? 0),
            token: hit.token || "USDC",
            status: hit.status || "completed",
            settled: Boolean(hit.txHash),
            txHash: hit.txHash,
            mode: hit.mode,
            at: hit.createdAt,
          },
        };
      }

      // Long-running operations live as jobs until they settle into activity,
      // so a "missing" transaction is often a job that never finished.
      try {
        const { listAppKitJobsForUser } = await import("./appKitMoney.js");
        const job = listAppKitJobsForUser(ctx.userId).find(
          (j) => j.id.toLowerCase() === needle,
        );
        if (job) {
          return {
            ok: true,
            data: {
              kind: job.op,
              status: job.status,
              error: job.error,
              pinSteps: job.challenges.length,
              at: job.updatedAt,
            },
          };
        }
      } catch {
        /* jobs are a bonus lookup, not required */
      }
      return { ok: false, error: `No transaction found matching "${ref}".` };
    },
  },

  get_pending_operations: {
    description:
      "Operations that started but have not finished — typically waiting on a " +
      "PIN or still settling. Call this when the user says something did not " +
      "go through, or asks what is outstanding.",
    parameters: NO_ARGS,
    async run(ctx) {
      try {
        const { listAppKitJobsForUser } = await import("./appKitMoney.js");
        const live = listAppKitJobsForUser(ctx.userId)
          .filter((j) => j.status === "running")
          .slice(0, 8)
          .map((j) => ({
            id: j.id,
            operation: j.op,
            pinSteps: j.challenges.length,
            startedAt: j.createdAt,
          }));
        return { ok: true, data: { pending: live, count: live.length } };
      } catch {
        return { ok: false, error: "Could not read pending operations." };
      }
    },
  },

  get_invoices: {
    description:
      "Invoices and payment requests the user has sent or received, with " +
      "whether each is still unpaid.",
    parameters: {
      type: "object",
      properties: {
        only: {
          type: "string",
          enum: ["all", "unpaid", "sent", "received"],
          description: "Which subset to return. Defaults to all.",
        },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const only = str(args.only) || "all";
      try {
        const { listInvoicesForUser } = await import("./payment-requests.js");
        let rows = listInvoicesForUser(ctx.userId);
        const settled = ["paid", "released", "refunded", "cancelled", "expired"];
        if (only === "unpaid") {
          rows = rows.filter((r) => !settled.includes(r.invoice.status || ""));
        } else if (only === "sent" || only === "received") {
          rows = rows.filter((r) => r.role === only);
        }
        return {
          ok: true,
          data: rows.slice(0, 15).map((r) => ({
            id: r.invoice.id,
            role: r.role,
            amount: money(Number(r.invoice.total ?? r.invoice.amount ?? 0)),
            token: r.invoice.token || "USDC",
            status: r.invoice.status || "open",
            description: r.invoice.description,
          })),
        };
      } catch {
        return { ok: false, error: "Could not read invoices." };
      }
    },
  },

  get_payment_request: {
    description:
      "Look up one payment request by its id — the part after evabob://pay/ " +
      "or /pay/ in a link the user pasted or was sent. Returns who asked, " +
      "every line, the total and whether it is still unpaid. Use this " +
      "whenever the user pastes a pay link, then offer propose_pay_invoice " +
      "if it is open. A request can be opened by anyone with its link.",
    parameters: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description: "The request id, or the whole pay link.",
        },
      },
      required: ["requestId"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const raw = str(args.requestId) ?? "";
      const { getPaymentRequest, payLinkIds, invoiceStatusLabel } = await import(
        "./payment-requests.js"
      );
      const id = payLinkIds(raw)[0] ?? raw.trim().toLowerCase();
      const inv = id ? getPaymentRequest(id) : undefined;
      if (!inv) return { ok: false, error: "No payment request with that id." };
      const issuer = store.getUser(inv.senderId || inv.userId);
      return {
        ok: true,
        data: {
          id: inv.id,
          from: issuer?.handle ? `@${issuer.handle}` : issuer?.displayName || "someone",
          raisedByYou: (inv.senderId || inv.userId) === ctx.userId,
          status: invoiceStatusLabel(inv),
          open: inv.status === "open",
          token: inv.token || "USDC",
          total: money(Number(inv.total ?? inv.amount ?? 0)),
          lines: inv.items.map((it) => ({ description: it.description, amount: money(it.amount) })),
          description: inv.description,
          dueAt: inv.dueAt ?? null,
        },
      };
    },
  },

  get_receiving_details: {
    description:
      "The user's own wallet address and handle — what they give someone else " +
      "so that person can pay them.",
    parameters: NO_ARGS,
    async run(ctx) {
      const user = store.getUser(ctx.userId);
      const address = requireWallet(ctx);
      if (!address) return { ok: false, error: NO_WALLET };
      return {
        ok: true,
        data: {
          address,
          handle: user?.handle ? `@${user.handle}` : null,
          email: user?.email ?? null,
          network: "Arc",
          accepts: ["USDC", "EURC"],
        },
      };
    },
  },

  get_contacts: {
    description: "People the user has saved, so they can be named in a payment.",
    parameters: NO_ARGS,
    async run(ctx) {
      const rows = store.listContacts(ctx.userId);
      return {
        ok: true,
        data: rows.slice(0, 30).map((c) => ({
          name: c.name,
          address: c.address,
        })),
      };
    },
  },

  get_agent_wallets: {
    description:
      "The user's separate spending wallets for AI agents (used for automated " +
      "per-request payments). These are NOT this assistant — they are wallets " +
      "the user funds and hands to external software. Never reveal an API key; " +
      "only the short prefix is available.",
    parameters: NO_ARGS,
    async run(ctx) {
      const rows = store.listAgents(ctx.userId);
      return {
        ok: true,
        data: rows.map((a) => ({
          id: a.id,
          label: a.label,
          balance: money(Number(a.balanceUsdc ?? 0)),
          spentToday: money(Number(a.spentTodayUsdc ?? 0)),
          dailyLimit: a.dailyLimitUsdc ?? null,
          keyPrefix: a.apiKeyPrefix ?? null,
          revoked: !a.apiKeyHash,
        })),
      };
    },
  },

  get_profile: {
    description:
      "Who the user is in this app — display name, handle, email, and whether " +
      "their wallet is set up.",
    parameters: NO_ARGS,
    async run(ctx) {
      const user = store.getUser(ctx.userId);
      if (!user) return { ok: false, error: "No profile found." };
      return {
        ok: true,
        data: {
          displayName: user.displayName ?? null,
          handle: user.handle ? `@${user.handle}` : null,
          email: user.email ?? null,
          walletReady: Boolean(
            user.evmAddress && /^0x[a-fA-F0-9]{40}$/.test(user.evmAddress),
          ),
        },
      };
    },
  },
};

/**
 * A money action the model wants the user to approve.
 *
 * Not an instruction to do anything. The propose tools below validate and
 * resolve an action, then hand back one of these; the route turns it into the
 * same Confirm card the deterministic parser has always produced, and the
 * Flutter client runs the PIN flow only after the user taps it. There is no
 * code path from a model deciding something to money leaving an account.
 */
export type Proposal = {
  intent: "send" | "swap" | "bridge" | "deposit" | "invoice" | "escrow";
  amount: number;
  asset: "USDC" | "EURC" | "CBTC";
  chain: "Arc" | "Base" | "Ethereum";
  to?: string;
  toType?: "address" | "email" | "handle";
  resolvedLabel?: string;
  resolvedAddress?: string;
  tokenIn?: "USDC" | "EURC" | "CBTC";
  tokenOut?: "USDC" | "EURC" | "CBTC";
  fromChain?: "Arc" | "Base" | "Ethereum";
  toChain?: "Arc" | "Base" | "Ethereum";
  description?: string;
  /** Optional human-readable payment context, never interpreted as commands. */
  memo?: string;
  /**
   * The invoice this settles, when it settles one.
   *
   * Travels with the card so that once the payment lands the client can
   * close the invoice out. Without it a paid invoice stays open forever and
   * the person who raised it has no way to know they were paid.
   */
  invoiceId?: string;
};

const ASSETS = ["USDC", "EURC", "CBTC"] as const;
const CHAINS = ["Arc", "Base", "Ethereum"] as const;

type Asset = (typeof ASSETS)[number];
type Chain = (typeof CHAINS)[number];

function asset(v: unknown, fallback: Asset = "USDC"): Asset {
  const s = String(v || "").toUpperCase();
  return (ASSETS as readonly string[]).includes(s) ? (s as Asset) : fallback;
}

function chain(v: unknown, fallback: Chain = "Arc"): Chain {
  const s = String(v || "");
  const hit = CHAINS.find((c) => c.toLowerCase() === s.toLowerCase());
  return hit ?? fallback;
}

function amountOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Told to the model after a proposal, so it describes rather than promises.
 *
 * The tense matters more than it looks. Asked to request money, the model
 * replied "I've created a request for $25" — nothing had been created, and a
 * user who believes it will stop waiting for the card and wonder later why no
 * one paid them. Hence the worked example rather than a general instruction.
 */
const PROPOSED =
  "Nothing has happened yet. A confirmation card is now shown to the user; " +
  "it only takes effect when they approve it with their PIN. Describe it in " +
  "one sentence in the future tense. Use the verb that matches the card — paying an invoice is paying, not requesting. Write \"this will send 25 USDC to @maya\", " +
  "never \"I've created a request\" or \"done\" — no past tense, because no " +
  "action has been taken.";

const propose = (proposal: Proposal): ToolResult => ({
  ok: true,
  data: { proposal, note: PROPOSED },
});

const AMOUNT_PARAM = {
  type: "number",
  description: "How much, as a positive number.",
};

export const PROPOSE_TOOLS: Record<string, ReadTool> = {
  propose_send: {
    description:
      "Ask the user to confirm sending money to someone. Use when they say " +
      "something like 'send 10 to @maya'. This does NOT send anything — it " +
      "shows a card they must approve.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        to: {
          type: "string",
          description:
            "The payee: an @handle, an email address, or a 0x wallet address. " +
            "Never a person's display name.",
        },
        asset: {
          type: "string",
          enum: ["USDC", "EURC", "CBTC"],
          description: "What to send. Defaults to USDC.",
        },
        memo: {
          type: "string",
          maxLength: 120,
          description:
            "Optional payment memo supplied by the user, such as 'Rent, second half'.",
        },
      },
      required: ["amount", "to"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      const to = str(args.to);
      if (!to) return { ok: false, error: "Needs a payee." };

      const { resolvePayee } = await import("./resolvePayee.js");
      const payee = resolvePayee(ctx.userId, to);
      if (!payee.ok) return { ok: false, error: payee.error };

      return propose({
        intent: "send",
        amount,
        asset: asset(args.asset),
        chain: "Arc",
        to: payee.kind === "handle" ? payee.label : payee.address,
        // A saved contact resolves to a plain address, so that is what the
        // client is handed — "contact" is how it was looked up, not what it is.
        toType: payee.kind === "contact" ? "address" : payee.kind,
        resolvedLabel: payee.label,
        resolvedAddress: payee.address,
        memo: str(args.memo)?.slice(0, 120),
        description: str(args.memo)?.slice(0, 120),
      });
    },
  },

  propose_swap: {
    description:
      "Ask the user to confirm exchanging one currency for another, for " +
      "example dollars to euros. Shows a card they must approve; exchanges " +
      "nothing by itself.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        from: {
          type: "string",
          enum: ["USDC", "EURC", "CBTC"],
          description: "What they are spending.",
        },
        to: {
          type: "string",
          enum: ["USDC", "EURC", "CBTC"],
          description: "What they want to receive.",
        },
      },
      required: ["amount", "from", "to"],
      additionalProperties: false,
    },
    async run(_ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      const tokenIn = asset(args.from);
      const tokenOut = asset(args.to, "EURC");
      if (tokenIn === tokenOut) {
        return { ok: false, error: "Those are the same currency." };
      }
      return propose({
        intent: "swap",
        amount,
        asset: tokenIn,
        chain: "Arc",
        tokenIn,
        tokenOut,
      });
    },
  },

  propose_bridge: {
    description:
      "Ask the user to confirm moving money from one network to another. " +
      "Both networks must be known — never guess a destination. Shows a card " +
      "they must approve.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        from: {
          type: "string",
          enum: ["Arc", "Base", "Ethereum"],
          description: "Network the money is on now.",
        },
        to: {
          type: "string",
          enum: ["Arc", "Base", "Ethereum"],
          description:
            "Network to move it to. If the user did not say, ask them — do " +
            "not call this tool with a guess.",
        },
      },
      required: ["amount", "from", "to"],
      additionalProperties: false,
    },
    async run(_ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      const fromChain = chain(args.from);
      const toChain = chain(args.to, "Base");
      if (fromChain === toChain) {
        return {
          ok: false,
          error: "Source and destination are the same network.",
        };
      }
      return propose({
        intent: "bridge",
        amount,
        asset: "USDC",
        chain: fromChain,
        fromChain,
        toChain,
      });
    },
  },

  propose_topup: {
    description:
      "Ask the user to confirm moving money from another network into their " +
      "GA — the spendable balance they pay from. Users say 'top up my GA " +
      "with 5 from Base' or just 'top up'. Shows a card they must approve.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        from: {
          type: "string",
          enum: ["Arc", "Base", "Ethereum"],
          description: "Network the money is coming from.",
        },
      },
      required: ["amount"],
      additionalProperties: false,
    },
    async run(_ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      const from = chain(args.from);
      return propose({
        intent: "deposit",
        amount,
        asset: "USDC",
        chain: from,
        fromChain: from,
      });
    },
  },

  propose_pay_invoice: {
    description:
      "Ask the user to confirm paying an invoice or payment request they have " +
      "been given. Takes the invoice id, which is the last part of an " +
      "evabob://pay/... link. Use this whenever someone pastes such a link or " +
      "asks to pay a request — the invoice already records who is owed, so " +
      "never ask them who to send it to.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: {
          type: "string",
          description:
            "The invoice id, e.g. the part after evabob://pay/ in a link.",
        },
      },
      required: ["invoiceId"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const raw = str(args.invoiceId);
      if (!raw) return { ok: false, error: "Needs an invoice id." };
      // Accept a whole link as well as a bare id; people paste what they were
      // given rather than picking the id out of it.
      const id = raw.split("/").pop()!.trim();

      const { getPaymentRequest } = await import("./payment-requests.js");
      const invoice = getPaymentRequest(id);
      if (!invoice) return { ok: false, error: `No invoice found for "${id}".` };

      const settled = ["paid", "released", "refunded", "cancelled", "expired"];
      if (settled.includes(invoice.status || "")) {
        return { ok: false, error: `That invoice is already ${invoice.status}.` };
      }

      // Whoever raised it is the one owed. This is the whole point of the
      // lookup: the assistant used to have an amount and nobody to send it to,
      // so it asked the payer for a recipient they had no way of knowing.
      const issuerId = invoice.senderId || invoice.userId;
      const issuer = store.getUser(issuerId);
      if (!issuer) {
        return { ok: false, error: "Cannot tell who raised that invoice." };
      }
      const payee = issuer.handle
        ? `@${issuer.handle}`
        : issuer.email || issuer.evmAddress;
      if (!payee) {
        return {
          ok: false,
          error: "The person who raised it has no way to be paid yet.",
        };
      }

      const { resolvePayee } = await import("./resolvePayee.js");
      const resolved = resolvePayee(ctx.userId, payee);
      if (!resolved.ok) return { ok: false, error: resolved.error };

      const total = Number(invoice.total ?? invoice.amount ?? 0);
      if (!(total > 0)) return { ok: false, error: "That invoice has no amount." };

      return propose({
        intent: "send",
        amount: total,
        asset: asset(invoice.token),
        chain: "Arc",
        to: resolved.kind === "handle" ? resolved.label : resolved.address,
        toType: resolved.kind === "contact" ? "address" : resolved.kind,
        resolvedLabel: resolved.label,
        resolvedAddress: resolved.address,
        description: invoice.description || "",
        invoiceId: invoice.id,
      });
    },
  },

  propose_escrow: {
    description:
      "Ask the user to confirm holding money for someone until a job is " +
      "delivered. The money leaves their balance now and is released to the " +
      "other person only when the user says the work is done, so it protects " +
      "both sides. Use when paying an invoice for work not yet delivered, or " +
      "when the user asks to hold, lock, or escrow a payment. Shows a card " +
      "they must approve.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        to: {
          type: "string",
          description:
            "Who gets paid on delivery: an @handle, email, or 0x address.",
        },
        description: {
          type: "string",
          description: "What the work is, if the user said.",
        },
      },
      required: ["amount", "to"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      const to = str(args.to);
      if (!to) return { ok: false, error: "Needs someone to hold it for." };

      const { resolvePayee } = await import("./resolvePayee.js");
      const payee = resolvePayee(ctx.userId, to);
      if (!payee.ok) return { ok: false, error: payee.error };

      return propose({
        intent: "escrow",
        amount,
        asset: asset(args.asset),
        chain: "Arc",
        to: payee.kind === "handle" ? payee.label : payee.address,
        toType: payee.kind === "contact" ? "address" : payee.kind,
        resolvedLabel: payee.label,
        resolvedAddress: payee.address,
        description: str(args.description) ?? "",
      });
    },
  },

  propose_request: {
    description:
      "Ask the user to confirm creating a payment request they can send to " +
      "someone who owes them money. Produces a shareable link. Shows a card " +
      "they must approve.",
    parameters: {
      type: "object",
      properties: {
        amount: AMOUNT_PARAM,
        asset: {
          type: "string",
          enum: ["USDC", "EURC"],
          description: "Currency to request. Defaults to USDC.",
        },
        description: {
          type: "string",
          description: "What the request is for, if the user said.",
        },
      },
      required: ["amount"],
      additionalProperties: false,
    },
    async run(_ctx, args) {
      const amount = amountOf(args.amount);
      if (!amount) return { ok: false, error: "Needs a positive amount." };
      return propose({
        intent: "invoice",
        amount,
        asset: asset(args.asset),
        chain: "Arc",
        description: str(args.description) ?? "",
      });
    },
  },
};

/** Function schemas in the OpenAI-compatible shape the model's tools parameter expects. */
export function readToolDefinitions() {
  return Object.entries({ ...READ_TOOLS, ...PROPOSE_TOOLS }).map(
    ([name, tool]) => ({
      type: "function" as const,
      function: {
        name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }),
  );
}

/**
 * Runs one tool the model asked for.
 *
 * `ctx` is built from the verified session by the caller. Note that `args`
 * never carries an identity: an unknown tool name, bad arguments, or a thrown
 * executor all come back as a normal failed result, because the model should
 * get the chance to apologise or try something else rather than have the whole
 * turn collapse.
 */
export async function runReadTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = READ_TOOLS[name] ?? PROPOSE_TOOLS[name];
  if (!tool) return { ok: false, error: `Unknown tool "${name}".` };
  try {
    return await tool.run(ctx, args || {});
  } catch (e) {
    console.warn(
      `[agent-tools] ${name} failed:`,
      e instanceof Error ? e.message : e,
    );
    return { ok: false, error: `Could not complete ${name} right now.` };
  }
}

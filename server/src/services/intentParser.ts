/**
 * Smart intent parser for chat money commands and the Evabob Agent.
 *
 * Deterministic first (strict `@.` + natural language). Never moves funds —
 * callers always get structured JSON with `needsConfirmation: true`.
 */

export type SendChain = "Arc" | "Base" | "Ethereum";
export type SendAsset = "USDC" | "EURC" | "CBTC";
export type ToType =
  | "address"
  | "email"
  | "handle"
  | "thread"
  | null;

export type ThreadContext = {
  peerHandle?: string;
  peerAddress?: string;
  threadId?: string;
  isAgent?: boolean;
  /** Last incomplete money intent on this thread (follow-up merge). */
  pendingIntent?: AgentIntent;
};

export type SendIntent = {
  intent: "send" | "clarification_needed";
  amount: number | null;
  asset: SendAsset;
  chain: SendChain;
  to: string | null;
  toType: ToType;
  confidence: number;
  needsConfirmation: true;
  originalMessage: string;
  clarification?: string;
};

export type AgentIntentName =
  | "send"
  | "bridge"
  | "buy"
  | "swap"
  | "deposit"
  | "escrow"
  | "invoice"
  | "balance"
  | "activity"
  | "help"
  | "invoices"
  | "clarification_needed"
  | "chat";

export type AgentIntent = {
  intent: AgentIntentName;
  amount: number | null;
  asset: SendAsset;
  chain: SendChain;
  to: string | null;
  toType: ToType;
  /** Swap/buy source token (defaults to asset when unused). */
  tokenIn?: SendAsset;
  tokenOut?: SendAsset;
  fromChain?: SendChain;
  toChain?: SendChain;
  description?: string;
  confidence: number;
  needsConfirmation: boolean;
  originalMessage: string;
  clarification?: string;
  /** Short agent-facing reply (help / unclear). */
  reply?: string;
  /** Extra 0x payees when the user listed several addresses. */
  recipients?: string[];
};

const ADDR_RE = /0x[a-fA-F0-9]{6,40}/;
const FULL_ADDR_RE = /0x[a-fA-F0-9]{40}/gi;

export function extractFullAddresses(text: string): string[] {
  const found = text.match(FULL_ADDR_RE) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of found) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /\+\d{7,15}|\b0\d{9,14}\b/;
const HANDLE_RE = /@([a-zA-Z0-9_]{3,24})/;
const CHAIN_NAME_RE = /^(aarc|arc|base|ethereum|eth|sepolia)$/i;

const ASSET_WORD =
  "(?:usdc|eurc|cbtc|cirbtc|eur|usd|btc|dollar|dollars|euro|euros)";
const CHAIN_WORD = "(?:aarc|arc|base|ethereum|eth|sepolia)";

function stripCommandPrefix(raw: string): { text: string; strict: boolean } {
  const trimmed = raw.trim();
  const strict = /^\s*@\./.test(trimmed);
  const text = trimmed.replace(/^\s*@\.\s*/i, "").trim();
  return { text, strict };
}

export function normalizeAsset(raw: string | undefined | null): SendAsset {
  const x = (raw || "").trim().toLowerCase();
  if (
    x === "eurc" ||
    x === "eur" ||
    x === "euro" ||
    x === "euros" ||
    x === "€"
  ) {
    return "EURC";
  }
  if (
    x === "cbtc" ||
    x === "cirbtc" ||
    x === "btc" ||
    x === "bitcoin" ||
    x.includes("bitcoin")
  ) {
    return "CBTC";
  }
  return "USDC";
}

export function normalizeChain(raw: string | undefined | null): SendChain {
  const x = (raw || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (
    x === "base" ||
    x === "base_sepolia" ||
    x === "basesepolia" ||
    x.startsWith("base")
  ) {
    return "Base";
  }
  if (
    x === "eth" ||
    x === "ethereum" ||
    x === "ethereum_sepolia" ||
    x === "sepolia" ||
    x.startsWith("eth")
  ) {
    return "Ethereum";
  }
  return "Arc";
}

/** Display chain → App Kit / Circle chain id. */
export function toAppKitChain(chain: SendChain): string {
  switch (chain) {
    case "Base":
      return "Base_Sepolia";
    case "Ethereum":
      return "Ethereum_Sepolia";
    default:
      return "Arc_Testnet";
  }
}

/** Display asset → on-chain token ticker used by Circle send. */
export function toOnchainToken(asset: SendAsset): "USDC" | "EURC" | "CIRBTC" {
  if (asset === "EURC") return "EURC";
  if (asset === "CBTC") return "CIRBTC";
  return "USDC";
}

function parseAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[$,]/g, "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function classifyRecipient(
  raw: string | undefined | null,
  ctx?: ThreadContext,
): { to: string | null; toType: ToType } {
  if (!raw || !raw.trim()) {
    if (ctx?.peerHandle || ctx?.peerAddress) {
      const peer = ctx.peerAddress || ctx.peerHandle || null;
      if (peer && ADDR_RE.test(peer)) {
        return { to: peer, toType: "address" };
      }
      if (peer) {
        const h = peer.replace(/^@/, "");
        return { to: `@${h}`, toType: "handle" };
      }
    }
    return { to: null, toType: "thread" };
  }
  const t = raw.trim();
  const addr = t.match(ADDR_RE);
  if (addr) {
    const value = addr[0];
    return {
      to: value.length === 42 ? value : value,
      toType: "address",
    };
  }
  const email = t.match(EMAIL_RE);
  if (email) return { to: email[0], toType: "email" };
  if (PHONE_RE.test(t.replace(/[\s()-]/g, ""))) {
    return { to: t, toType: null };
  }
  if (CHAIN_NAME_RE.test(t)) {
    return { to: t, toType: null };
  }
  const handle = t.match(HANDLE_RE);
  if (handle) return { to: `@${handle[1]}`, toType: "handle" };
  const bare = t.replace(/^@/, "").replace(/[^\w.]/g, "");
  if (bare.length >= 2 && bare.length <= 32 && /[a-zA-Z]/.test(bare)) {
    return { to: `@${bare.toLowerCase()}`, toType: "handle" };
  }
  return { to: t, toType: null };
}

function extractFromTo(text: string): {
  fromChain?: string;
  toRaw?: string;
  rest: string;
} {
  let rest = text;
  let fromChain: string | undefined;
  let toRaw: string | undefined;

  const fromMatch = rest.match(
    new RegExp(`\\bfrom\\s+(${CHAIN_WORD})\\b`, "i"),
  );
  if (fromMatch) {
    fromChain = fromMatch[1];
    rest = rest.replace(fromMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  const toMatch = rest.match(
    /\bto\s+(\S+(?:\s+\S+)?)/i,
  );
  if (toMatch) {
    // Stop at trailing "from <chain>" if still present after to.
    toRaw = toMatch[1]
      .replace(new RegExp(`\\s+from\\s+${CHAIN_WORD}\\s*$`, "i"), "")
      .trim();
    rest = rest.replace(toMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  return { fromChain, toRaw, rest };
}

function looksLikeSend(text: string, strict: boolean): boolean {
  const t = text.toLowerCase();
  if (strict && /\bsend\b/.test(t)) return true;
  if (/^\s*send\b/.test(t)) return true;
  if (/\bsend\s+\$?\s*[\d,]/.test(t)) return true;
  if (/\b(please\s+)?(send|transfer|pay)\s+\$?\s*[\d,]/.test(t)) return true;
  return false;
}

/**
 * Parse a send intent from `@.` commands or natural language.
 * Never executes a transfer — always `needsConfirmation: true`.
 */
export function parseSendIntent(
  message: string,
  threadContext?: ThreadContext,
): SendIntent {
  const originalMessage = message;
  const { text, strict } = stripCommandPrefix(message);

  const unclear = (
    confidence: number,
    clarification: string,
    partial?: Partial<SendIntent>,
  ): SendIntent => ({
    intent: "clarification_needed",
    amount: partial?.amount ?? null,
    asset: partial?.asset ?? "USDC",
    chain: partial?.chain ?? "Arc",
    to: partial?.to ?? null,
    toType: partial?.toType ?? (threadContext ? "thread" : null),
    confidence,
    needsConfirmation: true,
    originalMessage,
    clarification,
  });

  if (!looksLikeSend(text, strict) && !strict) {
    return unclear(
      0.15,
      "I didn't detect a send. Try: send 5 USDC to @handle",
    );
  }

  if (strict && !/\bsend\b/i.test(text)) {
    return unclear(
      0.2,
      "That's an @. command but not a send. Try: @. send 5 USDC",
    );
  }

  const { fromChain, toRaw, rest } = extractFromTo(text);

  const sendRe = new RegExp(
    `\\bsend\\s+\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD}|\\$)?`,
    "i",
  );
  const m = rest.match(sendRe) || text.match(sendRe);
  const amount = parseAmount(m?.[1]);
  const asset = normalizeAsset(m?.[2] || "USDC");
  const chain = normalizeChain(fromChain);

  const recipient = classifyRecipient(toRaw, threadContext);

  if (toRaw && CHAIN_NAME_RE.test(toRaw.trim())) {
    return unclear(
      0.4,
      `I can't send to a chain. Did you mean to bridge to ${normalizeChain(toRaw)}, or send to @username / email / 0x?`,
      { amount, asset, chain },
    );
  }

  if (toRaw && PHONE_RE.test(toRaw.replace(/[\s()-]/g, ""))) {
    return unclear(
      0.3,
      "Phone numbers aren't payees. Use @username, email, or a 0x address.",
      { amount, asset, chain },
    );
  }

  if (amount == null) {
    return unclear(0.35, "How much should I send, and in which asset?", {
      asset,
      chain,
      to: recipient.to,
      toType: recipient.toType,
    });
  }

  // Incomplete 0x address → ask to paste the full one.
  if (recipient.toType === "address" && recipient.to && recipient.to.length !== 42) {
    return unclear(
      0.55,
      "That looks like an address but it isn't 42 characters. Paste the full 0x address.",
      { amount, asset, chain, to: recipient.to, toType: "address" },
    );
  }

  const confidence = strict
    ? 0.95
    : recipient.toType === "thread"
      ? 0.82
      : 0.9;

  return {
    intent: "send",
    amount,
    asset,
    chain,
    to: recipient.to,
    toType: recipient.toType,
    confidence,
    needsConfirmation: true,
    originalMessage,
  };
}

function parseBridge(text: string, originalMessage: string): AgentIntent | null {
  if (!/\bbridge\b/i.test(text)) return null;

  const amountMatch = text.match(
    new RegExp(
      `\\bbridge\\s+\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD})?`,
      "i",
    ),
  );
  const fromMatch = text.match(new RegExp(`\\bfrom\\s+(${CHAIN_WORD})\\b`, "i"));
  const toMatch = text.match(
    new RegExp(`\\b(?:to|onto)\\s+(${CHAIN_WORD})\\b`, "i"),
  );
  const amount = parseAmount(amountMatch?.[1]);
  const asset = normalizeAsset(amountMatch?.[2] || "USDC");
  const fromChain = fromMatch ? normalizeChain(fromMatch[1]) : "Arc";
  const toChain = toMatch ? normalizeChain(toMatch[1]) : undefined;

  if (asset !== "USDC") {
    return {
      intent: "clarification_needed",
      amount,
      asset,
      chain: fromChain,
      fromChain,
      toChain,
      to: null,
      toType: null,
      confidence: 0.7,
      needsConfirmation: false,
      originalMessage,
      clarification:
        "Bridge is USDC-only (CCTP). EURC/CBTC stay on Arc — swap to USDC first, then bridge.",
      reply:
        "I can't bridge EURC or CBTC. Circle CCTP moves USDC only. Swap to USDC on Arc, then bridge.",
    };
  }

  if (!toChain) {
    return {
      intent: "clarification_needed",
      amount,
      asset: "USDC",
      chain: fromChain,
      fromChain,
      to: null,
      toType: null,
      confidence: 0.45,
      needsConfirmation: true,
      originalMessage,
      clarification:
        "Bridge to which chain — Arc, Base, or Ethereum? I won't guess a destination.",
    };
  }

  if (amount == null) {
    return {
      intent: "clarification_needed",
      amount: null,
      asset: "USDC",
      chain: fromChain,
      fromChain,
      toChain,
      to: null,
      toType: null,
      confidence: 0.4,
      needsConfirmation: true,
      originalMessage,
      clarification: `How much USDC should I bridge from ${fromChain} to ${toChain}?`,
    };
  }

  return {
    intent: "bridge",
    amount,
    asset: "USDC",
    chain: fromChain,
    fromChain,
    toChain,
    to: null,
    toType: null,
    confidence: 0.93,
    needsConfirmation: true,
    originalMessage,
  };
}

function parseBuySwap(text: string, originalMessage: string): AgentIntent | null {
  // "buy 100 USDC with EURC" → spend EURC, get USDC
  const buyWith = text.match(
    new RegExp(
      `\\bbuy\\s+([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD})\\s+(?:with|using|for)\\s+(${ASSET_WORD})`,
      "i",
    ),
  );
  if (buyWith) {
    const amount = parseAmount(buyWith[1]);
    const tokenOut = normalizeAsset(buyWith[2]);
    const tokenIn = normalizeAsset(buyWith[3]);
    return {
      intent: "buy",
      amount,
      asset: tokenOut,
      chain: "Arc",
      tokenIn,
      tokenOut,
      to: null,
      toType: null,
      confidence: amount ? 0.92 : 0.4,
      needsConfirmation: true,
      originalMessage,
      clarification: amount ? undefined : "How much should I buy?",
    };
  }

  const swap = text.match(
    new RegExp(
      `\\b(?:swap|buy|exchange|convert)\\s+([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD})?(?:\\s+(?:to|for|->|→)\\s*(${ASSET_WORD}))?`,
      "i",
    ),
  );
  if (!swap) return null;
  const amount = parseAmount(swap[1]);
  const tokenIn = normalizeAsset(swap[2] || "USDC");
  const tokenOut = normalizeAsset(swap[3] || (tokenIn === "USDC" ? "EURC" : "USDC"));
  const isBuy = /\bbuy\b/i.test(text);
  return {
    intent: isBuy ? "buy" : "swap",
    amount,
    asset: tokenOut,
    chain: "Arc",
    tokenIn,
    tokenOut,
    to: null,
    toType: null,
    confidence: amount ? 0.9 : 0.4,
    needsConfirmation: true,
    originalMessage,
    clarification: amount ? undefined : "How much should I swap?",
  };
}

function parseDeposit(text: string, originalMessage: string): AgentIntent | null {
  const m = text.match(
    new RegExp(
      `\\bdeposit\\s+([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD})?(?:\\s+from\\s+(${CHAIN_WORD}))?`,
      "i",
    ),
  );
  if (!m) return null;
  const amount = parseAmount(m[1]);
  return {
    intent: "deposit",
    amount,
    asset: "USDC",
    chain: normalizeChain(m[3] || "Arc"),
    fromChain: normalizeChain(m[3] || "Arc"),
    to: null,
    toType: null,
    confidence: amount ? 0.9 : 0.4,
    needsConfirmation: true,
    originalMessage,
  };
}

function parseInvoice(text: string, originalMessage: string): AgentIntent | null {
  if (
    !/\b(invoice|payment request|request payment|bill)\b/i.test(text)
  ) {
    return null;
  }
  const amt = text.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(usdc|eurc|cbtc|usd)?/i);
  const amount = parseAmount(amt?.[1]);
  const asset = normalizeAsset(amt?.[2] || "USDC");
  const descMatch = text.match(
    /\b(?:for|desc|description|memo)\s+(.+)$/i,
  );
  return {
    intent: "invoice",
    amount,
    asset,
    chain: "Arc",
    to: null,
    toType: "thread",
    description: descMatch?.[1]?.trim(),
    confidence: amount ? 0.88 : 0.45,
    needsConfirmation: true,
    originalMessage,
    clarification: amount
      ? undefined
      : "What amount should the invoice be for?",
  };
}

function parseEscrow(text: string, originalMessage: string): AgentIntent | null {
  if (!/\bescrow\b/i.test(text)) return null;
  const amt = text.match(
    new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*(${ASSET_WORD})?`, "i"),
  );
  const amount = parseAmount(amt?.[1]);
  const { toRaw } = extractFromTo(text);
  const recipient = classifyRecipient(toRaw);
  const descMatch = text.match(/\b(?:for|job|memo)\s+(.+)$/i);
  return {
    intent: "escrow",
    amount,
    asset: normalizeAsset(amt?.[2] || "USDC"),
    chain: "Arc",
    to: recipient.to,
    toType: recipient.toType === "thread" ? "thread" : recipient.toType,
    description: descMatch?.[1]?.trim(),
    confidence: amount ? 0.86 : 0.42,
    needsConfirmation: true,
    originalMessage,
    clarification: amount
      ? undefined
      : "How much should I lock in escrow, and for whom?",
  };
}

function parseReadOnly(text: string, originalMessage: string): AgentIntent | null {
  const t = text.toLowerCase();
  if (
    /\b(balance|how much|what do i have|funds|wallet)\b/.test(t) &&
    !/\bsend\b|\bbridge\b|\bbuy\b|\bswap\b/.test(t)
  ) {
    return {
      intent: "balance",
      amount: null,
      asset: "USDC",
      chain: "Arc",
      to: null,
      toType: null,
      confidence: 0.94,
      needsConfirmation: false,
      originalMessage,
    };
  }
  if (
    /\b(activity|transactions?|history|recent|receipts?)\b/.test(t)
  ) {
    return {
      intent: "activity",
      amount: null,
      asset: "USDC",
      chain: "Arc",
      to: null,
      toType: null,
      confidence: 0.92,
      needsConfirmation: false,
      originalMessage,
    };
  }
  if (
    /\b(invoices?|payment requests?)\b/.test(t) &&
    !/\bsend\b|\bcreate\b|\bnew\b/.test(t)
  ) {
    return {
      intent: "invoices",
      amount: null,
      asset: "USDC",
      chain: "Arc",
      to: null,
      toType: null,
      confidence: 0.9,
      needsConfirmation: false,
      originalMessage,
    };
  }
  if (
    /^(hi|hello|hey|yo)\b/.test(t) ||
    /\b(help|what can you (help me )?do|how can you help|what do you do|commands?)\b/.test(
      t,
    )
  ) {
    return {
      intent: "help",
      amount: null,
      asset: "USDC",
      chain: "Arc",
      to: null,
      toType: null,
      confidence: 0.9,
      needsConfirmation: false,
      originalMessage,
      reply: helpText(),
    };
  }
  return null;
}

/**
 * What the assistant says when someone asks what it can do.
 *
 * This used to read "I can send, bridge, swap, invoice, escrow, and check
 * balances" — a list of the app's internal verbs, three of which mean nothing
 * to someone who is not a crypto user, offered as the very first thing a new
 * person sees in their chat list. The brief calls it out by name.
 *
 * Written as things a person wants to do, in the order they are likely to want
 * them.
 */
export function helpText(): string {
  return [
    "I can help you move your money — just ask in your own words.",
    "Try:",
    "• Send 25 to @john",
    "• How much do I have?",
    "• Change 50 dollars into euros",
    "• Ask Maya for 20",
    "• Why hasn't my payment arrived?",
    "I'll always show you what I'm about to do, and you approve it with your PIN.",
  ].join("\n");
}

/**
 * Full agent parser: send / bridge / swap / escrow / invoice / reads.
 * Money intents never auto-execute.
 */
export function parseAgentIntent(
  message: string,
  threadContext?: ThreadContext,
): AgentIntent {
  const originalMessage = message;
  const { text, strict } = stripCommandPrefix(message);
  const addrs = extractFullAddresses(originalMessage);

  const read = parseReadOnly(text, originalMessage);
  if (read) return read;

  const bridge = parseBridge(text, originalMessage);
  if (bridge) return bridge;

  const deposit = parseDeposit(text, originalMessage);
  if (deposit) return deposit;

  const buy = parseBuySwap(text, originalMessage);
  if (buy) return buy;

  const invoice = parseInvoice(text, originalMessage);
  if (invoice) return invoice;

  const escrow = parseEscrow(text, originalMessage);
  if (escrow) return escrow;

  if (
    addrs.length >= 2 &&
    (looksLikeSend(text, strict) ||
      /\b(each|these addresses|split|all of)\b/i.test(text))
  ) {
    const send = parseSendIntent(message, threadContext);
    return {
      intent: send.amount ? "send" : "clarification_needed",
      amount: send.amount,
      asset: send.asset,
      chain: send.chain,
      to: addrs[0],
      toType: "address",
      recipients: addrs,
      confidence: send.amount ? 0.9 : 0.4,
      needsConfirmation: true,
      originalMessage,
      clarification: send.amount
        ? `Send ${send.amount} ${send.asset} to each of ${addrs.length} addresses.`
        : "How much should I send to each of those addresses?",
    };
  }

  if (looksLikeSend(text, strict) || (strict && /\bsend\b/i.test(text))) {
    const send = parseSendIntent(message, threadContext);
    const to = addrs[0] || send.to;
    const toType = addrs[0] ? "address" : send.toType;
    return {
      intent: send.intent === "send" ? "send" : "clarification_needed",
      amount: send.amount,
      asset: send.asset,
      chain: send.chain,
      to,
      toType,
      recipients: addrs.length > 1 ? addrs : undefined,
      confidence: send.confidence,
      needsConfirmation: true,
      originalMessage,
      clarification: send.clarification,
    };
  }

  return {
    intent: "clarification_needed",
    amount: null,
    asset: "USDC",
    chain: "Arc",
    to: null,
    toType: null,
    confidence: 0.25,
    needsConfirmation: false,
    originalMessage,
    clarification:
      "I didn't catch that. " +
      "You can send, bridge, swap, invoice, escrow, or ask for balances.",
    reply: helpText(),
  };
}

/** True when a peer-chat message should be treated as a money send. */
export function looksLikeSendIntent(message: string): boolean {
  const { text, strict } = stripCommandPrefix(message);
  return looksLikeSend(text, strict);
}

const MONEY_INTENTS: AgentIntentName[] = [
  "send",
  "bridge",
  "buy",
  "swap",
  "deposit",
  "escrow",
  "invoice",
];

function isMoneyOrPending(intent: AgentIntent): boolean {
  return (
    intent.intent === "clarification_needed" ||
    MONEY_INTENTS.includes(intent.intent)
  );
}

/** Short answers that fill a missing field on the last money ask. */
export function looksLikeFollowUpFragment(message: string): boolean {
  const { text } = stripCommandPrefix(message);
  const t = text.trim();
  if (!t || t.length > 80) return false;
  const words = t.split(/\s+/);
  if (
    /\b(send|bridge|swap|buy|deposit|escrow|invoice|balance|activity|help)\b/i.test(
      t,
    ) &&
    words.length > 3
  ) {
    return false;
  }
  if (extractFullAddresses(t).length) return true;
  if (/^\$?\s*[\d,]+(?:\.\d+)?\s*(?:usdc|eurc|cbtc|usd|eur|\$)?$/i.test(t)) {
    return true;
  }
  if (new RegExp(`^(${ASSET_WORD}|\\$)$`, "i").test(t)) return true;
  if (CHAIN_NAME_RE.test(t)) return true;
  if (EMAIL_RE.test(t)) return true;
  if (/^@?[a-z0-9_]{3,24}$/i.test(t) && words.length === 1) return true;
  return words.length <= 3;
}

export function shouldMergeFollowUp(
  message: string,
  current: AgentIntent,
  pending: AgentIntent | undefined | null,
): boolean {
  if (!pending || !isMoneyOrPending(pending)) return false;
  if (
    current.confidence >= 0.75 &&
    current.intent !== "clarification_needed" &&
    current.intent !== "chat"
  ) {
    return false;
  }
  return looksLikeFollowUpFragment(message);
}

/**
 * Merge a short follow-up ("usdc", "5", "@john", "Ethereum") into the last
 * incomplete money intent. Deterministic — does not call an LLM.
 */
export function mergeFollowUp(prev: AgentIntent, message: string): AgentIntent {
  const { text } = stripCommandPrefix(message);
  const t = text.trim();
  const next: AgentIntent = {
    ...prev,
    originalMessage: `${prev.originalMessage} | ${message}`,
    reply: undefined,
  };

  const addrs = extractFullAddresses(t);
  if (addrs.length >= 1) {
    next.to = addrs[0];
    next.toType = "address";
    if (addrs.length > 1) next.recipients = addrs;
  }

  if (/^\$?\s*[\d,]+/.test(t)) {
    const n = parseAmount(t.match(/\$?\s*([\d,]+(?:\.\d+)?)/)?.[1]);
    if (n) next.amount = n;
  }

  const assetMatch = t.match(new RegExp(`\\b(${ASSET_WORD}|\\$)\\b`, "i"));
  if (assetMatch) {
    next.asset = normalizeAsset(assetMatch[1]);
    if (prev.intent === "swap" || prev.intent === "buy") {
      next.tokenIn = next.asset;
    }
  }

  const chainMatch = t.match(new RegExp(`\\b(${CHAIN_WORD})\\b`, "i"));
  if (chainMatch) {
    const c = normalizeChain(chainMatch[1]);
    const prevWasBridge =
      prev.intent === "bridge" || /\bbridge\b/i.test(prev.originalMessage);
    if (prevWasBridge) {
      if (!next.toChain) next.toChain = c;
      else next.fromChain = next.fromChain || c;
    } else {
      next.chain = c;
    }
  }

  if (!addrs.length) {
    const email = t.match(EMAIL_RE);
    if (email) {
      next.to = email[0];
      next.toType = "email";
    } else {
      const h = t.match(/^@?([a-z0-9_]{3,24})$/i);
      if (
        h &&
        !CHAIN_NAME_RE.test(t) &&
        !new RegExp(`^(${ASSET_WORD}|\\$)$`, "i").test(t)
      ) {
        next.to = `@${h[1]}`;
        next.toType = "handle";
      }
    }
  }

  const prevWasBridge =
    prev.intent === "bridge" || /\bbridge\b/i.test(prev.originalMessage);

  if (next.intent === "clarification_needed") {
    if (prevWasBridge) {
      if (next.amount && next.toChain) {
        next.intent = "bridge";
        next.needsConfirmation = true;
        next.confidence = 0.88;
        next.clarification = undefined;
      }
    } else if (next.amount && (next.to || (next.recipients && next.recipients.length))) {
      next.intent = "send";
      next.needsConfirmation = true;
      next.confidence = 0.88;
      next.clarification = undefined;
    } else if (next.amount && !next.to) {
      next.clarification = "Who should receive it? Use @username, email, or 0x.";
      next.confidence = 0.5;
    } else if (next.to && next.amount == null) {
      next.clarification = "How much should I send, and in which asset?";
      next.confidence = 0.5;
    }
  } else if (next.intent === "send") {
    if (next.amount && (next.to || (next.recipients && next.recipients.length))) {
      next.confidence = Math.max(next.confidence, 0.88);
      next.clarification = undefined;
      next.needsConfirmation = true;
    } else if (next.amount == null) {
      next.intent = "clarification_needed";
      next.clarification = "How much should I send, and in which asset?";
      next.confidence = 0.5;
    } else if (!next.to && !(next.recipients && next.recipients.length)) {
      next.intent = "clarification_needed";
      next.clarification = "Who should receive it? Use @username, email, or 0x.";
      next.confidence = 0.5;
    }
  } else if (next.intent === "bridge") {
    if (next.asset && next.asset !== "USDC") {
      next.intent = "clarification_needed";
      next.needsConfirmation = false;
      next.clarification =
        "Bridge is USDC-only (CCTP). EURC/CBTC stay on Arc — swap to USDC first, then bridge.";
      next.reply =
        "I can't bridge EURC or CBTC. Circle CCTP moves USDC only. Swap to USDC on Arc, then bridge.";
      next.confidence = 0.7;
    } else if (next.amount && next.toChain) {
      next.confidence = Math.max(next.confidence, 0.88);
      next.clarification = undefined;
      next.needsConfirmation = true;
    } else if (!next.toChain) {
      next.intent = "clarification_needed";
      next.clarification =
        "Bridge to which chain — Arc, Base, or Ethereum? I won't guess a destination.";
      next.confidence = 0.45;
    }
  }

  return next;
}

/** Previous user money ask in chat history (skip the current message). */
export function pendingIntentFromHistory(
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  currentMessage: string,
  threadContext?: ThreadContext,
): AgentIntent | undefined {
  if (threadContext?.pendingIntent) return threadContext.pendingIntent;
  if (!history?.length) return undefined;
  const users = history.filter(
    (h) =>
      h.role === "user" &&
      h.content.trim() &&
      h.content.trim() !== currentMessage.trim(),
  );
  for (let i = users.length - 1; i >= 0; i--) {
    const parsed = parseAgentIntent(users[i].content, threadContext);
    if (!isMoneyOrPending(parsed)) continue;
    if (
      parsed.intent === "clarification_needed" &&
      parsed.amount == null &&
      !parsed.to &&
      !parsed.toChain
    ) {
      continue;
    }
    return parsed;
  }
  return undefined;
}

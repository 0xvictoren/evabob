/**
 * The agent allowance: the shape people already use for pocket money.
 *
 * "$20 this week, research services only" is three things — an amount, a
 * window, and a list of what it may be spent on. On top of that, the owner's
 * own limit decides how loudly a payment happens:
 *
 *   at or below the owner's limit   → goes through silently
 *   above it, within the allowance  → a push asks the owner first
 *   beyond what is left this window → refused, whatever anyone says
 *
 * And a loop breaker. Every runaway agent bill in the developer post-mortems
 * was the same shape: software calling one endpoint over and over in a
 * short window. More than LOOP_LIMIT calls to one endpoint inside
 * LOOP_WINDOW_MS pauses the agent until its owner resumes it.
 *
 * Everything here is pure except the in-memory call log, so the rules can be
 * tested without a store. The store keeps the balance and the history; this
 * file only reads them.
 */

import type { AgentWallet } from "../store/db.js";

export type AllowanceWindow = "day" | "week" | "month";

export type Allowance = {
  amountUsdc: number;
  window: AllowanceWindow;
  /** Empty means anything on the approved list. */
  categories: string[];
  askAboveUsdc: number;
  proofOnly: boolean;
};

/** More calls than this to one endpoint inside the window pauses the agent. */
export const LOOP_LIMIT = 5;
export const LOOP_WINDOW_MS = 60_000;
/** An owner who has not answered by then has said no. */
export const APPROVAL_TTL_MS = 30 * 60_000;

/** What sellers are grouped into. Categories from Circle's catalog map here. */
export const SPEND_CATEGORIES = [
  "research",
  "data",
  "media",
  "ai",
  "finance",
  "people",
  "tools",
] as const;

export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

const CATEGORY_WORDS: Array<[SpendCategory, RegExp]> = [
  ["research", /research|search|news|knowledge|academic|science|web/i],
  ["data", /data|dataset|analytics|market|price|weather|geo|crypto|blockchain/i],
  ["media", /media|image|photo|video|audio|music|art|design/i],
  ["ai", /\bai\b|llm|model|inference|agent|gpt|ml\b|machine/i],
  ["finance", /financ|trading|defi|payment|bank|stock|forex/i],
  ["people", /people|human|time|service|freelance|labou?r|task|booking/i],
];

/** Maps any seller's own category label to one of ours. Unknown → tools. */
export function normalizeCategory(raw: string | undefined | null): SpendCategory {
  const text = (raw ?? "").trim();
  if ((SPEND_CATEGORIES as readonly string[]).includes(text.toLowerCase())) {
    return text.toLowerCase() as SpendCategory;
  }
  for (const [category, pattern] of CATEGORY_WORDS) {
    if (pattern.test(text)) return category;
  }
  return "tools";
}

export const CATEGORY_LABEL: Record<SpendCategory, string> = {
  research: "research services",
  data: "data",
  media: "photos, video and sound",
  ai: "AI models",
  finance: "financial data",
  people: "people's time",
  tools: "tools",
};

/**
 * The allowance an agent spends under. Agents created before allowances
 * existed read theirs from the daily and per-call limits they already had,
 * so nothing an owner set earlier gets looser.
 */
export function allowanceOf(agent: Pick<AgentWallet, "allowance" | "dailyLimitUsdc" | "perCallLimitUsdc">): Allowance {
  if (agent.allowance) return { ...agent.allowance, categories: [...agent.allowance.categories] };
  return {
    amountUsdc: agent.dailyLimitUsdc,
    window: "day",
    categories: [],
    askAboveUsdc: agent.perCallLimitUsdc ?? agent.dailyLimitUsdc,
    proofOnly: false,
  };
}

/** Start of the window `now` falls in. UTC, so it is the same for everyone. */
export function windowStart(window: AllowanceWindow, now: number): number {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (window === "day") return day;
  if (window === "week") {
    // Weeks start on Monday.
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return day - sinceMonday * 86_400_000;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** When the allowance next refills. */
export function windowEnd(window: AllowanceWindow, now: number): number {
  const start = windowStart(window, now);
  if (window === "day") return start + 86_400_000;
  if (window === "week") return start + 7 * 86_400_000;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

type HistoryRow = NonNullable<AgentWallet["paymentHistory"]>[number];

/** Money that has left, or may still leave, for a payment in this state. */
function counts(status: HistoryRow["status"]): "spent" | "held" | null {
  if (status === "settled" || status === "disputed" || status === "ambiguous") return "spent";
  if (status === "reserved" || status === "authorized" || status === "held") return "held";
  return null; // released or refunded: nothing left
}

export type Meter = {
  amountUsdc: number;
  window: AllowanceWindow;
  /** Paid out this window. */
  spentUsdc: number;
  /** Waiting on a response check or a person's delivery. */
  heldUsdc: number;
  remainingUsdc: number;
  resetsAt: string;
  payments: number;
};

/**
 * The live meter: what this window has spent, what is waiting, what is left.
 * `extraHeldUsdc` is money set aside elsewhere this window — fees locked for
 * people the agent hired.
 */
export function meterFor(
  agent: Pick<AgentWallet, "allowance" | "dailyLimitUsdc" | "perCallLimitUsdc" | "paymentHistory">,
  now: number,
  extra: { spentUsdc?: number; heldUsdc?: number } = {},
): Meter {
  const a = allowanceOf(agent);
  const from = windowStart(a.window, now);
  let spent = extra.spentUsdc ?? 0;
  let held = extra.heldUsdc ?? 0;
  let payments = 0;
  for (const row of agent.paymentHistory ?? []) {
    if (Date.parse(row.createdAt) < from) continue;
    const kind = counts(row.status);
    if (kind === "spent") spent += row.amountUsdc;
    else if (kind === "held") held += row.amountUsdc;
    if (kind) payments += 1;
  }
  const round = (n: number) => Number(n.toFixed(6));
  return {
    amountUsdc: a.amountUsdc,
    window: a.window,
    spentUsdc: round(spent),
    heldUsdc: round(held),
    remainingUsdc: round(Math.max(0, a.amountUsdc - spent - held)),
    resetsAt: new Date(windowEnd(a.window, now)).toISOString(),
    payments,
  };
}

export type Decision =
  | { tier: "silent" }
  | { tier: "ask" }
  | { tier: "refuse"; code: RefusalCode; reason: string };

export type RefusalCode =
  | "AGENT_PAUSED"
  | "NOT_ON_LIST"
  | "NEEDS_PROOF"
  | "OVER_ALLOWANCE"
  | "APPROVAL_DECLINED";

function money(n: number): string {
  return `$${n < 1 ? n.toFixed(n < 0.01 ? 4 : 2) : n.toFixed(2)}`;
}

const WINDOW_WORD: Record<AllowanceWindow, string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

export function describeAllowance(a: Allowance): string {
  const what = a.categories.length === 0
    ? "anything on the approved list"
    : `${a.categories.map((c) => CATEGORY_LABEL[normalizeCategory(c)]).join(", ")} only`;
  return `${money(a.amountUsdc)} ${WINDOW_WORD[a.window]}, ${what}`;
}

/**
 * Which of the three tiers a payment falls in. Pure: `remainingUsdc` comes
 * from the meter, and `approved` says whether the owner already said yes to
 * this exact payment.
 */
export function decide(input: {
  allowance: Allowance;
  paused: boolean;
  costUsdc: number;
  category: SpendCategory;
  /** The seller only takes the money after the response is checked. */
  waitsForProof: boolean;
  remainingUsdc: number;
  approved?: boolean;
}): Decision {
  const a = input.allowance;
  if (input.paused) {
    return { tier: "refuse", code: "AGENT_PAUSED", reason: "This agent is paused by its owner." };
  }
  if (a.categories.length > 0 && !a.categories.map(normalizeCategory).includes(input.category)) {
    return {
      tier: "refuse",
      code: "NOT_ON_LIST",
      reason: `Not on this agent's list. Its allowance is ${describeAllowance(a)}.`,
    };
  }
  if (a.proofOnly && !input.waitsForProof) {
    return {
      tier: "refuse",
      code: "NEEDS_PROOF",
      reason: "This seller takes payment before showing a response, and this agent only pays after proof.",
    };
  }
  if (input.costUsdc > input.remainingUsdc + 1e-9) {
    return {
      tier: "refuse",
      code: "OVER_ALLOWANCE",
      reason: `That is ${money(input.costUsdc)} and only ${money(input.remainingUsdc)} is left of the ${money(a.amountUsdc)} allowance ${WINDOW_WORD[a.window]}.`,
    };
  }
  if (input.costUsdc > a.askAboveUsdc + 1e-9 && !input.approved) return { tier: "ask" };
  return { tier: "silent" };
}

/** Checks an allowance an owner is about to save. Returns the problem, or null. */
export function validateAllowance(a: Allowance, maxAmountUsdc: number): string | null {
  if (!(a.amountUsdc > 0) || a.amountUsdc > maxAmountUsdc) {
    return `The allowance must be between $0.01 and ${money(maxAmountUsdc)}.`;
  }
  if (!["day", "week", "month"].includes(a.window)) return "Pick a day, a week or a month.";
  if (!(a.askAboveUsdc >= 0)) return "The ask-me limit cannot be negative.";
  if (a.askAboveUsdc > a.amountUsdc) return "The ask-me limit cannot be more than the allowance.";
  for (const c of a.categories) {
    if (!(SPEND_CATEGORIES as readonly string[]).includes(c)) return `Unknown category: ${c}`;
  }
  return null;
}

// ─── Loop breaker ───────────────────────────────────────────────────────

/** Origin and path, lower-cased host, no query: what "the same endpoint" means. */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return url;
  }
}

const calls = new Map<string, number[]>();

/**
 * Records one call and says whether it trips the breaker. Kept in memory:
 * a restart forgets the last minute of calls, which only delays a trip.
 */
export function noteCall(agentId: string, url: string, now = Date.now()): { trip: boolean; count: number; endpoint: string } {
  const endpoint = endpointOf(url);
  const key = `${agentId} ${endpoint}`;
  const recent = (calls.get(key) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
  recent.push(now);
  calls.set(key, recent);
  // Keep the map from growing without bound across many agents.
  if (calls.size > 5_000) {
    for (const [k, times] of calls) {
      if (!times.some((t) => now - t < LOOP_WINDOW_MS)) calls.delete(k);
    }
  }
  return { trip: recent.length > LOOP_LIMIT, count: recent.length, endpoint };
}

/** Forgets an agent's recent calls, so resuming starts with a clean slate. */
export function forgetCalls(agentId: string): void {
  for (const key of calls.keys()) {
    if (key.startsWith(`${agentId} `)) calls.delete(key);
  }
}

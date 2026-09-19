/**
 * Every Evabob link, turned into something a person can act on in a chat.
 *
 * A link pasted into a conversation — or given to the assistant — used to be
 * just text unless it was a pay link. Now each kind becomes a card built from
 * Evabob's own records (never from anything in the message), with the one
 * action that link is for:
 *
 *   /pay/…    a request          → the request card, with Pay and Cancel
 *   /h/…      sell with a link   → Pay safely (money set aside until it arrives)
 *   /g/…      a collection       → Chip in;  a money circle → Open
 *   /t/…      an agent's task    → Take this task
 *   /a/…      a named agent      → Pay
 *   /claim    money held for you → Claim
 *   /r/…      a payment's proof  → where it is (Sending → On the way → Done)
 *   /x/…      a paywall          → what it sells, and for whom
 *
 * Any host is accepted: the card comes from the id, so a link on the wrong
 * host can only ever show the real Evabob object behind that id.
 */

export type LinkKind = "pay" | "hold" | "group" | "task" | "agent" | "claim" | "receipt" | "paywall";
export type EvabobLink = { kind: LinkKind; id: string };

const PATTERNS: Array<[LinkKind, RegExp]> = [
  ["pay", /(?:evabob:\/\/pay\/|\/pay\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi],
  ["hold", /(?:evabob:\/\/hold\/|https?:\/\/[^\s/]+\/h\/)([A-Za-z0-9_-]{8,32})/g],
  ["group", /(?:evabob:\/\/group\/|https?:\/\/[^\s/]+\/g\/)([cp]_[A-Za-z0-9_-]{4,40})/g],
  ["task", /(?:evabob:\/\/task\/|https?:\/\/[^\s/]+\/t\/)(task_[a-f0-9]{8,40})/g],
  ["agent", /(?:https?:\/\/[^\s/]+\/a\/)@?([A-Za-z0-9_]{3,24})\b/g],
  ["claim", /(?:evabob:\/\/claim(?:\/|\?transferId=)|\/claim\?(?:transferId|token)=)(\d{1,12})\b/g],
  ["receipt", /(?:https?:\/\/[^\s/]+\/r\/)([A-Za-z0-9_-]{16,40})/g],
  ["paywall", /(?:https?:\/\/[^\s/]+\/x\/)([A-Za-z0-9_-]{8,32})/g],
];

/** The Evabob links in a piece of text, in order, each once. */
export function findEvabobLinks(text: string): EvabobLink[] {
  const found: Array<EvabobLink & { at: number }> = [];
  const seen = new Set<string>();
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = kind === "pay" ? m[1]!.toLowerCase() : m[1]!;
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, id, at: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ kind, id }) => ({ kind, id }));
}

export type LinkCard = {
  type: "link_card";
  link: EvabobLink;
  title: string;
  subtitle: string;
  amount: number | null;
  token: string;
  /** A short state word: Open, Paid, Closed, Done… */
  status: string;
  /** The one thing to do, when there is one for this person. */
  action: { label: string; deepLink: string } | null;
};

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

/**
 * The card for one link, as `viewerId` should see it — or null when the link
 * points at nothing. A pay link returns the request card itself.
 */
export async function cardForLink(link: EvabobLink, viewerId: string): Promise<Record<string, unknown> | null> {
  switch (link.kind) {
    case "pay": {
      const { getPaymentRequest, invoiceCardMeta } = await import("./payment-requests.js");
      const inv = getPaymentRequest(link.id);
      return inv ? invoiceCardMeta(inv) : null;
    }
    case "hold": {
      const { publicHoldLinkView } = await import("./holdLinks.js");
      const v = publicHoldLinkView(link.id);
      if (!v) return null;
      const r = v.record;
      const done = r.delivered + r.notDelivered + r.refundedAfterReview;
      return card(link, {
        title: v.title,
        subtitle: `Sold by ${v.seller.handle} · delivered within ${v.deliveryDays} days · ` +
          `your money is set aside until it arrives` +
          (done ? ` · ${r.delivered} of ${done} orders delivered` : ""),
        amount: v.amount,
        status: v.active ? "For sale" : "No longer for sale",
        action: v.active ? { label: "Pay safely", deepLink: `evabob://hold/${link.id}` } : null,
      });
    }
    case "group": {
      if (link.id.startsWith("c_")) {
        return card(link, {
          title: "Money circle",
          subtitle: "Saving together. Open it in Evabob to see the rounds.",
          amount: null,
          status: "Private to its members",
          action: { label: "Open", deepLink: `evabob://group/${link.id}` },
        });
      }
      const { publicPotView } = await import("./groupMoney.js");
      const v = await publicPotView(link.id).catch(() => null);
      if (!v) return null;
      const open = v.state === "open" && Date.parse(v.deadline) > Date.now();
      return card(link, {
        title: v.title,
        subtitle: `For ${v.beneficiary} · ${money(v.raisedUsdc)} of ${money(v.targetUsdc)} · ` +
          `${v.contributors} chipped in`,
        amount: v.targetUsdc,
        status: v.state === "released" ? "Reached" : open ? "Open" : "Closed — everyone refunded",
        action: open ? { label: "Chip in", deepLink: `evabob://group/${link.id}` } : null,
      });
    }
    case "task": {
      const { publicTaskView } = await import("./agentTasks.js");
      const v = publicTaskView(link.id);
      if (!v) return null;
      return card(link, {
        title: v.title,
        subtitle: `${v.agent.byline} · the money is set aside before you start`,
        amount: v.amountUsdc,
        status: v.statusText,
        action: v.takeable
          ? { label: "Take this task", deepLink: `evabob://task/${link.id}` }
          : { label: "Open", deepLink: `evabob://task/${link.id}` },
      });
    }
    case "agent": {
      const { publicAgentProfile } = await import("./agentNames.js");
      const v = publicAgentProfile(link.id);
      if (!v) return null;
      const r = v.record;
      const hired = r.hiredAndPaid + r.hiredNotDelivered + r.hiredReviewed;
      return card(link, {
        title: v.handle,
        subtitle: `${v.byline}` + (hired ? ` · paid ${r.hiredAndPaid} of ${hired} people it hired` : ""),
        amount: null,
        status: v.active ? "Agent" : "Switched off",
        action: v.active ? { label: "Pay", deepLink: `evabob://send/${v.handle}` } : null,
      });
    }
    case "claim": {
      const { findTrackedByTransferId } = await import("./escrow-jobs.js");
      const rec = findTrackedByTransferId(link.id);
      if (!rec) return null;
      const viewer = (await import("../store/db.js")).store.getUser(viewerId);
      const mine = [viewer?.email, viewer?.handle]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase() === rec.recipientId.toLowerCase());
      return card(link, {
        title: `Money held for ${rec.recipientId}`,
        subtitle: rec.status === "pending"
          ? `Theirs once they sign up with that ${rec.recipientKind === "email" ? "email" : "name"}`
          : rec.status === "claimed" ? "Claimed" : "Went back to the sender",
        amount: rec.amountUsdc,
        status: rec.status === "pending" ? "Waiting" : rec.status === "claimed" ? "Claimed" : "Returned",
        action: rec.status === "pending" && mine
          ? { label: "Claim", deepLink: `evabob://claim/${link.id}` }
          : null,
      });
    }
    case "receipt": {
      const { publicReceipt } = await import("./publicReceipts.js");
      const v = await publicReceipt(link.id).catch(() => null);
      if (!v) return null;
      const stage = String((v as { stage?: string }).stage ?? "");
      return card(link, {
        title: `Payment to ${String((v as { to?: string }).to ?? "someone")}`,
        subtitle: `From ${String((v as { from?: string }).from ?? "someone")}`,
        amount: Number((v as { amount?: number }).amount ?? 0),
        token: String((v as { token?: string }).token ?? "USDC"),
        status: stage === "done" ? "Done ✓" : stage === "on_the_way" ? "On the way"
          : stage === "held" ? "Set aside" : stage === "returned" ? "Returned"
            : stage === "failed" ? "Did not go through" : "Sending",
        action: null,
      });
    }
    case "paywall": {
      const { publicPaywallView } = await import("./paywalls.js");
      const v = publicPaywallView(link.id);
      if (!v) return null;
      return card(link, {
        title: v.title,
        subtitle: `For software and AI agents · by ${v.seller.handle || v.seller.name} · ` +
          `charged only if what comes back is usable`,
        amount: v.priceUsdc,
        status: v.active ? "For sale to agents" : "Closed",
        action: null,
      });
    }
  }
}

function card(
  link: EvabobLink,
  parts: Omit<LinkCard, "type" | "link" | "token"> & { token?: string },
): LinkCard {
  return { type: "link_card", link, token: parts.token ?? "USDC", ...parts };
}

/** The first card in a piece of text, for a chat message. */
export async function firstCardIn(text: string, viewerId: string): Promise<Record<string, unknown> | null> {
  for (const link of findEvabobLinks(text)) {
    const c = await cardForLink(link, viewerId).catch(() => null);
    if (c) return c;
  }
  return null;
}

/** A sentence the assistant says with a card, so the reply reads naturally. */
export function sayCard(c: Record<string, unknown>): string {
  if (c.type === "invoice_card") {
    return `This is a payment request for ${String(c.amount ?? "")} ${String(c.token ?? "USDC")}` +
      `${c.description ? ` — ${String(c.description)}` : ""}. ` +
      (c.open ? "You can pay or decline it below." : `It is ${String(c.status ?? "closed").toLowerCase()}.`);
  }
  const lc = c as unknown as LinkCard;
  const price = lc.amount != null ? ` — ${money(lc.amount)}` : "";
  const next = lc.action ? ` Tap ${lc.action.label} below.` : "";
  return `${lc.title}${price}. ${lc.subtitle}.${next}`;
}

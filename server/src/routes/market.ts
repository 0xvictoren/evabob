/**
 * The marketplace over HTTP. Rules live in services/market.ts; this file
 * reads requests, makes the payment request behind a deal, and tells people
 * when something on the market concerns them.
 *
 *   /v1/market/…          signed-in people
 *   /v1/public/market/…   anyone with a post's link
 *   /v1/operator/market/… the people who check outside accounts
 */

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { getUserId } from "../middleware/auth.js";
import { requireOperator } from "../middleware/authorization.js";
import { store } from "../store/db.js";
import * as market from "../services/market.js";
import { alertUser } from "../services/notifyUser.js";
import { marketFeeBpsNow } from "../services/marketFee.js";
import { pingSellers } from "../services/marketPings.js";
import { createInvoice, getPaymentRequest, invoiceCardMeta, requestAmountLabel } from "../services/payment-requests.js";
import { flushPrimaryStore } from "../services/primary-store.js";

export const marketRoutes = new Hono();

market.setRequestStatusReader((id) => getPaymentRequest(id)?.status);

const userId = getUserId;

async function act(c: Context, run: () => unknown | Promise<unknown>, status: 200 | 201 = 200) {
  try {
    const out = await run();
    await flushPrimaryStore();
    return c.json(out as object, status);
  } catch (error) {
    if (error instanceof market.MarketError) {
      return c.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    }
    throw error;
  }
}

const placeBody = z.object({
  country: z.string().max(40).optional(),
  state: z.string().max(40).optional(),
  area: z.string().max(60).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const money = (n: number) => `$${n.toFixed(2)}`;

// ─── Browsing ────────────────────────────────────────────────────────────

marketRoutes.get("/market/categories", (c) =>
  c.json({ items: market.MARKET_CATEGORIES.map((x) => ({ id: x.id, label: x.label })) }));

marketRoutes.get("/market/posts", (c) => {
  const q = z
    .object({
      kind: z.enum(["offer", "want"]).default("offer"),
      type: z.enum(["goods", "service"]).optional(),
      category: z.string().max(20).optional(),
      q: z.string().max(120).optional(),
      sort: z.enum(["best", "nearest", "top_rated", "price_low", "price_high", "newest"]).optional(),
    })
    .parse(c.req.query());
  const uid = userId(c);
  const items = market.browse({ viewerId: uid, kind: q.kind, type: q.type, category: q.category, query: q.q, sort: q.sort });
  const mine = market.placeOf(uid);
  return c.json({
    items: items.map(market.postCard),
    hasPlace: Boolean(mine),
    // Whether distances are measured (a shared position) or compared by name.
    hasPoint: mine?.lat != null && mine?.lng != null,
  });
});

marketRoutes.get("/market/mine", (c) => {
  const uid = userId(c);
  const posts = market.postsBy(uid).map((p) => ({
    ...market.cardFor(p, uid),
    offers: p.kind === "want" ? market.proposalsFor(p.id).filter((x) => x.status === "sent").length : 0,
  }));
  // Offers this person sent on other people's requests.
  const sent = market.proposalsBy(uid).flatMap((p) => {
    const post = market.getPost(p.postId);
    return post ? [{ ...p, postTitle: post.title, budgetUsd: post.priceUsd }] : [];
  });
  return c.json({
    posts,
    sent,
    deals: market.dealsFor(uid).map((d) => market.dealView(d, uid)),
  });
});

marketRoutes.get("/market/posts/:id", (c) => {
  const uid = userId(c);
  const post = market.getPost(c.req.param("id"));
  if (!post) return c.json({ error: "No such post." }, 404);
  const mine = post.ownerId === uid;
  const body: Record<string, unknown> = {
    post: market.cardFor(post, uid),
    mine,
    seller: market.personCard(post.ownerId, market.placeOf(uid)),
  };
  if (post.kind === "want") {
    if (mine) {
      // The poster sees what came in, and what the agent found without waiting.
      body.offers = market.rankProposals(post).map((r) => ({
        id: r.proposal.id,
        priceUsd: r.proposal.priceUsd,
        message: r.proposal.message,
        deliveryDays: r.proposal.deliveryDays,
        status: r.proposal.status,
        createdAt: r.proposal.createdAt,
        near: r.near.label,
        seller: market.personCard(r.proposal.sellerId, post.place),
      }));
      body.matches = market.matchWant(post).map(market.postCard);
      // Who they could pick, best first; they message whoever they choose.
      body.people = market.candidatesFor(post).map((p) => ({
        available: p.available,
        contacted: Boolean(p.contact),
        threadId: p.contact?.threadId ?? null,
        why: p.why,
        near: p.near.label,
        offer: p.offer ? { id: p.offer.post.id, title: p.offer.post.title, priceUsd: p.offer.post.priceUsd } : null,
        seller: market.personCard(p.sellerId, post.place),
      }));
      body.pinged = post.pinged?.length ?? 0;
    } else {
      const own = market.proposalsFor(post.id).find((p) => p.sellerId === uid && p.status !== "withdrawn");
      body.myOffer = own ?? null;
      body.available = market.isAvailable(post.id, uid);
      const contact = market.contactForSeller(post.id, uid);
      body.contact = contact ? { id: contact.id, threadId: contact.threadId ?? null } : null;
    }
  } else if (!mine) {
    const contact = market.contactBetween(post.id, uid, post.ownerId);
    body.contact = contact ? { id: contact.id, threadId: contact.threadId ?? null } : null;
  } else {
    // The seller's side of an offer: buyers who messaged about it.
    body.contacts = market.contactsOn(post.id).map((x) => ({
      id: x.id,
      threadId: x.threadId ?? null,
      buyer: market.personCard(x.buyerId).name,
    }));
  }
  // Evabob's share of a deal made now, so a seller sees it before invoicing.
  body.marketFeeBps = marketFeeBpsNow();
  // Invoices already sent between this viewer and the other side of this post.
  body.deals = market.dealsFor(uid).filter((d) => d.postId === post.id).map((d) => market.dealView(d, uid));
  return c.json(body);
});

// ─── Posting ─────────────────────────────────────────────────────────────

const postBody = z.object({
  kind: z.enum(["offer", "want"]),
  type: z.enum(["goods", "service"]),
  category: z.string().max(20).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(3_000).optional(),
  priceUsd: z.number().positive(),
  display: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().positive() }).optional(),
  photos: z.array(z.string().max(120)).max(market.MAX_PHOTOS).optional(),
  place: placeBody.optional(),
  remote: z.boolean().optional(),
  deliveryDays: z.number().int().min(1).max(60).optional(),
});

marketRoutes.post("/market/posts", async (c) => {
  const uid = userId(c);
  const body = postBody.parse(await c.req.json());
  return act(c, () => {
    const post = market.createPost(uid, body);
    let matches: ReturnType<typeof market.postCard>[] = [];
    if (post.kind === "want") {
      // The agent's first pass: who already sells this, and who should hear.
      matches = market.matchWant(post).map(market.postCard);
      pingSellers(post);
    }
    return { post: market.cardFor(post, uid), matches };
  }, 201);
});

marketRoutes.post("/market/posts/:id/close", (c) =>
  act(c, () => ({ post: market.cardFor(market.setPostActive(userId(c), c.req.param("id"), false), userId(c)) })));

marketRoutes.post("/market/posts/:id/open", (c) =>
  act(c, () => ({ post: market.cardFor(market.setPostActive(userId(c), c.req.param("id"), true), userId(c)) })));

/** One photo for a post, stored like profile photos. Returns its path. */
marketRoutes.post("/market/photos", async (c) => {
  const body = z
    .object({
      imageBase64: z.string().min(32).max(400_000),
      mime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    })
    .parse(await c.req.json());
  const { decodeAvatar } = await import("../services/avatar.js");
  let image;
  try {
    image = decodeAvatar(body.imageBase64, body.mime || "image/jpeg");
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message.replace(/avatar/gi, "photo") : "Invalid photo" }, 400);
  }
  const filename = `market_${randomBytes(16).toString("hex")}.${image.extension}`;
  const { mongoReady, mongoSaveAvatar } = await import("../services/mongo.js");
  if (mongoReady()) await mongoSaveAvatar(filename, image.mime, image.bytes);
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { dataPath } = await import("../utils/data-path.js");
  const dir = dataPath("uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), image.bytes);
  return c.json({ path: `/uploads/${filename}` }, 201);
});

/**
 * Turns "I need someone to clean my 3-bedroom flat in Lekki on Saturday,
 * 15k" into the fields of a post, so nobody has to fill in a form. The
 * model only suggests; the person sees every field before anything is
 * posted. Without a model the category is guessed from the words.
 */
marketRoutes.post("/market/assist", async (c) => {
  const { text } = z.object({ text: z.string().min(3).max(1_000) }).parse(await c.req.json());
  const fallback = {
    kind: /\b(need|want|looking for|hire|find me|who can)\b/i.test(text) ? "want" : "offer",
    type: /\b(sell|selling|buy|price of|pieces|bag of|carton|for sale)\b/i.test(text) ? "goods" : "service",
    category: market.guessCategory(text),
    title: text.replace(/\s+/g, " ").trim().slice(0, 90),
    description: "",
    source: "rules" as const,
  };
  const { chatCompletion, llmConfigured } = await import("../services/llm.js");
  if (!llmConfigured()) return c.json(fallback);
  const reply = await chatCompletion({
    caller: "market-assist",
    json: true,
    temperature: 0,
    timeoutMs: 12_000,
    messages: [
      {
        role: "system",
        content:
          "You turn one sentence about something a person sells or needs into a marketplace post. " +
          'Answer with JSON only: {"kind":"offer"|"want","type":"goods"|"service","category":one of ' +
          JSON.stringify(market.MARKET_CATEGORIES.map((x) => x.id)) +
          ',"title":string up to 80 characters, plain words, no price,"description":string up to 300 characters or ""}. ' +
          '"want" means they are looking for it; "offer" means they provide it. Do not invent details that were not said.',
      },
      { role: "user", content: text },
    ],
  });
  try {
    const parsed = z
      .object({
        kind: z.enum(["offer", "want"]),
        type: z.enum(["goods", "service"]),
        category: z.string(),
        title: z.string().min(3).max(120),
        description: z.string().max(600).optional(),
      })
      .parse(JSON.parse(reply?.content ?? ""));
    return c.json({
      kind: parsed.kind,
      type: parsed.type,
      category: market.MARKET_CATEGORIES.some((x) => x.id === parsed.category) ? parsed.category : fallback.category,
      title: parsed.title.slice(0, 90),
      description: parsed.description ?? "",
      source: "model",
    });
  } catch {
    return c.json(fallback);
  }
});

// ─── Offers on a request ─────────────────────────────────────────────────

marketRoutes.post("/market/posts/:id/offers", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      priceUsd: z.number().positive(),
      message: z.string().max(1_000).optional(),
      deliveryDays: z.number().int().min(1).max(60).optional(),
    })
    .parse(await c.req.json());
  return act(c, () => {
    const proposal = market.sendProposal(uid, c.req.param("id"), body);
    const post = market.getPost(proposal.postId)!;
    const seller = store.getUser(uid);
    alertUser(post.ownerId, {
      kind: "market_offer",
      title: "An offer on your request",
      body: `${seller?.handle ? `@${seller.handle}` : "A seller"} can do "${post.title}" for ${money(proposal.priceUsd)}.`,
      link: `evabob://market/${post.id}`,
    });
    return { offer: proposal };
  }, 201);
});

marketRoutes.post("/market/offers/:id/decline", (c) =>
  act(c, () => ({ offer: market.setProposalStatus(userId(c), c.req.param("id"), "declined") })));

marketRoutes.post("/market/offers/:id/withdraw", (c) =>
  act(c, () => ({ offer: market.setProposalStatus(userId(c), c.req.param("id"), "withdrawn") })));

// ─── Availability and contact ────────────────────────────────────────────

/** A seller says "I can do this". The buyer is told once per seller. */
marketRoutes.post("/market/posts/:id/available", (c) => {
  const uid = userId(c);
  return act(c, () => {
    const { interest, fresh } = market.markAvailable(uid, c.req.param("id"));
    if (fresh) {
      const post = market.getPost(interest.postId)!;
      const seller = store.getUser(uid);
      const rep = market.reputationOf(uid);
      alertUser(post.ownerId, {
        kind: "market_offer",
        title: "A seller is available",
        body: `${seller?.handle ? `@${seller.handle}` : "A seller"} (${rep.tierLabel}) can do "${post.title}". Open it to see their record and message them.`,
        link: `evabob://market/${post.id}`,
      });
    }
    return { available: true };
  });
});

marketRoutes.post("/market/posts/:id/unavailable", (c) =>
  act(c, () => {
    market.withdrawAvailable(userId(c), c.req.param("id"));
    return { available: false };
  }));

/**
 * The buyer messages a seller about a post. Opens (or reuses) the chat
 * between them, already accepted — a seller on the market has asked to hear
 * from buyers — and puts a first line in it saying what it is about.
 */
marketRoutes.post("/market/posts/:id/contact", async (c) => {
  const uid = userId(c);
  const body = z.object({ sellerId: z.string().max(80).optional() }).parse(await c.req.json().catch(() => ({})));
  return act(c, async () => {
    const post = market.getPost(c.req.param("id"));
    if (!post) throw new market.MarketError("No such post.", 404);
    const sellerId = post.kind === "want" ? body.sellerId : post.ownerId;
    const existing = sellerId ? store.findThreadBetween(uid, sellerId) : null;
    if (existing?.state === "blocked") throw new market.MarketError("You cannot message this person.", 403);
    const contact = market.recordContact(uid, post.id, sellerId);
    const seller = store.getUser(contact.sellerId)!;
    let thread = existing ?? store.addThread({
      members: [uid, seller.id],
      title: seller.displayName || seller.handle || "Seller",
      subtitle: "About the marketplace",
      handle: seller.handle,
      state: "accepted",
      invitedBy: uid,
    });
    if (thread.state === "pending") {
      // Accepted on behalf of whoever had not answered the invitation.
      const other = thread.invitedBy === uid ? seller.id : uid;
      thread = store.acceptThread(thread.id, other) ?? thread;
    }
    const first = !contact.threadId;
    market.setContactThread(contact.id, thread.id);
    if (first) {
      const msg = store.addMessage({
        threadId: thread.id,
        senderId: uid,
        kind: "text",
        text: post.kind === "want"
          ? `Hi, I posted "${post.title}" on the marketplace (budget ${money(post.priceUsd)}). Are you available?`
          : `Hi, I am interested in "${post.title}" on the marketplace.`,
        meta: { type: "market_contact", postId: post.id, contactId: contact.id, link: `evabob://market/${post.id}` },
      });
      const { announceChatMessage } = await import("../services/chatAnnounce.js");
      await announceChatMessage(thread, uid, msg);
    }
    return { contact: { id: contact.id, threadId: thread.id }, thread: store.threadForViewer(thread, uid) };
  }, 201);
});

/**
 * The seller's invoice to a buyer who messaged them: priced lines, a delivery
 * time and a note. It is a payment request like any other, posted into their
 * chat as a card, and the buyer pays it there — all held, half held, or all
 * now.
 */
marketRoutes.post("/market/contacts/:id/invoice", async (c) => {
  const uid = userId(c);
  const body = z
    .object({
      items: z
        .array(z.object({ description: z.string().min(1).max(200), amount: z.number().positive().max(market.MAX_MARKET_AMOUNT) }))
        .min(1)
        .max(10),
      note: z.string().max(600).optional(),
      deliveryDays: z.number().int().min(1).max(60).optional(),
      display: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().positive() }).optional(),
    })
    .parse(await c.req.json());
  return act(c, async () => {
    const contact = market.getContact(c.req.param("id"));
    const post = contact ? market.getPost(contact.postId) : undefined;
    if (!contact || !post) throw new market.MarketError("No such conversation.", 404);
    if (contact.sellerId !== uid) throw new market.MarketError("Only the seller sends the invoice.", 403);
    const total = body.items.reduce((s, i) => s + i.amount, 0);
    if (total > market.MAX_MARKET_AMOUNT) throw new market.MarketError("That is more than one marketplace invoice can be.");
    const thread = contact.threadId ? store.listThreads().find((t) => t.id === contact.threadId) : undefined;
    if (!thread || thread.state === "blocked") throw new market.MarketError("This chat is closed.", 409);
    const buyer = store.getUser(contact.buyerId);
    const days = body.deliveryDays ?? post.deliveryDays;
    const request = createInvoice({
      userId: uid,
      items: body.items,
      description: post.title,
      note: [`Delivery within ${days} ${days === 1 ? "day" : "days"}.`, body.note?.trim()].filter(Boolean).join(" "),
      threadId: thread.id,
      receiverId: contact.buyerId,
      receiverHandle: buyer?.handle,
      allowedStructures: ["escrow", "split", "full"],
      expiresInMs: 7 * 24 * 60 * 60 * 1000,
      display: body.display,
    });
    const deal = market.recordDeal({
      postId: post.id,
      sellerId: uid,
      buyerId: contact.buyerId,
      title: post.title,
      priceUsd: request.total,
      requestId: request.id,
      ...(marketFeeBpsNow() ? { feeBps: marketFeeBpsNow() } : {}),
    });
    const msg = store.addMessage({
      threadId: thread.id,
      senderId: uid,
      kind: "receipt",
      text: `Payment request · ${requestAmountLabel(request)} · ${post.title}`,
      meta: invoiceCardMeta(request),
    });
    const { announceChatMessage } = await import("../services/chatAnnounce.js");
    await announceChatMessage(thread, uid, msg);
    return { deal: market.dealView(deal, uid), threadId: thread.id };
  }, 201);
});

// ─── Deals ───────────────────────────────────────────────────────────────

/**
 * A deal is a payment request from the seller to the buyer, so the buyer
 * pays it the way every request is paid: all now, half now and half held,
 * or all held until it arrives.
 */
function openDeal(input: { postId: string; proposalId?: string; sellerId: string; buyerId: string; title: string; priceUsd: number }) {
  const buyer = store.getUser(input.buyerId);
  const request = createInvoice({
    userId: input.sellerId,
    amount: input.priceUsd,
    description: input.title,
    note: "From the marketplace",
    receiverId: input.buyerId,
    receiverHandle: buyer?.handle,
    allowedStructures: ["escrow", "split", "full"],
    expiresInMs: 3 * 24 * 60 * 60 * 1000,
  });
  const feeBps = marketFeeBpsNow();
  const deal = market.recordDeal({ ...input, requestId: request.id, ...(feeBps ? { feeBps } : {}) });
  alertUser(input.sellerId, {
    kind: "market_deal",
    title: "You have a buyer",
    body: `${buyer?.handle ? `@${buyer.handle}` : "Someone"} is paying ${money(input.priceUsd)} for "${input.title}". You will be told when the money is set aside.`,
    link: `evabob://market/${input.postId}`,
  });
  return deal;
}

/** The buyer takes an offer post as it stands. */
marketRoutes.post("/market/posts/:id/order", (c) => {
  const uid = userId(c);
  return act(c, () => {
    const post = market.getPost(c.req.param("id"));
    if (!post || post.kind !== "offer") throw new market.MarketError("No such post.", 404);
    if (!post.active) throw new market.MarketError("This is no longer available.", 409);
    if (post.ownerId === uid) throw new market.MarketError("This is your own post.", 403);
    const existing = market.openDealFor(uid, post.id);
    const deal = existing ?? openDeal({ postId: post.id, sellerId: post.ownerId, buyerId: uid, title: post.title, priceUsd: post.priceUsd });
    return { deal: market.dealView(deal, uid) };
  }, 201);
});

/** The poster of a request accepts one seller's offer. */
marketRoutes.post("/market/offers/:id/accept", (c) => {
  const uid = userId(c);
  return act(c, () => {
    const proposal = market.getProposal(c.req.param("id"));
    const post = proposal ? market.getPost(proposal.postId) : undefined;
    if (!proposal || !post) throw new market.MarketError("No such offer.", 404);
    if (post.ownerId !== uid) throw new market.MarketError("Only the person who asked can accept.", 403);
    if (proposal.status !== "sent") throw new market.MarketError("This offer is already settled.", 409);
    const deal = openDeal({
      postId: post.id,
      proposalId: proposal.id,
      sellerId: proposal.sellerId,
      buyerId: uid,
      title: post.title,
      priceUsd: proposal.priceUsd,
    });
    return { deal: market.dealView(deal, uid) };
  }, 201);
});

marketRoutes.get("/market/deals", (c) => {
  const uid = userId(c);
  return c.json({ items: market.dealsFor(uid).map((d) => market.dealView(d, uid)) });
});

marketRoutes.post("/market/deals/:id/review", async (c) => {
  const uid = userId(c);
  const body = z.object({ stars: z.number().int().min(1).max(5), text: z.string().max(1_000).optional() }).parse(await c.req.json());
  return act(c, () => {
    const review = market.leaveReview(uid, c.req.param("id"), body);
    alertUser(review.sellerId, {
      kind: "market_review",
      title: `${review.stars} ${review.stars === 1 ? "star" : "stars"} from a buyer`,
      body: review.text || "They left a rating on your profile.",
      link: "evabob://market/me",
    });
    return { review };
  }, 201);
});

// ─── Profile, place and outside accounts ─────────────────────────────────

marketRoutes.get("/market/me", (c) => c.json(market.myProfile(userId(c))));

const saveMe = async (c: Context) => {
  const body = z
    .object({
      bio: z.string().max(1_000).optional(),
      place: placeBody.optional(),
      socials: z
        .array(z.object({ platform: z.enum(market.SOCIAL_PLATFORMS), handle: z.string().max(200) }))
        .max(market.SOCIAL_PLATFORMS.length)
        .optional(),
    })
    .parse(await c.req.json());
  return act(c, () => {
    market.saveProfile(userId(c), body);
    return market.myProfile(userId(c));
  });
};
marketRoutes.put("/market/me", saveMe);
// The app's client has no PUT.
marketRoutes.post("/market/me", saveMe);

marketRoutes.get("/market/people/:id", (c) => {
  const raw = c.req.param("id");
  const user = store.getUser(raw) ?? store.findUserByHandle(raw.replace(/^@/, ""));
  if (!user) return c.json({ error: "No such person." }, 404);
  const uid = userId(c);
  const offers = market.postsBy(user.id).filter((p) => p.active && p.kind === "offer").map((p) => market.cardFor(p, uid));
  return c.json({ person: market.personCard(user.id, market.placeOf(uid)), offers });
});

/**
 * Asks for an outside account to be checked. The person gets a short code to
 * put in that account's bio (or on the page, for a website). A website is
 * read by the server straight away; the others wait for a person to look,
 * because those sites do not let software read a profile.
 */
marketRoutes.post("/market/me/socials/:platform/check", async (c) => {
  const uid = userId(c);
  const platform = z.enum(market.SOCIAL_PLATFORMS).parse(c.req.param("platform"));
  return act(c, async () => {
    const before = market.myProfile(uid).socials.find((s) => s.platform === platform)?.status;
    let link = market.requestSocialCheck(uid, platform);
    if (platform === "website" && link.status === "pending" && link.code) {
      try {
        const { safeAgentRequest } = await import("../services/safe-agent-http.js");
        const page = await safeAgentRequest(link.handle, [new URL(link.handle).origin], {
          headers: { accept: "text/html,*/*" },
        });
        if (page.status >= 200 && page.status < 300 && page.text.includes(link.code)) {
          link = market.decideSocialCheck({ userId: uid, platform, verified: true, by: "auto" });
        }
      } catch {
        /* unreachable for now: stays pending, they can try again */
      }
    }
    // A person has to look at this one: tell the people who do the looking,
    // once per request rather than on every tap.
    if (link.status === "pending" && before !== "pending" && platform !== "website") {
      const who = store.getUser(uid)?.handle;
      for (const operator of config.auth.operatorUserIds) {
        alertUser(operator, {
          kind: "market_review",
          title: `${market.socialName(platform)} account to check`,
          body: `${who ? `@${who}` : "Someone"} says ${link.handle} is theirs. Look for ${link.code} in the bio.`,
          link: "evabob://market/checks",
        });
      }
    }
    return {
      social: link,
      instructions: link.status === "verified"
        ? "Checked."
        : platform === "website"
          ? `Put ${link.code} anywhere on ${link.handle}, then tap Check again.`
          : `Put ${link.code} in your ${market.socialName(platform)} bio. We look within a day, then you can remove it.`,
    };
  });
});

// ─── Operators: checking outside accounts ────────────────────────────────

marketRoutes.get("/operator/market/socials", (c) => {
  const denied = requireOperator(c);
  if (denied) return denied;
  return c.json({ items: market.pendingSocialChecks().map((s) => ({ ...s, url: market.socialUrl(s) })) });
});

marketRoutes.post("/operator/market/socials", async (c) => {
  const denied = requireOperator(c);
  if (denied) return denied;
  const body = z
    .object({ userId: z.string(), platform: z.enum(market.SOCIAL_PLATFORMS), verified: z.boolean() })
    .parse(await c.req.json());
  return act(c, () => {
    const social = market.decideSocialCheck({ ...body, by: userId(c) });
    alertUser(body.userId, {
      kind: "market_review",
      title: body.verified ? `${market.socialName(body.platform)} checked` : `${market.socialName(body.platform)} not confirmed`,
      body: body.verified
        ? "It now shows as checked on your profile. You can remove the code."
        : "We could not find the code on that account. Add it and ask again.",
      link: "evabob://market/me",
    });
    return { social };
  });
});

// ─── Public ──────────────────────────────────────────────────────────────

/** A post as its shared link shows it: no viewer, so no distance. */
marketRoutes.get("/public/market/posts/:id", (c) => {
  const post = market.getPost(c.req.param("id"));
  if (!post) return c.json({ error: "No such post." }, 404);
  const card = market.postCard(market.rankPosts({ posts: [post] })[0]!);
  return c.json({ post: card, deepLink: `evabob://market/${post.id}` });
});

marketRoutes.get("/public/market/posts", (c) => {
  const kind = c.req.query("kind") === "want" ? "want" : "offer";
  const q = c.req.query("q");
  const category = c.req.query("category");
  const ranked = market.browse({ viewerId: "", kind, query: q, category: category || undefined, limit: 40 });
  return c.json({ items: ranked.map(market.postCard) });
});

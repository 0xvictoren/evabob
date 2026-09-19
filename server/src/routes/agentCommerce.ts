/**
 * Routes for §8.2 "For agents": the allowance and its controls, pay after
 * proof's evidence, agent names, agents hiring people, and paywalls.
 *
 *   agentCommerceRoutes  /v1/…            the owner and people, by session;
 *                                         /v1/public/… for anyone
 *   agentApiRoutes       /v1/agent-api/…  the agent itself, by its API key
 *   paywallResource      /x/:id           software paying for a paywall
 *
 * "Evabob Agent", the in-app assistant, is unrelated and not here.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { getAuth, getUserId } from "../middleware/auth.js";
import { store, type AgentWallet } from "../store/db.js";
import { flushPrimaryStore } from "../services/primary-store.js";
import { jsonSafe } from "../utils/json-safe.js";

export const agentCommerceRoutes = new Hono();
export const agentApiRoutes = new Hono();

const userId = getUserId;

function ownAgent(c: Context): AgentWallet | null {
  return store.getAgent(userId(c), c.req.param("id") ?? "") ?? null;
}

/** Runs an action, turning the services' own errors into their status codes. */
async function act(c: Context, run: () => unknown) {
  try {
    const out = await run();
    await flushPrimaryStore();
    return c.json(jsonSafe(out) as object);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const known = error instanceof Error && typeof status === "number" && status >= 400 && status < 500;
    if (known) {
      const code = (error as { code?: string }).code;
      return c.json({ error: (error as Error).message, ...(code ? { code } : {}) }, status as 400);
    }
    throw error;
  }
}

async function agentView(agent: AgentWallet) {
  const { publicAgent } = await import("./api.js");
  return publicAgent(agent);
}

// ─── 7 · Allowance ───────────────────────────────────────────────────────

agentCommerceRoutes.patch("/agents/:id/allowance", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { allowanceBody } = await import("./api.js");
  const body = allowanceBody.parse(await c.req.json());
  const { validateAllowance } = await import("../services/agentAllowance.js");
  const problem = validateAllowance(body, config.agents.maxDailyLimitUsdc * 31);
  if (problem) return c.json({ error: problem }, 400);
  agent.allowance = body;
  store.save();
  const { pushAgentUpdate } = await import("../services/agentControls.js");
  pushAgentUpdate(agent);
  await flushPrimaryStore();
  return c.json({ wallet: await agentView(agent) });
});

agentCommerceRoutes.post("/agents/:id/pause", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { pauseAgent } = await import("../services/agentControls.js");
  pauseAgent(agent, "owner", "Paused by the owner");
  await flushPrimaryStore();
  return c.json({ wallet: await agentView(agent) });
});

agentCommerceRoutes.post("/agents/:id/resume", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { resumeAgent } = await import("../services/agentControls.js");
  resumeAgent(agent);
  await flushPrimaryStore();
  return c.json({ wallet: await agentView(agent) });
});

/** One tap freezes everything. */
agentCommerceRoutes.post("/agents/freeze", async (c) => {
  const { freezeAll } = await import("../services/agentControls.js");
  const frozen = freezeAll(userId(c));
  await flushPrimaryStore();
  return c.json({ frozen });
});

agentCommerceRoutes.post("/agents/unfreeze", async (c) => {
  const { unfreezeAll } = await import("../services/agentControls.js");
  const resumed = unfreezeAll(userId(c));
  await flushPrimaryStore();
  return c.json({ resumed });
});

agentCommerceRoutes.get("/agents/:id/approvals", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { pendingApprovals } = await import("../services/agentControls.js");
  return c.json({
    pending: pendingApprovals(agent),
    recent: [...(agent.approvals ?? [])].reverse().slice(0, 20),
  });
});

agentCommerceRoutes.post("/agents/:id/approvals/:approvalId", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const body = z.object({ approve: z.boolean() }).parse(await c.req.json());
  // A task waiting on this approval continues from agentTasks' listener.
  await import("../services/agentTasks.js");
  const { decideApproval } = await import("../services/agentControls.js");
  return act(c, () => ({ approval: decideApproval(agent, c.req.param("approvalId"), body.approve) }));
});

// ─── 8 · Evidence ────────────────────────────────────────────────────────

agentCommerceRoutes.get("/agents/:id/evidence/:key", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { exportEvidence } = await import("../services/agentEvidence.js");
  const out = exportEvidence(agent.id, c.req.param("key"));
  if (out.bundles.length === 0) return c.json({ error: "No evidence for that payment" }, 404);
  c.header("Content-Disposition", `attachment; filename="evabob-evidence-${c.req.param("key").slice(0, 24)}.json"`);
  return c.json(out);
});

// ─── 9 · Names and the marketplace ───────────────────────────────────────

agentCommerceRoutes.post("/agents/:id/name", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const body = z.object({ handle: z.string().min(3).max(25) }).parse(await c.req.json());
  const { claimAgentHandle } = await import("../services/agentNames.js");
  return act(c, async () => ({ wallet: await agentView(await claimAgentHandle(agent, body.handle)) }));
});

agentCommerceRoutes.get("/agents/:id/record", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { agentRecord, agentByline } = await import("../services/agentNames.js");
  return c.json({ byline: agentByline(agent), record: agentRecord(agent) });
});

agentCommerceRoutes.get("/agents/marketplace", async (c) => {
  const { listMarketplace } = await import("../services/agentMarketplace.js");
  return c.json(await listMarketplace());
});

// ─── 10 · Hiring ─────────────────────────────────────────────────────────

agentCommerceRoutes.get("/agents/:id/tasks", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { tasksForAgent, taskView } = await import("../services/agentTasks.js");
  return c.json({ items: tasksForAgent(agent.id).map(taskView) });
});

/** The owner cancels one of their agent's tasks. */
agentCommerceRoutes.post("/agents/:id/tasks/:taskId/cancel", async (c) => {
  const agent = ownAgent(c);
  if (!agent) return c.json({ error: "not found" }, 404);
  const { getTask, cancelTask, taskView } = await import("../services/agentTasks.js");
  const task = getTask(c.req.param("taskId"));
  if (!task || task.agentId !== agent.id) return c.json({ error: "No such task" }, 404);
  return act(c, async () => ({ task: taskView(await cancelTask(task)) }));
});

agentCommerceRoutes.get("/agent-tasks/open", async (c) => {
  const { openTasks } = await import("../services/agentTasks.js");
  return c.json({ items: openTasks() });
});

agentCommerceRoutes.get("/agent-tasks/mine", async (c) => {
  const { tasksForPerson } = await import("../services/agentTasks.js");
  return c.json({ items: tasksForPerson(userId(c)) });
});

agentCommerceRoutes.post("/agent-tasks/:id/take", async (c) => {
  const { takeTask, publicTaskView } = await import("../services/agentTasks.js");
  return act(c, () => {
    const task = takeTask(c.req.param("id"), userId(c));
    return { task: publicTaskView(task.id) };
  });
});

// ─── 11 · Paywalls ───────────────────────────────────────────────────────

const paywallBody = z.object({
  kind: z.enum(["file", "text", "api", "time"]),
  title: z.string().min(1).max(120),
  description: z.string().max(600).optional(),
  priceUsdc: z.number().positive(),
  category: z.string().max(40).optional(),
  files: z
    .array(z.object({ name: z.string().min(1).max(200), mime: z.string().max(100).optional(), base64: z.string().min(1) }))
    .max(5)
    .optional(),
  text: z.string().max(100_000).optional(),
  api: z.object({ url: z.string().url(), headerName: z.string().max(60).optional(), headerValue: z.string().max(500).optional() }).optional(),
  time: z.object({ minutes: z.number().int().min(5).max(480), note: z.string().max(300).optional() }).optional(),
});

agentCommerceRoutes.get("/paywalls", async (c) => {
  const { listPaywallsFor, paywallSellerRecord } = await import("../services/paywalls.js");
  const uid = userId(c);
  return c.json({ items: listPaywallsFor(uid), record: paywallSellerRecord(uid) });
});

agentCommerceRoutes.post("/paywalls", async (c) => {
  const body = paywallBody.parse(await c.req.json());
  const { createPaywall, listPaywallsFor } = await import("../services/paywalls.js");
  return act(c, async () => {
    const created = await createPaywall(userId(c), body);
    return { item: listPaywallsFor(userId(c)).find((p) => p.id === created.id) };
  });
});

agentCommerceRoutes.post("/paywalls/:id/close", async (c) => {
  const { setPaywallActive } = await import("../services/paywalls.js");
  return act(c, () => ({ active: setPaywallActive(userId(c), c.req.param("id"), false).active }));
});

agentCommerceRoutes.post("/paywalls/:id/open", async (c) => {
  const { setPaywallActive } = await import("../services/paywalls.js");
  return act(c, () => ({ active: setPaywallActive(userId(c), c.req.param("id"), true).active }));
});

agentCommerceRoutes.get("/paywalls/:id/sales", async (c) => {
  const { salesFor } = await import("../services/paywalls.js");
  return c.json({ items: salesFor(userId(c), c.req.param("id")) });
});

agentCommerceRoutes.post("/paywalls/bookings/:saleId", async (c) => {
  const body = z
    .object({ accept: z.boolean(), details: z.string().max(1_000).optional() })
    .parse(await c.req.json());
  const { answerBooking } = await import("../services/paywalls.js");
  // An Evabob agent's held payment is finished by x402Pay's listener.
  await import("../services/x402Pay.js");
  return act(c, async () => {
    const sale = await answerBooking(
      userId(c),
      c.req.param("saleId"),
      body.accept ? { accept: true, details: body.details ?? "" } : { accept: false },
    );
    return { status: sale.status };
  });
});

// ─── Public ──────────────────────────────────────────────────────────────

agentCommerceRoutes.get("/public/agents/:handle", async (c) => {
  const { publicAgentProfile } = await import("../services/agentNames.js");
  const profile = publicAgentProfile(c.req.param("handle"));
  return profile ? c.json(profile) : c.json({ error: "No such agent" }, 404);
});

agentCommerceRoutes.get("/public/paywalls/:id", async (c) => {
  const { publicPaywallView } = await import("../services/paywalls.js");
  const view = publicPaywallView(c.req.param("id"));
  return view ? c.json(view) : c.json({ error: "No such link" }, 404);
});

agentCommerceRoutes.get("/public/tasks/:id", async (c) => {
  const { publicTaskView } = await import("../services/agentTasks.js");
  const view = publicTaskView(c.req.param("id"));
  return view ? c.json(view) : c.json({ error: "No such task" }, 404);
});

// ─── The agent's own API (its key, not a session) ────────────────────────

function callingAgent(c: Context): AgentWallet | null {
  const auth = getAuth(c);
  if (auth.principal !== "agent" || !auth.agentId) return null;
  return store.getAgentById(auth.agentId) ?? null;
}

const needsKey = (c: Context) =>
  c.json({ error: "API key required", code: "API_KEY_REQUIRED", hint: "Authorization: Bearer sk_evabob_…" }, 401);

/** What the agent may spend right now, and whether it is stopped. */
agentApiRoutes.get("/me", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const { allowanceView } = await import("../services/agentControls.js");
  const { agentByline, agentRecord } = await import("../services/agentNames.js");
  const view = allowanceView(agent);
  return c.json({
    id: agent.id,
    label: agent.label,
    handle: agent.handle ? `@${agent.handle}` : null,
    byline: agentByline(agent),
    balanceUsdc: agent.balanceUsdc,
    allowance: view.allowance,
    meter: view.meter,
    paused: view.paused,
    pauseDetail: view.pauseDetail,
    record: agentRecord(agent),
  });
});

agentApiRoutes.get("/approvals/:id", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const a = (agent.approvals ?? []).find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: "No such request" }, 404);
  return c.json({ id: a.id, status: a.status, amountUsdc: a.amountUsdc, url: a.url, expiresAt: a.expiresAt });
});

agentApiRoutes.get("/marketplace", async (c) => {
  if (!callingAgent(c)) return needsKey(c);
  const { listMarketplace } = await import("../services/agentMarketplace.js");
  return c.json(await listMarketplace());
});

agentApiRoutes.post("/tasks", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const body = z
    .object({
      to: z.string().max(120).optional(),
      title: z.string().min(1).max(120),
      description: z.string().max(2_000).optional(),
      amountUsdc: z.number().positive(),
      deliveryDays: z.number().int().min(1).max(60).optional(),
      openDays: z.number().int().min(1).max(30).optional(),
      idempotencyKey: z.string().min(16).max(100).optional(),
    })
    .parse(await c.req.json());
  const { postTask, taskView } = await import("../services/agentTasks.js");
  try {
    const task = await postTask(agent, { ...body, idempotencyKey: c.req.header("idempotency-key") || body.idempotencyKey });
    await flushPrimaryStore();
    return c.json({ task: taskView(task) }, task.status === "awaiting_approval" ? 202 : 201);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status === "number") {
      return c.json({ error: (error as Error).message, code: (error as { code?: string }).code }, status as 400);
    }
    throw error;
  }
});

agentApiRoutes.get("/tasks", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const { tasksForAgent, taskView } = await import("../services/agentTasks.js");
  return c.json({ items: tasksForAgent(agent.id).map(taskView) });
});

function agentTask(c: Context, agent: AgentWallet) {
  return import("../services/agentTasks.js").then(({ getTask }) => {
    const task = getTask(c.req.param("id") ?? "");
    return task && task.agentId === agent.id ? task : null;
  });
}

agentApiRoutes.get("/tasks/:id", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const task = await agentTask(c, agent);
  if (!task) return c.json({ error: "No such task" }, 404);
  const { taskView } = await import("../services/agentTasks.js");
  return c.json({ task: taskView(task) });
});

/** The work arrived: pay the person now rather than after 7 days. */
agentApiRoutes.post("/tasks/:id/accept", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const task = await agentTask(c, agent);
  if (!task) return c.json({ error: "No such task" }, 404);
  const { acceptDelivery, taskView } = await import("../services/agentTasks.js");
  return act(c, async () => ({ task: taskView(await acceptDelivery(task)) }));
});

/**
 * Something is wrong. Before delivery the money goes straight back; after
 * delivery a person reviews it, exactly as when a person pays.
 */
agentApiRoutes.post("/tasks/:id/dispute", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const task = await agentTask(c, agent);
  if (!task) return c.json({ error: "No such task" }, 404);
  const body = z
    .object({
      reason: z.enum(["no_longer_needed", "not_as_agreed", "not_received", "other"]),
      details: z.string().max(2_000).optional(),
    })
    .parse(await c.req.json());
  const { cancelTask, taskView } = await import("../services/agentTasks.js");
  return act(c, async () => ({ task: taskView(await cancelTask(task, body)) }));
});

agentApiRoutes.post("/tasks/:id/cancel", async (c) => {
  const agent = callingAgent(c);
  if (!agent) return needsKey(c);
  const task = await agentTask(c, agent);
  if (!task) return c.json({ error: "No such task" }, 404);
  const { cancelTask, taskView } = await import("../services/agentTasks.js");
  return act(c, async () => ({ task: taskView(await cancelTask(task)) }));
});

// ─── /x/:id — the paywall itself ─────────────────────────────────────────

export const paywallResource = new Hono();

paywallResource.get("/x/:id", async (c) => {
  const { handlePaywallRequest } = await import("../services/paywalls.js");
  const url = new URL(c.req.url);
  const res = await handlePaywallRequest({
    id: c.req.param("id"),
    query: url.search.replace(/^\?/, ""),
    paymentSignature: c.req.header("payment-signature") ?? null,
    message: c.req.header("x-booking-message") ?? undefined,
  });
  await flushPrimaryStore();
  return c.body(res.body, res.status as 200, {
    ...res.headers,
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    "Cache-Control": "no-store",
  });
});

paywallResource.get("/x/:id/booking/:saleId", async (c) => {
  const { bookingStatus } = await import("../services/paywalls.js");
  const status = bookingStatus(c.req.param("id"), c.req.param("saleId"));
  return status ? c.json(status) : c.json({ error: "No such booking" }, 404);
});

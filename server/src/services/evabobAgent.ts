/**
 * System Evabob Agent account + per-user pinned chat thread.
 */

import { store, type ChatThread } from "../store/db.js";

export const AGENT_USER_ID = "evabob-agent";
export const LEGACY_AGENT_USER_ID = "sendit-agent";
export const AGENT_HANDLE = "evabob";
export const AGENT_DISPLAY = "evabob Agent";

export function ensureAgentUser() {
  return store.upsertUser({
    id: AGENT_USER_ID,
    email: "agent@evabob.app",
    handle: AGENT_HANDLE,
    displayName: AGENT_DISPLAY,
    evmAddress: "",
  });
}

export function isAgentThread(thread: ChatThread | undefined | null): boolean {
  if (!thread) return false;
  if (thread.kind === "agent") return true;
  if (thread.handle === AGENT_HANDLE || thread.handle === "sendit") return true;
  return (
    thread.members.includes(AGENT_USER_ID) ||
    thread.members.includes(LEGACY_AGENT_USER_ID)
  );
}

export function ensureAgentThread(userId: string): ChatThread {
  ensureAgentUser();
  const existing =
    store.findThreadBetween(userId, AGENT_USER_ID) ||
    store.findThreadBetween(userId, LEGACY_AGENT_USER_ID) ||
    store.listThreadsForUser(userId).find((t) => isAgentThread(t));
  if (existing) {
    if (existing.kind !== "agent") {
      existing.kind = "agent";
      existing.handle = AGENT_HANDLE;
      existing.title = AGENT_DISPLAY;
    }
    return existing;
  }

  const thread = store.addThread({
    members: [userId, AGENT_USER_ID],
    title: AGENT_DISPLAY,
    subtitle: "Ask me to send, bridge, swap, or check balances",
    handle: AGENT_HANDLE,
    kind: "agent",
  });

  store.addMessage({
    threadId: thread.id,
    senderId: AGENT_USER_ID,
    kind: "system",
    text:
      "Hi — I'm the evabob Agent. Bob me! Talk naturally or use @. commands. I'll confirm before any money moves.",
    meta: { type: "agent_welcome" },
  });

  return thread;
}

/** Agent thread first; remaining threads keep recency order. */
export function pinAgentThreads<T extends { kind?: string; handle?: string; members?: string[] }>(
  threads: T[],
): T[] {
  const agent: T[] = [];
  const rest: T[] = [];
  for (const t of threads) {
    const isAgent =
      t.kind === "agent" ||
      t.handle === AGENT_HANDLE ||
      t.handle === "sendit" ||
      (t.members || []).includes(AGENT_USER_ID) ||
      (t.members || []).includes(LEGACY_AGENT_USER_ID);
    if (isAgent) agent.push(t);
    else rest.push(t);
  }
  return [...agent, ...rest];
}

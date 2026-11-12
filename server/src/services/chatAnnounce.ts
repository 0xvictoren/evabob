import { store } from "../store/db.js";
import { alertUser } from "./notifyUser.js";
import { pusherTrigger } from "./pusher.js";

/**
 * Tells everyone else in a chat that a message arrived: live in the open
 * thread, and on their own channel (and by push) so the Chat tab can show it
 * and a closed app still hears about it.
 */
export async function announceChatMessage(
  thread: { id: string; members: string[] },
  senderId: string,
  msg: { id: string; text: string; kind: string; meta?: Record<string, unknown> },
) {
  try {
    await pusherTrigger(`private-chat-${thread.id}`, "message", msg);
  } catch (e) {
    console.warn("pusher message", e);
  }
  const sender = store.getUser(senderId);
  const name = sender?.displayName || (sender?.handle ? `@${sender.handle}` : "Someone");
  for (const member of thread.members) {
    if (!member || member === senderId || member.startsWith("peer_") || member.endsWith("-agent")) continue;
    alertUser(member, {
      kind: "chat_message",
      title: name,
      body:
        msg.meta?.type === "invoice_card"
          ? `Sent you a request for ${msg.text.replace(/^Payment request · /, "")}`
          : msg.meta?.type === "photo"
            ? "Sent you a photo"
            : msg.text.slice(0, 140),
      link: `evabob://chat/${thread.id}`,
      threadId: thread.id,
    });
  }
}

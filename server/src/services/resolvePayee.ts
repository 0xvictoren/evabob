/**
 * Canonical payee resolution for Circle send, /transfers/send, App Kit, and chat.
 *
 * Order:
 *  1. 0x + 40 hex → that address (caller may prompt Save / Skip)
 *  2. Saved contact name → that contact’s stored 0x
 *  3. email (ada@mail.com, not @ada) → user by email
 *  4. @username or bare username → user by handle
 *  5. anything else (phone, digits, display name) → reject
 *
 * Unknown username/email, or a user without a wallet, never moves funds.
 */

import { store, type UserRecord } from "../store/db.js";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const HANDLE_RE = /^@?[a-z0-9_]{3,24}$/i;
const PHONE_RE = /^\+?\d{7,15}$/;

export type PayeeKind = "address" | "contact" | "email" | "handle";

export type PayeeOk = {
  ok: true;
  kind: PayeeKind;
  address: `0x${string}`;
  user?: UserRecord;
  /** A named agent wallet. Its owner is always shown with it. */
  agent?: { id: string; handle: string; label: string; owner: string };
  /** Raw 0x paste — client should offer Save / Skip. Never auto-save. */
  promptSave: boolean;
  label: string;
};

export type PayeeErr = {
  ok: false;
  code:
    | "UNKNOWN_HANDLE"
    | "UNKNOWN_EMAIL"
    | "NO_WALLET"
    | "REJECTED"
    | "INVALID_ADDRESS"
    | "SELF_SEND";
  error: string;
};

export type PayeeResult = PayeeOk | PayeeErr;

function hasWallet(user: UserRecord): boolean {
  return Boolean(user.evmAddress && EVM_RE.test(user.evmAddress));
}

function labelFor(user: UserRecord | undefined, fallback: string): string {
  if (user?.handle) return `@${user.handle}`;
  if (user?.email) return user.email;
  return fallback;
}

export function looksLikeEvm(raw: string): boolean {
  return EVM_RE.test(raw.trim());
}

export function looksLikeEmail(raw: string): boolean {
  const t = raw.trim();
  return !t.startsWith("@") && t.includes("@") && EMAIL_RE.test(t);
}

export function looksLikePhone(raw: string): boolean {
  const t = raw.trim().replace(/[\s()-]/g, "");
  return PHONE_RE.test(t);
}

function noWallet(who: string): PayeeErr {
  return {
    ok: false,
    code: "NO_WALLET",
    error: `${who} has no wallet yet. Nothing was sent.`,
  };
}

/**
 * True when a resolved payee is the sender's own wallet.
 *
 * Circle App Kit rejects these at the adapter with
 * `Invalid address '0x…' for Arc Testnet. Expected a different address than
 * the sender.` — accurate, but it arrives after the user has already been
 * through a PIN prompt, and it reads like an address-format fault rather than
 * "that's you". Several screens prefill the recipient with the user's own
 * address, so this is easy to hit by accident.
 */
export function isSameWallet(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function selfSend(): PayeeErr {
  return {
    ok: false,
    code: "SELF_SEND",
    error: "That's your own wallet. Choose someone else to send to.",
  };
}

/**
 * Resolve a payee string. Same rules everywhere money can leave an account.
 *
 * Wrapped by `resolvePayee` below, which applies the self-send check to every
 * branch at once — four separate checks would eventually miss one.
 */
function resolvePayeeInner(fromUserId: string, rawInput: string): PayeeResult {
  const raw = (rawInput || "").trim();
  if (!raw) {
    return { ok: false, code: "REJECTED", error: "Recipient required" };
  }

  // 1) Raw EVM
  if (raw.toLowerCase().startsWith("0x")) {
    if (!EVM_RE.test(raw)) {
      return {
        ok: false,
        code: "INVALID_ADDRESS",
        error: "That 0x address is not 42 characters. Nothing was sent.",
      };
    }
    const addr = raw as `0x${string}`;
    const user =
      store.listUsers().find((u) => u.evmAddress?.toLowerCase() === addr.toLowerCase());
    return {
      ok: true,
      kind: "address",
      address: addr,
      user,
      promptSave: true,
      label: labelFor(user, `${addr.slice(0, 8)}…${addr.slice(-4)}`),
    };
  }

  // 2) Saved contact (address book name, exact — not display name)
  const contact = store.findContact(fromUserId, raw);
  if (contact?.address && EVM_RE.test(contact.address)) {
    const user = store.listUsers().find(
      (u) => u.evmAddress?.toLowerCase() === contact.address.toLowerCase(),
    );
    return {
      ok: true,
      kind: "contact",
      address: contact.address as `0x${string}`,
      user,
      promptSave: false,
      label: contact.name,
    };
  }

  // 3) Email
  if (looksLikeEmail(raw)) {
    const user = store.findUserByEmail(raw);
    if (!user) {
      return {
        ok: false,
        code: "UNKNOWN_EMAIL",
        error: `No user with email ${raw.toLowerCase()}. Nothing was sent.`,
      };
    }
    if (!hasWallet(user)) return noWallet(user.email);
    return {
      ok: true,
      kind: "email",
      address: user.evmAddress as `0x${string}`,
      user,
      promptSave: false,
      label: user.email,
    };
  }

  // 4) @username or bare username
  const maybeHandle = raw.replace(/^@/, "");
  if (HANDLE_RE.test(raw) || HANDLE_RE.test(`@${maybeHandle}`)) {
    const user = store.findUserByHandle(maybeHandle);
    if (!user) {
      // People and agents share one namespace, so a name that is not a
      // person may be an agent — paid into its own wallet, never its owner's.
      const agent = store.findAgentByHandle(maybeHandle);
      if (agent?.handle && agent.custodyAddress && EVM_RE.test(agent.custodyAddress) && !agent.revokedAt) {
        const owner = store.getUser(agent.userId);
        return {
          ok: true,
          kind: "handle",
          address: agent.custodyAddress as `0x${string}`,
          agent: {
            id: agent.id,
            handle: `@${agent.handle}`,
            label: agent.label,
            owner: owner?.handle ? `@${owner.handle}` : owner?.displayName || "someone",
          },
          promptSave: false,
          label: `@${agent.handle}`,
        };
      }
      return {
        ok: false,
        code: "UNKNOWN_HANDLE",
        error: `No user with username @${maybeHandle.toLowerCase()}. Nothing was sent.`,
      };
    }
    if (!hasWallet(user)) return noWallet(`@${user.handle || maybeHandle}`);
    return {
      ok: true,
      kind: "handle",
      address: user.evmAddress as `0x${string}`,
      user,
      promptSave: false,
      label: `@${user.handle || maybeHandle}`,
    };
  }

  // 5) Phone, digits, display name, junk
  if (looksLikePhone(raw)) {
    return {
      ok: false,
      code: "REJECTED",
      error: "Phone numbers are not payees. Use @username, email, or a 0x address.",
    };
  }

  return {
    ok: false,
    code: "REJECTED",
    error:
      "Unknown recipient. Payees are @username, account email, a saved name, or a 0x address. Nothing was sent.",
  };
}

/**
 * Resolve a payee, refusing the sender's own wallet.
 *
 * The self-send check lives here rather than in each branch so no resolution
 * path — raw address, saved contact, email or handle — can reach a transfer
 * without it.
 */
export function resolvePayee(
  fromUserId: string,
  rawInput: string,
  /**
   * The sender's own wallet. Defaults to a store lookup; passing it lets a
   * caller that already knows the address skip the lookup, and lets tests
   * exercise the rule without writing users into the real database.
   */
  senderAddress: string | undefined = store.getUser(fromUserId)?.evmAddress,
): PayeeResult {
  const result = resolvePayeeInner(fromUserId, rawInput);
  if (result.ok && isSameWallet(senderAddress, result.address)) return selfSend();
  return result;
}

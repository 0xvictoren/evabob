/**
 * What the Evabob Agent knows about Evabob.
 *
 * Asked "how do I top up?", the model invented a card-and-bank flow with a
 * button that does not exist. It had no information about the app at all, so
 * it answered from generic knowledge of payment apps. Forbidding that in the
 * prompt stops the fabrication but only yields a hedge; this is the material
 * that lets it actually answer.
 *
 * Every entry is written from the shipped Flutter screens and the server
 * routes, not from the product documentation, which overstates what works.
 * Where a flow is slow or unreliable the entry says so — a user who is told
 * "this can take an hour" will wait, and a user who is told "instant" will
 * think the app has eaten their money.
 *
 * Keep entries short. They are retrieved three at a time and spent against a
 * token budget shared with the conversation.
 */

export type KbEntry = {
  id: string;
  title: string;
  /** Extra search terms, including the jargon a user might arrive with. */
  keywords: string[];
  body: string;
};

export const KB: KbEntry[] = [
  {
    id: "what-is-evabob",
    title: "What Evabob is",
    keywords: ["evabob", "app", "what is this", "about", "bob"],
    body: `Evabob is a payments app for sending and receiving digital dollars and euros. Balances are held as USDC (dollars) and EURC (euros). You can pay anyone by their @handle, their email, or their wallet address.

The bottom of the app has Home, Chat, a Send button in the middle, Activity and Assets. Home has shortcuts for Send, Request, Receive, Buy, Bridge and Agent.

Everything currently runs on test networks, so the balances are not real money.`,
  },
  {
    id: "adding-money",
    title: "Adding money to your account",
    keywords: [
      "top up", "topup", "add money", "fund", "deposit", "load", "put money in",
      "card", "bank", "buy with card",
    ],
    body: `Evabob has no card or bank top-up. There is no way to add money with a debit card, credit card or bank transfer.

Money arrives in one of two ways:

1. Someone sends you USDC or EURC. Share your address or @handle from Receive, on Home or in Assets.
2. You already hold USDC on another network and move it across with Top-up, which brings it into your GA — the pooled balance you spend from.

If someone asks how to "buy" money into the app, the honest answer is that this version cannot do it — funds have to come from another wallet.`,
  },
  {
    id: "receiving-money",
    title: "Receiving money",
    keywords: [
      "receive", "my address", "get paid", "how do people pay me", "qr",
      "handle", "share address",
    ],
    body: `Tap Receive on Home, or open Assets. You will see your wallet address and a QR code the sender can scan.

Three things work as a payee: your @handle, the email you signed up with, and your wallet address. A handle is easiest to read out loud.

Incoming payments show up in Activity. The app checks for them when you open it or refresh, so a payment may take a moment to appear after it arrives — there is no push notification yet.`,
  },
  {
    id: "sending-money",
    title: "Sending money",
    keywords: ["send", "pay", "transfer", "how do i send", "pay someone"],
    body: `Use the Send button in the middle of the bottom bar, or Send on Home. Enter who and how much. You can add an optional memo directly below the quick amount buttons, then approve with your PIN.

The payee can be an @handle, an email address, or a wallet address starting with 0x. You can also scan a QR code.

If the person is not on Evabob yet, the money is held and they get an email with a claim link.

You cannot send to yourself — the app will stop you.`,
  },
  {
    id: "batch-sending",
    title: "Sending to several people at once",
    keywords: [
      "batch",
      "batch transfer",
      "bulk send",
      "many recipients",
      "multiple payments",
    ],
    body: `Arc supports atomic batch USDC transfers from an EOA, but Evabob's human wallets are smart accounts and the agent-wallet balance currently sits in Gateway. Evabob must not describe several separate sends as one atomic batch.

The batch-send capability stays unavailable until the agent EOA can hold a direct USDC balance, the whole batch is simulated first, and every Transfer event is checked after settlement. For now, send recipients one at a time.`,
  },
  {
    id: "requesting-money",
    title: "Requesting money and invoices",
    keywords: [
      "request", "invoice", "bill", "ask for money", "payment request",
      "request link", "charge someone",
    ],
    body: `Request on Home creates a payment request. Set the amount, generate it, and you get a link you can copy and send to whoever owes you. Past ones are under Request history.

You can also send an invoice inside a chat, and the other person gets a card they can pay directly in the conversation.

A request stays open until it is paid or cancelled. Only the person who created it can cancel it.`,
  },
  {
    id: "swapping",
    title: "Swapping between dollars and euros",
    keywords: [
      "swap", "buy", "exchange", "convert", "usdc to eurc", "eurc to usdc",
      "change currency", "fx", "rate",
    ],
    body: `Buy on Home opens the exchange screen. Pick what you are spending and what you want to receive — USDC (dollars), EURC (euros) or CIRBTC — enter an amount, and approve with your PIN.

The screen shows what you spend and what you receive before you confirm.

If it says there is no route, the pair or the amount cannot be filled right now. Trying a different amount sometimes works.`,
  },
  {
    id: "bridging",
    title: "Moving money between networks",
    keywords: [
      "bridge", "network", "chain", "move between chains", "arc", "base",
      "ethereum", "cross chain", "transfer between networks",
    ],
    body: `Bridge moves your money from one network to another — for example from Arc to Base. Pick a source, a destination and an amount. The destination defaults to your own wallet on the other side.

Evabob uses three networks: Arc, Base Sepolia and Ethereum Sepolia.

Bridging is the slowest and least reliable thing in the app. It happens in two steps, and the second step can stall — if you see "Mint still pending", the money is not lost and there is a Retry mint button. Expect to wait, and expect to sometimes retry.`,
  },
  {
    id: "how-long-things-take",
    title: "How long payments take",
    keywords: [
      "how long", "slow", "pending", "still waiting", "not arrived",
      "taking forever", "settle", "confirm time",
    ],
    body: `On Arc, payments settle in a few seconds.

Moving money in from another network is much slower and the wait depends on the network, not on Evabob:
- From Base, usually within the hour.
- From Ethereum, often many hours.

A payment that shows as pending is normal during those windows. Money sitting in a pending transfer has not been lost; it is waiting on the other network to finish.`,
  },
  {
    id: "usdc-eurc",
    title: "What USDC and EURC are",
    keywords: [
      "usdc", "eurc", "stablecoin", "what is usdc", "cirbtc", "currency",
      "dollars", "euros", "token",
    ],
    body: `USDC is a digital dollar. One USDC is meant to always be worth one US dollar. EURC is the same idea for euros.

They are called stablecoins because their value is designed to hold steady, unlike currencies that swing around.

CIRBTC also appears in the app as a third option.

You hold and send these the way you would hold and send money in any payments app — the difference is that they move over public networks rather than through a bank.`,
  },
  {
    id: "networks",
    title: "What a network is, and which ones Evabob uses",
    keywords: [
      "network", "chain", "blockchain", "arc", "base", "ethereum", "sepolia",
      "testnet", "what is a chain",
    ],
    body: `A network is the system your money moves over — a bit like choosing between a bank transfer and a card payment. The same USDC can sit on different networks, and moving it between them takes a bridge.

Evabob uses Arc for day-to-day payments because it settles in seconds and fees are tiny. Base and Ethereum are supported mainly so you can move money in and out.

All three are test versions of those networks, so balances here are not real money.`,
  },
  {
    id: "fees",
    title: "Fees",
    keywords: ["fee", "fees", "gas", "cost", "charge", "how much does it cost"],
    body: `On Arc, the network fee is paid in USDC and is a fraction of a cent, so a payment costs essentially nothing.

Bridging between networks costs more than a payment on Arc, because two networks are involved.

The amount you are shown before you confirm is what will leave your balance.`,
  },
  {
    id: "pin-and-confirming",
    title: "Your PIN and confirming payments",
    keywords: [
      "pin", "confirm", "password", "approve", "why does it ask",
      "biometrics", "fingerprint", "app lock",
    ],
    body: `Nothing leaves your account without your PIN. Whenever you send, swap, bridge or fund, the app asks you to approve it — that step is what actually authorises the payment.

There are two separate PINs, which is easy to confuse:
- Your wallet PIN, which approves payments.
- The app lock PIN under Profile, which just opens the app. You can use a fingerprint instead.

If you cancel at the PIN screen, nothing moves.`,
  },
  {
    id: "stuck-payment",
    title: "A payment that is stuck or did not arrive",
    keywords: [
      "stuck", "failed", "did not go through", "missing", "not arrived",
      "pending forever", "where is my money", "lost payment", "error",
    ],
    body: `Check Activity first — it shows every attempt with its current status, including ones that failed.

Common causes, in order of likelihood:
- It is still settling. Payments from Base or Ethereum can take an hour or many hours.
- The PIN step was cancelled or timed out, so it never started. Nothing moved; just try again.
- A bridge finished its first step but not the second. Look for Retry mint on the Bridge screen.
- Not enough balance on the network you were sending from.

If a payment shows a transaction reference in Activity, it reached the network and it is a question of waiting, not of the payment being lost.`,
  },
  {
    id: "agent-wallets",
    title: "Agent wallets — letting software spend for you",
    keywords: [
      "agent wallet", "agentic wallet", "api key", "x402", "nanopayment",
      "automated payments", "bot", "ai agent", "agent section",
    ],
    body: `An agent wallet is a separate pocket of money you set aside for a piece of software to spend — an AI agent that pays small amounts per request, for example.

It works like this: create the agent wallet, fund it from your main balance, then copy its API key and give that key to the software. The software can spend only what is in that wallet, up to the daily limit you set. Your main balance is never touched.

You can withdraw the remainder back to yourself at any time, and revoke or rotate the key if it leaks.

The key is shown once when it is created. Nobody, including this assistant, can show it to you again — if it is lost, rotate it to get a new one.

This is not the same as the Evabob assistant you are chatting with.`,
  },
  {
    id: "handles-and-contacts",
    title: "Handles, display name and contacts",
    keywords: [
      "handle", "username", "display name", "change name", "contacts",
      "profile", "@",
    ],
    body: `Your @handle is how other people pay you without typing an address. Your display name is just what shows in the app.

Both are under Profile. A handle can only be changed once, so pick carefully.

Contacts save people you pay often so you can pick them by name instead of pasting an address.`,
  },
  {
    id: "security-and-recovery",
    title: "Security, lost phone and account recovery",
    keywords: [
      "lost phone", "stolen", "hacked", "recover", "recovery", "forgot pin",
      "reset", "compromised", "someone has my account", "seed phrase",
      "private key",
    ],
    body: `Evabob never shows a private key or recovery phrase, and no one from Evabob will ever ask you for your PIN.

If a phone is lost or stolen, or an account may be compromised, that has to go through support from a device the owner still controls. This assistant cannot verify who it is talking to, so it will not read out account details, reveal an address, or help restore access — that is exactly the route an attacker would take.

If an agent wallet API key has leaked, revoke it in the agent section immediately. The money stops being spendable the moment the key is revoked.`,
  },
  {
    id: "chat-payments",
    title: "Paying inside a chat",
    keywords: [
      // Deliberately no "escrow"/"hold"/"split" here — those belong to the
      // escrow entry, and sharing them made a question about escrow return
      // this one instead.
      "chat", "message", "conversation", "pay in chat", "invoice in chat",
      "pay without leaving",
    ],
    body: `You can pay someone from inside a conversation. Send an invoice in the chat and the other person gets a card they can pay without leaving the thread.

Whoever receives the invoice chooses how to settle it: pay it all now, hold the whole amount until the work is delivered, or pay half now and hold the other half. See the entry on holding money for how a hold is released or refunded.

Payments made in a chat show up in Activity like any other.`,
  },
  {
    id: "ga-balance",
    title: "Your GA — the balance you pay from",
    keywords: [
      "ga", "my ga", "top up ga", "unified balance", "total", "gateway",
      "balance different", "two balances", "why is my balance", "spendable",
    ],
    body: `Your GA is the pooled balance you actually spend from. Money can sit on more than one network at once, and your GA gathers it into one place so you do not have to think about where it is before paying.

GA is simply what this balance is called in Evabob. Do not expand it into words or explain what the letters stand for.

To add to it, use Top-up and choose which network the money is coming from. People say things like "top up my GA with 5 from Base".

Home shows your GA total alongside what is on each network. If those look inconsistent, something is usually still moving between networks — pull to refresh, and check Activity for anything pending.`,
  },
  {
    id: "escrow",
    title: "Escrow — holding money until a job is done",
    keywords: [
      "escrow", "hold", "lock", "protect", "milestone", "half now",
      "release", "deliver", "freelancer", "not delivered", "dispute", "refund",
    ],
    body: `Escrow means money set aside until work is delivered.

When someone invoices you for work, you do not have to pay it all up front. There are three ways to settle an invoice:

- Pay it all now.
- Hold the whole amount. The money leaves your balance and is held until you say the work is delivered, then it goes to them.
- Pay half now and hold the other half, so they get something up front and the rest on delivery.

Held money is not theirs and not yours to spend — it sits aside until released. You release it when the work arrives. If it never arrives you can reject the job and the held amount comes back to you, and a job that is never settled expires and refunds automatically.

Only the person who paid can release a hold. The person doing the work cannot release it to themselves.`,
  },
  {
    id: "getting-started",
    title: "Setting up for the first time",
    keywords: [
      "get started", "sign up", "new", "set up wallet", "first time",
      "no wallet", "onboarding", "cant send",
    ],
    body: `You sign in with your email and a one-time code.

Before you can hold or move money you need a wallet, which is created under Profile with Set up wallet. That is also where you choose the PIN that approves payments.

If the app says there is no wallet on the account, or Send does nothing, this is almost always the missing step.`,
  },
];

/** Words too common to tell entries apart. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "how", "do", "does", "did", "i", "my", "me", "you", "your", "it",
  "this", "that", "what", "why", "can", "with", "from", "at", "be", "have",
  "has", "get", "got", "if", "so", "not", "no", "yes", "there", "here",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * Scores an entry against the query.
 *
 * Deliberately not embeddings: eighteen entries do not need a vector database,
 * and a keyword match is inspectable when the agent answers oddly. Keywords
 * outweigh body text because they are where a user's own phrasing lives — a
 * person asks "how do I top up", never "unified balance deposit".
 */
function score(entry: KbEntry, queryTerms: string[]): number {
  const title = tokenize(entry.title);
  const keywordTerms = tokenize(entry.keywords.join(" "));
  const body = new Set(tokenize(entry.body));
  const joined = queryTerms.join(" ");

  let total = 0;
  for (const term of queryTerms) {
    if (keywordTerms.includes(term)) total += 3;
    if (title.includes(term)) total += 2;
    if (body.has(term)) total += 1;
  }
  // A whole keyword phrase appearing in the question is a much stronger signal
  // than its words appearing separately: "where is my money" should outrank an
  // entry that merely mentions "money", and "lost phone" should not score as
  // "lost" plus "phone". Both sides are tokenized before comparing, so the
  // stop words dropped from the question do not stop a phrase from matching.
  for (const phrase of entry.keywords) {
    const phraseTerms = tokenize(phrase).join(" ");
    if (phraseTerms.includes(" ") && joined.includes(phraseTerms)) total += 6;
  }
  return total;
}

/** Best entries for a question, most relevant first. */
export function searchKb(query: string, limit = 3): KbEntry[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return KB.map((entry) => ({ entry, s: score(entry, terms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.entry);
}

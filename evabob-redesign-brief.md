# Evabob — UI/UX Redesign Brief

## ⚠️ Scope restriction — read first
This is a **UI/UX redesign only**. Do not touch, refactor, or rewire any core logic: API calls, App Kit / Circle UCW integration, chain logic, state management, routing logic, or data models stay exactly as they are. Every change below is visual and layout — component structure, styling, copy, and screen composition. If a visual change seems to require a data or logic change, flag it instead of making it.

---

## 1. Brand
- App name: **Evabob**
- Tagline: **"Bob me!"** — used sparingly, as a moment of personality (e.g. send-confirmation toast: "Bobbed!"), never as permanent chrome.
- Wordmark appears top-left near the greeting, in the display typeface, bold.

## 2. Visual system
**Typeface:** San Francisco Pro throughout.
- SF Pro Display (bold, tight tracking) — balance figure, wordmark
- SF Pro Text (regular/medium) — body copy, labels
- SF Pro Text, tabular numerals — transaction amounts, timestamps

**Color tokens:**
| Token | Hex | Use |
|---|---|---|
| Pale mint | `#EAFBDD` | hero card background |
| Lime green | `#8ED14A` | primary accent, active states, positive deltas |
| Forest green | `#1F4D2B` | dark action panel (replaces black) |
| White | `#FFFFFF` | content sheet background |
| Near-black | `#111111` | primary text on light surfaces |
| Page background | `#F4FFE8` | behind the card stack |

**Feel — soft, smooth, motion-forward:**
- Generous rounded corners everywhere, soft low-opacity shadows instead of hard borders.
- Screen/sheet transitions use spring easing with slight overshoot — the bottom sheet feels pulled up and rubber-banded into place, not slid on rails.
- Buttons/pills scale to ~0.96 on press, spring back on release.
- Balance figure counts up on load rather than snapping in.
- List items (chat tiles, activity rows) stagger in with a slight fade + rise.
- Respect reduced-motion settings: fall back to plain opacity crossfades.

**Copy rules (apply on every screen):**
- No crypto jargon in user-facing text: no USDC/EURC tickers as labels, no "chain," "gas," "bridge," "CCTP," "UCW," "PIN challenge," "escrow," "Gateway," "unified balance." Say what it does in plain terms instead.
- Present dollar amounts with `$` and euro amounts with `€`; use **Dollars** and
  **Euros** when naming a currency without an amount. Settlement asset codes
  stay internal and must never be interpolated into customer-facing copy.
- On public-web payment and claim views, the `TESTNET` label is centred inside
  its badge container, never placed as a sibling outside the badge.
- One hero element per screen, one supporting line max under any heading.
- Full detailed copy pass by screen is in Section 6.

---

## 3. Home screen

### 3.1 Action row
Rebuild the Receive/Send/Request/Buy/Top-up/Agent/Bridge row exactly as laid out in the second reference mockup: a **Send** pill on the left, a **circular scan/QR icon button** in the center, a **Request** pill on the right, all sitting on the dark forest-green action panel. This replaces the current button grid entirely — those actions move into the overflow menu (3.3).

### 3.2 Balance card — swipeable per chain
Replace the single balance card (with the inline Arc/ETH/Base/EURC/cirBTC/Unified pill row) with a **horizontally swipeable card stack, one card per chain**.

Each card:
- Occupies the same hero-card position/size as today.
- Shows the **largest asset balance on that chain**, bold, large, left-aligned, taking up roughly the top 75% of the card.
- Shows the **other asset balances on that chain** (e.g. EURC) stacked at the right side, smaller, secondary weight.
- Has a small footnote label at the bottom of the card naming the chain (e.g. "Arc," "Ethereum Sepolia," "Base Sepolia") — quiet, low-emphasis, just enough to orient the user.
- Swiping right moves to the next chain's card; swiping left goes back. Use the same spring/rubber-band motion as the rest of the app, with a small dot or line indicator for card position if needed.

**Remove "Unified" from the balance display entirely** — no unified total shown on or across these cards.

### 3.3 Overflow menu (the "⋮⋮" icon)
Tapping the dots icon next to the notification bell opens a menu with:
- Request
- Buy
- Unified
- Agent
- Bridge
- Profile → navigates to the app's profile screen

These are the actions removed from the old button row (3.1) — they now live here instead of cluttering the main screen.

### 3.4 Your Income
Keep this card, but make it **reactive**: the chart and figures reflect the chain currently in view on the swipeable balance card (3.2). Swiping to a new chain updates "Your Income" to that chain's flow of funds.

### 3.5 "Send Again" → Chat
Rename/rebuild this section as **Chat**, using the same 2x2 avatar-grid layout as today:
- **First tile:** the Evabob agent (assistant avatar).
- **Next two tiles:** the user's most frequent chat contacts.
- **Fourth tile** (currently the "+" icon): tapping it opens the full **Chat list screen** (see Section 5) instead of an add-contact action.

Tapping any of the first three tiles opens a chat thread with that contact/agent directly.

---

## 4. Send screen
Rebuild to match the third reference mockup exactly:
- Back arrow + "Sent To" header
- Large bold amount entry with currency label
- Recipient row (name, masked account/reference, action icon)
- A "Total Balance" tooltip/chip near the recipient row
- Full numeric keypad below, same soft rounded-key styling as the rest of the app

Apply the same color tokens, type, and motion rules from Section 2 — this screen should feel like it belongs to the same app as Home, not a different visual system.

## 5. Chat screen
Rebuild to match the fourth reference image:
- Header: "Chat" with a "+" new-chat action
- Evabob agent pinned at the top of the list, with a short plain-language preview line (no jargon — if the agent's default reply currently lists raw actions like "send, bridge, swap, invoice, escrow," rewrite it in plain terms, e.g. "You can send money, convert currency, or check your balance — just ask.")
- Contact threads below, each with name, last message preview, and timestamp
- Same soft card styling, spacing, and stagger-in motion as list items elsewhere in the app

---

## 6. Copy pass — screen by screen (plain language, no jargon)

- **Home** — Balance is just the number; no ticker under it. Action labels stay literal: Send, Scan, Request.
- **Send** — Recipient input labelled "Who's this for?", accepts name/number/email without exposing which one it detected. Wallet address, if ever shown, lives one tap deeper under "Details."
- **Convert** (was Buy/Swap) — Plain currency names, not tickers. One line for the rate; fees shown only at confirm, plainly ("Fee: $0.10").
- **Move money** (was Bridge) — No chain/network/attestation language. Simple progress states: Sending → On the way → Done.
- **Activity** — Who, what, amount, when per row. Hashes/chain names live behind "View details."
- **Balances** (was Assets) — Plain currency names; combine what the user doesn't need to see separately.
- **Pending/escrow sends** — Never say "escrow." Say "Waiting for [name] to join."
- **Agents** — Either out of scope for this pass, or reduced to one plain sentence per agent, no protocol names.
- **Login/wallet setup** — "Enter your code" for OTP, "Set a PIN" for wallet setup — treat like a banking app PIN screen.
- **Chat money commands** — Shorthand commands can stay for power users, but the resulting receipt in the thread must read in plain language ("Sent $50 to Hannah"), never echoing raw command syntax.

---

## Reference images
1. Second mockup (light hero card, dark action panel, Send/Scan/Request row) — use exactly for Home's action row layout.
2. Third mockup (dark "Sent To" keypad screen) — use exactly for the Send screen.
3. Fourth mockup (Chat list with Evabob/Evabob Agent pinned) — use exactly for the Chat screen.
4. Current Home screenshot — reference only for what's being replaced (button grid, unified balance line, chain pill row).

export type Currency = "EUR" | "USDC";

export type Transaction = {
  id: string;
  name: string;
  description: string;
  amount: number;
  currency: Currency;
  date: string;
  kind: "subscription" | "send" | "receive" | "exchange" | "purchase" | "request";
};

export const USER = {
  firstName: "Victor",
  fullName: "Victor En",
  initials: "VE",
  unread: 3,
};

export const BALANCES: Record<Currency, number> = {
  EUR: 4280.55,
  USDC: 3912.18,
};

/** 1 EUR ≈ n USDC */
export const FX_RATE = 1.09;

/**
 * Real everyday activity only — subscriptions, purchases,
 * transfers to named people.
 * Never "Escrow refund" or "On-chain settlement."
 */
export const TRANSACTIONS: Transaction[] = [
  {
    id: "1",
    name: "Spotify Subscription",
    description: "Paid for 1 month",
    amount: -10.99,
    currency: "EUR",
    date: "Today · 14:22",
    kind: "subscription",
  },
  {
    id: "2",
    name: "Sent to Adaobi via chat",
    description: "Food money",
    amount: -42.0,
    currency: "EUR",
    date: "Today · 11:05",
    kind: "send",
  },
  {
    id: "3",
    name: "Received from Chinedu",
    description: "Rent share",
    amount: 320.0,
    currency: "EUR",
    date: "Yesterday",
    kind: "receive",
  },
  {
    id: "4",
    name: "Exchange EUR → USDC",
    description: "Converted €50",
    amount: 54.5,
    currency: "USDC",
    date: "Yesterday",
    kind: "exchange",
  },
  {
    id: "5",
    name: "Netflix Subscription",
    description: "Monthly plan",
    amount: -15.99,
    currency: "EUR",
    date: "Jul 12",
    kind: "subscription",
  },
  {
    id: "6",
    name: "Sent to Maya",
    description: "Concert tickets",
    amount: -68.0,
    currency: "EUR",
    date: "Jul 11",
    kind: "send",
  },
  {
    id: "7",
    name: "Zara",
    description: "In-store purchase",
    amount: -89.5,
    currency: "EUR",
    date: "Jul 9",
    kind: "purchase",
  },
  {
    id: "8",
    name: "Received from Tunde",
    description: "Dinner split",
    amount: 24.0,
    currency: "EUR",
    date: "Jul 8",
    kind: "receive",
  },
  {
    id: "9",
    name: "Uber",
    description: "Airport ride",
    amount: -18.4,
    currency: "EUR",
    date: "Jul 7",
    kind: "purchase",
  },
];

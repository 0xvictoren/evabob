/**
 * Amounts in words people read: two decimals and a currency sign.
 *
 * Notifications, activity rows and chat lines are written in dozens of
 * places, and most printed the raw number and ticker — "1.438849 USDC".
 * People see dollars and euros, rounded to the cent. Rather than trust every
 * writer to remember, the text is tidied where it is stored and sent.
 */

const TWO = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

function money(n: number, sign: string): string {
  return `${sign}${n.toLocaleString("en-US", TWO)}`;
}

/** "1.438849 USDC" → "$1.44", "20 EURC" → "€20.00". Leaves everything else. */
export function humanizeAmounts(text: string): string;
export function humanizeAmounts(text: string | undefined): string | undefined;
export function humanizeAmounts(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(
    /(?<![\w.$€])(\d{1,15}(?:\.\d+)?)\s?(USDC|EURC)\b/g,
    (whole, num: string, ticker: string) => {
      const n = Number(num);
      if (!Number.isFinite(n)) return whole;
      return money(n, ticker === "EURC" ? "€" : "$");
    },
  );
}

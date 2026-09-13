import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const sleekEase = [0.32, 0.72, 0, 1] as const;

export const settleSpring = {
  type: "spring" as const,
  stiffness: 180,
  damping: 22,
};

export function formatMoney(
  amount: number,
  currency: "EUR" | "USDC",
  opts?: { compact?: boolean }
) {
  const symbol = currency === "EUR" ? "€" : "";
  const suffix = currency === "USDC" ? " USDC" : "";
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = amount < 0 ? "−" : amount > 0 && opts?.compact ? "+" : "";
  if (currency === "EUR") return `${sign}${symbol}${formatted}`;
  return `${sign}${formatted}${suffix}`;
}

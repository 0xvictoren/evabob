"use client";

import { motion } from "framer-motion";
import {
  Music2,
  User,
  ArrowDownLeft,
  Repeat2,
  ShoppingBag,
  FileText,
} from "lucide-react";
import type { Transaction } from "@/lib/mock-data";
import { cn, formatMoney, sleekEase } from "@/lib/utils";

function txIcon(tx: Transaction) {
  switch (tx.kind) {
    case "subscription":
      return Music2;
    case "send":
      return User;
    case "receive":
      return ArrowDownLeft;
    case "exchange":
      return Repeat2;
    case "purchase":
      return ShoppingBag;
    case "request":
      return FileText;
    default:
      return User;
  }
}

type TransactionListProps = {
  items: Transaction[];
  className?: string;
};

/**
 * Flat surface card (#161A2E) — utility list, not heavy glass.
 * Amounts: mono + tabular-nums so columns never shift.
 */
export function TransactionList({ items, className }: TransactionListProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border border-white/[0.05] bg-navy-surface",
        className
      )}
    >
      {items.map((tx, i) => {
        const Icon = txIcon(tx);
        const positive = tx.amount > 0;
        // Color-coded amounts: incoming green, outgoing soft red
        const amountTone = positive ? "text-success" : "text-danger/90";
        return (
          <motion.div
            key={tx.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.4,
              ease: sleekEase,
              delay: i * 0.04,
            }}
            className={cn(
              "flex items-center gap-3 px-4 py-3.5",
              i < items.length - 1 && "border-b border-white/[0.04]"
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet/15 text-violet-soft">
              <Icon className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-chalk">{tx.name}</p>
              <p className="truncate text-xs text-chalk-muted">{tx.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "font-mono text-sm tabular-nums tracking-tight",
                  amountTone
                )}
              >
                {formatMoney(tx.amount, tx.currency, { compact: true })}
              </p>
              <p className="text-[11px] text-chalk-faint">{tx.date}</p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

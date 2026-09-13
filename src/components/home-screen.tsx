"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Bell,
  Eye,
  EyeOff,
  ArrowDownLeft,
  FileText,
  ArrowLeftRight,
  Building2,
  Plus,
} from "lucide-react";
import { AnimatedNumber } from "@/components/odometer";
import { Pressable } from "@/components/pressable";
import { TransactionList } from "@/components/transaction-list";
import {
  BALANCES,
  TRANSACTIONS,
  USER,
  type Currency,
} from "@/lib/mock-data";
import { cn, formatMoney, settleSpring, sleekEase } from "@/lib/utils";

const QUICK = [
  {
    label: "Receive",
    href: "/receive",
    icon: ArrowDownLeft,
    color: "text-accent-receive",
    bg: "bg-accent-receive/15",
  },
  {
    label: "Request",
    href: "/request",
    icon: FileText,
    color: "text-accent-request",
    bg: "bg-accent-request/15",
  },
  {
    label: "Exchange",
    href: "/exchange",
    icon: ArrowLeftRight,
    color: "text-accent-exchange",
    bg: "bg-accent-exchange/15",
  },
  {
    label: "Withdraw",
    href: "/withdraw",
    icon: Building2,
    color: "text-accent-withdraw",
    bg: "bg-accent-withdraw/15",
  },
] as const;

export function HomeScreen() {
  const [currency, setCurrency] = useState<Currency>("EUR");
  const [hidden, setHidden] = useState(false);

  const balance = BALANCES[currency];
  const balanceLabel = useMemo(() => {
    if (currency === "EUR") {
      return formatMoney(balance, "EUR").replace("€", "");
    }
    return balance.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }, [balance, currency]);

  const prefix = currency === "EUR" ? "€" : "";
  const suffix = currency === "USDC" ? " USDC" : "";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-4">
      {/* Header: avatar + Hello, [Name] · glass bell with unread alert */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-gradient text-sm font-semibold text-white shadow-glass-soft">
            {USER.initials}
          </div>
          <p className="text-[15px] font-medium text-chalk">
            Hello, {USER.firstName}
          </p>
        </div>
        <Pressable
          className="glass relative flex h-11 w-11 items-center justify-center rounded-full"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5 text-chalk" strokeWidth={1.75} />
          {USER.unread > 0 && (
            <span
              className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[#F87171] shadow-[0_0_10px_rgba(248,113,113,0.65)]"
              aria-label={`${USER.unread} unread`}
            />
          )}
        </Pressable>
      </header>

      {/* Balance hero */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: sleekEase }}
        className="glass-heavy relative overflow-hidden rounded-glass p-5"
      >
        <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-90" />
        <div className="relative z-10">
          <div className="flex items-center justify-between">
            <p className="text-sm text-chalk-muted">Your Balance</p>
            <Pressable
              bloom={false}
              onClick={() => setHidden((v) => !v)}
              className="glass-chip flex h-9 w-9 items-center justify-center rounded-full"
              aria-label={hidden ? "Show balance" : "Hide balance"}
            >
              {hidden ? (
                <EyeOff className="h-4 w-4 text-chalk-muted" />
              ) : (
                <Eye className="h-4 w-4 text-chalk-muted" />
              )}
            </Pressable>
          </div>

          <div className="mt-3 flex items-baseline gap-1.5">
            {prefix && (
              <span className="font-display text-3xl text-chalk/80 tabular">
                {prefix}
              </span>
            )}
            <AnimatedNumber
              value={balance}
              format={() => balanceLabel}
              blurred={hidden}
              className="text-[2.75rem] leading-none tracking-tight text-chalk sm:text-5xl"
            />
            {suffix && (
              <span className="font-display text-lg text-chalk-muted tabular">
                {suffix}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-chalk-faint">Updated moments ago</p>
        </div>
      </motion.section>

      {/* Fund / Send */}
      <div className="grid grid-cols-2 gap-3">
        <Link href="/fund" className="block">
          <motion.div
            whileTap={{ scale: 0.97 }}
            transition={settleSpring}
            className="flex h-12 items-center justify-center rounded-pill bg-violet-gradient font-medium text-white shadow-bloom"
          >
            Fund
          </motion.div>
        </Link>
        <Link href="/send" className="block">
          <motion.div
            whileTap={{ scale: 0.97 }}
            transition={settleSpring}
            className="gradient-rim glass flex h-12 items-center justify-center rounded-pill font-medium text-chalk"
          >
            <span className="relative z-10">Send</span>
          </motion.div>
        </Link>
      </div>

      {/* Currency strip */}
      <div className="flex items-center gap-2">
        {(["EUR", "USDC"] as Currency[]).map((c) => {
          const active = currency === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCurrency(c)}
              className={cn(
                "relative rounded-pill px-4 py-2 text-sm font-medium transition-colors duration-500 ease-sleek",
                active
                  ? "text-chalk"
                  : "glass-chip text-chalk-muted hover:text-chalk"
              )}
            >
              {c}
              {active && (
                <motion.span
                  layoutId="currency-underline"
                  className="absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full bg-violet-gradient"
                  transition={{ duration: 0.45, ease: sleekEase }}
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="ml-1 flex items-center gap-1 rounded-pill px-3 py-2 text-sm text-chalk-faint transition-colors duration-500 ease-sleek hover:text-chalk-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          Add currency
        </button>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-4 gap-3">
        {QUICK.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              className="flex flex-col items-center gap-2"
            >
              <motion.span
                whileTap={{ scale: 0.97 }}
                transition={settleSpring}
                className={cn(
                  "glass flex h-14 w-14 items-center justify-center rounded-full",
                  item.bg
                )}
              >
                <Icon className={cn("h-5 w-5", item.color)} strokeWidth={1.75} />
              </motion.span>
              <span className="text-xs text-chalk-muted">{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Recent activity — flat #161A2E, mono tabular amounts, See all in signal violet */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium text-chalk">
            Recent Transactions
          </h2>
          <Link
            href="/activity"
            className="text-sm font-medium text-violet-signal transition-opacity duration-500 ease-sleek hover:opacity-80"
          >
            See all
          </Link>
        </div>
        <TransactionList items={TRANSACTIONS.slice(0, 5)} />
      </section>
    </div>
  );
}

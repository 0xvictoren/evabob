"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { BALANCES } from "@/lib/mock-data";
import { AnimatedNumber } from "@/components/odometer";
import { sleekEase } from "@/lib/utils";

export default function WalletPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-6">
      <h1 className="text-2xl font-medium text-chalk">Wallet</h1>
      <p className="text-sm text-chalk-muted">
        Your balances across currencies — ready to send anytime.
      </p>

      <div className="flex flex-col gap-3">
        {(
          [
            { code: "EUR" as const, label: "Euro", amount: BALANCES.EUR },
            { code: "USDC" as const, label: "USDC", amount: BALANCES.USDC },
          ] as const
        ).map((c, i) => (
          <motion.div
            key={c.code}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: sleekEase, delay: i * 0.06 }}
            className="glass-heavy relative overflow-hidden rounded-glass p-5"
          >
            <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-40" />
            <div className="relative z-10 flex items-center justify-between">
              <div>
                <p className="text-xs text-chalk-muted">{c.label}</p>
                <p className="mt-1 text-sm font-medium text-chalk">{c.code}</p>
              </div>
              <div className="text-right">
                <div className="flex items-baseline justify-end gap-1">
                  {c.code === "EUR" && (
                    <span className="font-display text-xl text-chalk/70">€</span>
                  )}
                  <AnimatedNumber
                    value={c.amount}
                    className="text-2xl tracking-tight text-chalk"
                  />
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <Link
        href="/exchange"
        className="gradient-rim glass flex h-12 items-center justify-center rounded-pill font-medium text-chalk"
      >
        <span className="relative z-10">Exchange currencies</span>
      </Link>
    </div>
  );
}

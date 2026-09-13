"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDownUp, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { AnimatedNumber, CalcAmountDisplay } from "@/components/odometer";
import { AmountKeypad } from "@/components/amount-keypad";
import { applyKey, emptyCalc } from "@/lib/calculator";
import { BALANCES, FX_RATE, type Currency } from "@/lib/mock-data";
import { cn, settleSpring, sleekEase } from "@/lib/utils";

export function ExchangeScreen() {
  const [from, setFrom] = useState<Currency>("EUR");
  const [to, setTo] = useState<Currency>("USDC");
  const [calc, setCalc] = useState(emptyCalc);
  const [rate, setRate] = useState(FX_RATE);
  const [swapTurns, setSwapTurns] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      const drift = (Math.random() - 0.5) * 0.004;
      setRate(Math.round((FX_RATE + drift) * 10000) / 10000);
    }, 10000);
    return () => clearInterval(id);
  }, []);

  const amount = calc.value ?? 0;
  const converted = useMemo(() => {
    if (from === "EUR" && to === "USDC") return amount * rate;
    if (from === "USDC" && to === "EUR") return amount / rate;
    return amount;
  }, [amount, from, to, rate]);

  const canExchange = amount > 0 && amount <= BALANCES[from];

  function flip() {
    setFrom(to);
    setTo(from);
    setSwapTurns((t) => t + 1);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-32 pt-4">
      <header className="flex items-center gap-3">
        <Link
          href="/home"
          className="glass flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft className="h-5 w-5 text-chalk" />
        </Link>
        <h1 className="text-lg font-medium text-chalk">Exchange</h1>
      </header>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: sleekEase }}
        className="relative flex flex-col gap-3"
      >
        {/* You send — money moment = heavy glass */}
        <div className="glass-heavy relative overflow-hidden rounded-glass p-4">
          <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-50" />
          <div className="relative z-10">
            <div className="flex items-center justify-between">
              <p className="text-xs text-chalk-muted">You send</p>
              <span className="glass-chip rounded-pill px-2.5 py-1 text-xs font-medium text-chalk">
                {from}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              {from === "EUR" && (
                <span className="font-display text-2xl text-chalk/70 tabular-nums">
                  €
                </span>
              )}
              <CalcAmountDisplay
                display={calc.display}
                value={calc.value}
                className="text-4xl tracking-tight text-chalk"
              />
            </div>
            <p className="mt-1 text-xs text-chalk-faint tabular-nums">
              Available{" "}
              {from === "EUR"
                ? `€${BALANCES.EUR.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                : `${BALANCES.USDC.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC`}
            </p>
          </div>
        </div>

        {/* Swap — circular glass, rotates 180° with soft spring */}
        <div className="relative z-20 -my-1.5 flex justify-center">
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            animate={{ rotate: swapTurns * 180 }}
            transition={settleSpring}
            onClick={flip}
            className="glass flex h-11 w-11 items-center justify-center rounded-full shadow-glass-soft"
            aria-label="Swap currencies"
          >
            <ArrowDownUp className="h-4 w-4 text-violet-soft" />
          </motion.button>
        </div>

        {/* They receive */}
        <div className="glass-heavy relative overflow-hidden rounded-glass p-4">
          <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-30" />
          <div className="relative z-10">
            <div className="flex items-center justify-between">
              <p className="text-xs text-chalk-muted">They receive</p>
              <span className="glass-chip rounded-pill px-2.5 py-1 text-xs font-medium text-chalk">
                {to}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              {to === "EUR" && (
                <span className="font-display text-2xl text-chalk/70 tabular-nums">
                  €
                </span>
              )}
              <AnimatedNumber
                value={converted}
                className="text-4xl tracking-tight text-chalk"
              />
              {to === "USDC" && (
                <span className="font-display text-base text-chalk-muted">
                  USDC
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Live rate ticker — mono, pulse dot not blink */}
      <div className="flex items-center justify-center gap-2 text-xs text-chalk-muted">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-violet-soft"
          aria-hidden
        />
        <span className="font-mono tabular-nums tracking-tight">
          1 EUR ≈ {rate.toFixed(2)} USDC · updates every 10s
        </span>
      </div>

      {/* Max / quick amounts — glass pills */}
      <div className="flex flex-wrap gap-2">
        {["25", "50", "100", "Max"].map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              if (q === "Max") {
                const max = BALANCES[from];
                setCalc({
                  expression: String(max),
                  display: max.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  }),
                  value: max,
                  error: false,
                });
              } else {
                setCalc({
                  expression: q,
                  display: q,
                  value: Number(q),
                  error: false,
                });
              }
            }}
            className="glass-chip rounded-pill px-3.5 py-1.5 text-xs font-medium text-chalk-muted transition-colors duration-500 ease-sleek hover:text-chalk"
          >
            {q === "Max" ? "Max" : from === "EUR" ? `€${q}` : q}
          </button>
        ))}
      </div>

      <AmountKeypad onKey={(k) => setCalc((s) => applyKey(s, k))} />

      {/* CTA — gradient when ready; glass @ 40% when disabled (not flat grey) */}
      <motion.button
        type="button"
        whileTap={canExchange ? { scale: 0.97 } : undefined}
        transition={settleSpring}
        disabled={!canExchange}
        className={cn(
          "mt-1 flex h-14 w-full items-center justify-center rounded-pill font-medium transition-all duration-500 ease-sleek",
          canExchange
            ? "bg-violet-gradient text-white shadow-bloom"
            : "glass text-chalk/80 opacity-40"
        )}
      >
        Exchange
      </motion.button>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { AnimatedNumber, CalcAmountDisplay } from "@/components/odometer";
import { AmountKeypad } from "@/components/amount-keypad";
import { applyKey, emptyCalc } from "@/lib/calculator";
import { BALANCES, FX_RATE, type Currency } from "@/lib/mock-data";
import { cn, settleSpring, sleekEase } from "@/lib/utils";

type AmountFlowProps = {
  mode: "send" | "fund";
  defaultCurrency?: Currency;
};

export function AmountFlow({
  mode,
  defaultCurrency = "EUR",
}: AmountFlowProps) {
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [calc, setCalc] = useState(emptyCalc);
  const [recipient, setRecipient] = useState("");

  const amount = calc.value ?? 0;
  const fxLine = useMemo(() => {
    if (currency === "EUR") return amount * FX_RATE;
    return amount / FX_RATE;
  }, [amount, currency]);

  const title = mode === "send" ? "Send" : "Fund";
  const canSubmit =
    amount > 0 && (mode === "fund" || recipient.trim().length > 0);

  const cta = (() => {
    if (amount <= 0) return "Enter amount";
    const n =
      currency === "EUR"
        ? `€${calc.display}`
        : `${calc.display} USDC`;
    return mode === "send" ? `Send ${n}` : `Fund ${n}`;
  })();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-32 pt-4">
      <header className="flex items-center gap-3">
        <Link
          href="/home"
          className="glass flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft className="h-5 w-5 text-chalk" />
        </Link>
        <h1 className="text-lg font-medium text-chalk">{title}</h1>
      </header>

      {mode === "send" && (
        <div className="glass rounded-card p-3.5">
          <label className="text-xs text-chalk-muted">To</label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Phone, email, or @handle"
            className="mt-1 w-full bg-transparent text-base text-chalk outline-none placeholder:text-chalk-faint"
          />
        </div>
      )}

      {/* Large display-font amount + live FX */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: sleekEase }}
        className="glass-heavy relative overflow-hidden rounded-glass px-4 py-6 text-center"
      >
        <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-60" />
        <div className="relative z-10">
          <div className="mb-3 flex justify-center gap-2">
            {(["EUR", "USDC"] as Currency[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={cn(
                  "rounded-pill px-3 py-1 text-xs font-medium transition-colors duration-500 ease-sleek",
                  currency === c
                    ? "bg-violet/25 text-violet-soft"
                    : "text-chalk-muted"
                )}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-center gap-1">
            {currency === "EUR" && (
              <span className="font-display text-4xl text-chalk/70 tabular-nums">
                €
              </span>
            )}
            <CalcAmountDisplay
              display={calc.display}
              value={calc.value}
              className="text-5xl tracking-tight text-chalk"
            />
          </div>

          {/* Slim FX line — rolling digits, never hard swap */}
          <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-chalk-muted">
            <span>≈</span>
            {currency === "EUR" ? (
              <>
                <AnimatedNumber
                  value={fxLine}
                  className="text-sm text-chalk-muted"
                />
                <span>USDC</span>
              </>
            ) : (
              <>
                <span>€</span>
                <AnimatedNumber
                  value={fxLine}
                  className="text-sm text-chalk-muted"
                />
              </>
            )}
          </p>

          {calc.expression && /[+\-×÷*/]/.test(calc.expression) && (
            <p className="mt-1.5 font-mono text-xs tabular-nums text-chalk-faint">
              {calc.expression.replace(/\*/g, "×").replace(/\//g, "÷")}
            </p>
          )}
        </div>
      </motion.div>

      {/* Max / quick amounts — glass pills above keypad */}
      <div className="flex flex-wrap justify-center gap-2">
        {["10", "25", "50", "100", "Max"].map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              if (q === "Max") {
                const max = BALANCES[currency];
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
            {q === "Max" ? "Max" : currency === "EUR" ? `€${q}` : q}
          </button>
        ))}
      </div>

      {/* Soft glass keypad — digits + arithmetic */}
      <AmountKeypad onKey={(k) => setCalc((s) => applyKey(s, k))} />

      <motion.button
        type="button"
        whileTap={canSubmit ? { scale: 0.97 } : undefined}
        transition={settleSpring}
        disabled={!canSubmit}
        className={cn(
          "flex h-14 w-full items-center justify-center rounded-pill font-medium transition-all duration-500 ease-sleek",
          canSubmit
            ? "bg-violet-gradient text-white shadow-bloom"
            : "glass text-chalk/80 opacity-40"
        )}
      >
        {cta}
      </motion.button>

      {mode === "send" && (
        <p className="text-center text-[11px] text-chalk-faint">
          Protected transfer · delivery fee shown before you confirm
        </p>
      )}
    </div>
  );
}

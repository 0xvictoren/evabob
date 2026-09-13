"use client";

import { motion } from "framer-motion";
import { Delete } from "lucide-react";
import { settleSpring } from "@/lib/utils";
import { cn } from "@/lib/utils";

const KEYS: (string | { label: string; key: string })[][] = [
  ["1", "2", "3", "÷"],
  ["4", "5", "6", "×"],
  ["7", "8", "9", "−"],
  [".", "0", "⌫", "+"],
];

type AmountKeypadProps = {
  onKey: (key: string) => void;
  className?: string;
};

export function AmountKeypad({ onKey, className }: AmountKeypadProps) {
  return (
    <div className={cn("grid grid-cols-4 gap-2.5", className)}>
      {KEYS.flat().map((k) => {
        const key = typeof k === "string" ? k : k.key;
        const label = typeof k === "string" ? k : k.label;
        const isOp = ["+", "−", "×", "÷"].includes(key);
        const isUtil = key === "⌫";

        return (
          <motion.button
            key={key}
            type="button"
            whileTap={{ scale: 0.97 }}
            transition={settleSpring}
            onClick={() => onKey(key === "⌫" ? "⌫" : key)}
            className={cn(
              "glass-chip flex h-14 items-center justify-center rounded-2xl font-display text-xl tabular-nums text-chalk shadow-glass-soft active:shadow-bloom",
              isOp && "text-violet-soft",
              isUtil && "text-chalk-muted"
            )}
            aria-label={key === "⌫" ? "Backspace" : key}
          >
            {key === "⌫" ? <Delete className="h-5 w-5" /> : label}
          </motion.button>
        );
      })}
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        transition={settleSpring}
        onClick={() => onKey("=")}
        className="col-span-3 flex h-14 items-center justify-center rounded-2xl bg-violet-gradient font-display text-lg font-medium text-white shadow-bloom"
      >
        =
      </motion.button>
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        transition={settleSpring}
        onClick={() => onKey("C")}
        className="glass-chip flex h-14 items-center justify-center rounded-2xl text-sm font-medium text-chalk-muted"
      >
        C
      </motion.button>
    </div>
  );
}

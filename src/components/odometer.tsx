"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { cn, settleSpring } from "@/lib/utils";

type OdometerProps = {
  value: string;
  className?: string;
  blurred?: boolean;
};

/**
 * Soft rolling odometer for display amounts.
 * Digit columns animate with low-stiffness spring — never a hard cut.
 */
export function Odometer({ value, className, blurred }: OdometerProps) {
  const chars = useMemo(() => value.split(""), [value]);

  return (
    <span
      className={cn(
        "font-display inline-flex items-baseline overflow-hidden transition-[filter] duration-500 ease-sleek",
        "tabular-nums",
        blurred && "select-none",
        className
      )}
      style={blurred ? { filter: "blur(10px)" } : { filter: "blur(0px)" }}
      aria-label={blurred ? "Balance hidden" : value}
    >
      {chars.map((char, i) =>
        /[0-9]/.test(char) ? (
          <Digit key={`d-${i}`} digit={char} />
        ) : (
          <span key={`c-${i}-${char}`} className="inline-block px-[0.02em]">
            {char}
          </span>
        )
      )}
    </span>
  );
}

function Digit({ digit }: { digit: string }) {
  const n = Number(digit);

  return (
    <span className="relative inline-block h-[1em] w-[0.62em] overflow-hidden align-baseline">
      <motion.span
        className="absolute left-0 top-0 flex flex-col will-change-transform"
        initial={false}
        animate={{ y: `-${n}em` }}
        transition={settleSpring}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className="flex h-[1em] w-[0.62em] items-center justify-center leading-none"
          >
            {i}
          </span>
        ))}
      </motion.span>
      <span className="invisible">0</span>
    </span>
  );
}

type AnimatedNumberProps = {
  value: number;
  format?: (n: number) => string;
  className?: string;
  blurred?: boolean;
};

export function AnimatedNumber({
  value,
  format = (n) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  className,
  blurred,
}: AnimatedNumberProps) {
  return (
    <Odometer value={format(value)} className={className} blurred={blurred} />
  );
}

/** Display calc amount: rolls when numeric, shows expression while typing ops */
export function CalcAmountDisplay({
  display,
  value,
  className,
}: {
  display: string;
  value: number | null;
  className?: string;
}) {
  const isNumericResolved =
    value !== null && !/[+\-×÷*/]/.test(display.replace(/[,.]/g, ""));

  if (isNumericResolved && value !== null) {
    return (
      <AnimatedNumber
        value={value}
        format={(n) =>
          n.toLocaleString("en-US", {
            minimumFractionDigits: n % 1 === 0 ? 0 : 2,
            maximumFractionDigits: 2,
          })
        }
        className={className}
      />
    );
  }

  return (
    <span
      className={cn(
        "font-display tabular-nums tracking-tight text-chalk",
        className
      )}
    >
      {display}
    </span>
  );
}

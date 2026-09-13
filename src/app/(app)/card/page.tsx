"use client";

import { motion } from "framer-motion";
import { sleekEase } from "@/lib/utils";

export default function CardPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-6">
      <h1 className="text-2xl font-medium text-chalk">Card</h1>
      <p className="text-sm text-chalk-muted">
        An Evabob card for everyday spend — coming soon.
      </p>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: sleekEase }}
        className="relative aspect-[1.586/1] overflow-hidden rounded-glass bg-violet-gradient p-6 shadow-bloom"
      >
        <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-40 mix-blend-soft-light" />
        <div className="relative z-10 flex h-full flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold tracking-wide text-white/90">
              Evabob
            </span>
            <span className="rounded-pill bg-white/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/80">
              Virtual
            </span>
          </div>
          <div>
            <p className="font-display text-lg tracking-[0.2em] text-white/90 tabular">
              •••• •••• •••• 4280
            </p>
            <p className="mt-2 text-xs text-white/70">Victor En</p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

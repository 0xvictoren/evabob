"use client";

import Link from "next/link";
import { ChevronLeft, Building2 } from "lucide-react";
import { motion } from "framer-motion";
import { settleSpring } from "@/lib/utils";

export default function WithdrawPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-4">
      <header className="flex items-center gap-3">
        <Link
          href="/home"
          className="glass flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft className="h-5 w-5 text-chalk" />
        </Link>
        <h1 className="text-lg font-medium text-chalk">Withdraw</h1>
      </header>

      <div className="glass-heavy rounded-glass p-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-withdraw/15">
          <Building2 className="h-5 w-5 text-accent-withdraw" />
        </div>
        <h2 className="mt-4 text-lg font-medium text-chalk">
          Bank account
        </h2>
        <p className="mt-1 text-sm text-chalk-muted">
          Move funds to your linked bank. Delivery usually completes within a
          few business hours.
        </p>
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={settleSpring}
          className="mt-6 flex h-12 w-full items-center justify-center rounded-pill bg-violet-gradient font-medium text-white shadow-bloom"
        >
          Continue
        </motion.button>
      </div>
    </div>
  );
}

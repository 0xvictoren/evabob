"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Home, Wallet, Activity, CreditCard, Send } from "lucide-react";
import { cn, settleSpring, sleekEase } from "@/lib/utils";

const tabs = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/send", label: "Send", icon: Send, center: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/card", label: "Card", icon: CreditCard },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.65rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto relative w-full max-w-md">
        {/* Bar sits under the raised center action */}
        <div className="glass-heavy relative flex h-[4.25rem] items-center justify-between rounded-[1.75rem] px-2 pt-1">
          {tabs.map((tab) => {
            const active =
              pathname === tab.href ||
              (tab.href !== "/home" && pathname.startsWith(tab.href));
            const Icon = tab.icon;

            if ("center" in tab && tab.center) {
              return (
                <div
                  key={tab.href}
                  className="relative flex w-[4.5rem] flex-col items-center"
                >
                  {/* Raised violet gradient send / @ action */}
                  <Link
                    href={tab.href}
                    aria-label="Send"
                    className="absolute -top-8 left-1/2 -translate-x-1/2"
                  >
                    <motion.span
                      whileTap={{ scale: 0.97 }}
                      transition={settleSpring}
                      className="relative flex h-[3.75rem] w-[3.75rem] items-center justify-center rounded-full bg-violet-gradient shadow-bloom ring-[6px] ring-[#0A0A12]"
                    >
                      <Send
                        className="h-5 w-5 -translate-x-px translate-y-px text-white"
                        strokeWidth={2.25}
                      />
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-navy-surface text-[10px] font-semibold text-violet-soft ring-2 ring-violet/40">
                        @
                      </span>
                    </motion.span>
                  </Link>
                  <span className="mt-8 text-[10px] font-medium text-chalk-muted">
                    {tab.label}
                  </span>
                </div>
              );
            }

            return (
              <Link
                key={tab.href}
                href={tab.href}
                className="relative flex min-w-[3.25rem] flex-1 flex-col items-center gap-0.5 py-1"
              >
                <motion.span
                  whileTap={{ scale: 0.97 }}
                  transition={settleSpring}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-500 ease-sleek",
                    active ? "text-violet-soft" : "text-chalk-faint"
                  )}
                >
                  <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                </motion.span>
                <span
                  className={cn(
                    "text-[10px] font-medium transition-colors duration-500 ease-sleek",
                    active ? "text-chalk" : "text-chalk-faint"
                  )}
                >
                  {tab.label}
                </span>
                {active && (
                  <motion.span
                    layoutId="nav-dot"
                    className="absolute bottom-0 h-1 w-1 rounded-full bg-violet"
                    transition={{ duration: 0.45, ease: sleekEase }}
                  />
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

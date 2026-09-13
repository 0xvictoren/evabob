"use client";

import Link from "next/link";
import { ChevronLeft, Copy } from "lucide-react";
import { Pressable } from "@/components/pressable";
import { USER } from "@/lib/mock-data";

export default function ReceivePage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-4">
      <header className="flex items-center gap-3">
        <Link
          href="/home"
          className="glass flex h-10 w-10 items-center justify-center rounded-full"
        >
          <ChevronLeft className="h-5 w-5 text-chalk" />
        </Link>
        <h1 className="text-lg font-medium text-chalk">Receive</h1>
      </header>

      <div className="glass-heavy relative overflow-hidden rounded-glass p-6 text-center">
        <div className="pointer-events-none absolute inset-0 bg-mesh-ambient opacity-50" />
        <div className="relative z-10">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-violet-gradient text-lg font-semibold text-white">
            {USER.initials}
          </div>
          <p className="text-sm text-chalk-muted">Share your handle</p>
          <p className="mt-2 font-display text-2xl text-chalk">
            @{USER.firstName.toLowerCase()}
          </p>
          <Pressable className="glass-chip mx-auto mt-5 flex items-center gap-2 rounded-pill px-4 py-2.5 text-sm text-chalk">
            <Copy className="h-4 w-4 text-violet-soft" />
            Copy handle
          </Pressable>
        </div>
      </div>
    </div>
  );
}

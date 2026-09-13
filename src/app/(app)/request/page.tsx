"use client";

import { AmountFlow } from "@/components/amount-flow";

/** Request reuses amount entry bones with send mode styling for now. */
export default function RequestPage() {
  return <AmountFlow mode="send" />;
}

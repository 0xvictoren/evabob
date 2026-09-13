"use client";

import { TRANSACTIONS } from "@/lib/mock-data";
import { TransactionList } from "@/components/transaction-list";

export default function ActivityPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-32 pt-6">
      <h1 className="text-2xl font-medium text-chalk">Activity</h1>
      <p className="text-sm text-chalk-muted">
        Every transfer, purchase, and conversion in one place.
      </p>
      <TransactionList items={TRANSACTIONS} />
    </div>
  );
}

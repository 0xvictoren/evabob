/**
 * Run a read, retrying once on a transient error.
 *
 * Returns null when the value genuinely could not be read — never a zero value.
 * A failed read and an empty result are different facts, and collapsing them
 * makes a funded wallet render as zero every time an RPC hiccups.
 */
export async function readOrNull<T>(
  read: () => Promise<T>,
  { retryDelayMs = 150 }: { retryDelayMs?: number } = {},
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await read();
    } catch {
      if (attempt === 0 && retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  return null;
}

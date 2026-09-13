/**
 * JSON cannot serialize BigInt. Convert every bigint to decimal string so
 * Hono `c.json()` and `JSON.stringify` never throw:
 *   "Do not know how to serialize a BigInt"
 */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as T;
}

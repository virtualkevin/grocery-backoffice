/** Exact non-negative rational rounding; only final monetary totals round. */
export function roundCents(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("Invalid exact monetary ratio");
  const value = (numerator * 2n + denominator) / (denominator * 2n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Monetary overflow");
  return Number(value);
}
export function landedTotal(
  casePriceCents: number,
  cases: number,
  freightCents: number,
): number {
  for (const n of [casePriceCents, cases, freightCents])
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("Invalid integer money or quantity");
  if (cases === 0) throw new Error("Quantity must be positive");
  return roundCents(
    BigInt(casePriceCents) * BigInt(cases) + BigInt(freightCents),
    1n,
  );
}
export function promotionExposure(
  landedCostCents: number,
  quantity: number,
  retailCents: number,
  cap: number,
): number {
  if (
    ![landedCostCents, quantity, retailCents, cap].every(
      Number.isSafeInteger,
    ) ||
    quantity <= 0 ||
    cap < 0 ||
    cap > quantity ||
    retailCents < 0
  )
    throw new Error("Invalid promotion quantities");
  const loss = BigInt(landedCostCents) - BigInt(retailCents) * BigInt(quantity);
  return loss <= 0n ? 0 : roundCents(loss * BigInt(cap), BigInt(quantity));
}

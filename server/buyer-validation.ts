import type { PublicQuote } from "../shared/types.js";
export interface BuyerChoice {
  skuId: string;
  quoteId: string;
  counterofferCasePriceCents?: number;
}
export function validateBuyerChoices(
  result: unknown,
  items: { skuId: string }[],
  quotes: Pick<PublicQuote, "id" | "skuId" | "casePriceCents">[],
) {
  const raw = (result as { choices?: unknown } | null)?.choices;
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  const accepted = new Map<string, BuyerChoice>();
  const issues: { skuId: string; reason: string }[] = [];
  for (const item of items) {
    const matches = rows.filter(
      (row) =>
        row &&
        typeof row === "object" &&
        (row as BuyerChoice).skuId === item.skuId,
    ) as BuyerChoice[];
    if (matches.length !== 1) {
      issues.push({
        skuId: item.skuId,
        reason: matches.length ? "Duplicate SKU choices" : "Missing SKU choice",
      });
      continue;
    }
    const choice = matches[0]!;
    const quote = quotes.find((q) => q.id === choice.quoteId);
    if (!quote || quote.skuId !== item.skuId) {
      issues.push({
        skuId: item.skuId,
        reason: quote
          ? "Selected quote belongs to another SKU"
          : "Selected quote ID is not an allowed offer",
      });
      continue;
    }
    const bid = choice.counterofferCasePriceCents;
    if (
      bid !== undefined &&
      (!Number.isSafeInteger(bid) || bid <= 0 || bid > quote.casePriceCents)
    ) {
      issues.push({
        skuId: item.skuId,
        reason:
          "Counteroffer must be positive integer cents per case, no greater than the selected case price",
      });
      continue;
    }
    accepted.set(item.skuId, {
      skuId: item.skuId,
      quoteId: quote.id,
      ...(bid !== undefined ? { counterofferCasePriceCents: bid } : {}),
    });
  }
  return { accepted, issues };
}

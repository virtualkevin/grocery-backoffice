import test from "node:test";
import assert from "node:assert/strict";
import { validateBuyerChoices } from "../server/buyer-validation.js";
test("actual live cross-SKU strawberry choice is quarantined without discarding valid lines", () => {
  const wrongQuote = "659bde43-0b05-4063-8fa4-5548cf3170af";
  const correctQuote = "48712b03-e871-4c12-a300-3cb596609bde";
  const quotes = [
    { id: wrongQuote, skuId: "raspberries", casePriceCents: 3665 },
    { id: correctQuote, skuId: "strawberries", casePriceCents: 3960 },
    { id: "valid-apple-quote", skuId: "apples", casePriceCents: 2800 },
  ];
  const good = {
    skuId: "apples",
    quoteId: "valid-apple-quote",
    counterofferCasePriceCents: 2500,
  };
  const checked = validateBuyerChoices(
    {
      choices: [
        good,
        {
          skuId: "strawberries",
          quoteId: wrongQuote,
          counterofferCasePriceCents: 2700,
        },
      ],
    },
    [{ skuId: "apples" }, { skuId: "strawberries" }],
    quotes,
  );
  assert.deepEqual(checked.accepted.get("apples"), good);
  assert.deepEqual(checked.issues, [
    { skuId: "strawberries", reason: "Selected quote belongs to another SKU" },
  ]);
  const repaired = validateBuyerChoices(
    {
      choices: [
        {
          skuId: "strawberries",
          quoteId: correctQuote,
          counterofferCasePriceCents: 2700,
        },
      ],
    },
    [{ skuId: "strawberries" }],
    quotes.filter((q) => q.skuId === "strawberries"),
  );
  assert.equal(repaired.issues.length, 0);
  assert.equal(
    repaired.accepted.get("strawberries")?.counterofferCasePriceCents,
    2700,
  );
});

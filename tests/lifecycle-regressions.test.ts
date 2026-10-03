import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, Engine, type ProviderBridge } from "../server/engine.js";
import type { AgentEnvelope, PlanItem, PublicQuote, RoleId } from "../shared/types.js";

test("a newer supplier revision fences older acceptance without spending budget or stock", () => {
  const engine = new Engine(":memory:", 0);
  try {
    const run = engine.create({ mode: "simulation" }, false);
    engine.plan(run.id);
    const original = engine.makeQuote(run.id, "supplier-wholesale", "apples", undefined, 0);
    const revised = engine.makeQuote(run.id, "supplier-wholesale", "apples", undefined, 1);
    engine.addQuote(run.id, original);
    engine.addQuote(run.id, revised);
    const before = engine.snapshot(run.id).budget;
    const stock = () => engine.db.prepare("SELECT quantity FROM stock WHERE run_id=? AND supplier_id=? AND sku_id=?").get(run.id, original.supplierId, original.skuId)?.quantity;
    const initialStock = stock();
    assert.throws(() => engine.commit(run.id, original.id), /revision|supersed|stale/i);
    assert.deepEqual(engine.snapshot(run.id).budget, before);
    assert.equal(stock(), initialStock);
    assert.equal(engine.snapshot(run.id).decisions.length, 0);
    const decision = engine.commit(run.id, revised.id);
    assert.equal(decision.quoteId, revised.id);
    assert.equal(stock(), Number(initialStock) - revised.quantity);
    assert.equal(engine.commit(run.id, revised.id).id, decision.id);
    assert.equal(stock(), Number(initialStock) - revised.quantity);
  } finally { engine.close(); }
});

test("a quote expiring between receipt and commit cannot debit the ledger", () => {
  const engine = new Engine(":memory:", 0);
  const now = Date.now;
  try {
    const run = engine.create({ mode: "simulation" }, false);
    engine.plan(run.id);
    const quote = engine.makeQuote(run.id, "supplier-wholesale", "apples");
    engine.addQuote(run.id, quote);
    const before = engine.snapshot(run.id).budget;
    Date.now = () => Date.parse(quote.expiresAt) + 1;
    assert.throws(() => engine.commit(run.id, quote.id), /expired/i);
    assert.deepEqual(engine.snapshot(run.id).budget, before);
    assert.equal(engine.snapshot(run.id).decisions.length, 0);
  } finally { Date.now = now; engine.close(); }
});

/** Explicit in-process test transport: no Band socket or paid model calls. */
class TimeoutBridge implements ProviderBridge {
  handler?: (message: AgentEnvelope) => Promise<void> | void;
  errors: unknown[] = [];
  timedOut = false;
  async start() {}
  async stop() {}
  status() { return { live: true, source: "in-process-test-only" }; }
  onMessage(handler: (message: AgentEnvelope) => Promise<void> | void) {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }
  async send(message: AgentEnvelope) {
    const payload = message.payload as { lines?: { skuId: string }[] };
    if (message.type === "counteroffer" && payload.lines?.some(line => line.skuId === "avocados")) {
      this.timedOut = true;
      throw new DomainError("Injected supplier transport timed out", 504);
    }
    queueMicrotask(() => { void Promise.resolve(this.handler?.(message)).catch(error => this.errors.push(error)); });
    return { source: "in-process-test-only" };
  }
  async reason(_role: RoleId, raw: unknown): Promise<unknown> {
    const context = raw as any;
    switch (context.kind) {
      case "manager_plan": return { allocations: context.data.items.map((item: PlanItem) => ({ skuId: item.skuId, allocationCents: item.allocationCents })) };
      case "supplier_quotes": return { quotes: context.data.request.lines.map((line: { skuId: string; casePriceCents?: number }) => {
        const state = context.data.privateState.find((entry: any) => entry.skuId === line.skuId);
        return { skuId: line.skuId, casePriceCents: line.casePriceCents === undefined ? state.targetCaseCents : Math.max(line.casePriceCents, state.floorCaseCents) };
      }) };
      case "buyer_decision": return { choices: context.data.items.map((item: PlanItem) => {
        const quote = (context.data.quotes as PublicQuote[]).filter(offer => offer.skuId === item.skuId).sort((a, b) => a.landedCostCents - b.landedCostCents)[0]!;
        return { skuId: item.skuId, quoteId: quote.id, ...(item.spotlight ? { counterofferCasePriceCents: Math.floor(quote.casePriceCents * 0.9) } : {}) };
      }) };
      case "buyer_counteroffer": return { casePriceCents: Math.floor(context.data.currentQuote.casePriceCents * 0.65) };
      case "manager_budget": return { approve: true };
      default: throw new Error("Unexpected test reasoning kind");
    }
  }
}

test("one supplier exchange timeout preserves earlier purchases and resolves later SKU decisions", async () => {
  const engine = new Engine(":memory:", 0);
  const bridge = new TimeoutBridge();
  engine.attachBridge(bridge);
  try {
    const run = engine.create({ mode: "live" }, false);
    await engine.execute(run.id);
    const result = engine.snapshot(run.id);
    assert.equal(bridge.timedOut, true);
    assert.deepEqual(bridge.errors, []);
    assert.equal(result.status, "reviewing");
    assert.equal(result.decisions.length, 24);
    assert.equal(result.decisions.find(decision => decision.skuId === "avocados")?.outcome, "failed");
    assert.equal(result.decisions.find(decision => decision.skuId === "apples")?.outcome, "accepted");
    assert.equal(result.decisions.find(decision => decision.skuId === "mushrooms")?.outcome, "accepted");
    assert.equal(result.decisions.filter(decision => decision.outcome === "failed").length, 1);
    assert.equal(result.budget.reservedCents, 0);
    assert.equal(result.budget.committedCents, result.decisions.reduce((sum, decision) => sum + decision.committedCostCents, 0));
    assert.equal(result.budget.totalCents, result.budget.committedCents + result.budget.unallocatedCents);
    assert.equal(Number(engine.db.prepare("SELECT COUNT(*) count FROM purchases").get()?.count), 23);
  } finally { engine.close(); }
});

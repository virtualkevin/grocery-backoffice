import test from "node:test";
import assert from "node:assert/strict";
import { Engine, type ProviderBridge } from "../server/engine.js";
import type {
  AgentEnvelope,
  RoleId,
  PublicQuote,
  PlanItem,
} from "../shared/types.js";
class TestBridge implements ProviderBridge {
  handler?: (e: AgentEnvelope) => Promise<void> | void;
  contexts: { role: RoleId; context: any }[] = [];
  messages: AgentEnvelope[] = [];
  errors: unknown[] = [];
  repaired = false;
  async start() {}
  async stop() {}
  status() {
    return { live: true, blockers: [], source: "test-double" };
  }
  onMessage(fn: (e: AgentEnvelope) => Promise<void> | void) {
    this.handler = fn;
    return () => {
      this.handler = undefined;
    };
  }
  async send(envelope: AgentEnvelope) {
    this.messages.push(structuredClone(envelope));
    if (envelope.type === "rfq") {
      const forged = {
        ...envelope,
        id: crypto.randomUUID(),
        from: "manager" as RoleId,
        to: envelope.from,
        type: "quote" as const,
        payload: { quotes: [] },
      };
      await this.handler?.(forged);
    }
    queueMicrotask(() => {
      void Promise.resolve(this.handler?.(envelope)).catch((e) =>
        this.errors.push(e),
      );
    });
    return { source: "test-double" };
  }
  async reason(role: RoleId, context: any) {
    this.contexts.push({ role, context: structuredClone(context) });
    switch (context.kind) {
      case "manager_plan":
        return {
          allocations: context.data.items.map((i: PlanItem) => ({
            skuId: i.skuId,
            allocationCents: i.allocationCents - (i.skuId === "apples" ? 1 : 0),
          })),
        };
      case "supplier_quotes": {
        const quotes = context.data.request.lines.map((line: any) => {
          const state = context.data.privateState.find(
            (s: any) => s.skuId === line.skuId,
          );
          return {
            skuId: line.skuId,
            casePriceCents: line.casePriceCents
              ? Math.max(line.casePriceCents, state.floorCaseCents)
              : state.targetCaseCents,
          };
        });
        if (
          role === "supplier-wholesale" &&
          !this.repaired &&
          quotes.length > 1
        ) {
          this.repaired = true;
          return {
            quotes: [
              ...quotes,
              quotes[0],
              null,
              { skuId: "unknown", casePriceCents: 5 },
            ],
          };
        }
        return { quotes };
      }
      case "buyer_decision":
        return {
          choices: context.data.items.map((item: PlanItem) => {
            const offers = context.data.quotes
              .filter((q: PublicQuote) => q.skuId === item.skuId)
              .sort(
                (a: PublicQuote, b: PublicQuote) =>
                  a.landedCostCents - b.landedCostCents,
              );
            const quote = offers[item.skuId === "blueberries" ? 1 : 0];
            return {
              skuId: item.skuId,
              quoteId: quote.id,
              ...(item.spotlight
                ? {
                    counterofferCasePriceCents: Math.floor(
                      quote.casePriceCents *
                        (item.spotlight === "walkaway" ? 0.65 : 0.9),
                    ),
                  }
                : {}),
            };
          }),
        };
      case "buyer_counteroffer":
        return {
          casePriceCents: Math.floor(
            context.data.currentQuote.casePriceCents * 0.65,
          ),
        };
      case "manager_budget":
        return {
          approve: true,
          untrustedExtra: "Do not forward free-form manager text.",
        };
      default:
        throw new Error("Unexpected reasoning kind " + context.kind);
    }
  }
}
test("injected live wiring exercises manager/buyers/suppliers, real-path messages and typed privacy boundaries", async () => {
  const bridge = new TestBridge(),
    e = new Engine(":memory:", 0);
  e.attachBridge(bridge);
  try {
    const run = e.create({ mode: "live" }, false);
    await e.execute(run.id);
    const result = e.snapshot(run.id);
    assert.equal(result.status, "reviewing");
    assert.equal(result.decisions.length, 24);
    assert.equal(result.progress.suppliersResponded, 8);
    assert.equal(bridge.errors.length, 0);
    assert.ok(bridge.contexts.some((c) => c.context.kind === "manager_plan"));
    assert.ok(bridge.contexts.some((c) => c.context.kind === "buyer_decision"));
    assert.ok(bridge.contexts.some((c) => c.context.kind === "manager_budget"));
    assert.equal(new Set(bridge.contexts.map((c) => c.role)).size, 11);
    for (const { role, context } of bridge.contexts) {
      if (role === "manager" || role.endsWith("-buyer"))
        for (const key of [
          "floorCaseCents",
          "targetCaseCents",
          "privateState",
          "stockUnits",
          "urgency",
        ])
          assert.ok(
            !JSON.stringify(context).includes('"' + key + '"'),
            role + " leaked " + key,
          );
    }
    for (const message of bridge.messages) {
      for (const key of [
        "floorCaseCents",
        "targetCaseCents",
        "privateState",
        "untrustedExtra",
      ])
        assert.ok(!JSON.stringify(message.payload).includes('"' + key + '"'));
    }
    assert.equal(
      bridge.messages.filter((m) => m.type === "accept_quote").length,
      23,
    );
    assert.equal(
      bridge.messages.filter((m) => m.type === "decision").length,
      23,
    );
    assert.equal(
      result.events.filter((e) => e.type === "supplier_acceptance_received")
        .length,
      23,
    );
    for (const notice of bridge.messages.filter(
      (m) => m.type === "accept_quote",
    )) {
      const payload = notice.payload as { quoteId: string; skuId: string };
      assert.ok(
        result.decisions.some(
          (d) => d.quoteId === payload.quoteId && d.supplierId === notice.to,
        ),
      );
      assert.equal(
        e.db.prepare("SELECT status FROM outbox WHERE id=?").get(notice.id)
          ?.status,
        "acknowledged",
      );
    }
    assert.ok(bridge.messages.some((m) => m.type === "counteroffer"));
    assert.ok(bridge.messages.some((m) => m.type === "budget_request"));
    assert.ok(bridge.messages.some((m) => m.type === "budget_decision"));
    assert.ok(
      bridge.contexts.filter(
        (c) =>
          c.role === "supplier-wholesale" &&
          c.context.kind === "supplier_quotes",
      ).length >= 2,
    );
    const berries = result.decisions.find((d) => d.skuId === "blueberries")!;
    const cheapest = result.quotes
      .filter((q) => q.skuId === "blueberries" && q.status !== "invalid")
      .sort((a, b) => a.landedCostCents - b.landedCostCents)[0]!;
    assert.notEqual(
      berries.quoteId,
      cheapest.id,
      "Backend must honor valid buyer selection rather than replace it with deterministic cheapest",
    );
    assert.equal(
      result.decisions.find((d) => d.skuId === "strawberries")!.escalated,
      true,
    );
  } finally {
    e.close();
  }
});

test("acceptance is durable before delivery; malformed receipt preserves purchase as unconfirmed and duplicate notice cannot debit twice", async () => {
  const bridge = new TestBridge(),
    e = new Engine(":memory:", 0);
  const send = bridge.send.bind(bridge);
  let pendingObserved = false;
  bridge.send = async (envelope) => {
    const payload = envelope.payload as { intentId?: string };
    if (envelope.type === "accept_quote" && payload.intentId === "apples") {
      const decision = e
        .snapshot(envelope.runId)
        .decisions.find((d) => d.skuId === "apples")!;
      assert.equal(decision.receiptStatus, "pending");
      assert.ok(
        e.db
          .prepare(
            "SELECT * FROM purchases WHERE run_id=? AND intent_id='apples'",
          )
          .get(envelope.runId),
      );
      assert.equal(
        e.db.prepare("SELECT status FROM outbox WHERE id=?").get(envelope.id)
          ?.status,
        "pending",
      );
      pendingObserved = true;
    }
    if (envelope.type === "decision" && payload.intentId === "apples")
      return send({
        ...envelope,
        payload: { ...(envelope.payload as object), quoteId: "wrong-quote" },
      });
    return send(envelope);
  };
  e.attachBridge(bridge);
  try {
    const run = e.create({ mode: "live" }, false);
    await e.execute(run.id);
    const result = e.snapshot(run.id);
    assert.equal(pendingObserved, true);
    assert.equal(
      result.decisions.find((d) => d.skuId === "apples")?.receiptStatus,
      "unconfirmed",
    );
    assert.equal(
      result.decisions.filter((d) => d.receiptStatus === "confirmed").length,
      22,
    );
    assert.equal(
      result.decisions.filter((d) => d.outcome === "accepted").length,
      23,
    );
    assert.match(result.error!, /acknowledgment/);
    const notice = bridge.messages.find(
      (m) =>
        m.type === "accept_quote" &&
        (m.payload as { intentId?: string }).intentId === "apples",
    )!;
    const budget = result.budget;
    await bridge.handler!(notice);
    assert.deepEqual(e.snapshot(run.id).budget, budget);
    assert.equal(
      e.db
        .prepare(
          "SELECT COUNT(*) n FROM purchases WHERE run_id=? AND intent_id='apples'",
        )
        .get(run.id)?.n,
      1,
    );
    assert.equal(
      e.db.prepare("SELECT status FROM outbox WHERE id=?").get(notice.id)
        ?.status,
      "sent",
    );
  } finally {
    e.close();
  }
});

for (const repaired of [true, false])
  test(`cross-SKU buyer choice ${repaired ? "repairs only its failed line" : "fails only its line after one repair"}`, async () => {
    const bridge = new TestBridge(),
      e = new Engine(":memory:", 0);
    const reason = bridge.reason.bind(bridge);
    let fruitAttempts = 0;
    let firstValid: { skuId: string; quoteId: string }[] = [];
    bridge.reason = async (role, context) => {
      const result = await reason(role, context);
      if (role === "fruit-buyer" && context.kind === "buyer_decision") {
        fruitAttempts++;
        const choices = result.choices as { skuId: string; quoteId: string }[];
        if (fruitAttempts === 1) {
          firstValid = structuredClone(
            choices.filter((c) => c.skuId !== "strawberries"),
          );
          choices.find((c) => c.skuId === "strawberries")!.quoteId =
            context.data.quotes.find(
              (q: PublicQuote) => q.skuId === "raspberries",
            ).id;
        } else {
          assert.deepEqual(
            context.data.items.map((i: PlanItem) => i.skuId),
            ["strawberries"],
          );
          assert.ok(
            context.data.quotes.every(
              (q: PublicQuote) => q.skuId === "strawberries",
            ),
          );
          assert.equal(
            context.data.validationIssues[0].reason,
            "Selected quote belongs to another SKU",
          );
          if (!repaired) choices[0]!.quoteId = "invalid-again";
        }
      }
      return result;
    };
    e.attachBridge(bridge);
    try {
      const run = e.create({ mode: "live" }, false);
      await e.execute(run.id);
      const snapshot = e.snapshot(run.id);
      assert.equal(fruitAttempts, 2);
      assert.equal(snapshot.decisions.length, 24);
      assert.equal(
        snapshot.decisions.find((d) => d.skuId === "strawberries")?.outcome,
        repaired ? "accepted" : "failed",
      );
      assert.equal(
        snapshot.decisions.filter((d) => d.outcome === "failed").length,
        repaired ? 0 : 1,
      );
      assert.equal(
        snapshot.decisions.find((d) => d.skuId === "mushrooms")?.outcome,
        "accepted",
      );
      for (const choice of firstValid.filter(
        (c) => !["apples", "avocados"].includes(c.skuId),
      ))
        assert.equal(
          snapshot.decisions.find((d) => d.skuId === choice.skuId)?.quoteId,
          choice.quoteId,
        );
      assert.equal(snapshot.budget.reservedCents, 0);
    } finally {
      e.close();
    }
  });

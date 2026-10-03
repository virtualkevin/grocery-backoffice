import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../server/engine.js";
import { CATALOG, SUPPLIERS, createPrivateStock } from "../server/fixtures.js";
import {
  landedTotal,
  roundCents,
  promotionExposure,
} from "../server/accounting.js";
const setup = () => {
  const e = new Engine(":memory:", 0),
    r = e.create({ mode: "simulation" }, false);
  e.plan(r.id);
  return { e, id: r.id };
};
test("full assortment simulation resolves24 with8suppliers, no technical failures, all3 outcomes", async () => {
  const e = new Engine(":memory:", 0);
  try {
    const r = e.create({ mode: "simulation" }, false);
    await e.execute(r.id);
    const s = e.snapshot(r.id);
    assert.equal(s.decisions.length, 24);
    assert.equal(s.progress.suppliersResponded, 8);
    assert.equal(s.decisions.filter((d) => d.outcome === "failed").length, 0);
    assert.equal(
      s.decisions.find((d) => d.skuId === "apples")?.outcome,
      "accepted",
    );
    assert.equal(
      s.decisions.find((d) => d.skuId === "strawberries")?.escalated,
      true,
    );
    assert.equal(
      s.decisions.find((d) => d.skuId === "avocados")?.outcome,
      "unavailable",
    );
    assert.equal(s.promotions.length, 3);
    assert.equal(s.budget.reservedCents, 0);
    assert.equal(
      s.budget.totalCents,
      s.budget.committedCents + s.budget.unallocatedCents,
    );
    assert.ok(
      s.budget.promotionExposureCents <= s.budget.promotionAllowanceCents,
    );
  } finally {
    e.close();
  }
});
test("fixture has 3 compatible supplier options perSKU and eachsupplier participates", () => {
  for (const sku of CATALOG)
    assert.ok(
      SUPPLIERS.filter((s) => s.eligibleSkuIds.includes(sku.id)).length >= 3,
      sku.id,
    );
  for (const s of SUPPLIERS) assert.ok(s.eligibleSkuIds.length > 0);
  assert.equal(CATALOG.filter((s) => s.category === "fruit").length, 12);
  assert.equal(CATALOG.filter((s) => s.category === "vegetable").length, 12);
  assert.ok(
    SUPPLIERS.find((s) => s.id === "supplier-organic")!.eligibleSkuIds.every(
      (id) => CATALOG.find((s) => s.id === id)!.organic,
    ),
  );
});
test("two distinct quote IDs race sameintent: exactly one purchase, one stock/budget debit", async () => {
  const { e, id } = setup();
  try {
    const a = e.makeQuote(id, "supplier-wholesale", "apples"),
      b = e.makeQuote(id, "supplier-rapid", "apples");
    e.addQuote(id, a);
    e.addQuote(id, b);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => e.commit(id, a.id)),
      Promise.resolve().then(() => e.commit(id, b.id)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(e.snapshot(id).decisions.length, 1);
    assert.equal(e.snapshot(id).budget.committedCents, a.landedCostCents);
    assert.equal(
      Number(e.db.prepare("SELECT COUNT(*) n FROM purchases").get()!.n),
      1,
    );
    assert.equal(e.commit(id, a.id).quoteId, a.id);
    assert.equal(
      Number(e.db.prepare("SELECT COUNT(*) n FROM purchases").get()!.n),
      1,
    );
  } finally {
    e.close();
  }
});
test("supplier floor/stock rejection rolls back budget and decisions", () => {
  const { e, id } = setup();
  try {
    const q = e.makeQuote(id, "supplier-wholesale", "apples", 1);
    e.addQuote(id, q);
    const before = e.snapshot(id).budget;
    assert.throws(() => e.commit(id, q.id), /cannot honor/);
    assert.deepEqual(e.snapshot(id).budget, before);
    assert.equal(e.snapshot(id).decisions.length, 0);
    const good = e.makeQuote(id, "supplier-wholesale", "apples");
    e.addQuote(id, good);
    e.db
      .prepare(
        "UPDATE stock SET quantity=0 WHERE run_id=? AND supplier_id=? AND sku_id=?",
      )
      .run(id, good.supplierId, "apples");
    assert.throws(() => e.commit(id, good.id), /cannot honor/);
    assert.deepEqual(e.snapshot(id).budget, before);
  } finally {
    e.close();
  }
});
test("cancellation fences late acceptance and releases every reservation", () => {
  const { e, id } = setup();
  try {
    const q = e.makeQuote(id, "supplier-wholesale", "apples");
    e.addQuote(id, q);
    e.cancel(id);
    assert.throws(() => e.commit(id, q.id, 1), /no longer active/);
    const s = e.snapshot(id);
    assert.equal(s.budget.reservedCents, 0);
    assert.equal(s.budget.unallocatedCents, s.budget.totalCents);
    assert.equal(s.decisions.length, 0);
  } finally {
    e.close();
  }
});
test("restart marks unfinishedrun interrupted; preservescommits releasesholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "produce-test-"));
  try {
    const path = join(dir, "db.sqlite"),
      e = new Engine(path, 0),
      r = e.create({}, false);
    e.plan(r.id);
    const q = e.makeQuote(r.id, "supplier-wholesale", "apples");
    e.addQuote(r.id, q);
    e.commit(r.id, q.id);
    e.close();
    const reopened = new Engine(path, 0);
    try {
      const s = reopened.snapshot(r.id);
      assert.equal(s.status, "interrupted");
      assert.equal(s.decisions.length, 1);
      assert.equal(s.budget.committedCents, q.landedCostCents);
      assert.equal(s.budget.reservedCents, 0);
      assert.throws(() => reopened.commit(r.id, q.id), /no longer active/);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("exactweighted rates roundatline notunit and promo loss cannotoffsetprofits", () => {
  assert.equal(roundCents(3150n * 40n, 40n), 3150);
  assert.equal(landedTotal(3150, 2, 100), 6400);
  assert.notEqual(Math.round(3150 / 40) * 40, 3150);
  assert.equal(promotionExposure(3150, 40, 70, 12), 105);
  assert.equal(promotionExposure(3150, 40, 100, 12), 0);
  assert.throws(() => landedTotal(3.5, 2, 0));
});
test("late inbound excluded from buyingwindow and privatecontext absent from snapshots", () => {
  const { e, id } = setup();
  try {
    const s = e.snapshot(id);
    for (const item of s.items) {
      const sku = CATALOG.find((x) => x.id === item.skuId)!;
      assert.equal(
        item.neededUnits,
        sku.forecastUnits +
          (sku.id === "apples" ? 4 : 0) +
          sku.safetyStockUnits -
          10,
      );
    }
    const raw = JSON.stringify(s);
    for (const field of [
      "floorCaseCents",
      "targetCaseCents",
      "privateState",
      "privateSuppliers",
    ])
      assert.ok(!raw.includes(field));
    assert.equal(
      e.godSnapshot(id).privateSuppliers.length,
      createPrivateStock().length,
    );
  } finally {
    e.close();
  }
});

test("cross-intent and malformed quote constraints cannot debit another reservation", () => {
  const { e, id } = setup();
  try {
    const before = e.snapshot(id).budget;
    for (const patch of [
      { intentId: "bananas" },
      { runId: "another-run" },
      { expiresAt: "not-a-date" },
      { availableUnits: Number.NaN },
      { minimumCases: -1 },
    ]) {
      const quote = {
        ...e.makeQuote(id, "supplier-wholesale", "apples"),
        ...patch,
      };
      e.addQuote(id, quote);
      assert.throws(
        () => e.commit(id, quote.id),
        /identity mismatch|Invalid quantity or date/,
      );
      assert.deepEqual(e.snapshot(id).budget, before);
      assert.equal(e.snapshot(id).decisions.length, 0);
    }
  } finally {
    e.close();
  }
});

test("source refresh preserves negotiated evidence and updates only future research", async () => {
  const e = new Engine(":memory:", 0);
  try {
    const evidence = {
      id: "market-test",
      source: "Test source",
      title: "Prior observation",
      summary: "Prior",
      observedAt: "2026-10-01",
      fetchedAt: "2026-10-03",
      scenarioDate: "2026-10-03",
      mode: "fixture" as const,
    };
    e.setEvidence([evidence]);
    const old = e.create({}, false);
    await e.execute(old.id);
    e.setEvidence([{ ...evidence, summary: "New" }]);
    assert.equal(
      e.snapshot(old.id).evidence.find((x) => x.id === evidence.id)?.summary,
      "Prior",
    );
    const fresh = e.create({}, false);
    assert.equal(
      e.snapshot(fresh.id).evidence.find((x) => x.id === evidence.id)?.summary,
      "New",
    );
    const god = e.godSnapshot(old.id);
    const winner = e
      .snapshot(old.id)
      .decisions.find((d) => d.skuId === "apples")!;
    assert.equal(
      god.privateSuppliers.find(
        (s) => s.skuId === "apples" && s.supplierId === winner.supplierId,
      )?.negotiationState,
      "selected",
    );
    assert.ok(
      god.privateSuppliers.some(
        (s) => s.skuId === "apples" && s.negotiationState === "not selected",
      ),
    );
    assert.equal(
      god.agentStates.find((a) => a.id === "fruit-buyer")?.status,
      "12/12 decisions resolved",
    );
  } finally {
    e.close();
  }
});

test("dated seasonal fixture changes demand before whole-case rounding with an explicit cap", () => {
  const { e, id } = setup();
  try {
    const apples = e.snapshot(id).items.find((i) => i.skuId === "apples")!;
    assert.equal(apples.demand?.baselineForecastUnits, 44);
    assert.equal(apples.demand?.adjustedForecastUnits, 48);
    assert.equal(apples.demand?.seasonalAdjustmentUnits, 4);
    assert.equal(apples.demand?.evidenceId, "seasonal-fixture");
    assert.equal(apples.neededUnits, 44);
    assert.equal(apples.cases, 2);
    assert.equal(apples.quantity, 80);
    for (const item of e.snapshot(id).items.filter((i) => i.skuId !== "apples"))
      assert.equal(item.demand?.seasonalAdjustmentUnits, 0);
  } finally {
    e.close();
  }
});

test("cancelled approved promotion cannot resurrect its run by composing a flyer", async () => {
  const e = new Engine(":memory:", 0);
  try {
    const run = e.create({}, false);
    await e.execute(run.id);
    e.approve(run.id, e.snapshot(run.id).promotionRevision);
    e.cancel(run.id);
    assert.throws(() => e.flyer(run.id), /current state/);
    assert.equal(e.snapshot(run.id).status, "cancelled");
  } finally {
    e.close();
  }
});
test("cancellation and restart mark pending supplier receipts unconfirmed without undoing purchases", () => {
  const dir = mkdtempSync(join(tmpdir(), "produce-receipt-"));
  const path = join(dir, "db.sqlite");
  const bridge = {
    start: async () => {},
    stop: async () => {},
    reason: async () => ({}),
    send: async () => ({}),
    onMessage: () => () => {},
    status: () => ({ live: true, blockers: [] }),
  };
  const e = new Engine(path, 0);
  e.attachBridge(bridge);
  try {
    const a = e.create({ mode: "live" }, false);
    e.plan(a.id);
    const q = e.makeQuote(a.id, "supplier-wholesale", "apples");
    e.addQuote(a.id, q);
    e.commit(a.id, q.id);
    e.cancel(a.id);
    assert.equal(e.snapshot(a.id).decisions[0]?.receiptStatus, "unconfirmed");
    assert.equal(e.snapshot(a.id).budget.committedCents, q.landedCostCents);
    const b = e.create({ mode: "live" }, false);
    e.plan(b.id);
    const q2 = e.makeQuote(b.id, "supplier-wholesale", "apples");
    e.addQuote(b.id, q2);
    e.commit(b.id, q2.id);
    e.close();
    const reopened = new Engine(path, 0);
    try {
      assert.equal(
        reopened.snapshot(b.id).decisions[0]?.receiptStatus,
        "unconfirmed",
      );
      assert.equal(
        reopened.snapshot(b.id).budget.committedCents,
        q2.landedCostCents,
      );
    } finally {
      reopened.close();
    }
  } finally {
    try {
      e.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart preserves finished negotiations awaiting review or flyer composition',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'produce-review-'));const path=join(dir,'db.sqlite');let e=new Engine(path,0);
 try {
  const r=e.create({},false);await e.execute(r.id);const reviewing=e.snapshot(r.id);assert.equal(reviewing.status,'reviewing');
  // Seed stored delivery evidence; this test exercises persistence, not provider transport.
  for(const decision of reviewing.decisions)if(decision.outcome==='accepted')decision.receiptStatus='confirmed';
  e.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(reviewing),r.id);
  e.close();e=new Engine(path,0);
  assert.deepEqual(e.snapshot(r.id),reviewing);
  e.approve(r.id,reviewing.promotionRevision);const approved=e.snapshot(r.id);assert.equal(approved.status,'flyer_ready');e.close();e=new Engine(path,0);
  assert.deepEqual(e.snapshot(r.id),approved);assert.equal(e.flyer(r.id).status,'complete');
 }finally{e.close();rmSync(dir,{recursive:true,force:true})}
});

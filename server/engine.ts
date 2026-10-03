import {
  EMPTY_TRENDS,
  trendAdjustments,
  trendEvidence,
  purchaseNeed,
  trendImpactPreview,
} from "./trend-policy.js";
import { validateBuyerChoices } from "./buyer-validation.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
  Evidence,
  AgentEnvelope,
  Bootstrap,
  Capabilities,
  Decision,
  GodSnapshot,
  PlanItem,
  Promotion,
  PublicQuote,
  RoleId,
  RunEvent,
  RunMode,
  RunSnapshot,
  SupplierPrivateState,
  TrendReport,
} from "../shared/types.js";
import {
  CATALOG,
  DEFAULT_BUDGET,
  DEFAULT_PROMOTION_ALLOWANCE,
  FIXTURE_EVIDENCE,
  STORE,
  SUPPLIERS,
  createPrivateStock,
  eligible,
} from "./fixtures.js";
import { landedTotal, promotionExposure } from "./accounting.js";
import { openDatabase, transaction } from "./db.js";
const terminal = new Set(["complete", "cancelled", "failed", "interrupted"]);
const clone = <T>(x: T): T => structuredClone(x);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export interface ProviderBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  reason(role: RoleId, context: unknown): Promise<unknown>;
  send(envelope: AgentEnvelope): Promise<unknown>;
  onMessage(
    callback: (message: AgentEnvelope) => Promise<void> | void,
  ): () => void;
  status(): unknown;
  cancelRun?(runId: string): Promise<unknown>;
}
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export class Engine {
  readonly db: DatabaseSync;
  private runs = new Map<string, RunSnapshot>();
  private privateStates = new Map<string, SupplierPrivateState[]>();
  private listeners = new Set<(id: string) => void>();
  private bridge?: ProviderBridge;
  private evidence: Evidence[] = clone(FIXTURE_EVIDENCE);
  private trends: TrendReport = clone(EMPTY_TRENDS);
  setTrends(report: TrendReport) {
    this.trends = clone(report);
  }
  trendsSnapshot(): TrendReport {
    return {
      ...clone(this.trends),
      eligibleSkuIds: [...trendAdjustments(this.trends).keys()],
      impactPreview: trendImpactPreview(this.trends),
    };
  }
  private liveChoices = new Map<
    string,
    Map<string, { quoteId: string; counterofferCasePriceCents?: number }>
  >();
  private unsubscribe?: () => void;
  private waits = new Map<
    string,
    {
      resolve: (message: AgentEnvelope) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      expectedFrom: RoleId;
      expectedTo: RoleId;
      expectedType: AgentEnvelope["type"];
    }
  >();
  constructor(
    path?: string,
    private stepMs = Number(process.env.DEMO_STEP_MS ?? 220),
  ) {
    this.db = openDatabase(path);
    for (const row of this.db.prepare("SELECT snapshot FROM runs").all()) {
      const run = JSON.parse(String(row.snapshot)) as RunSnapshot;
      if (!terminal.has(run.status)) {
        run.status = "interrupted";
        run.generation++;
        for (const decision of run.decisions)
          if (decision.receiptStatus === "pending")
            decision.receiptStatus = "unconfirmed";
        run.error =
          "The server restarted. Start a fresh run; committed purchases are preserved.";
        run.budget.reservedCents = 0;
        run.budget.unallocatedCents =
          run.budget.totalCents - run.budget.committedCents;
        this.db
          .prepare(
            "UPDATE intents SET reserved=0,status='interrupted' WHERE run_id=? AND status='open'",
          )
          .run(run.id);
      }
      this.runs.set(run.id, run);
      this.privateStates.set(run.id, createPrivateStock());
      this.persist(run);
    }
  }
  attachBridge(bridge: ProviderBridge) {
    this.bridge = bridge;
    this.unsubscribe?.();
    this.unsubscribe = bridge.onMessage((message) => this.receive(message));
  }
  capabilities(): Capabilities {
    const raw = this.bridge?.status() as Record<string, unknown> | undefined;
    const band = raw?.band as Record<string, unknown> | undefined;
    const ready = raw?.live === true || raw?.liveReady === true;
    const blockers = Array.isArray(raw?.blockers)
      ? (raw.blockers.filter((x) => typeof x === "string") as string[])
      : [
          "Live agent connections are not ready. Configure all eleven Band identities and verify ZooWork.",
        ];
    return {
      simulation: true,
      live: ready,
      blockers: ready ? [] : blockers,
      providers: raw ?? {
        band: { configured: 1, required: 11, status: "not_started" },
        zoowork: { status: "not_started" },
      },
      image: {
        available: existsSync("public/assets/produce-editorial.png"),
        mode: existsSync("public/assets/produce-editorial.png")
          ? "pregenerated"
          : "unavailable",
        ...(existsSync("public/assets/produce-editorial.png")
          ? { url: "/assets/produce-editorial.png" }
          : {}),
      },
    };
  }
  setEvidence(evidence: Evidence[]) {
    this.evidence = [...clone(FIXTURE_EVIDENCE), ...evidence];
    for (const run of this.runs.values()) {
      if (!["created", "researching"].includes(run.status)) continue;
      run.evidence = [
        ...clone(this.evidence),
        ...(run.useTrends && run.trends ? trendEvidence(run.trends) : []),
      ];
      this.persist(run);
      this.notify(run.id);
    }
  }
  bootstrap(): Bootstrap {
    const current = [...this.runs.values()].at(-1);
    return {
      store: STORE,
      trends: this.trendsSnapshot(),
      catalog: CATALOG,
      suppliers: SUPPLIERS,
      capabilities: this.capabilities(),
      currentRun: current ? this.snapshot(current.id) : null,
      defaults: {
        budgetCents: DEFAULT_BUDGET,
        promotionAllowanceCents: DEFAULT_PROMOTION_ALLOWANCE,
      },
    };
  }
  subscribe(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(id: string) {
    for (const listener of this.listeners) listener(id);
  }
  private persist(run: RunSnapshot) {
    this.db
      .prepare(
        "INSERT INTO runs(id,generation,status,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status=excluded.status,snapshot=excluded.snapshot",
      )
      .run(run.id, run.generation, run.status, JSON.stringify(run));
  }
  private get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new DomainError("Run not found", 404);
    return run;
  }
  snapshot(id: string): RunSnapshot {
    const r = clone(this.get(id));
    r.capabilities = this.capabilities();
    r.events = r.events.filter((e) => e.visibility === "operator");
    return r;
  }
  godSnapshot(id: string): GodSnapshot {
    const run = this.snapshot(id);
    const state = (this.privateStates.get(id) ?? createPrivateStock()).map(
      (s) => {
        const stock = this.db
          .prepare(
            "SELECT quantity FROM stock WHERE run_id=? AND supplier_id=? AND sku_id=?",
          )
          .get(id, s.supplierId, s.skuId);
        return {
          ...s,
          stockUnits: Number(stock?.quantity ?? s.stockUnits),
          negotiationState: (() => {
            const decision = run.decisions.find((d) => d.skuId === s.skuId);
            if (decision)
              return decision.supplierId === s.supplierId
                ? "selected"
                : decision.outcome === "accepted"
                  ? "not selected"
                  : decision.outcome;
            const quotes = run.quotes.filter(
              (q) => q.supplierId === s.supplierId && q.skuId === s.skuId,
            );
            if (quotes.some((q) => q.round > 0)) return "counteroffer returned";
            if (quotes.some((q) => q.status === "offered"))
              return "quote returned";
            if (quotes.length) return "offer invalid";
            return terminal.has(run.status) ? run.status : "awaiting request";
          })(),
        };
      },
    );
    return {
      ...run,
      privateSuppliers: state,
      agentStates: [
        "manager",
        "fruit-buyer",
        "vegetable-buyer",
        ...SUPPLIERS.map((s) => s.id),
      ].map((id) => {
        const last = run.events.filter((e) => e.actor === id).at(-1);
        const assigned = run.items.filter((i) => i.buyerId === id);
        const status = terminal.has(run.status)
          ? run.status
          : assigned.length
            ? `${assigned.filter((i) => ["accepted", "unavailable", "failed", "skipped"].includes(i.status)).length}/${assigned.length} decisions resolved`
            : id === "manager"
              ? (last?.type.replaceAll("_", " ") ?? "awaiting allocation")
              : state
                    .filter((s) => s.supplierId === id)
                    .some((s) => s.negotiationState === "awaiting request")
                ? last
                  ? "partially quoted"
                  : "awaiting request"
                : "offers evaluated";
        return {
          id: id as RoleId,
          status,
          ...(last ? { lastActivity: last.timestamp } : {}),
        };
      }),
    };
  }
  private event(
    run: RunSnapshot,
    actor: RunEvent["actor"],
    type: string,
    summary: string,
    data?: Record<string, unknown>,
  ) {
    const e: RunEvent = {
      id: randomUUID(),
      runId: run.id,
      seq: run.eventSeq + 1,
      timestamp: new Date().toISOString(),
      actor,
      type,
      summary,
      visibility: "operator",
      ...(data ? { data } : {}),
    };
    run.eventSeq = e.seq;
    run.events.push(e);
    run.updatedAt = e.timestamp;
    this.db
      .prepare("INSERT INTO events(run_id,seq,payload) VALUES(?,?,?)")
      .run(run.id, e.seq, JSON.stringify(e));
    this.persist(run);
    queueMicrotask(() => this.notify(run.id));
    return e;
  }
  private assertActive(id: string, generation?: number) {
    const run = this.get(id);
    if (
      terminal.has(run.status) ||
      (generation !== undefined && generation !== run.generation)
    )
      throw new DomainError(
        "Run is no longer active; stale action rejected",
        409,
      );
    return run;
  }
  create(
    config: {
      mode?: RunMode;
      useTrends?: boolean;
      budgetCents?: number;
      promotionAllowanceCents?: number;
    },
    start = true,
  ) {
    const mode = config.mode ?? "simulation";
    if (!["simulation", "live"].includes(mode))
      throw new DomainError("Unsupported run mode");
    if (mode === "live" && !this.capabilities().live)
      throw new DomainError(
        "Live mode is blocked: " + this.capabilities().blockers.join(" "),
        409,
      );
    if (config.useTrends !== undefined && typeof config.useTrends !== "boolean")
      throw new DomainError("Trend opt-in must be a boolean");
    const useTrends = config.useTrends === true;
    const trends = this.trendsSnapshot();
    if (useTrends && !trends.eligibleSkuIds?.length)
      throw new DomainError(
        "No recent dated social signals are eligible for an adjustment. Refresh trends or leave opt-in off.",
        409,
      );
    const total = config.budgetCents ?? DEFAULT_BUDGET;
    const allowance =
      config.promotionAllowanceCents ?? DEFAULT_PROMOTION_ALLOWANCE;
    if (
      !Number.isSafeInteger(total) ||
      total < 10000 ||
      total > 10000000 ||
      !Number.isSafeInteger(allowance) ||
      allowance < 0 ||
      allowance > 1000000
    )
      throw new DomainError("Budgets must be bounded integer cents");
    const now = new Date().toISOString(),
      id = randomUUID();
    const run: RunSnapshot = {
      id,
      generation: 1,
      mode,
      useTrends,
      ...(useTrends ? { trends } : {}),
      status: "created",
      createdAt: now,
      updatedAt: now,
      store: STORE,
      budget: {
        totalCents: total,
        committedCents: 0,
        reservedCents: 0,
        unallocatedCents: total,
        promotionAllowanceCents: allowance,
        promotionExposureCents: 0,
      },
      items: [],
      quotes: [],
      decisions: [],
      events: [],
      eventSeq: 0,
      promotions: [],
      promotionRevision: 0,
      flyer: { status: "unavailable", provenance: "No flyer composed yet" },
      suppliers: SUPPLIERS,
      evidence: [
        ...clone(this.evidence),
        ...(useTrends ? trendEvidence(trends) : []),
      ],
      progress: { resolved: 0, total: 24, suppliersResponded: 0 },
      capabilities: this.capabilities(),
    };
    this.runs.set(id, run);
    const priv = createPrivateStock();
    this.privateStates.set(id, priv);
    transaction(this.db, () => {
      this.persist(run);
      for (const s of priv)
        this.db
          .prepare("INSERT INTO stock VALUES(?,?,?,?,?)")
          .run(id, s.supplierId, s.skuId, s.stockUnits, s.floorCaseCents);
    });
    this.event(
      run,
      "system",
      "run_created",
      mode === "simulation"
        ? "Simulation started · all inventory and supplier quotes are simulated."
        : "Live run started · reasoning via ZooWork and messages via Band.",
    );
    if (start) void this.execute(id).catch((error) => this.fail(id, error));
    return this.snapshot(id);
  }
  plan(id: string) {
    const run = this.assertActive(id);
    run.status = "allocating";
    const social =
      run.useTrends && run.trends
        ? trendAdjustments(run.trends, Date.parse(run.createdAt))
        : new Map<string, { units: number; evidenceIds: string[] }>();
    for (const sku of CATALOG) {
      const trend = social.get(sku.id);
      const trendAdjustment = trend?.units ?? 0;
      const { usable, seasonalAdjustment, adjustedForecast, need, cases } = purchaseNeed(sku, trendAdjustment);
      const desired = Math.round(
        sku.baseCaseCostCents *
          cases *
          (sku.id === "avocados"
            ? 0.35
            : sku.id === "strawberries"
              ? 0.75
              : 1.32),
      );
      const amount = Math.min(
        desired,
        Math.max(0, run.budget.unallocatedCents - 10000),
      );
      const item: PlanItem = {
        skuId: sku.id,
        name: sku.name,
        buyerId: sku.buyerId,
        category: sku.category,
        neededUnits: need,
        demand: {
          baselineForecastUnits: sku.forecastUnits,
          adjustedForecastUnits: adjustedForecast,
          seasonalAdjustmentUnits: seasonalAdjustment,
          trendAdjustmentUnits: trendAdjustment,
          trendEvidenceIds: trend?.evidenceIds ?? [],
          adjustmentCapUnits: 4,
          ...(seasonalAdjustment ? { evidenceId: "seasonal-fixture" } : {}),
          rationale: trendAdjustment
            ? `Operator opted in to a social-interest hypothesis: +${trendAdjustment} units (5% baseline, capped at 2). Not measured growth or proven local demand. Seasonal adjustment separately adds ${seasonalAdjustment} units.`
            : seasonalAdjustment
              ? "Simulated October 4–5 fall produce weekend: 10% apple forecast adjustment, rounded up and capped at four units. This is a store scenario assumption, not a discovered event or measured lift."
              : "Seeded baseline forecast; no seasonal or demographic multiplier applied.",
        },
        cases,
        quantity: cases * sku.unitsPerCase,
        allocationCents: amount,
        status: "pending",
        ...(sku.id === "apples"
          ? { spotlight: "win" as const }
          : sku.id === "strawberries"
            ? { spotlight: "escalation" as const }
            : sku.id === "avocados"
              ? { spotlight: "walkaway" as const }
              : {}),
        rationale: trendAdjustment
          ? `Opted-in social interest adds ${trendAdjustment} units; seasonal scenario adds ${seasonalAdjustment}. Forecast ${sku.forecastUnits} → ${adjustedForecast}; net need ${need}, rounded to ${cases} whole cases. Interest is not measured growth; budget, stock and shelf-life constraints still apply.`
          : seasonalAdjustment
            ? `Simulated fall produce weekend adds ${seasonalAdjustment} apple units (10%, capped at 4): forecast ${sku.forecastUnits} → ${adjustedForecast}; net need ${need}, rounded to ${cases} whole cases. Late October 11 inbound is excluded.`
            : "Forecast + safety stock − usable dated inventory; October 11 inbound arrives after this buying window.",
      };
      run.items.push(item);
      run.budget.reservedCents += amount;
      run.budget.unallocatedCents -= amount;
      this.db
        .prepare("INSERT INTO intents VALUES(?,?,0,'open',?)")
        .run(id, sku.id, amount);
    }
    this.event(
      run,
      "manager",
      "budget_allocated",
      `Reserved budgets across 24 produce decisions; $${(run.budget.unallocatedCents / 100).toFixed(2)} remains available for justified escalations.`,
    );
  }
  private validQuote(run: RunSnapshot, q: PublicQuote) {
    const item = run.items.find((x) => x.skuId === q.skuId),
      sku = CATALOG.find((x) => x.id === q.skuId);
    if (!item || !sku || !eligible(q.supplierId, q.skuId))
      return "Unknown or ineligible SKU/supplier";
    if (q.runId !== run.id || q.intentId !== q.skuId)
      return "Quote run or intent identity mismatch";
    if (
      !Number.isSafeInteger(q.revision) ||
      q.revision !== q.round ||
      q.round < 0 ||
      q.round > 3
    )
      return "Invalid quote revision";
    if (
      run.quotes.some(
        (other) =>
          other.supplierId === q.supplierId &&
          other.skuId === q.skuId &&
          other.revision > q.revision &&
          other.status !== "invalid",
      )
    )
      return "Quote superseded by a newer supplier revision";
    if (
      !Number.isSafeInteger(q.availableUnits) ||
      q.availableUnits < 0 ||
      !Number.isSafeInteger(q.minimumCases) ||
      q.minimumCases < 1 ||
      !Number.isSafeInteger(q.shelfLifeDays) ||
      q.shelfLifeDays < 0 ||
      !Number.isFinite(Date.parse(q.deliveryDate)) ||
      !Number.isFinite(Date.parse(q.expiresAt))
    )
      return "Invalid quantity or date constraints";
    if (
      !Number.isSafeInteger(q.casePriceCents) ||
      q.casePriceCents <= 0 ||
      q.cases !== item.cases ||
      q.quantity !== item.quantity ||
      q.unitsPerCase !== sku.unitsPerCase ||
      q.grade !== sku.grade ||
      q.organic !== sku.organic
    )
      return "Price, quantity, pack, or specification mismatch";
    if (
      !Number.isSafeInteger(q.landedCostCents) ||
      q.landedCostCents !== q.casePriceCents * q.cases + q.freightCents ||
      q.freightCents < 0 ||
      !Number.isSafeInteger(q.freightCents)
    )
      return "Invalid landed total";
    if (q.minimumCases > q.cases || q.availableUnits < q.quantity)
      return "Minimum order or available quantity cannot satisfy request";
    if (
      q.deliveryDate > "2026-10-06" ||
      q.shelfLifeDays < (q.skuId === "bananas" ? 2 : 4)
    )
      return "Delivery or remaining shelf life does not meet the buying window";
    if (Date.parse(q.expiresAt) <= Date.now()) return "Quote has expired";
    return undefined;
  }
  makeQuote(
    id: string,
    supplierId: RoleId,
    skuId: string,
    casePriceCents?: number,
    round = 0,
  ): PublicQuote {
    const run = this.assertActive(id),
      item = run.items.find((x) => x.skuId === skuId)!;
    const sku = CATALOG.find((x) => x.id === skuId)!;
    const priv = this.privateStates
      .get(id)!
      .find((x) => x.supplierId === supplierId && x.skuId === skuId);
    if (!priv || !item) throw new DomainError("Invalid quote identity");
    const price = casePriceCents ?? priv.targetCaseCents;
    const freight = supplierId === "supplier-rapid" ? 250 : 100;
    return {
      id: randomUUID(),
      revision: round,
      runId: id,
      intentId: skuId,
      skuId,
      supplierId,
      casePriceCents: price,
      cases: item.cases,
      quantity: item.quantity,
      unitsPerCase: sku.unitsPerCase,
      freightCents: freight,
      landedCostCents: landedTotal(price, item.cases, freight),
      availableUnits: Math.min(priv.stockUnits, item.quantity),
      minimumCases: 1,
      grade: sku.grade,
      organic: sku.organic,
      deliveryDate: "2026-10-04",
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      shelfLifeDays: supplierId === "supplier-surplus" ? 3 : 7,
      status: "offered",
      round,
      source: run.mode,
    };
  }
  addQuote(id: string, quote: PublicQuote) {
    const run = this.assertActive(id);
    if (run.quotes.some((q) => q.id === quote.id)) return;
    const bad = this.validQuote(run, quote);
    if (!bad)
      for (const prior of run.quotes)
        if (
          prior.supplierId === quote.supplierId &&
          prior.skuId === quote.skuId &&
          prior.revision < quote.revision &&
          prior.status === "offered"
        ) {
          prior.status = "rejected";
          prior.rejectionReason = "Superseded by a newer supplier revision";
        }
    run.quotes.push(
      bad ? { ...quote, status: "invalid", rejectionReason: bad } : quote,
    );
    run.progress.suppliersResponded = new Set(
      run.quotes.map((q) => q.supplierId),
    ).size;
    this.persist(run);
  }
  commit(id: string, quoteId: string, generation?: number): Decision {
    const run = this.assertActive(id, generation);
    const q = run.quotes.find((x) => x.id === quoteId);
    if (!q) throw new DomainError("Quote not found", 404);
    const prior = run.decisions.find((x) => x.intentId === q.intentId);
    if (prior) {
      if (prior.quoteId === quoteId) return prior;
      throw new DomainError("Intent is already resolved by another quote", 409);
    }
    const invalid = this.validQuote(run, q);
    if (invalid) throw new DomainError(invalid, 409);
    const backup = clone(run);
    try {
      const decision = transaction(this.db, () => {
        const row = this.db
          .prepare("SELECT * FROM intents WHERE run_id=? AND id=?")
          .get(id, q.intentId);
        if (
          !row ||
          row.status !== "open" ||
          q.landedCostCents > Number(row.reserved)
        )
          throw new DomainError(
            "Intent has insufficient reservation or is no longer open",
            409,
          );
        const dbRun = this.db
          .prepare("SELECT generation,status FROM runs WHERE id=?")
          .get(id);
        if (
          Number(dbRun?.generation) !== run.generation ||
          terminal.has(String(dbRun?.status))
        )
          throw new DomainError("Stale run action", 409);
        const stock = this.db
          .prepare(
            "SELECT * FROM stock WHERE run_id=? AND supplier_id=? AND sku_id=?",
          )
          .get(id, q.supplierId, q.skuId);
        if (
          !stock ||
          Number(stock.quantity) < q.quantity ||
          q.casePriceCents < Number(stock.floor_cents)
        )
          throw new DomainError(
            "Supplier cannot honor this quantity or price",
            409,
          );
        this.db
          .prepare("INSERT INTO purchases VALUES(?,?,?,?,?)")
          .run(id, q.intentId, q.id, q.landedCostCents, q.quantity);
        const changed = this.db
          .prepare(
            "UPDATE intents SET status='committed',reserved=0,revision=revision+1 WHERE run_id=? AND id=? AND revision=? AND status='open'",
          )
          .run(id, q.intentId, Number(row.revision));
        if (changed.changes !== 1)
          throw new DomainError("Intent changed before acceptance", 409);
        this.db
          .prepare(
            "UPDATE stock SET quantity=quantity-? WHERE run_id=? AND supplier_id=? AND sku_id=? AND quantity>=?",
          )
          .run(q.quantity, id, q.supplierId, q.skuId, q.quantity);
        run.budget.reservedCents -= Number(row.reserved);
        run.budget.committedCents += q.landedCostCents;
        run.budget.unallocatedCents += Number(row.reserved) - q.landedCostCents;
        q.status = "accepted";
        const item = run.items.find((i) => i.skuId === q.skuId)!;
        item.status = "accepted";
        const d: Decision = {
          id: randomUUID(),
          skuId: q.skuId,
          intentId: q.intentId,
          outcome: "accepted",
          supplierId: q.supplierId,
          quoteId: q.id,
          quantity: q.quantity,
          committedCostCents: q.landedCostCents,
          reason: q.round
            ? "Counteroffer met the budget, specification and delivery window."
            : "Buyer selected a feasible offer for the required quality, quantity and delivery window.",
          alternatives: run.quotes
            .filter((x) => x.skuId === q.skuId && x.id !== q.id)
            .map((x) => ({
              quoteId: x.id,
              reason:
                x.rejectionReason ??
                (x.landedCostCents >= q.landedCostCents
                  ? "Higher landed cost for the required specification"
                  : "Not selected after quality and delivery comparison"),
            })),
          escalated: run.events.some(
            (e) => e.type === "budget_approved" && e.data?.skuId === q.skuId,
          ),
        };
        run.decisions.push(d);
        if (run.mode === "live") {
          d.receiptStatus = "pending";
          const notice: AgentEnvelope = {
            id: `accept:${run.id}:${q.intentId}`,
            runId: run.id,
            runGeneration: run.generation,
            from: item.buyerId,
            to: q.supplierId,
            type: "accept_quote",
            correlationId: randomUUID(),
            payload: {
              decisionId: d.id,
              intentId: q.intentId,
              skuId: q.skuId,
              quoteId: q.id,
              quoteRevision: q.revision,
              quantity: q.quantity,
              committedCostCents: q.landedCostCents,
            },
            createdAt: new Date().toISOString(),
          };
          this.db
            .prepare("INSERT INTO outbox VALUES(?,?,?,'pending')")
            .run(notice.id, run.id, JSON.stringify(notice));
        }
        run.progress.resolved = run.decisions.length;
        this.event(
          run,
          item.buyerId,
          "purchase_accepted",
          `${item.name}: ${q.quantity} ${CATALOG.find((x) => x.id === q.skuId)!.unit} from ${SUPPLIERS.find((x) => x.id === q.supplierId)!.shortName} for $${(q.landedCostCents / 100).toFixed(2)}.`,
          { skuId: q.skuId, supplierId: q.supplierId, quoteId: q.id },
        );
        return d;
      });
      this.notify(id);
      return decision;
    } catch (e) {
      this.runs.set(id, backup);
      throw e;
    }
  }
  increaseBudget(id: string, skuId: string, increment: number) {
    const run = this.assertActive(id);
    if (
      !Number.isSafeInteger(increment) ||
      increment < 0 ||
      increment > run.budget.unallocatedCents
    )
      throw new DomainError("Budget increment exceeds unallocated funds", 409);
    transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT reserved FROM intents WHERE run_id=? AND id=? AND status='open'",
        )
        .get(id, skuId);
      if (!row) throw new DomainError("Intent is not open", 409);
      this.db
        .prepare(
          "UPDATE intents SET reserved=reserved+?,revision=revision+1 WHERE run_id=? AND id=?",
        )
        .run(increment, id, skuId);
      run.budget.reservedCents += increment;
      run.budget.unallocatedCents -= increment;
      run.items.find((i) => i.skuId === skuId)!.allocationCents += increment;
      this.event(
        run,
        "manager",
        "budget_approved",
        `Approved $${(increment / 100).toFixed(2)} more for ${CATALOG.find((x) => x.id === skuId)!.name}; total store budget is unchanged.`,
        { skuId, incrementCents: increment },
      );
    });
  }
  private resolveWithoutPurchase(
    id: string,
    item: PlanItem,
    outcome: "unavailable" | "skipped" | "failed",
    reason: string,
  ) {
    const run = this.assertActive(id);
    if (run.decisions.some((x) => x.skuId === item.skuId)) return;
    transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT reserved FROM intents WHERE run_id=? AND id=?")
        .get(id, item.skuId);
      const reserved = Number(row?.reserved ?? 0);
      this.db
        .prepare(
          "UPDATE intents SET status=?,reserved=0,revision=revision+1 WHERE run_id=? AND id=?",
        )
        .run(outcome, id, item.skuId);
      run.budget.reservedCents -= reserved;
      run.budget.unallocatedCents += reserved;
      item.status = outcome;
      run.decisions.push({
        id: randomUUID(),
        skuId: item.skuId,
        intentId: item.skuId,
        outcome,
        quantity: 0,
        committedCostCents: 0,
        reason,
        alternatives: run.quotes
          .filter((q) => q.skuId === item.skuId)
          .map((q) => ({
            quoteId: q.id,
            reason:
              q.rejectionReason ??
              "Exceeds this item’s approved willingness to pay",
          })),
        escalated: false,
      });
      run.progress.resolved = run.decisions.length;
      this.event(
        run,
        item.buyerId,
        `purchase_${outcome}`,
        `${item.name}: ${reason}`,
        { skuId: item.skuId },
      );
    });
  }
  async execute(id: string) {
    const run = this.assertActive(id),
      generation = run.generation;
    run.status = "researching";
    this.event(
      run,
      "manager",
      "research_started",
      "Reviewing dated inventory, forecast needs and available market context.",
    );
    await sleep(this.stepMs);
    this.assertActive(id, generation);
    this.plan(id);
    run.status = "negotiating";
    this.event(
      run,
      "manager",
      "rfqs_started",
      run.mode === "simulation"
        ? "Fruit and vegetable buyers are requesting simulated quotes from eight supplier personas."
        : "Fruit and vegetable buyers are sending real Band RFQs to eight supplier agents.",
    );
    if (run.mode === "live") await this.liveQuotes(run);
    else
      for (const supplier of SUPPLIERS) {
        this.assertActive(id, generation);
        for (const item of run.items.filter((i) =>
          eligible(supplier.id, i.skuId),
        )) {
          item.status = "quoting";
          this.addQuote(id, this.makeQuote(id, supplier.id, item.skuId));
        }
        this.event(
          run,
          supplier.id,
          "quotes_received",
          `${supplier.shortName} returned ${run.items.filter((i) => eligible(supplier.id, i.skuId)).length} comparable line offers.`,
          { supplierId: supplier.id },
        );
        await sleep(this.stepMs);
      }
    for (const item of run.items) {
      this.assertActive(id, generation);
      try {
        if (
          run.mode === "live" &&
          Date.now() >= Date.parse(run.createdAt) + 5 * 60000
        )
          throw new DomainError("Run deadline reached", 504);
        await this.settle(run, item);
      } catch {
        this.assertActive(id, generation);
        run.error =
          "One or more sourcing decisions failed technically; other items continue and existing commitments are preserved.";
        if (!run.decisions.some((d) => d.skuId === item.skuId))
          this.resolveWithoutPurchase(
            id,
            item,
            "failed",
            "Supplier or manager exchange failed or exceeded the run deadline; this is a technical failure, not a business walkaway.",
          );
      }
      await sleep(this.stepMs);
    }
    this.assertActive(id, generation);
    run.status = "reviewing";
    this.createPromotions(run);
    this.event(
      run,
      "manager",
      "run_review_ready",
      `All 24 decisions resolved. ${run.decisions.filter((d) => d.outcome === "accepted").length} purchases selected; review the produce promotion plan.`,
    );
  }
  private async settle(run: RunSnapshot, item: PlanItem) {
    const candidates = run.quotes
      .filter(
        (q) =>
          q.skuId === item.skuId &&
          q.status === "offered" &&
          !this.validQuote(run, q),
      )
      .sort((a, b) => a.landedCostCents - b.landedCostCents);
    if (!candidates.length) {
      this.resolveWithoutPurchase(
        run.id,
        item,
        run.mode === "live" ? "failed" : "unavailable",
        "No compatible valid supplier offer was received.",
      );
      return;
    }
    let quote = candidates[0]!;
    if (run.mode === "live") {
      const choice = this.liveChoices.get(run.id)?.get(item.skuId);
      const selected = candidates.find((q) => q.id === choice?.quoteId);
      if (!selected)
        throw new DomainError(
          "Buyer did not return a valid selected quote for " + item.name,
          502,
        );
      quote = selected;
    }
    if (item.spotlight) {
      item.status = "negotiating";
      for (
        let round = 1;
        round <= (item.spotlight === "walkaway" ? 3 : 1);
        round++
      ) {
        let price = Math.max(
          1,
          Math.floor(
            quote.casePriceCents * (item.spotlight === "walkaway" ? 0.65 : 0.9),
          ),
        );
        if (run.mode === "live") {
          if (round === 1) {
            price =
              this.liveChoices.get(run.id)?.get(item.skuId)
                ?.counterofferCasePriceCents ?? price;
          } else {
            const action = (await this.bridge!.reason(item.buyerId, {
              runId: run.id,
              runGeneration: run.generation,
              deadlineAt: new Date(
                Date.parse(run.createdAt) + 5 * 60000,
              ).toISOString(),
              kind: "buyer_counteroffer",
              instruction:
                'Return JSON {"casePriceCents":integer}. Propose a feasible buyer counteroffer within this item budget; use only public quotes. Do not increase the buyer budget.',
              data: { item, currentQuote: quote, round },
            })) as { casePriceCents?: number };
            if (
              !Number.isSafeInteger(action.casePriceCents) ||
              Number(action.casePriceCents) <= 0 ||
              Number(action.casePriceCents) > quote.casePriceCents
            )
              throw new DomainError("Invalid buyer counteroffer", 502);
            price = Number(action.casePriceCents);
          }
        }
        this.event(
          run,
          item.buyerId,
          "counteroffer",
          `${item.name}: requesting $${(price / 100).toFixed(2)} per case from ${SUPPLIERS.find((s) => s.id === quote.supplierId)!.shortName}.`,
          { skuId: item.skuId, supplierId: quote.supplierId, round },
        );
        if (run.mode === "simulation") {
          const floor = this.privateStates
            .get(run.id)!
            .find(
              (s) =>
                s.supplierId === quote.supplierId && s.skuId === item.skuId,
            )!.floorCaseCents;
          const response = this.makeQuote(
            run.id,
            quote.supplierId,
            item.skuId,
            Math.max(price, floor),
            round,
          );
          this.addQuote(run.id, response);
          quote = response;
          this.event(
            run,
            quote.supplierId,
            "counteroffer_response",
            `${SUPPLIERS.find((s) => s.id === quote.supplierId)!.shortName}: $${(quote.casePriceCents / 100).toFixed(2)} per case is the current offer.`,
            { skuId: item.skuId, quoteId: quote.id },
          );
        } else {
          const response = await this.exchange(
            run,
            item.buyerId,
            quote.supplierId,
            "counteroffer",
            {
              lines: [
                { skuId: item.skuId, casePriceCents: price, cases: item.cases },
              ],
              round,
            },
          );
          this.ingestQuotePayload(run, response);
          const later = run.quotes
            .filter(
              (q) =>
                q.skuId === item.skuId &&
                q.round === round &&
                q.status === "offered",
            )
            .sort((a, b) => a.landedCostCents - b.landedCostCents)[0];
          if (later) quote = later;
        }
        await sleep(this.stepMs);
      }
    }
    if (quote.landedCostCents > item.allocationCents) {
      if (item.spotlight === "walkaway") {
        this.resolveWithoutPurchase(
          run.id,
          item,
          "unavailable",
          "Competing offers remain above the approved item budget after three rounds. Preserve cash this week.",
        );
        return;
      }
      const increment = quote.landedCostCents - item.allocationCents;
      this.event(
        run,
        item.buyerId,
        "budget_requested",
        `${item.name}: requesting $${(increment / 100).toFixed(2)} more from the manager reserve.`,
        { skuId: item.skuId, incrementCents: increment },
      );
      let approved = increment <= run.budget.unallocatedCents;
      if (run.mode === "live") {
        const response = await this.exchange(
          run,
          item.buyerId,
          "manager",
          "budget_request",
          { skuId: item.skuId, incrementCents: increment, quoteId: quote.id },
        );
        approved =
          approved &&
          (response.payload as Record<string, unknown>)?.approve === true;
      }
      if (approved) this.increaseBudget(run.id, item.skuId, increment);
      else {
        this.resolveWithoutPurchase(
          run.id,
          item,
          "unavailable",
          "Manager could not justify the required budget increase.",
        );
        return;
      }
    }
    this.commit(run.id, quote.id, run.generation);
    if (run.mode === "live") {
      const saved = this.db
        .prepare("SELECT payload FROM outbox WHERE id=?")
        .get(`accept:${run.id}:${quote.intentId}`);
      const notice = JSON.parse(String(saved!.payload)) as AgentEnvelope;
      try {
        const response = await this.exchange(
          run,
          notice.from,
          notice.to,
          notice.type,
          notice.payload,
          notice,
        );
        const receipt = response.payload as {
          kind?: string;
          accepted?: boolean;
          decisionId?: string;
          intentId?: string;
          quoteId?: string;
          quoteRevision?: number;
        };
        const committed = run.decisions.find((d) => d.quoteId === quote.id)!;
        if (
          receipt?.kind !== "purchase_receipt" ||
          receipt.accepted !== true ||
          receipt.decisionId !== committed.id ||
          receipt.intentId !== quote.intentId ||
          receipt.quoteId !== quote.id ||
          receipt.quoteRevision !== quote.revision
        )
          throw new DomainError("Invalid supplier acceptance receipt", 502);
        committed.receiptStatus = "confirmed";
        this.db
          .prepare("UPDATE outbox SET status='acknowledged' WHERE id=?")
          .run(notice.id);
        this.event(
          run,
          quote.supplierId,
          "supplier_acceptance_received",
          `${SUPPLIERS.find((s) => s.id === quote.supplierId)!.shortName} acknowledged the committed ${item.name} purchase.`,
          {
            skuId: item.skuId,
            quoteId: quote.id,
            supplierId: quote.supplierId,
          },
        );
      } catch {
        this.assertActive(run.id, run.generation);
        run.decisions.find((d) => d.quoteId === quote.id)!.receiptStatus =
          "unconfirmed";
        run.error =
          "A committed purchase lacks supplier acknowledgment; the live run is degraded.";
        this.event(
          run,
          "system",
          "supplier_acceptance_unconfirmed",
          `${item.name} remains committed in the ledger, but supplier receipt is unconfirmed.`,
          {
            skuId: item.skuId,
            quoteId: quote.id,
            supplierId: quote.supplierId,
          },
        );
      }
    }
  }
  private createPromotions(run: RunSnapshot) {
    run.promotionRevision++;
    const preferred = ["bananas", "apples", "carrots"];
    const decisions = preferred
      .map((id) =>
        run.decisions.find((d) => {
          const q = run.quotes.find((q) => q.id === d.quoteId);
          return (
            d.skuId === id &&
            d.outcome === "accepted" &&
            q &&
            q.deliveryDate <= "2026-10-04" &&
            Date.parse(q.deliveryDate) + q.shelfLifeDays * 86400000 >=
              Date.parse("2026-10-06")
          );
        }),
      )
      .filter((d): d is Decision => Boolean(d));
    if (decisions.length < 3) return;
    let allowance = run.budget.promotionAllowanceCents;
    run.promotions = decisions.map((d, i) => {
      const sku = CATALOG.find((s) => s.id === d.skuId)!,
        cost = Math.ceil(d.committedCostCents / d.quantity),
        cap = Math.min(d.quantity, i === 0 ? 12 : 24);
      let price =
        i === 0
          ? Math.max(1, cost - 20)
          : Math.max(cost + 20, Math.floor(sku.retailPriceCents * 0.9));
      let exposure = promotionExposure(
        d.committedCostCents,
        d.quantity,
        price,
        cap,
      );
      if (exposure > allowance) {
        price = cost;
        exposure = 0;
      }
      allowance -= exposure;
      return {
        id: randomUUID(),
        revision: run.promotionRevision,
        skuId: sku.id,
        name: sku.name,
        role: i === 0 ? "loss_leader" : "complement",
        retailPriceCents: price,
        regularPriceCents: sku.retailPriceCents,
        unit: sku.unit,
        quantityCap: cap,
        costPerUnitCents: cost,
        exposureCents: exposure,
        startsAt: "2026-10-04",
        endsAt: "2026-10-05",
        rationale:
          i === 0
            ? "A capped produce loss leader with explicitly budgeted exposure."
            : "A complementary produce offer with positive expected unit margin.",
        approved: false,
      };
    });
    run.budget.promotionExposureCents = run.promotions.reduce(
      (s, p) => s + p.exposureCents,
      0,
    );
    this.persist(run);
  }
  approve(id: string, revision: number) {
    const run = this.get(id);
    if (
      run.status !== "reviewing" &&
      run.status !== "flyer_ready" &&
      run.status !== "complete"
    )
      throw new DomainError("Promotion plan is not ready", 409);
    if (revision !== run.promotionRevision || run.promotions.length !== 3)
      throw new DomainError("Stale or incomplete promotion plan", 409);
    if (run.promotions.every((p) => p.approved)) return this.snapshot(id);
    run.promotions.forEach((p) => (p.approved = true));
    run.status = "flyer_ready";
    this.event(
      run,
      "manager",
      "promotions_approved",
      "Approved the frozen three-product promotion plan.",
    );
    return this.snapshot(id);
  }
  flyer(id: string) {
    const run = this.get(id);
    if (run.flyer.status === "ready") return this.snapshot(id);
    if (run.status !== "flyer_ready")
      throw new DomainError(
        "This run cannot compose a flyer in its current state",
        409,
      );
    if (!run.promotions.length || run.promotions.some((p) => !p.approved))
      throw new DomainError("Approve the promotion plan first", 409);
    const art = this.capabilities().image;
    if (!art.available)
      throw new DomainError("Generated artwork is not available yet", 409);
    run.flyer = {
      status: "ready",
      url: `/api/runs/${id}/flyer/preview`,
      artworkUrl: existsSync("public/assets/flyer-produce.png")
        ? "/assets/flyer-produce.png"
        : art.url,
      provenance:
        "Pregenerated AI artwork with application-rendered approved offer text",
    };
    run.status = "complete";
    this.event(
      run,
      "manager",
      "flyer_ready",
      "Flyer composed from approved prices and saved AI-generated artwork.",
    );
    return this.snapshot(id);
  }
  cancel(id: string) {
    void this.bridge?.cancelRun?.(id).catch(() => {});
    const run = this.get(id);
    if (terminal.has(run.status)) return this.snapshot(id);
    transaction(this.db, () => {
      run.status = "cancelled";
      run.generation++;
      for (const decision of run.decisions)
        if (decision.receiptStatus === "pending")
          decision.receiptStatus = "unconfirmed";
      run.budget.unallocatedCents += run.budget.reservedCents;
      run.budget.reservedCents = 0;
      this.db
        .prepare(
          "UPDATE intents SET status='cancelled',reserved=0,revision=revision+1 WHERE run_id=? AND status='open'",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE outbox SET status='cancelled' WHERE run_id=? AND status='pending'",
        )
        .run(id);
      this.event(
        run,
        "system",
        "run_cancelled",
        "Cancelled locally. Existing purchases are retained; uncommitted reservations released. External execution cancellation is not assumed.",
      );
    });
    for (const [key, w] of this.waits) {
      if (key.startsWith(id + ":")) {
        clearTimeout(w.timer);
        w.reject(new DomainError("Run cancelled", 409));
        this.waits.delete(key);
      }
    }
    return this.snapshot(id);
  }
  private fail(id: string, error: unknown) {
    void this.bridge?.cancelRun?.(id).catch(() => {});
    for (const [key, w] of this.waits) {
      if (key.startsWith(id + ":")) {
        clearTimeout(w.timer);
        w.reject(new DomainError("Run failed", 409));
        this.waits.delete(key);
      }
    }
    const run = this.get(id);
    if (terminal.has(run.status)) return;
    run.status = "failed";
    run.generation++;
    for (const decision of run.decisions)
      if (decision.receiptStatus === "pending")
        decision.receiptStatus = "unconfirmed";
    run.error =
      error instanceof DomainError
        ? error.message
        : "An external provider or processing step failed. Inspect provider readiness and start a fresh run.";
    run.budget.unallocatedCents += run.budget.reservedCents;
    run.budget.reservedCents = 0;
    this.db
      .prepare(
        "UPDATE intents SET status='failed',reserved=0,revision=revision+1 WHERE run_id=? AND status='open'",
      )
      .run(id);
    this.event(run, "system", "run_failed", run.error);
  }
  private async exchange(
    run: RunSnapshot,
    from: RoleId,
    to: RoleId,
    type: AgentEnvelope["type"],
    payload: unknown,
    persistedEnvelope?: AgentEnvelope,
  ) {
    if (!this.bridge)
      throw new DomainError("Provider bridge is not connected", 409);
    this.assertActive(run.id, run.generation);
    const correlationId = persistedEnvelope?.correlationId ?? randomUUID(),
      key = run.id + ":" + correlationId;
    const envelope: AgentEnvelope = persistedEnvelope ?? {
      id: randomUUID(),
      runId: run.id,
      runGeneration: run.generation,
      from,
      to,
      type,
      correlationId,
      payload,
      createdAt: new Date().toISOString(),
    };
    const response = new Promise<AgentEnvelope>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waits.delete(key);
          reject(new DomainError("Supplier exchange timed out", 504));
        },
        Math.max(
          1,
          Math.min(
            type === "accept_quote" ? 15000 : 90000,
            Date.parse(run.createdAt) + 5 * 60000 - Date.now(),
          ),
        ),
      );
      this.waits.set(key, {
        resolve,
        reject,
        timer,
        expectedFrom: to,
        expectedTo: from,
        expectedType:
          type === "budget_request"
            ? "budget_decision"
            : type === "accept_quote"
              ? "decision"
              : "quote",
      });
    });
    void response.catch(() => {});
    this.db
      .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
      .run(envelope.id, run.id, JSON.stringify(envelope), "pending");
    try {
      await Promise.race([
        this.bridge.send(envelope),
        response.then(() => undefined),
      ]);
      this.db
        .prepare("UPDATE outbox SET status='sent' WHERE id=?")
        .run(envelope.id);
    } catch (e) {
      const w = this.waits.get(key);
      if (w) {
        clearTimeout(w.timer);
        this.waits.delete(key);
        w.reject(new DomainError("Band send failed", 502));
      }
    }
    return response;
  }
  private async liveQuotes(run: RunSnapshot) {
    if (!this.bridge) throw new DomainError("Live provider unavailable", 409);
    const manager = (await this.bridge.reason("manager", {
      runId: run.id,
      runGeneration: run.generation,
      deadlineAt: new Date(Date.parse(run.createdAt) + 5 * 60000).toISOString(),
      kind: "manager_plan",
      instruction:
        'Allocate the produce budget. Return ONLY JSON {"allocations":[{"skuId":"...","allocationCents":1234}]} with every one of the 24 SKU IDs exactly once. Each allocation must be a nonnegative integer no greater than that item’s initial allocationCents policy cap; preserving the proposed amounts is acceptable. Keep unallocated manager reserve for later justified requests. Supplier private constraints are unavailable to you.',
      data: {
        store: STORE,
        items: run.items,
        budget: run.budget,
        evidence: run.evidence,
      },
    })) as { allocations?: { skuId: string; allocationCents: number }[] };
    this.assertActive(run.id, run.generation);
    if (
      !Array.isArray(manager.allocations) ||
      manager.allocations.length !== 24 ||
      new Set(manager.allocations.map((a) => a.skuId)).size !== 24
    )
      throw new DomainError(
        "Manager allocation response did not cover all24 items",
        502,
      );
    for (const allocation of manager.allocations) {
      const item = run.items.find((i) => i.skuId === allocation.skuId);
      if (
        !item ||
        !Number.isSafeInteger(allocation.allocationCents) ||
        allocation.allocationCents < 0 ||
        allocation.allocationCents > item.allocationCents
      )
        throw new DomainError(
          "Manager allocation exceeded initial policy cap",
          502,
        );
    }
    transaction(this.db, () => {
      for (const allocation of manager.allocations!) {
        const item = run.items.find((i) => i.skuId === allocation.skuId)!;
        const released = item.allocationCents - allocation.allocationCents;
        item.allocationCents = allocation.allocationCents;
        run.budget.reservedCents -= released;
        run.budget.unallocatedCents += released;
        this.db
          .prepare(
            "UPDATE intents SET reserved=?,revision=revision+1 WHERE run_id=? AND id=?",
          )
          .run(allocation.allocationCents, run.id, item.skuId);
      }
      this.event(
        run,
        "manager",
        "live_allocations_validated",
        "ZooWork manager allocations validated against the total budget and per-item policy caps.",
      );
    });
    for (const buyer of ["fruit-buyer", "vegetable-buyer"] as RoleId[]) {
      const suppliers = SUPPLIERS.filter((s) =>
        run.items.some((i) => i.buyerId === buyer && eligible(s.id, i.skuId)),
      );
      for (let offset = 0; offset < suppliers.length; offset += 4) {
        const responses = await Promise.allSettled(
          suppliers.slice(offset, offset + 4).map(async (supplier) => {
            const lines = run.items
              .filter(
                (i) => i.buyerId === buyer && eligible(supplier.id, i.skuId),
              )
              .map((i) => ({
                skuId: i.skuId,
                intentId: i.skuId,
                cases: i.cases,
                quantity: i.quantity,
                specification: CATALOG.find((c) => c.id === i.skuId),
              }));
            const response = await this.exchange(
              run,
              buyer,
              supplier.id,
              "rfq",
              { lines, round: 0 },
            );
            this.ingestQuotePayload(run, response);
            this.event(
              run,
              supplier.id,
              "quotes_received",
              `${supplier.shortName} returned live Band quotes for ${lines.length} requested produce lines.`,
              { supplierId: supplier.id },
            );
          }),
        );
        for (const [index, result] of responses.entries())
          if (result.status === "rejected") {
            this.assertActive(run.id, run.generation);
            const supplier = suppliers[offset + index]!;
            run.error =
              "One or more supplier exchanges failed; this run is degraded and uses remaining valid offers.";
            this.event(
              run,
              supplier.id,
              "supplier_exchange_failed",
              `${supplier.shortName} did not complete a valid exchange. Remaining suppliers continue; this is not a successful full live rehearsal.`,
              { supplierId: supplier.id },
            );
          }
      }
    }
    const choices = new Map<
      string,
      { quoteId: string; counterofferCasePriceCents?: number }
    >();
    for (const buyer of ["fruit-buyer", "vegetable-buyer"] as RoleId[]) {
      const items = run.items.filter(
        (i) =>
          i.buyerId === buyer &&
          run.quotes.some(
            (q) =>
              q.skuId === i.skuId &&
              q.status === "offered" &&
              !this.validQuote(run, q),
          ),
      );
      if (!items.length) continue;
      const quotes = run.quotes.filter(
        (q) =>
          items.some((i) => i.skuId === q.skuId) &&
          q.status === "offered" &&
          !this.validQuote(run, q),
      );
      let issues: { skuId: string; reason: string }[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = items.filter((item) => !choices.has(item.skuId));
        if (!remaining.length) break;
        const allowedQuotes = quotes.filter((q) =>
          remaining.some((item) => item.skuId === q.skuId),
        );
        try {
          const result = await this.bridge.reason(buyer, {
            runId: run.id,
            runGeneration: run.generation,
            deadlineAt: new Date(
              Date.parse(run.createdAt) + 5 * 60000,
            ).toISOString(),
            kind: "buyer_decision",
            instruction:
              'Choose a public supplier offer for each supplied SKU. Return ONLY JSON {"choices":[{"skuId":"...","quoteId":"exact existing quote ID","counterofferCasePriceCents":1234}]}. Copy one exact quote ID from that SAME SKU only; never use another SKU’s quote. Include each requested SKU once. Select on landed cost, specification, delivery and shelf life. Counteroffer is positive integer CENTS PER CASE at or below the selected case price; for an over-budget item target its budget per case. Supplier floors are unknown and must not be inferred as constraints on your bid. This is attempt ' +
              (attempt + 1) +
              "; previously valid choices are frozen and omitted. Correct the listed validation issues for the remaining lines only.",
            data: {
              items: remaining,
              quotes: allowedQuotes,
              validationIssues: issues,
              evidence: run.evidence.filter(
                (e) =>
                  !e.skuIds ||
                  e.skuIds.some((id) => remaining.some((i) => i.skuId === id)),
              ),
            },
          });
          this.assertActive(run.id, run.generation);
          const checked = validateBuyerChoices(
            result,
            remaining,
            allowedQuotes,
          );
          for (const [skuId, choice] of checked.accepted)
            choices.set(skuId, choice);
          issues = checked.issues;
        } catch {
          this.assertActive(run.id, run.generation);
          issues = remaining.map((item) => ({
            skuId: item.skuId,
            reason: "Buyer reasoning request failed",
          }));
        }
        if (issues.length)
          this.event(
            run,
            buyer,
            "buyer_choice_repair",
            attempt === 0
              ? "Some buyer choices failed validation; valid lines are retained and only invalid lines are being corrected."
              : "Buyer correction did not resolve every line; unresolved items will be marked failed independently.",
            { attempt: attempt + 1, issues },
          );
      }
      this.event(
        run,
        buyer,
        "buyer_choices_validated",
        "ZooWork buyer selections validated against public quote and specification constraints.",
        {
          itemCount: items.filter((i) => choices.has(i.skuId)).length,
          unresolved: items.filter((i) => !choices.has(i.skuId)).length,
        },
      );
    }
    this.liveChoices.set(run.id, choices);
  }
  private ingestQuotePayload(run: RunSnapshot, message: AgentEnvelope) {
    const payload = message.payload as { quotes?: PublicQuote[] };
    if (!Array.isArray(payload?.quotes))
      throw new DomainError("Invalid quote response", 502);
    const seen = new Set<string>();
    for (const q of payload.quotes) {
      if (
        !q ||
        typeof q !== "object" ||
        typeof q.skuId !== "string" ||
        seen.has(q.skuId) ||
        q.supplierId !== message.from ||
        q.runId !== run.id
      )
        continue;
      seen.add(q.skuId);
      this.addQuote(run.id, q);
    }
  }
  private async receive(message: AgentEnvelope) {
    const run = this.assertActive(message.runId, message.runGeneration);
    if (!this.bridge) return;
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO inbox VALUES(?,?,?,'received')")
      .run(message.id, run.id, JSON.stringify(message));
    if (!inserted.changes) return;
    const key = run.id + ":" + message.correlationId;
    if (
      message.type === "quote" ||
      message.type === "budget_decision" ||
      message.type === "decision"
    ) {
      const wait = this.waits.get(key);
      if (
        wait &&
        message.from === wait.expectedFrom &&
        message.to === wait.expectedTo &&
        message.type === wait.expectedType
      ) {
        clearTimeout(wait.timer);
        this.waits.delete(key);
        wait.resolve(message);
      }
      this.db
        .prepare("UPDATE inbox SET status='processed' WHERE id=?")
        .run(message.id);
      return;
    }
    let replyPayload: unknown;
    let type: AgentEnvelope["type"];
    if (message.type === "rfq" || message.type === "counteroffer") {
      if (
        !SUPPLIERS.some((s) => s.id === message.to) ||
        !["fruit-buyer", "vegetable-buyer"].includes(message.from)
      )
        throw new DomainError("Invalid supplier message ownership", 403);
      const p = message.payload as {
        lines: { skuId: string; casePriceCents?: number }[];
        round: number;
      };
      if (
        !Array.isArray(p?.lines) ||
        !Number.isSafeInteger(p.round) ||
        p.round < 0 ||
        p.round > 3 ||
        p.lines.some(
          (l) =>
            !l ||
            typeof l.skuId !== "string" ||
            !run.items.some(
              (i) => i.skuId === l.skuId && i.buyerId === message.from,
            ) ||
            !eligible(message.to, l.skuId),
        ) ||
        new Set(p.lines.map((l) => l.skuId)).size !== p.lines.length
      )
        throw new DomainError("Invalid RFQ line ownership or round", 403);
      const privateState = this.privateStates
        .get(run.id)!
        .filter(
          (s) =>
            s.supplierId === message.to &&
            p.lines.some((l) => l.skuId === s.skuId),
        );
      const accepted = new Map<string, PublicQuote>();
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = p.lines.filter((l) => !accepted.has(l.skuId));
        if (!remaining.length) break;
        const result = (await this.bridge.reason(message.to, {
          runId: run.id,
          runGeneration: run.generation,
          deadlineAt: new Date(
            Date.parse(run.createdAt) + 5 * 60000,
          ).toISOString(),
          kind: "supplier_quotes",
          instruction:
            'Negotiate as this supplier using only your own private constraints. Return ONLY JSON {"quotes":[{"skuId":"...","casePriceCents":1234}]}, one line per requested SKU. Never disclose private floor/target labels or prose. Quote prices must be integer cents and at least your minimum. Accept a requested counteroffer if feasible; otherwise counter with a valid price. This is attempt ' +
            (attempt + 1) +
            "; return each requested ID exactly once.",
          data: {
            request: { ...p, lines: remaining },
            privateState: privateState.filter((s) =>
              remaining.some((l) => l.skuId === s.skuId),
            ),
          },
        })) as { quotes?: unknown };
        this.assertActive(run.id, message.runGeneration);
        if (!Array.isArray(result?.quotes)) continue;
        const counts = new Map<string, number>();
        for (const raw of result.quotes)
          if (raw && typeof raw === "object" && typeof raw.skuId === "string")
            counts.set(raw.skuId, (counts.get(raw.skuId) ?? 0) + 1);
        for (const raw of result.quotes) {
          if (
            !raw ||
            typeof raw !== "object" ||
            typeof raw.skuId !== "string" ||
            counts.get(raw.skuId) !== 1 ||
            !remaining.some((l) => l.skuId === raw.skuId) ||
            !Number.isSafeInteger(raw.casePriceCents)
          )
            continue;
          const state = privateState.find((s) => s.skuId === raw.skuId);
          if (
            !state ||
            raw.casePriceCents < state.floorCaseCents ||
            raw.casePriceCents > 10000000
          )
            continue;
          accepted.set(
            raw.skuId,
            this.makeQuote(
              run.id,
              message.to,
              raw.skuId,
              raw.casePriceCents,
              p.round,
            ),
          );
        }
      }
      const quotes = [...accepted.values()];
      if (quotes.length < p.lines.length)
        this.event(
          run,
          message.to,
          "quote_lines_missing",
          "Supplier response contained invalid or missing lines after one repair; valid lines were retained.",
          {
            supplierId: message.to,
            requested: p.lines.length,
            valid: quotes.length,
          },
        );
      replyPayload = { quotes };
      type = "quote";
    } else if (message.type === "accept_quote") {
      const p = message.payload as {
        decisionId?: string;
        intentId?: string;
        skuId?: string;
        quoteId?: string;
        quoteRevision?: number;
        quantity?: number;
        committedCostCents?: number;
      };
      const decision = run.decisions.find(
        (d) =>
          d.id === p?.decisionId &&
          d.intentId === p?.intentId &&
          d.skuId === p?.skuId &&
          d.quoteId === p?.quoteId &&
          d.outcome === "accepted",
      );
      const quote = run.quotes.find((q) => q.id === p?.quoteId);
      const item = run.items.find((i) => i.skuId === p?.skuId);
      if (
        !decision ||
        !quote ||
        quote.revision !== p.quoteRevision ||
        decision.supplierId !== message.to ||
        item?.buyerId !== message.from ||
        decision.quantity !== p.quantity ||
        decision.committedCostCents !== p.committedCostCents
      )
        throw new DomainError(
          "Acceptance notification does not match committed purchase",
          403,
        );
      replyPayload = {
        kind: "purchase_receipt",
        accepted: true,
        decisionId: decision.id,
        intentId: decision.intentId,
        quoteId: decision.quoteId,
        quoteRevision: quote.revision,
      };
      type = "decision";
    } else if (message.type === "budget_request") {
      if (
        message.to !== "manager" ||
        !["fruit-buyer", "vegetable-buyer"].includes(message.from)
      )
        throw new DomainError("Invalid manager message ownership", 403);
      const p = message.payload as { incrementCents: number; skuId: string };
      if (
        !Number.isSafeInteger(p.incrementCents) ||
        p.incrementCents < 0 ||
        !run.items.some(
          (i) => i.skuId === p.skuId && i.buyerId === message.from,
        )
      )
        throw new DomainError(
          "Invalid budget request ownership or amount",
          403,
        );
      const decision = (await this.bridge.reason("manager", {
        runId: run.id,
        runGeneration: run.generation,
        deadlineAt: new Date(
          Date.parse(run.createdAt) + 5 * 60000,
        ).toISOString(),
        kind: "manager_budget",
        instruction:
          'Evaluate a buyer budget request against unallocated store funds. Return only JSON {"approve":true} or {"approve":false}. Never increase the store total. Approve if the requested amount is available and preserves the planned produce assortment.',
        data: { request: p, budget: run.budget, items: run.items },
      })) as { approve?: unknown };
      if (typeof decision?.approve !== "boolean")
        throw new DomainError(
          "Manager budget response is not a boolean decision",
          502,
        );
      replyPayload = { approve: decision.approve };
      type = "budget_decision";
    } else {
      return;
    }
    const response: AgentEnvelope = {
      id: randomUUID(),
      runId: run.id,
      runGeneration: message.runGeneration,
      from: message.to,
      to: message.from,
      type,
      correlationId: message.correlationId,
      payload: replyPayload,
      createdAt: new Date().toISOString(),
    };
    this.assertActive(run.id, message.runGeneration);
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE inbox SET status='processed' WHERE id=?")
        .run(message.id);
      this.db
        .prepare("INSERT INTO outbox VALUES(?,?,?,'pending')")
        .run(response.id, run.id, JSON.stringify(response));
    });
    await this.bridge.send(response);
    this.db
      .prepare("UPDATE outbox SET status='sent' WHERE id=?")
      .run(response.id);
  }
  close() {
    this.unsubscribe?.();
    for (const w of this.waits.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("Engine closed"));
    }
    this.waits.clear();
    this.db.close();
  }
}

export const ROLE_IDS = [
  "manager",
  "fruit-buyer",
  "vegetable-buyer",
  "supplier-wholesale",
  "supplier-farm",
  "supplier-organic",
  "supplier-surplus",
  "supplier-fruit",
  "supplier-coop",
  "supplier-import",
  "supplier-rapid",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export type RunMode = "simulation" | "live";
export type RunStatus =
  | "created"
  | "researching"
  | "allocating"
  | "negotiating"
  | "reviewing"
  | "flyer_ready"
  | "complete"
  | "cancelled"
  | "failed"
  | "interrupted";
export type MessageType =
  | "rfq"
  | "quote"
  | "counteroffer"
  | "budget_request"
  | "budget_decision"
  | "accept_quote"
  | "decision";
export interface AgentEnvelope {
  id: string;
  runId: string;
  runGeneration: number;
  from: RoleId;
  to: RoleId;
  type: MessageType;
  correlationId: string;
  payload: unknown;
  createdAt: string;
}
export interface StoreProfile {
  id: string;
  name: string;
  neighborhood: string;
  city: string;
  zcta: string;
  scenarioDate: string;
}
export interface InventoryLot {
  id: string;
  quantity: number;
  availableAt: string;
  expiresAt: string;
  source: "on_hand" | "inbound" | "purchase";
  costCents: number;
}
export interface CatalogItem {
  id: string;
  name: string;
  category: "fruit" | "vegetable";
  buyerId: RoleId;
  unit: string;
  unitsPerCase: number;
  gramsPerUnit?: number;
  grade: string;
  organic: boolean;
  baseCaseCostCents: number;
  retailPriceCents: number;
  forecastUnits: number;
  safetyStockUnits: number;
  lots: InventoryLot[];
  image?: string;
}
export interface SupplierPublic {
  id: RoleId;
  name: string;
  shortName: string;
  persona: string;
  location: string;
  color: string;
  specialty: string;
  eligibleSkuIds: string[];
}
export interface Evidence {
  id: string;
  source: string;
  title: string;
  summary: string;
  url?: string;
  observedAt: string;
  fetchedAt: string;
  scenarioDate: string;
  mode: "live" | "cached-live" | "fixture" | "derived" | "unavailable";
  skuIds?: string[];
  values?: Record<string, string | number>;
}
export interface PlanItem {
  skuId: string;
  name: string;
  buyerId: RoleId;
  category: "fruit" | "vegetable";
  neededUnits: number;
  demand?: {
    baselineForecastUnits: number;
    adjustedForecastUnits: number;
    seasonalAdjustmentUnits: number;
    trendAdjustmentUnits?: number;
    trendEvidenceIds?: string[];
    adjustmentCapUnits: number;
    evidenceId?: string;
    rationale: string;
  };
  cases: number;
  quantity: number;
  allocationCents: number;
  status:
    | "pending"
    | "quoting"
    | "negotiating"
    | "accepted"
    | "unavailable"
    | "skipped"
    | "failed";
  spotlight?: "win" | "escalation" | "walkaway";
  rationale: string;
}
export interface PublicQuote {
  id: string;
  revision: number;
  runId: string;
  intentId: string;
  skuId: string;
  supplierId: RoleId;
  casePriceCents: number;
  cases: number;
  quantity: number;
  unitsPerCase: number;
  freightCents: number;
  landedCostCents: number;
  availableUnits: number;
  minimumCases: number;
  grade: string;
  organic: boolean;
  deliveryDate: string;
  expiresAt: string;
  shelfLifeDays: number;
  status: "offered" | "accepted" | "rejected" | "invalid";
  round: number;
  source: RunMode;
  rejectionReason?: string;
}
export interface Decision {
  id: string;
  skuId: string;
  intentId: string;
  outcome: "accepted" | "unavailable" | "skipped" | "failed";
  supplierId?: RoleId;
  quoteId?: string;
  quantity: number;
  committedCostCents: number;
  reason: string;
  alternatives: { quoteId: string; reason: string }[];
  escalated: boolean;
  receiptStatus?: "pending" | "confirmed" | "unconfirmed";
}
export interface Budget {
  totalCents: number;
  committedCents: number;
  reservedCents: number;
  unallocatedCents: number;
  promotionAllowanceCents: number;
  promotionExposureCents: number;
}
export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  timestamp: string;
  actor: RoleId | "system";
  type: string;
  summary: string;
  data?: Record<string, unknown>;
  visibility: "operator" | "god";
}
export interface Promotion {
  id: string;
  revision: number;
  skuId: string;
  name: string;
  role: "loss_leader" | "complement";
  retailPriceCents: number;
  regularPriceCents: number;
  unit: string;
  quantityCap: number;
  costPerUnitCents: number;
  exposureCents: number;
  startsAt: string;
  endsAt: string;
  rationale: string;
  approved: boolean;
}
export interface Capabilities {
  simulation: boolean;
  live: boolean;
  blockers: string[];
  providers?: Record<string, unknown>;
  image: {
    available: boolean;
    mode: "pregenerated" | "unavailable";
    url?: string;
  };
}
export interface RunSnapshot {
  id: string;
  generation: number;
  mode: RunMode;
  useTrends?: boolean;
  trends?: TrendReport;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  store: StoreProfile;
  budget: Budget;
  items: PlanItem[];
  quotes: PublicQuote[];
  decisions: Decision[];
  events: RunEvent[];
  eventSeq: number;
  promotions: Promotion[];
  promotionRevision: number;
  flyer: {
    status: "unavailable" | "ready";
    url?: string;
    artworkUrl?: string;
    provenance: string;
  };
  suppliers: SupplierPublic[];
  evidence: Evidence[];
  progress: { resolved: number; total: number; suppliersResponded: number };
  capabilities: Capabilities;
  error?: string;
}
export interface SupplierPrivateState {
  supplierId: RoleId;
  skuId: string;
  floorCaseCents: number;
  targetCaseCents: number;
  stockUnits: number;
  reservedUnits: number;
  urgency: string;
  negotiationState: string;
}
export interface GodSnapshot extends RunSnapshot {
  privateSuppliers: SupplierPrivateState[];
  agentStates: { id: RoleId; status: string; lastActivity?: string }[];
}
export interface Bootstrap {
  trends?: TrendReport;
  store: StoreProfile;
  catalog: CatalogItem[];
  suppliers: SupplierPublic[];
  capabilities: Capabilities;
  currentRun: RunSnapshot | null;
  defaults: { budgetCents: number; promotionAllowanceCents: number };
}

export interface TrendSignal {
  id: string;
  platform: "tiktok" | "x";
  skuIds: string[];
  query: string;
  title: string;
  url: string;
  postedAt?: string;
  observedAt: string;
  engagement?: {
    views?: number;
    likes?: number;
    reposts?: number;
    comments?: number;
  };
  source: string;
  signalType: "social_interest";
  provenGrowth: false;
}
export type TrendTopic =
  | "cucumbers"
  | "avocados"
  | "strawberries"
  | "apples"
  | "bananas";
export interface TrendReport {
  querySkuId?: TrendTopic;
  eligibleSkuIds?: string[];
  impactPreview?: { skuId: string; baselineForecastUnits: number; adjustedForecastUnits: number; baselineOrderUnits: number; adjustedOrderUnits: number; baselineCases: number; adjustedCases: number }[];
  observedAt: string;
  status: "live" | "partial" | "unavailable";
  signals: TrendSignal[];
  providers: {
    platform: "tiktok" | "x";
    status: "live" | "unavailable";
    count: number;
    error?: string;
    chargedUsd?: string;
    runUrl?: string;
  }[];
  totalChargedUsd: string;
}

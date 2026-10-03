import type {
  CatalogItem,
  RoleId,
  StoreProfile,
  SupplierPublic,
  SupplierPrivateState,
  Evidence,
} from "../shared/types.js";
export const STORE: StoreProfile = {
  id: "mission-market",
  name: "Mission Market",
  neighborhood: "Mission District",
  city: "San Francisco",
  zcta: "94110",
  scenarioDate: "2026-10-03",
};
export const DEFAULT_BUDGET = 200_000;
export const DEFAULT_PROMOTION_ALLOWANCE = 5_000;
const FRUITS = [
  ["apples", "Apples", "each", 40, 2800],
  ["bananas", "Bananas", "1 lb bag", 20, 1800],
  ["strawberries", "Strawberries", "pint", 12, 3600],
  ["blueberries", "Blueberries", "pint", 12, 3200],
  ["raspberries", "Raspberries", "6 oz pack", 12, 3400],
  ["grapes", "Grapes", "1 lb bag", 18, 2700],
  ["oranges", "Oranges", "each", 40, 2400],
  ["mandarins", "Mandarins", "1 lb bag", 20, 2600],
  ["lemons", "Lemons", "each", 60, 2500],
  ["limes", "Limes", "each", 60, 2100],
  ["pears", "Pears", "each", 36, 2900],
  ["avocados", "Avocados", "each", 48, 4800],
] as const;
const VEGETABLES = [
  ["tomatoes", "Tomatoes", "1 lb pack", 20, 2400],
  ["romaine", "Romaine lettuce", "head", 24, 2400],
  ["broccoli", "Broccoli", "head", 20, 2600],
  ["potatoes", "Potatoes", "2 lb bag", 20, 2000],
  ["onions", "Onions", "2 lb bag", 20, 1900],
  ["carrots", "Carrots", "1 lb bag", 24, 1800],
  ["cucumbers", "Cucumbers", "each", 36, 2200],
  ["bell-peppers", "Bell peppers", "each", 36, 2800],
  ["zucchini", "Zucchini", "each", 30, 2400],
  ["spinach", "Spinach", "8 oz bag", 24, 3000],
  ["kale", "Organic kale", "bunch", 24, 3000],
  ["mushrooms", "Mushrooms", "8 oz pack", 24, 3400],
] as const;
export const CATALOG: CatalogItem[] = [...FRUITS, ...VEGETABLES].map(
  (row, index) => {
    const [id, name, unit, unitsPerCase, baseCaseCostCents] = row;
    return {
      id,
      name,
      unit,
      unitsPerCase,
      grade: "US No. 1",
      organic: id === "kale",
      category: index < 12 ? "fruit" : "vegetable",
      buyerId: index < 12 ? "fruit-buyer" : "vegetable-buyer",
      baseCaseCostCents,
      retailPriceCents:
        Math.ceil(((baseCaseCostCents / unitsPerCase) * 1.65) / 5) * 5,
      forecastUnits: unitsPerCase * (index % 2 ? 2 : 1) + 4,
      safetyStockUnits: 6,
      gramsPerUnit: unit.includes("1 lb")
        ? 454
        : unit.includes("2 lb")
          ? 908
          : unit.includes("8 oz")
            ? 227
            : undefined,
      lots: [
        {
          id: `${id}-opening`,
          quantity: 10,
          availableAt: "2026-10-02",
          expiresAt: "2026-10-10",
          source: "on_hand",
          costCents: Math.round(baseCaseCostCents / unitsPerCase),
        },
        {
          id: `${id}-late-inbound`,
          quantity: unitsPerCase,
          availableAt: "2026-10-11",
          expiresAt: "2026-10-17",
          source: "inbound",
          costCents: Math.round(baseCaseCostCents / unitsPerCase),
        },
      ],
    };
  },
);
const all = CATALOG.map((x) => x.id),
  fruit = CATALOG.filter((x) => x.category === "fruit").map((x) => x.id),
  veg = CATALOG.filter((x) => x.category === "vegetable").map((x) => x.id);
export const SUPPLIERS: SupplierPublic[] = [
  {
    id: "supplier-wholesale",
    name: "Bayline Produce Wholesale",
    shortName: "Bayline",
    persona: "Competitive bulk wholesaler",
    location: "South San Francisco",
    color: "#5b8776",
    specialty: "Broad assortment · bulk value",
    eligibleSkuIds: all,
  },
  {
    id: "supplier-farm",
    name: "Fog & Field Farm",
    shortName: "Fog & Field",
    persona: "Seasonal local farm with limited stock",
    location: "Half Moon Bay",
    color: "#9b9b5f",
    specialty: "Local harvest · freshness",
    eligibleSkuIds: [
      "strawberries",
      "apples",
      "pears",
      "tomatoes",
      "romaine",
      "broccoli",
      "carrots",
      "zucchini",
      "spinach",
      "kale",
    ],
  },
  {
    id: "supplier-organic",
    name: "Verdant Organic",
    shortName: "Verdant",
    persona: "Premium organic distributor",
    location: "Watsonville",
    color: "#71975b",
    specialty: "Certified-spec organic · premium quality",
    eligibleSkuIds: ["kale"],
  },
  {
    id: "supplier-surplus",
    name: "Second Harvest Exchange",
    shortName: "Second Harvest",
    persona: "Ripe stock with short remaining shelf life",
    location: "Oakland",
    color: "#c19b51",
    specialty: "Ripe today · sharp discounts",
    eligibleSkuIds: [
      "bananas",
      "tomatoes",
      "avocados",
      "grapes",
      "potatoes",
      "onions",
    ],
  },
  {
    id: "supplier-fruit",
    name: "Orchard House",
    shortName: "Orchard House",
    persona: "Fruit specialist",
    location: "San Jose",
    color: "#ba7968",
    specialty: "Fruit assortment · consistent grades",
    eligibleSkuIds: fruit,
  },
  {
    id: "supplier-coop",
    name: "Coast Growers Co-op",
    shortName: "Coast Growers",
    persona: "Vegetable grower cooperative",
    location: "Salinas",
    color: "#5e9696",
    specialty: "Vegetables · harvest-linked stock",
    eligibleSkuIds: veg,
  },
  {
    id: "supplier-import",
    name: "Pacific Citrus & Tropics",
    shortName: "Pacific Citrus",
    persona: "Import and citrus distributor",
    location: "Port of Oakland",
    color: "#c68e45",
    specialty: "Citrus & tropical · shipment value",
    eligibleSkuIds: [
      "bananas",
      "oranges",
      "mandarins",
      "lemons",
      "limes",
      "avocados",
    ],
  },
  {
    id: "supplier-rapid",
    name: "First Light Produce",
    shortName: "First Light",
    persona: "Rapid delivery supplier",
    location: "San Francisco",
    color: "#7b7fab",
    specialty: "Same-day delivery · service premium",
    eligibleSkuIds: all,
  },
];
export const SUPPLIER_FACTORS = [100, 107, 123, 86, 98, 96, 94, 114];
export function createPrivateStock(): SupplierPrivateState[] {
  return SUPPLIERS.flatMap((s, i) =>
    s.eligibleSkuIds.map((id) => {
      const sku = CATALOG.find((x) => x.id === id)!;
      return {
        supplierId: s.id,
        skuId: id,
        floorCaseCents: Math.round(
          ((sku.baseCaseCostCents * SUPPLIER_FACTORS[i]!) / 100) * 0.93,
        ),
        targetCaseCents: Math.round(
          ((sku.baseCaseCostCents * SUPPLIER_FACTORS[i]!) / 100) * 1.1,
        ),
        stockUnits: sku.unitsPerCase * (s.id === "supplier-farm" ? 4 : 12),
        reservedUnits: 0,
        urgency:
          s.id === "supplier-surplus"
            ? "High: ripe inventory"
            : s.id === "supplier-farm"
              ? "Harvest-limited"
              : "Normal",
        negotiationState: "ready",
      };
    }),
  );
}
export const FIXTURE_EVIDENCE: Evidence[] = [
  {
    id: "inventory-fixture",
    source: "Demo inventory",
    title: "A dated, transparent store scenario",
    summary:
      "24 produce SKUs with simulated sales, dated stock lots, supplier availability and expiry. Late inbound arriving October 11 is excluded from this buying window.",
    observedAt: "2026-10-03",
    fetchedAt: new Date().toISOString(),
    scenarioDate: STORE.scenarioDate,
    mode: "fixture",
  },
  {
    id: "seasonal-fixture",
    source: "Seasonal scenario",
    title: "Early October assortment",
    summary:
      "Simulated October 4–5 fall produce weekend: apple forecast +10%, rounded up and capped at four units before net-need and whole-case rounding. This store scenario is not a discovered event or measured sales lift. No demographic multiplier is applied.",
    observedAt: "2026-10-03",
    fetchedAt: new Date().toISOString(),
    scenarioDate: STORE.scenarioDate,
    mode: "fixture",
  },
];
export function eligible(supplierId: RoleId, skuId: string) {
  return (
    SUPPLIERS.find((x) => x.id === supplierId)?.eligibleSkuIds.includes(
      skuId,
    ) ?? false
  );
}

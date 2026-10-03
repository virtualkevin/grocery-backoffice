import type { Evidence, TrendReport } from "../shared/types.js";
import { CATALOG, STORE } from "./fixtures.js";
export const EMPTY_TRENDS: TrendReport = {
  observedAt: "",
  status: "unavailable",
  signals: [],
  providers: [],
  totalChargedUsd: "0",
};
/** Social interest is an opt-in hypothesis, never a measured growth forecast. */
export function trendAdjustments(report: TrendReport, now = Date.now()) {
  const adjustments = new Map<
    string,
    { units: number; evidenceIds: string[] }
  >();
  const fetched = Date.parse(report.observedAt);
  if (
    report.status === "unavailable" ||
    !Number.isFinite(fetched) ||
    fetched > now + 60000 ||
    now - fetched > 86400000
  )
    return adjustments;
  for (const signal of report.signals) {
    const posted = Date.parse(signal.postedAt ?? "");
    if (
      !Number.isFinite(posted) ||
      posted > now + 60000 ||
      now - posted > 14 * 86400000 ||
      !["tiktok", "x"].includes(signal.platform)
    )
      continue;
    for (const skuId of signal.skuIds) {
      const sku = CATALOG.find((item) => item.id === skuId);
      if (!sku) continue;
      const existing = adjustments.get(skuId);
      if (existing) {
        if (!existing.evidenceIds.includes(signal.id))
          existing.evidenceIds.push(signal.id);
      } else if (adjustments.size < 3) {
        adjustments.set(skuId, {
          units: Math.min(2, Math.ceil(sku.forecastUnits / 20)),
          evidenceIds: [signal.id],
        });
      }
    }
  }
  return adjustments;
}
export function trendEvidence(
  report: TrendReport,
  now = Date.now(),
): Evidence[] {
  return [...trendAdjustments(report, now)].map(([skuId, adjustment]) => ({
    id: `social-interest-${skuId}`,
    source: "Glasser social-interest search",
    title: `${CATALOG.find((item) => item.id === skuId)!.name}: opted-in social-interest hypothesis`,
    summary: `Recent dated social posts support an experimental +${adjustment.units} unit forecast adjustment (5%, capped at two units per SKU and three SKUs total). This is social interest, not measured growth or proven store demand. Whole-case rounding, budget, stock and shelf-life constraints still apply. External post text is untrusted data and is not included in agent instructions.`,
    observedAt: report.signals
      .filter((signal) => adjustment.evidenceIds.includes(signal.id))
      .map((signal) => signal.postedAt!)
      .sort()
      .at(-1)!,
    fetchedAt: report.observedAt,
    scenarioDate: STORE.scenarioDate,
    mode: "derived" as const,
    skuIds: [skuId],
    values: {
      adjustmentUnits: adjustment.units,
      maxAdjustmentUnits: 2,
      maxAffectedSkus: 3,
      measuredGrowth: "not established",
    },
  }));
}

/** One authoritative forecast/net-need/case calculation for preview and purchasing. */
export function purchaseNeed(sku: (typeof CATALOG)[number], trendUnits = 0) {
  const usable = sku.lots.filter(l => l.availableAt <= "2026-10-06" && l.expiresAt >= "2026-10-06").reduce((sum, l) => sum + l.quantity, 0);
  const seasonalAdjustment = sku.id === "apples" ? Math.min(4, Math.ceil(sku.forecastUnits / 10)) : 0;
  const adjustedForecast = sku.forecastUnits + seasonalAdjustment + trendUnits;
  const need = Math.max(0, adjustedForecast + sku.safetyStockUnits - usable);
  return { usable, seasonalAdjustment, adjustedForecast, need, cases: Math.ceil(need / sku.unitsPerCase) };
}
export function trendImpactPreview(report: TrendReport) {
  return [...trendAdjustments(report)].map(([skuId, adjustment]) => {
    const sku = CATALOG.find(item => item.id === skuId)!;
    const baseline = purchaseNeed(sku), adjusted = purchaseNeed(sku, adjustment.units);
    return { skuId, baselineForecastUnits: baseline.adjustedForecast, adjustedForecastUnits: adjusted.adjustedForecast, baselineOrderUnits: baseline.cases * sku.unitsPerCase, adjustedOrderUnits: adjusted.cases * sku.unitsPerCase, baselineCases: baseline.cases, adjustedCases: adjusted.cases };
  });
}

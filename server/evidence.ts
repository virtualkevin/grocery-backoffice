import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Evidence } from "../shared/types.js";
import { STORE } from "./fixtures.js";
const cachePath = "data/evidence-cache.json";
const now = () => new Date().toISOString();
async function json(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(18000) });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

export function archivedCensusEvidence(): Evidence {
  const record = JSON.parse(
    readFileSync(
      new URL("./data/census-94110-p9.json", import.meta.url),
      "utf8",
    ),
  );
  const total = record.counts.P0090001,
    hispanic = record.counts.P0090002,
    nonHispanic = record.counts.P0090003;
  if (
    record.zcta !== "94110" ||
    record.year !== 2020 ||
    !Number.isSafeInteger(total) ||
    total !== hispanic + nonHispanic
  )
    throw new Error("Invalid verified Census archive record");
  return {
    id: "census-94110",
    source: "US Census · 2020 DHC P9 official archive",
    title: "Neighborhood context · ZCTA 94110",
    summary: `2020 Census: ${total.toLocaleString()} residents; ${hispanic.toLocaleString()} Hispanic or Latino (${((hispanic / total) * 100).toFixed(1)}%). Verified from the official national DHC archive by geography/log-record join. Aggregate context only; no deterministic demographic purchasing multiplier.`,
    url: record.sourceUrl,
    observedAt: record.observedAt,
    fetchedAt: record.retrievedAt,
    scenarioDate: STORE.scenarioDate,
    mode: "cached-live",
    values: {
      population: total,
      hispanicOrLatino: hispanic,
      notHispanicOrLatino: nonHispanic,
      hispanicPercent: Math.round((hispanic / total) * 1000) / 10,
      zcta: "94110",
      year: 2020,
      sourceMember: record.sourceMember,
      geoid: record.geoid,
      verification: record.verification,
    },
  };
}

export async function fetchEvidence(): Promise<Evidence[]> {
  const result: Evidence[] = [];
  const fetchedAt = now();
  let cached: Evidence[] = [];
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {}
  }
  try {
    const data = (await json(
      "https://api.census.gov/data/2020/dec/dhc?get=NAME,P9_001N,P9_002N,P9_003N&for=zip%20code%20tabulation%20area:94110" +
        (process.env.CENSUS_API_KEY
          ? "&key=" + encodeURIComponent(process.env.CENSUS_API_KEY)
          : ""),
    )) as string[][];
    if (!Array.isArray(data) || !Array.isArray(data[1]))
      throw new Error("invalid_response");
    const values = Object.fromEntries(
      data[0]!.map((field, i) => [field, data[1]![i]!]),
    );
    result.push({
      id: "census-94110",
      source: "US Census · 2020 DHC P9",
      title: "Neighborhood context · ZCTA 94110",
      summary: `2020 decennial population: ${Number(values.P9_001N).toLocaleString()} residents in ZCTA 94110. Aggregate neighborhood context only; no deterministic demographic purchasing multiplier.`,
      url: "https://data.census.gov/table/DECENNIALDHC2020.P9",
      observedAt: "2020-04-01",
      fetchedAt,
      scenarioDate: STORE.scenarioDate,
      mode: "live",
      values,
    });
  } catch {
    const previous = cached.find(
      (e) => e.id === "census-94110" && e.mode !== "unavailable",
    );
    result.push(
      previous
        ? { ...previous, mode: "cached-live" }
        : archivedCensusEvidence(),
    );
  }
  const key = process.env.USDA_AMS_API_KEY;
  if (key) {
    try {
      const reports = await json(
        "https://marsapi.ams.usda.gov/services/v1.2/reports/2306/report%20details?lastReports=2",
        { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") },
      );
      const rows = extractRows(reports);
      const matches = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const commodity = String(
          row.commodity ?? row.commodity_name ?? "",
        ).toLowerCase();
        const sku = [
          "apples",
          "bananas",
          "strawberries",
          "blueberries",
          "grapes",
        ].find((x) => commodity === x || commodity.includes(x));
        if (sku) {
          const list = matches.get(sku) ?? [];
          list.push(row);
          matches.set(sku, list);
        }
      }
      for (const [sku, rows] of [...matches].slice(0, 5)) {
        const ordered = rows
          .filter((r) => r.report_date)
          .sort(
            (a, b) =>
              Date.parse(String(b.report_date)) -
              Date.parse(String(a.report_date)),
          );
        const first = ordered[0];
        if (!first) continue;
        const matchKeys = [
          "commodity",
          "package",
          "grade",
          "variety",
          "origin",
          "district",
          "item_size",
          "organic",
          "market_location_name",
          "storage",
          "transportation_mode",
          "quality",
          "condition",
          "appearance",
          "repack",
          "unit_sales",
          "crop",
          "environment",
        ];
        const previous = ordered.find(
          (r) =>
            String(r.report_date) !== String(first.report_date) &&
            matchKeys.every(
              (k) => String(r[k] ?? "") === String(first[k] ?? ""),
            ),
        );
        const numeric = (value: unknown) =>
          value === null || value === undefined || value === ""
            ? undefined
            : Number.isFinite(Number(value))
              ? Number(value)
              : undefined;
        const low = numeric(first.low_price ?? first.mostly_low_price),
          high = numeric(first.high_price ?? first.mostly_high_price) ?? low,
          previousLow = previous
            ? numeric(previous.low_price ?? previous.mostly_low_price)
            : undefined,
          previousHigh = previous
            ? (numeric(previous.high_price ?? previous.mostly_high_price) ??
              previousLow)
            : undefined;
        const changePercent =
          low !== undefined &&
          high !== undefined &&
          previousLow !== undefined &&
          previousHigh !== undefined &&
          previousLow + previousHigh > 0
            ? Math.round(
                ((low + high) / (previousLow + previousHigh) - 1) * 1000,
              ) / 10
            : undefined;
        const price =
          low !== undefined && high !== undefined
            ? `Reported ${low === high ? "price $" + low.toFixed(2) : "range $" + low.toFixed(2) + "–$" + high.toFixed(2)} per ${String(first.package ?? "reported package")}.`
            : "Price basis retained from the source; no normalized store price is inferred.";
        const prior = previous
          ? ` Same-specification prior observation: ${String(previous.report_date)}${changePercent !== undefined ? "; reported midpoint " + (changePercent > 0 ? "+" : "") + changePercent.toFixed(1) + "%" : ""}.`
          : " No compatible prior observation was found; no price change is inferred.";
        result.push({
          id: `ams-${sku}`,
          source: "USDA AMS · Los Angeles wholesale benchmark",
          title: `${sku[0]!.toUpperCase() + sku.slice(1)} · geographic proxy`,
          summary: `Los Angeles benchmark used as a geographic proxy for San Francisco. ${price}${prior} SF terminal series were discontinued in May 2025. This commodity benchmark may differ from the store SKU specification; it is not an executable supplier quote.`,
          url: "https://mymarketnews.ams.usda.gov/viewReport/2306",
          observedAt: String(first.report_date),
          fetchedAt,
          scenarioDate: STORE.scenarioDate,
          mode: "live",
          skuIds: [sku],
          values: {
            ...(low !== undefined ? { priceLow: low } : {}),
            ...(high !== undefined ? { priceHigh: high } : {}),
            ...(previousLow !== undefined ? { previousLow } : {}),
            ...(previousHigh !== undefined ? { previousHigh } : {}),
            ...(changePercent !== undefined ? { changePercent } : {}),
            ...(Object.fromEntries(
              Object.entries(first).filter(
                ([k, v]) =>
                  [
                    "commodity",
                    "package",
                    "grade",
                    "variety",
                    "origin",
                    "item_size",
                    "organic",
                    "report_date",
                    "low_price",
                    "high_price",
                    "mostly_low_price",
                    "mostly_high_price",
                    "market_location_name",
                    "appearance",
                    "quality",
                    "condition",
                  ].includes(k) && ["string", "number"].includes(typeof v),
              ),
            ) as Record<string, string | number>),
          },
        });
      }
      if (![...matches].length) throw new Error("no_verified_commodity_rows");
    } catch {
      const previous = cached.filter(
        (e) => e.id.startsWith("ams-") && e.mode !== "unavailable",
      );
      if (previous.length)
        result.push(
          ...previous.map((e) => ({ ...e, mode: "cached-live" as const })),
        );
      else
        result.push({
          id: "ams-unavailable",
          source: "USDA AMS",
          title: "Wholesale benchmark pending verification",
          summary:
            "No compatible live market observations were retrieved. San Francisco terminal reports are discontinued; Los Angeles is the proposed geographic proxy. Simulated supplier offers remain explicitly labeled.",
          url: "https://mymarketnews.ams.usda.gov/viewReport/2306",
          observedAt: "unknown",
          fetchedAt,
          scenarioDate: STORE.scenarioDate,
          mode: "unavailable",
        });
    }
  } else
    result.push({
      id: "ams-unavailable",
      source: "USDA AMS",
      title: "Wholesale API not configured",
      summary:
        "USDA observations are unavailable. No market prices or trends are invented.",
      observedAt: "unknown",
      fetchedAt,
      scenarioDate: STORE.scenarioDate,
      mode: "unavailable",
    });
  mkdirSync("data", { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result, null, 2));
  return result;
}
function extractRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(extractRows);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.commodity || record.commodity_name) return [record];
    return Object.values(record)
      .filter((v) => Array.isArray(v) || (v && typeof v === "object"))
      .flatMap(extractRows);
  }
  return [];
}

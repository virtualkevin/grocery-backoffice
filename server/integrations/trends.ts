import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import type { TrendReport, TrendSignal, TrendTopic } from '../../shared/types.js';

export const TREND_TOPICS: Record<TrendTopic, { query: string; match: RegExp }> = {
  cucumbers: { query: 'cucumber salad', match: /\bcucumbers?\b/i },
  avocados: { query: 'avocado recipe', match: /\bavocados?\b/i },
  strawberries: { query: 'strawberry recipe', match: /\bstrawberr(?:y|ies)\b/i },
  apples: { query: 'apple recipe', match: /\bapples?\b/i },
  bananas: { query: 'banana recipe', match: /\bbananas?\b/i },
};
type Platform = 'tiktok' | 'x';
const endpoints = [
  { platform: 'tiktok' as const, provider: 'scrapecreators', endpoint: '/v1/tiktok/search/keyword', endpoint_version: 2 },
  { platform: 'x' as const, provider: 'tikhub', endpoint: '/api/v1/twitter/web/fetch_search_timeline', endpoint_version: 1 },
];
class TrendError extends Error { constructor(readonly code: string) { super(code); } }
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown, max = 280) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
export function usdMicros(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+\.\d{1,6}$/.test(value)) throw new TrendError('invalid_price');
  const [whole, fraction] = value.split('.'); return BigInt(whole!) * 1000000n + BigInt(fraction!.padEnd(6, '0'));
}
const usd = (value: bigint) => `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, '0')}`;
const metric = (value: unknown) => { const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value; return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
function date(value: unknown, observedAt: string): string | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d{10,13}$/.test(value) ? Number(value) : undefined;
  const milliseconds = numeric !== undefined ? (numeric >= 1000000000000 ? numeric : numeric * 1000) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= Date.parse(observedAt) ? new Date(milliseconds).toISOString() : undefined;
}
export function safeTrendUrl(raw: unknown, platform: Platform): string | undefined {
  if (typeof raw !== 'string') return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (platform === 'tiktok') {
      if (!['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || !/^\/@[\w.-]+\/video\/\d+$/.test(url.pathname)) return;
      return `https://www.tiktok.com${url.pathname}`;
    }
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || !/^\/(?:[\w]+|i\/web)\/status\/\d+$/.test(url.pathname)) return;
    return `https://x.com${url.pathname}`;
  } catch { return; }
}
function safeRunUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  try { const u = new URL(raw); if (u.origin === 'https://app.glasser.ai' && /^\/runs\/[a-zA-Z0-9-]+$/.test(u.pathname)) return u.origin + u.pathname; } catch {}
}
/** Only observed supported provider shapes are accepted. Empty arrays are valid; unknown shapes are errors. */
export function normalizeTrendRun(platform: Platform, raw: unknown, topic: TrendTopic, observedAt = new Date().toISOString()): { signals: TrendSignal[]; provider: TrendReport['providers'][number] } {
  const run = object(raw); const charge = run?.charge_usd;
  const provider: TrendReport['providers'][number] = { platform, status: 'unavailable', count: 0, ...(typeof charge === 'string' && /^\d+\.\d{1,6}$/.test(charge) ? { chargedUsd: charge } : {}), ...(safeRunUrl(run?.run_url) ? { runUrl: safeRunUrl(run?.run_url) } : {}) };
  if (run?.status !== 'COMPLETED' || !Number.isInteger(run?.provider_response?.http_status) || run!.provider_response.http_status < 200 || run!.provider_response.http_status >= 300) return { signals: [], provider: { ...provider, error: 'provider_result_unavailable' } };
  const output = object(run.output);
  const items: unknown = platform === 'tiktok' ? output?.search_item_list : object(output?.data)?.timeline;
  if (!Array.isArray(items) || (platform === 'tiktok' && output?.success !== true) || (platform === 'x' && output?.code !== 200)) return { signals: [], provider: { ...provider, error: 'unsupported_provider_response' } };
  const recognizable = items.length === 0 || items.some(rawItem => { const item = object(rawItem); return item && typeof (platform === 'tiktok' ? item.desc : item.text) === 'string' && typeof (platform === 'tiktok' ? item.aweme_id : item.tweet_id) === 'string'; });
  if (!recognizable) return { signals: [], provider: { ...provider, error: 'unsupported_provider_response' } };
  const topicDefinition = TREND_TOPICS[topic]; const signals: TrendSignal[] = []; const seen = new Set<string>();
  for (const rawItem of items.slice(0, 100)) {
    const item = object(rawItem); if (!item || item.is_ad === true || item.sensitive === true) continue;
    const title = text(platform === 'tiktok' ? item.desc : item.text);
    if (!title || !topicDefinition.match.test(title)) continue;
    const identifier = platform === 'tiktok' ? item.aweme_id : item.tweet_id;
    const handle = platform === 'tiktok' ? object(item.author)?.unique_id : item.screen_name;
    const synthesized = typeof identifier === 'string' && /^\d+$/.test(identifier) && typeof handle === 'string' && /^[\w.-]+$/.test(handle) ? (platform === 'tiktok' ? `https://www.tiktok.com/@${handle}/video/${identifier}` : `https://x.com/${handle}/status/${identifier}`) : undefined;
    const url = safeTrendUrl(item.url, platform) ?? safeTrendUrl(synthesized, platform);
    if (!url || seen.has(url)) continue; seen.add(url);
    const stats = platform === 'tiktok' ? object(item.statistics) ?? {} : item;
    const engagement = { views: metric(platform === 'tiktok' ? stats.play_count : stats.views), likes: metric(platform === 'tiktok' ? stats.digg_count : stats.favorites), reposts: metric(platform === 'tiktok' ? stats.share_count : stats.retweets), comments: metric(platform === 'tiktok' ? stats.comment_count : stats.replies) };
    signals.push({ id: 'social-' + createHash('sha256').update(url).digest('hex').slice(0, 20), platform, skuIds: [topic], query: topicDefinition.query, title, url, postedAt: date(platform === 'tiktok' ? item.create_time_utc ?? item.create_time : item.created_at, observedAt), observedAt, engagement, source: platform === 'tiktok' ? 'Glasser / ScrapeCreators' : 'Glasser / TikHub', signalType: 'social_interest', provenGrowth: false });
    if (signals.length === 10) break;
  }
  return { signals, provider: { ...provider, status: 'live', count: signals.length } };
}
export function assembleTrendReport(topic: TrendTopic, results: ReturnType<typeof normalizeTrendRun>[], observedAt = new Date().toISOString()): TrendReport {
  const providers = results.map(result => result.provider); const live = providers.filter(p => p.status === 'live').length;
  return { observedAt, querySkuId: topic, status: live === 2 ? 'live' : live ? 'partial' : 'unavailable', signals: results.flatMap(r => r.signals), providers, totalChargedUsd: usd(providers.reduce((sum, p) => sum + (p.chargedUsd ? usdMicros(p.chargedUsd) : 0n), 0n)) };
}
const cachePath = 'data/trends.json';
export function loadCachedTrendReport(): TrendReport | undefined {
  try { const value = JSON.parse(readFileSync(cachePath, 'utf8')) as TrendReport; if (Array.isArray(value.signals) && value.signals.length <= 20 && Array.isArray(value.providers) && value.providers.length === 2 && Number.isFinite(Date.parse(value.observedAt)) && value.signals.every(s => ['tiktok', 'x'].includes(s.platform) && safeTrendUrl(s.url, s.platform) === s.url)) return value; } catch {}
}
export function saveTrendReport(report: TrendReport) { mkdirSync('data', { recursive: true }); writeFileSync(cachePath, JSON.stringify(report), { mode: 0o600 }); }
async function request(path: string, input: unknown, idempotencyKey?: string, timeoutMs = 15000): Promise<any> {
  const response = await fetch('https://api.glasser.ai' + path, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + process.env.GLASSER_API_KEY, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs) });
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (!reader) throw new TrendError('empty_response');
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 5000000) { await reader.cancel(); throw new TrendError('response_too_large'); } chunks.push(next.value); }
  if (!response.ok) throw new TrendError('http_' + response.status);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TrendError('invalid_json'); }
}
let refreshFlight: Promise<TrendReport> | undefined;
let refreshingTopic: TrendTopic | undefined;
export function fetchTrendSignals(topic: TrendTopic = 'cucumbers'): Promise<TrendReport> {
  if (!Object.hasOwn(TREND_TOPICS, topic)) return Promise.reject(new TrendError('invalid_topic'));
  if (refreshFlight) return refreshingTopic === topic ? refreshFlight : Promise.reject(new TrendError('refresh_topic_conflict'));
  refreshingTopic = topic;
  return refreshFlight = refresh(topic).finally(() => { refreshFlight = undefined; refreshingTopic = undefined; });
}
async function refresh(topic: TrendTopic): Promise<TrendReport> {
  const observedAt = new Date().toISOString();
  if (!process.env.GLASSER_API_KEY) return assembleTrendReport(topic, endpoints.map(d => ({ signals: [], provider: { platform: d.platform, status: 'unavailable', count: 0, error: 'missing_api_key' } })), observedAt);
  const results = await Promise.all(endpoints.map(async definition => {
    const { platform, ...endpoint } = definition;
    try {
      const contract = await request('/v1/endpoints/inspect', endpoint);
      if (contract.run_mode !== 'sync' || contract.timeout_ms > 40000 || contract.price?.rule?.type !== 'flat' || usdMicros(contract.price.rule.amount_usd) > 10000n) throw new TrendError('endpoint_contract_or_price_changed');
      const input = platform === 'tiktok' ? { query: TREND_TOPICS[topic].query, sort_by: 'date-posted', date_posted: 'this-week', trim: true } : { keyword: TREND_TOPICS[topic].query };
      const pendingPath = `data/glasser-pending-${platform}-${topic}.json`; mkdirSync('data', { recursive: true });
      let pending = { key: randomUUID(), body: { ...endpoint, input } };
      try { const prior = JSON.parse(readFileSync(pendingPath, 'utf8')); if (JSON.stringify(prior.body) === JSON.stringify(pending.body) && typeof prior.key === 'string') pending = prior; } catch {}
      writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
      const run = await request('/v1/runs', pending.body, pending.key, 50000);
      if (['COMPLETED', 'FAILED', 'STOPPED'].includes(run.status)) { try { unlinkSync(pendingPath); } catch {} }
      return normalizeTrendRun(platform, run, topic, observedAt);
    } catch (error) {
      return { signals: [], provider: { platform, status: 'unavailable' as const, count: 0, error: error instanceof TrendError ? error.code : 'provider_request_failed' } };
    }
  }));
  const report = assembleTrendReport(topic, results, observedAt); saveTrendReport(report); return report;
}

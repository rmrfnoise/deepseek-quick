'use strict';

/**
 * 官方价格（人民币 / 百万 tokens），2026-11-18 核对：
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * 高峰：北京时间周一至周五 09:00-12:00、14:00-18:00，不含法定节假日。
 * 其余时间（含周末、节假日）为空闲时段，价格是高峰的一半。
 */
const PRICES = {
  'deepseek-flash': {
    hit: { off: 0.02, peak: 0.04 },
    miss: { off: 1, peak: 2 },
    out: { off: 4, peak: 8 },
  },
  'deepseek-v4-pro': {
    hit: { off: 0.15, peak: 0.3 },
    miss: { off: 4.5, peak: 9 },
    out: { off: 13.5, peak: 27 },
  },
};

const PRICE_VERSION = '2026-11-18';
const CONTEXT_LIMIT = 1000000;

/* 节假日数据放在 holidays.json：每年国务院通知发布后补一年即可。
   没覆盖的年份不会假装精确，费用 tooltip 会标“按工作日估算”。 */
let HOLIDAY_DATA = {};
try {
  HOLIDAY_DATA = require('./holidays.json');
} catch (_) {
  HOLIDAY_DATA = {};
}

const HOLIDAYS = new Set();
const HOLIDAY_YEARS = new Set();
for (const [year, dates] of Object.entries(HOLIDAY_DATA)) {
  if (!Array.isArray(dates)) continue;
  HOLIDAY_YEARS.add(String(year));
  for (const date of dates) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) HOLIDAYS.add(date);
  }
}


const BEIJING = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

function beijingParts(at) {
  const parts = BEIJING.formatToParts(new Date(at));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    weekday: get('weekday'),
  };
}

/** 某个时间点是否按高峰价计费 */
function isPeak(at) {
  if (!Number.isFinite(at)) return false;
  const { date, hour, weekday } = beijingParts(at);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (HOLIDAYS.has(date)) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 该时间点所在年份是否已有节假日表；没有就属于“按工作日估算” */
function holidayKnown(at) {
  if (!Number.isFinite(at)) return false;
  return HOLIDAY_YEARS.has(beijingParts(at).date.slice(0, 4));
}

/** 服务端 usage → 可记账的 token 字段（缺缓存字段时按全部未命中处理，并标记 cacheKnown=false） */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const hitRaw = Number(usage.prompt_cache_hit_tokens);
  const missRaw = Number(usage.prompt_cache_miss_tokens);
  const cacheKnown = Number.isFinite(hitRaw) || Number.isFinite(missRaw);
  let hit = Number.isFinite(hitRaw)
    ? Math.max(0, hitRaw)
    : Number.isFinite(missRaw)
      ? Math.max(0, prompt - missRaw)
      : 0;
  let miss = Number.isFinite(missRaw) ? Math.max(0, missRaw) : Math.max(0, prompt - hit);
  if (hit + miss !== prompt) {
    hit = Math.min(hit, prompt);
    miss = Math.max(0, prompt - hit);
  }
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  return { prompt, hit, miss, completion, reasoning, cacheKnown };
}

/**
 * 汇总若干次 API 调用：token、费用、峰谷、模型。
 * 费用按每次调用的时间点与模型分别计价，跨峰谷也不会算错。
 */
function summarize(calls) {
  const list = Array.isArray(calls) ? calls.filter((c) => c && Number.isFinite(c.at)) : [];
  const out = {
    calls: list.length,
    prompt: 0,
    hit: 0,
    miss: 0,
    completion: 0,
    reasoning: 0,
    cost: 0,
    tier: null,
    model: null,
    rates: null,
    limit: CONTEXT_LIMIT,
    priceVersion: PRICE_VERSION,
    cacheKnown: true,
    holidayKnown: true,
  };
  if (!list.length) return out;

  const tiers = new Set();
  const models = new Set();
  for (const call of list) {
    const model = call.model;
    const p = PRICES[model] || PRICES['deepseek-flash'];
    const tier = isPeak(call.at) ? 'peak' : 'off';
    tiers.add(tier);
    models.add(model);
    out.prompt += call.prompt;
    out.hit += call.hit;
    out.miss += call.miss;
    out.completion += call.completion;
    out.reasoning += call.reasoning || 0;
    out.cacheKnown = out.cacheKnown && call.cacheKnown !== false;
    out.holidayKnown = out.holidayKnown && holidayKnown(call.at);
    out.cost += (call.hit * p.hit[tier] + call.miss * p.miss[tier] + call.completion * p.out[tier]) / 1e6;
  }

  out.tier = tiers.size === 1 ? [...tiers][0] : 'mixed';
  out.model = models.size === 1 ? [...models][0] : null;
  if (out.model && out.tier !== 'mixed') {
    const p = PRICES[out.model] || PRICES['deepseek-flash'];
    out.rates = { hit: p.hit[out.tier], miss: p.miss[out.tier], out: p.out[out.tier] };
  }
  return out;
}

module.exports = {
  PRICES,
  PRICE_VERSION,
  CONTEXT_LIMIT,
  isPeak,
  holidayKnown,
  beijingParts,
  normalizeUsage,
  summarize,
};

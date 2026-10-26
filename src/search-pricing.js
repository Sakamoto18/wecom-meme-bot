// Exa public list prices checked 2026-10-25. Credits/contract discounts are not
// observable here; these are usage costs, not a claim about the final invoice.
export const EXA_PRICE_SOURCE = 'https://exa.ai/docs/admin/pricing';
export const EXA_PRICE_VERSION = '2026-10-25';
const BASE_USD = { auto: 0.007, fast: 0.007, lite: 0.004, instant: 0.004,
  'deep-lite': 0.012, deep: 0.012, 'deep-reasoning': 0.015 };

export function searchCharge(info, usdToCny) {
  const raw = info.costDollars;
  const reported = typeof raw === 'number' ? raw : raw?.total;
  let usd = null;
  let status = 'unpriced';
  if (info.provider === 'web') return { usd: 0, cny: 0, status: 'free' };
  if (info.provider === 'exa') {
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
      usd = reported;
      status = 'reported';
    } else if (info.succeeded && BASE_USD[info.searchType] !== undefined
      && Number.isInteger(info.requestedResults) && info.requestedResults > 0) {
      // Search's text content is included. This client does not request AI summaries.
      usd = BASE_USD[info.searchType] + Math.max(0, info.requestedResults - 10) * 0.001;
      status = 'estimated';
    } else if (!info.succeeded) {
      status = 'unknown'; // A timeout does not prove the upstream did not charge.
    }
  }
  return { usd: usd ?? 0, cny: (usd ?? 0) * usdToCny, status };
}

export function emptySearchCosts() {
  return { searchEstimatedCostUsd: 0, searchEstimatedCostCny: 0,
    searchPricedCalls: 0, searchEstimatedCalls: 0, searchUnpricedCalls: 0,
    searchUnknownCalls: 0, searchFreeCalls: 0, searchExchangeRates: [] };
}

export function calculateSearchCosts(rows) {
  const total = emptySearchCosts();
  const byGroup = new Map();
  for (const row of rows) {
    const group = byGroup.get(row.groupId) ?? emptySearchCosts();
    byGroup.set(row.groupId, group);
    for (const target of [total, group]) {
      const status = row.searchBillingStatus;
      if (['reported', 'estimated'].includes(status)) {
        target.searchEstimatedCostUsd += row.estimatedCostUsd;
        target.searchEstimatedCostCny += row.estimatedCostCny;
        target.searchPricedCalls++;
        if (status === 'estimated') target.searchEstimatedCalls++;
        if (!target.searchExchangeRates.includes(row.usdToCny)) target.searchExchangeRates.push(row.usdToCny);
      } else if (status === 'free') target.searchFreeCalls++;
      else if (['unknown', 'pending'].includes(status)) target.searchUnknownCalls++;
      else target.searchUnpricedCalls++;
    }
  }
  for (const summary of [total, ...byGroup.values()]) {
    for (const key of ['searchEstimatedCostUsd', 'searchEstimatedCostCny']) {
      summary[key] = Math.round(summary[key] * 1e9) / 1e9;
    }
    summary.searchExchangeRates.sort((a, b) => a - b);
  }
  return { total, byGroup };
}

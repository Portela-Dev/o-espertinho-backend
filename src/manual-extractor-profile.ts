import { HttpError } from './security.js';
import type { ScrapingMarket, ScrapingProfile, SelectorRule } from './scraping.js';

function ruleContract(rule: SelectorRule) {
  return {
    field: rule.field, selectors: rule.selectors, mode: rule.mode, required: rule.required,
    ...(rule.wholeSelector ? {wholeSelector:rule.wholeSelector} : {}),
    ...(rule.fractionSelector ? {fractionSelector:rule.fractionSelector} : {}),
    ...(rule.mode === 'attribute' ? { attribute: rule.attribute } : {}),
    ...(rule.mode === 'pairs' ? { nameSelector: rule.nameSelector || 'th', valueSelector: rule.valueSelector || 'td' } : {}),
  };
}
export function manualProfile(market: ScrapingMarket, profile: ScrapingProfile) {
  const rules = profile.rules.filter(rule => rule.field !== 'externalId').flatMap(rule => {
    const base = ruleContract(rule);
    // Legacy profiles relied on these price parts implicitly. Keep a text fallback
    // because selectors such as .a-offscreen contain the entire price directly.
    if (rule.mode === 'text' && !rule.wholeSelector && ['price', 'originalPrice'].includes(rule.field)) {
      return [{ ...base, wholeSelector: '.a-price-whole,.andes-money-amount__fraction',
        fractionSelector: '.a-price-fraction,.andes-money-amount__cents' }, base];
    }
    // The core accepts image URLs, not the proprietary JSON gallery attribute.
    // Existing data-old-hires/src rules retain their order and priority.
    if (rule.field === 'images' && rule.mode === 'attribute' && rule.attribute === 'data-a-dynamic-image') {
      return [{ ...base, attribute: 'src' }];
    }
    return [base];
  });
  if (rules.length > 40) { throw new HttpError(400, 'Reduza as regras de seletores para acomodar os fallbacks de preço no limite de 40 regras do extrator.'); }
  return { allowedHosts: market.allowed_hosts, timeoutMs: profile.wait_timeout_ms, rules };
}

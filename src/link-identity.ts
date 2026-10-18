import { createHash } from 'node:crypto';

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}
// Identifies only the registered link. Catalog product selection remains manual.
export function linkIdentity(marketplaceId: string, affiliateUrl: string): string {
  return 'url-v1:' + createHash('sha256').update(marketplaceId + ':' + normalizedUrl(affiliateUrl)).digest('hex');
}
export function sameProductUrl(actual: string, expected: string): boolean {
  return normalizedUrl(actual) === normalizedUrl(expected);
}

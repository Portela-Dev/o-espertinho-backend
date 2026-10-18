/** Product destinations exclude query strings and fragments; affiliate links do not. */
export function productUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href;
}

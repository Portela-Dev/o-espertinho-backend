export type RecipeJson =
  | string
  | number
  | boolean
  | null
  | RecipeJson[]
  | { [key: string]: RecipeJson };
export type RecipeBody = { [key: string]: RecipeJson };
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
export function isResponsePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    /^\w+(?:\.\w+)*$/.test(value) &&
    value.split('.').every((key) => !reserved.has(key))
  );
}
export function isRequestBody(
  value: unknown,
  form = false,
): value is RecipeBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 512 || entry.depth > 6) return false;
    const item: unknown = entry.value;
    if (!validJsonValue(item)) return false;
    if (item === null || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (
        reserved.has(key) ||
        key.length > 100 ||
        (form && typeof child !== 'string')
      )
        return false;
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return JSON.stringify(value).length <= 32768;
}

function validJsonValue(item: unknown): boolean {
  if (item === null || typeof item === 'boolean') return true;
  if (typeof item === 'number') return Number.isFinite(item);
  if (typeof item === 'string') return item.length <= 4000;
  if (typeof item !== 'object') return false;
  return (
    Array.isArray(item) ||
    [Object.prototype, null].includes(Object.getPrototypeOf(item))
  );
}

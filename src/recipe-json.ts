export type RecipeJson = string | number | boolean | null | RecipeJson[] | { [key: string]: RecipeJson };
export type RecipeBody = { [key: string]: RecipeJson };
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
export function isResponsePath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 200 && /^\w+(?:\.\w+)*$/.test(value) && value.split('.').every(key => !reserved.has(key));
}
export function isRequestBody(value: unknown, form = false): value is RecipeBody {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const pending = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const entry = pending.pop()!;
        if (++nodes > 512 || entry.depth > 6) return false;
        const item: unknown = entry.value;
        if (item === null || typeof item === 'boolean') continue;
        if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
        if (typeof item === 'string') { if (item.length > 4000) return false; continue; }
        if (typeof item !== 'object') return false;
        if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
        for (const [key, child] of Object.entries(item)) {
            if (reserved.has(key) || key.length > 100 || (form && typeof child !== 'string')) return false;
            pending.push({ value: child, depth: entry.depth + 1 });
        }
    }
    return JSON.stringify(value).length <= 32768;
}

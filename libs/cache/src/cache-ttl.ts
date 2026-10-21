export function isValidCacheTtl(ttl: number): boolean {
  return Number.isInteger(ttl) && ttl > 0 && ttl <= 2147483647;
}

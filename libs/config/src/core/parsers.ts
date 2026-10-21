function fail(path: string, reason: string): never {
  throw new Error(`${path}: ${reason}`);
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

export function asObject(
  value: unknown,
  path: string,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (isAbsent(value)) return fallback;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, '必须是对象');
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, path: string, fallback?: string): string {
  if (isAbsent(value)) {
    if (fallback !== undefined) return fallback;
    return fail(path, '必须是非空字符串');
  }
  if (typeof value !== 'string' && typeof value !== 'number') return fail(path, '必须是字符串');

  const result = String(value).trim();
  if (result.length === 0) return fallback ?? fail(path, '必须是非空字符串');
  return result;
}

export function asOptionalString(value: unknown, path: string): string | undefined {
  if (isAbsent(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return fail(path, '必须是字符串');
  const result = String(value).trim();
  return result.length === 0 ? undefined : result;
}

export function asBoolean(value: unknown, path: string, fallback?: boolean): boolean {
  if (isAbsent(value)) {
    if (fallback !== undefined) return fallback;
    return fail(path, '必须是 true 或 false');
  }
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fail(path, '只能是 true 或 false');
}

export function asInteger(value: unknown, path: string, fallback: number | undefined, min: number): number {
  if (isAbsent(value)) {
    if (fallback !== undefined) return fallback;
    return fail(path, '必须是整数');
  }

  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(result) || result < min) {
    return fail(path, min > 0 ? `必须是大于等于 ${min} 的整数` : '必须是非负整数');
  }
  return result;
}

function assertNumericInput(value: unknown, path: string, reason: string): void {
  if (!isAbsent(value) && typeof value !== 'number' && typeof value !== 'string') {
    fail(path, reason);
  }
}

/** 拒绝隐式类型和空白字符串；仅指定 max 时检查安全整数与上限。 */
export function asStrictInteger(
  value: unknown,
  path: string,
  fallback: number | undefined,
  min: number,
  max?: number,
): number {
  assertNumericInput(value, path, '必须是整数');
  if (typeof value === 'string' && value.trim().length === 0) fail(path, '必须是整数');
  const result = asInteger(value, path, fallback, min);
  if (max !== undefined && (!Number.isSafeInteger(result) || result > max)) {
    fail(path, `必须小于等于 ${max}`);
  }
  return result;
}

/** 保留正整数配置原有的类型提示和下限校验语义。 */
export function asPositiveInteger(value: unknown, path: string, fallback: number): number {
  assertNumericInput(value, path, '必须是正整数');
  return asInteger(value, path, fallback, 1);
}

export function asEnum<TValue extends string>(
  value: unknown,
  path: string,
  allowed: readonly TValue[],
  fallback?: TValue,
): TValue {
  if (isAbsent(value)) {
    if (fallback !== undefined) return fallback;
    return fail(path, `必须是以下值之一：${allowed.join(', ')}`);
  }
  if (typeof value !== 'string' || !allowed.includes(value as TValue)) {
    return fail(path, `必须是以下值之一：${allowed.join(', ')}`);
  }
  return value as TValue;
}

function normalizeList(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string' && typeof item !== 'number')) {
      return fail(path, '数组元素必须是字符串');
    }
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fail(path, '必须是数组或逗号分隔的字符串');
}

export function asList(value: unknown, path: string, fallback?: readonly string[]): string[] {
  if (isAbsent(value)) {
    if (fallback !== undefined) return [...fallback];
    return fail(path, '不能为空');
  }
  const result = normalizeList(value, path);
  if (result.length === 0) return fail(path, '不能为空');
  return result;
}

export function asOptionalList(value: unknown, path: string): string[] | undefined {
  if (isAbsent(value)) return undefined;
  const result = normalizeList(value, path);
  return result.length === 0 ? undefined : result;
}

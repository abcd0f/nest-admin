import { SetMetadata } from '@nestjs/common';

export const ACCESS_REQUIREMENTS = Symbol('permission:requirements');
export const AUTHENTICATED_ROUTE = Symbol('permission:authenticated');

export enum Mode {
  AND = 'AND',
  OR = 'OR',
}

export interface RoleOptions {
  value: string | readonly string[];
  mode?: Mode;
}

export interface PermissionOptions extends RoleOptions {
  /** 任一角色可兜底当前 Permission 注解；不能绕过其他注解。 */
  role?: string | readonly string[];
}

export type AccessRequirement =
  | { kind: 'permission'; value: readonly string[]; mode: Mode; role: readonly string[] }
  | { kind: 'role'; value: readonly string[]; mode: Mode };

function normalizeValues(value: string | readonly string[]): readonly string[] {
  const values = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some(
      (item) => typeof item !== 'string' || !item || item !== item.trim() || item.includes('*'),
    )
  ) {
    throw new Error('权限码或角色标识必须非空、无首尾空白且不含通配符');
  }
  return [...new Set(values)];
}

function normalizeMode(mode: Mode = Mode.AND): Mode {
  if (mode !== Mode.AND && mode !== Mode.OR) throw new Error('mode 只能是 AND 或 OR');
  return mode;
}

function appendRequirement(requirement: AccessRequirement): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const metadataTarget = descriptor?.value ?? target;
    const existing = Reflect.getMetadata(ACCESS_REQUIREMENTS, metadataTarget) as
      readonly AccessRequirement[] | undefined;
    // 每条注解独立保存；复制已有数组，避免修改父类元数据。
    Reflect.defineMetadata(ACCESS_REQUIREMENTS, [...(existing ?? []), requirement], metadataTarget);
  };
}

/** 单条注解内默认 AND；role 为任一角色兜底，多条注解之间固定 AND。 */
export function Permission(input: string | PermissionOptions): ClassDecorator & MethodDecorator {
  const options = typeof input === 'string' ? { value: input } : input;
  return appendRequirement({
    kind: 'permission',
    value: normalizeValues(options.value),
    mode: normalizeMode(options.mode),
    role: options.role === undefined ? [] : normalizeValues(options.role),
  });
}

/** 角色标识精确匹配，单条注解内默认 AND，可显式选择 OR。 */
export function Role(input: string | RoleOptions): ClassDecorator & MethodDecorator {
  const options = typeof input === 'string' ? { value: input } : input;
  return appendRequirement({
    kind: 'role',
    value: normalizeValues(options.value),
    mode: normalizeMode(options.mode),
  });
}

/** 兼容已有调用，相当于一条默认 AND 的 Permission 注解。 */
export function RequirePermissions(...permissions: string[]) {
  return Permission({ value: permissions });
}

/** 显式声明需要登录；不会清除类或方法上已有的角色/权限要求。 */
export const Authenticated = () => SetMetadata(AUTHENTICATED_ROUTE, true);

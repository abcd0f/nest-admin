import { REGEX_SPECIAL_CHARS_PATTERN } from '@app/common/constants/regex.js';

/**
 * 超级管理员常量与通配权限匹配。
 *
 * 取值与语义对齐 RuoYi-Vue-Plus：
 * - `SystemConstants.SUPER_ADMIN_ID = 1L`
 * - `TenantConstants.SUPER_ADMIN_ROLE_KEY = "superadmin"`
 * - `SysPermissionServiceImpl.getMenuPermission` 对超管注入 `*:*:*`
 * - Sa-Token `SaFoxUtil.vagueMatch` 的通配匹配行为
 */

/** 超级管理员用户 ID。与 Java 侧一致，是唯一且不可转让的身份标记。 */
export const SUPER_ADMIN_ID = '1';

/** 超级管理员角色标识。超管由权限源注入此角色，不依赖 `sys_user_role` 关联。 */
export const SUPER_ADMIN_ROLE_KEY = 'superadmin';

/**
 * 租户管理员角色标识。
 *
 * 本项目没有多租户，但为与 Java 侧 `TenantConstants.TENANT_ADMIN_ROLE_KEY` 保持一致，
 * 仍把它列为保留标识，禁止普通角色占用，避免与 RuoYi 的数据/权限码迁移冲突。
 */
export const RESERVED_TENANT_ADMIN_ROLE_KEY = 'admin';

/** 全量权限码。持有它即命中任意权限要求。 */
export const ALL_PERMISSION = '*:*:*';

/** 是否为超级管理员。只接受规范化十进制用户 ID。 */
export function isSuperAdmin(userId: string): boolean {
  return userId === SUPER_ADMIN_ID;
}

/**
 * 通配匹配，等价于 Sa-Token `SaFoxUtil.vagueMatch(pattern, value)`。
 *
 * - 完全相等直接命中；
 * - `pattern` 不含 `*` 时不再匹配（精确语义）；
 * - 含 `*` 时把每个 `*` 展开为 `.*`，其余字符按字面量转义后整体锚定匹配。
 *
 * 与 Java 的差异：Java 只做 `replace("*", ".*")` 不转义其它字符，权限码里出现正则元字符时
 * 行为未定义；这里做字面量转义，正常权限码（字母、数字、`:`、`-`、`_`）结果完全一致。
 */
export function vagueMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const body = [...pattern]
    .map((char) => (char === '*' ? '.*' : char.replace(REGEX_SPECIAL_CHARS_PATTERN, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'u').test(value);
}

/**
 * 把一份已授权集合编译成判定函数：先精确命中，再逐条通配。
 *
 * 多数请求只有精确权限码，走 `Set` 查询保持 O(1)；只有存在通配码时才线性扫描。
 */
export function createMatcher(granted: readonly string[]): (required: string) => boolean {
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const item of granted) {
    if (item.includes('*')) patterns.push(item);
    else exact.add(item);
  }
  return (required) => exact.has(required) || patterns.some((p) => vagueMatch(p, required));
}

import type { AuthSnapshot } from '@app/auth';
import { Inject, Injectable } from '@nestjs/common';
import { createMatcher } from './permission.constants.js';
import { AccessRequirement, Mode } from './permission.decorator.js';
import { PermissionSource, UserAuthorization } from './permission.source.js';

@Injectable()
export class PermissionService {
  constructor(@Inject(PermissionSource) private readonly source: PermissionSource) {}

  /**
   * 登录时计算授权快照，结果写入会话。
   *
   * 对应 RuoYi `SysLoginService.buildLoginUser` 调用 `getMenuPermission` / `getRolePermission`。
   */
  snapshot(userId: string): Promise<UserAuthorization> {
    return this.source.getAuthorization(userId);
  }

  /**
   * 运行时读取已认证上下文里的快照，不查库、不访问 Redis。
   *
   * 快照由 `AuthService.authenticate` 从会话带出，`@CurrentUser()` 拿到的是同一份数据。
   */
  getAuthorization(user: AuthSnapshot): UserAuthorization {
    return { roles: user.roles, permissions: user.permissions };
  }

  hasAll(user: AuthSnapshot, required: readonly string[]): boolean {
    return this.isAllowed(user, [
      { kind: 'permission', value: required, mode: Mode.AND, role: [] },
    ]);
  }

  isAllowed(user: AuthSnapshot, requirements: readonly AccessRequirement[]): boolean {
    const { permissions, roles } = this.getAuthorization(user);
    // 精确码走 Set 命中；含 `*` 的授权码按 Sa-Token 语义展开匹配，超管的 `*:*:*` 即这条路径。
    const matchPermission = createMatcher(permissions);
    const matchRole = createMatcher(roles);
    return requirements.every((item) => {
      const matches =
        item.kind === 'permission'
          ? item.mode === Mode.OR
            ? item.value.some(matchPermission)
            : item.value.every(matchPermission)
          : item.mode === Mode.OR
            ? item.value.some(matchRole)
            : item.value.every(matchRole);
      return matches || (item.kind === 'permission' && item.role.some(matchRole));
    });
  }
}

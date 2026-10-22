import { Inject, Injectable } from '@nestjs/common';
import { AccessRequirement, Mode } from './permission.decorator.js';
import { PermissionSource, UserAuthorization } from './permission.source.js';

@Injectable()
export class PermissionService {
  constructor(@Inject(PermissionSource) private readonly source: PermissionSource) {}

  /** 供当前用户信息业务复用；调用方传入已认证上下文中的 userId。 */
  getAuthorization(userId: string): Promise<UserAuthorization> {
    return this.source.getAuthorization(userId);
  }

  async hasAll(userId: string, required: readonly string[]): Promise<boolean> {
    return this.isAllowed(userId, [
      { kind: 'permission', value: required, mode: Mode.AND, role: [] },
    ]);
  }

  async isAllowed(userId: string, requirements: readonly AccessRequirement[]): Promise<boolean> {
    const { permissions, roles } = await this.getAuthorization(userId);
    const grantedPermissions = new Set(permissions);
    const grantedRoles = new Set(roles);
    return requirements.every((item) => {
      const granted = item.kind === 'permission' ? grantedPermissions : grantedRoles;
      const matches =
        item.mode === Mode.OR
          ? item.value.some((value) => granted.has(value))
          : item.value.every((value) => granted.has(value));
      return (
        matches || (item.kind === 'permission' && item.role.some((role) => grantedRoles.has(role)))
      );
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { AccessRequirement, Mode } from './permission.decorator.js';
import { PermissionSource } from './permission.source.js';

@Injectable()
export class PermissionService {
  constructor(@Inject(PermissionSource) private readonly source: PermissionSource) {}

  async hasAll(userId: string, required: readonly string[]): Promise<boolean> {
    return this.isAllowed(userId, [
      { kind: 'permission', value: required, mode: Mode.AND, role: [] },
    ]);
  }

  async isAllowed(userId: string, requirements: readonly AccessRequirement[]): Promise<boolean> {
    const needsPermissions = requirements.some((item) => item.kind === 'permission');
    const needsRoles = requirements.some((item) => item.kind === 'role' || item.role.length > 0);
    const [permissions, roles] = await Promise.all([
      needsPermissions ? this.source.getPermissions(userId) : [],
      needsRoles ? this.source.getRoles(userId) : [],
    ]);
    const grantedPermissions = new Set(permissions);
    const grantedRoles = new Set(roles);
    return requirements.every((item) => {
      const granted = item.kind === 'permission' ? grantedPermissions : grantedRoles;
      const matches =
        item.mode === Mode.OR
          ? item.value.some((value) => granted.has(value))
          : item.value.every((value) => granted.has(value));
      return (
        matches ||
        (item.kind === 'permission' && item.role.some((role) => grantedRoles.has(role)))
      );
    });
  }
}

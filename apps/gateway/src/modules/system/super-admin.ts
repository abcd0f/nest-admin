import {
  isSuperAdmin,
  RESERVED_TENANT_ADMIN_ROLE_KEY,
  SUPER_ADMIN_ROLE_KEY,
} from '@app/permission';
import { ConflictException } from '@nestjs/common';

/**
 * 超级管理员账号不允许被任何人修改、停用、改角色或删除。
 *
 * 对应 Java 侧 `SysUserServiceImpl.checkUserAllowed`：`userId == SUPER_ADMIN_ID` 一律拒绝。
 * 这也是"系统不会被锁死"的唯一保证——超管不可操作，所以永远有人能管系统；
 * RuoYi 没有、本项目也不再需要额外的"最后一位管理员"检查。
 *
 * 副作用与 Java 一致：超管无法通过管理端点改自己的资料或密码，需要单独的 profile 通道。
 */
export function assertNotSuperAdmin(userId: string): void {
  if (isSuperAdmin(userId)) {
    throw new ConflictException('不允许操作超级管理员用户');
  }
}

/**
 * 系统内置角色标识不允许被新建或改名占用。
 *
 * 对应 Java 侧 `SysRoleServiceImpl.checkRoleAllowed` 的保留标识部分。
 * Java 另有 `roleId == 1` 的角色保护，那是依赖初始化数据里"1 号角色即超管"的耦合，
 * 本项目的超管由 `userId == 1` 判定、不依赖角色行，因此不移植该条。
 */
export function assertRoleKeyAvailable(roleKey: string): void {
  if (roleKey === SUPER_ADMIN_ROLE_KEY || roleKey === RESERVED_TENANT_ADMIN_ROLE_KEY) {
    throw new ConflictException('不允许使用系统内置管理员角色标识符');
  }
}

/** 修改角色时，原标识已是保留标识的也不允许改名。 */
export function assertRoleKeyNotReserved(roleKey: string): void {
  if (roleKey === SUPER_ADMIN_ROLE_KEY || roleKey === RESERVED_TENANT_ADMIN_ROLE_KEY) {
    throw new ConflictException('不允许修改系统内置管理员角色标识符');
  }
}

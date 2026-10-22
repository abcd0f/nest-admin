import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertNotSuperAdmin,
  assertRoleKeyAvailable,
  assertRoleKeyNotReserved,
} from './super-admin.js';

describe('超级管理员写保护', () => {
  it('拒绝操作 1 号用户，其他 ID 不受影响', () => {
    expect(() => assertNotSuperAdmin('1')).toThrow(ConflictException);
    expect(() => assertNotSuperAdmin('1')).toThrow('不允许操作超级管理员用户');
    // 只有规范化十进制 '1' 是超管；这些看起来像 1 的写法都不算。
    for (const id of ['2', '01', '1.0', ' 1', '9223372036854775807']) {
      expect(() => assertNotSuperAdmin(id)).not.toThrow();
    }
  });

  it('拒绝用保留标识新建角色', () => {
    for (const key of ['superadmin', 'admin']) {
      expect(() => assertRoleKeyAvailable(key)).toThrow('不允许使用系统内置管理员角色标识符');
    }
    // 大小写与前后缀不同即视为普通标识。
    for (const key of ['operator', 'SuperAdmin', 'admin2', 'superadmin ']) {
      expect(() => assertRoleKeyAvailable(key)).not.toThrow();
    }
  });

  it('拒绝给已是保留标识的角色改名', () => {
    for (const key of ['superadmin', 'admin']) {
      expect(() => assertRoleKeyNotReserved(key)).toThrow('不允许修改系统内置管理员角色标识符');
    }
    for (const key of ['operator', 'SuperAdmin', '']) {
      expect(() => assertRoleKeyNotReserved(key)).not.toThrow();
    }
  });
});

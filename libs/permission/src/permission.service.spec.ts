import { DatabaseModule, PrismaService } from '@app/database';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { Mode } from './permission.decorator.js';
import { PermissionModule } from './permission.module.js';
import { PermissionService } from './permission.service.js';

describe('功能权限判定', () => {
  it('所有声明均须精确匹配，不展开通配符，不因角色名自动放行', async () => {
    const getAuthorization = vi.fn().mockResolvedValue({
      permissions: ['system:user:list', 'system:user:query', '*:*:*', 'admin'],
      roles: [],
    });
    const service = new PermissionService({ getAuthorization });
    expect(await service.hasAll('1', ['system:user:list', 'system:user:query'])).toBe(true);
    expect(await service.hasAll('1', ['system:user:list', 'system:user:delete'])).toBe(false);
    expect(getAuthorization).toHaveBeenCalledWith('1');
  });

  it('真实权限源接入 Prisma，空的授权关联不放行', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule, PermissionModule] })
      .overrideProvider(PrismaService)
      .useValue({
        user: { findUnique: vi.fn().mockResolvedValue({ status: '0', delFlag: '0', roles: [] }) },
      })
      .compile();
    try {
      expect(await module.get(PermissionService).hasAll('1', ['system:user:list'])).toBe(false);
      expect(
        await module
          .get(PermissionService)
          .isAllowed('1', [{ kind: 'role', value: ['admin'], mode: Mode.AND }]),
      ).toBe(false);
    } finally {
      await module.close();
    }
  });
});

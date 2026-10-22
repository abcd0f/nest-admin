import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { Mode } from './permission.decorator.js';
import { PermissionModule } from './permission.module.js';
import { PermissionService } from './permission.service.js';

describe('功能权限判定', () => {
  it('所有声明均须精确匹配，不展开通配符，不因角色名自动放行', async () => {
    const getPermissions = vi
      .fn()
      .mockResolvedValue(['system:user:list', 'system:user:query', '*:*:*', 'admin']);
    const service = new PermissionService({
      getPermissions,
      getRoles: vi.fn().mockResolvedValue([]),
    });
    expect(await service.hasAll('1', ['system:user:list', 'system:user:query'])).toBe(true);
    expect(await service.hasAll('1', ['system:user:list', 'system:user:delete'])).toBe(false);
    expect(getPermissions).toHaveBeenCalledWith('1');
  });

  it('默认权限源失败关闭，等待阶段 3 的实际查询实现', async () => {
    const module = await Test.createTestingModule({ imports: [PermissionModule] }).compile();
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

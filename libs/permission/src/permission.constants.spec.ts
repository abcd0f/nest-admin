import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION,
  createMatcher,
  isSuperAdmin,
  vagueMatch,
} from './permission.constants.js';

describe('通配匹配（对齐 Sa-Token SaFoxUtil.vagueMatch）', () => {
  it.each([
    ['*:*:*', 'system:user:list', true],
    ['*:*:*', 'system:role:assignMenus', true],
    ['*:*:*', 'system:user:list:export', true],
    ['*:*:*', 'system:user', false],
    ['*:*:*', 'system', false],
    ['*', 'anything:at:all', true],
    ['system:user:*', 'system:user:list', true],
    ['system:user:*', 'system:role:list', false],
    ['system:*:list', 'system:user:list', true],
    ['system:*:list', 'system:user:edit', false],
    ['system:user:list', 'system:user:list', true],
    ['system:user:list', 'system:user:list:export', false],
    ['system:user:list', 'system:user:lis', false],
  ])('%s 匹配 %s => %s', (pattern, value, expected) => {
    expect(vagueMatch(pattern, value)).toBe(expected);
  });

  it('不含通配的授权码只做精确比较，不做前缀或子串匹配', () => {
    expect(vagueMatch('system:user', 'system:user:list')).toBe(false);
    expect(vagueMatch('user', 'system:user')).toBe(false);
  });

  it('正则元字符按字面量处理，不会意外放大匹配范围', () => {
    expect(vagueMatch('a.b', 'axb')).toBe(false);
    expect(vagueMatch('a.b', 'a.b')).toBe(true);
    expect(vagueMatch('a+b', 'aab')).toBe(false);
    expect(vagueMatch('a(1)', 'a1')).toBe(false);
  });

  it('全量权限码覆盖三段及以上权限码', () => {
    expect(vagueMatch(ALL_PERMISSION, 'system:dept:delete')).toBe(true);
    expect(vagueMatch(ALL_PERMISSION, 'workflow:task:complete')).toBe(true);
  });
});

describe('超管常量', () => {
  it('只有规范化的用户 ID 1 是超级管理员', () => {
    expect(isSuperAdmin('1')).toBe(true);
    for (const value of ['01', '1.0', ' 1', '2', '', '9223372036854775807']) {
      expect(isSuperAdmin(value)).toBe(false);
    }
  });
});

describe('授权集合编译', () => {
  it('精确码走集合命中，通配码走模式匹配', () => {
    const match = createMatcher(['system:user:list', 'system:role:*', 'a.b']);
    expect(match('system:user:list')).toBe(true);
    expect(match('system:role:edit')).toBe(true);
    expect(match('system:menu:list')).toBe(false);
    expect(match('axb')).toBe(false);
    expect(match('a.b')).toBe(true);
  });

  it('空集合拒绝一切要求', () => {
    const match = createMatcher([]);
    expect(match('system:user:list')).toBe(false);
    expect(match('')).toBe(false);
  });
});

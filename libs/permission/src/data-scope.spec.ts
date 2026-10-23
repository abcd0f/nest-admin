import type { RoleScope } from '@app/auth';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  DATA_SCOPE,
  isDeptInScope,
  loadDataScope,
  needsDeptAndChild,
  resolveDataScope,
  withDataScope,
} from './data-scope.js';

/** 普通用户：ID 2、部门 10。`1` 是超管，这里不用。 */
function subject(dataScopes: RoleScope[], deptId: string | null = '10') {
  return { userId: '2', deptId, dataScopes };
}

function scope(dataScope: string, deptIds: string[] = [], roleId = '3'): RoleScope {
  return { roleId, dataScope, deptIds };
}

describe('数据范围解析', () => {
  it('没有任何有效角色时拒绝，不退化成全量', () => {
    expect(resolveDataScope(subject([]))).toEqual({ kind: 'none' });
  });

  it('任一角色为全部数据即不受限，忽略其他角色', () => {
    expect(resolveDataScope(subject([scope(DATA_SCOPE.SELF), scope(DATA_SCOPE.ALL)]))).toEqual({
      kind: 'all',
    });
  });

  it('自定义范围只取 RoleDept 指定的部门，不自动展开下级', () => {
    expect(resolveDataScope(subject([scope(DATA_SCOPE.CUSTOM, ['21', '22'])]))).toEqual({
      kind: 'limited',
      deptIds: ['21', '22'],
      selfUserId: null,
    });
  });

  it('本部门只取当前部门；用户无部门时不贡献条件', () => {
    expect(resolveDataScope(subject([scope(DATA_SCOPE.DEPT)]))).toEqual({
      kind: 'limited',
      deptIds: ['10'],
      selfUserId: null,
    });
    expect(resolveDataScope(subject([scope(DATA_SCOPE.DEPT)], null))).toEqual({ kind: 'none' });
  });

  it('本部门及以下使用传入的子树，仅本人只产生本人分支', () => {
    expect(
      resolveDataScope(subject([scope(DATA_SCOPE.DEPT_AND_CHILD)]), ['10', '11', '12']),
    ).toEqual({
      kind: 'limited',
      deptIds: ['10', '11', '12'],
      selfUserId: null,
    });
    expect(resolveDataScope(subject([scope(DATA_SCOPE.SELF)]))).toEqual({
      kind: 'limited',
      deptIds: [],
      selfUserId: '2',
    });
  });

  it('多角色取并集并去重', () => {
    const filter = resolveDataScope(
      subject([
        scope(DATA_SCOPE.CUSTOM, ['21'], '3'),
        scope(DATA_SCOPE.CUSTOM, ['21', '22'], '4'),
        scope(DATA_SCOPE.DEPT, [], '5'),
        scope(DATA_SCOPE.SELF, [], '6'),
      ]),
    );
    expect(filter).toEqual({
      kind: 'limited',
      deptIds: ['21', '22', '10'],
      selfUserId: '2',
    });
  });

  it('未知范围码按配置错误拒绝访问', () => {
    expect(() => resolveDataScope(subject([scope('9')]))).toThrow(ForbiddenException);
    expect(() => resolveDataScope(subject([scope('')]))).toThrow(ForbiddenException);
  });

  it('只有本部门及以下需要部门子树', () => {
    expect(needsDeptAndChild([scope(DATA_SCOPE.DEPT)])).toBe(false);
    expect(needsDeptAndChild([scope(DATA_SCOPE.SELF)])).toBe(false);
    expect(needsDeptAndChild([scope(DATA_SCOPE.CUSTOM, ['10'])])).toBe(false);
    expect(needsDeptAndChild([scope(DATA_SCOPE.SELF), scope(DATA_SCOPE.DEPT_AND_CHILD)])).toBe(
      true,
    );
  });
});

describe('查询条件组装', () => {
  const columns = { dept: 'deptId', self: 'userId' };

  it('不受限时原样返回，不改变调用方条件', () => {
    const where = { delFlag: '0' };
    expect(withDataScope(where, { kind: 'all' }, columns)).toBe(where);
  });

  it('空范围生成恒假条件', () => {
    expect(withDataScope({ delFlag: '0' }, { kind: 'none' }, columns)).toEqual({
      AND: [{ delFlag: '0' }, { deptId: { in: [] } }],
    });
  });

  it('部门与本人两个分支用 OR 合并，用 AND 包住原条件避免覆盖已有 OR', () => {
    const where = { OR: [{ userName: { contains: 'a' } }] };
    expect(
      withDataScope(where, { kind: 'limited', deptIds: ['10', '11'], selfUserId: '2' }, columns),
    ).toEqual({
      AND: [where, { OR: [{ deptId: { in: [10n, 11n] } }, { userId: 2n }] }],
    });
  });

  it('只有一个分支时不额外包 OR', () => {
    expect(
      withDataScope({}, { kind: 'limited', deptIds: ['10'], selfUserId: null }, columns),
    ).toEqual({ AND: [{}, { deptId: { in: [10n] } }] });
    expect(withDataScope({}, { kind: 'limited', deptIds: [], selfUserId: '2' }, columns)).toEqual({
      AND: [{}, { userId: 2n }],
    });
  });

  it('模型没有归属人列时忽略本人分支', () => {
    expect(
      withDataScope({}, { kind: 'limited', deptIds: ['10'], selfUserId: '2' }, { dept: 'deptId' }),
    ).toEqual({ AND: [{}, { deptId: { in: [10n] } }] });
  });

  it('模型没有归属人列且只剩本人分支时退化成恒假条件', () => {
    expect(
      withDataScope({}, { kind: 'limited', deptIds: [], selfUserId: '2' }, { dept: 'deptId' }),
    ).toEqual({ AND: [{}, { deptId: { in: [] } }] });
  });

  it('缺少全部归属列时显式报错，不静默放行', () => {
    expect(() =>
      withDataScope({}, { kind: 'limited', deptIds: ['10'], selfUserId: null }, {}),
    ).toThrow('数据范围缺少可用的归属列');
  });
});

describe('写入目标的部门范围', () => {
  it('不受限放行任意部门，受限只放行范围内的部门', () => {
    const limited = { kind: 'limited', deptIds: ['10', '11'], selfUserId: '2' } as const;
    expect(isDeptInScope({ kind: 'all' }, '999')).toBe(true);
    expect(isDeptInScope(limited, '10')).toBe(true);
    expect(isDeptInScope(limited, '99')).toBe(false);
  });

  it('空范围、无部门归属一律拒绝', () => {
    const limited = { kind: 'limited', deptIds: ['10'], selfUserId: '2' } as const;
    expect(isDeptInScope(limited, null)).toBe(false);
    expect(isDeptInScope({ kind: 'none' }, '10')).toBe(false);
  });
});

describe('当前用户范围加载', () => {
  function prisma(rows: { deptId: bigint }[] = []) {
    return { dept: { findMany: vi.fn().mockResolvedValue(rows) } };
  }

  it('超管不受限且不查部门子树', async () => {
    const client = prisma();
    expect(await loadDataScope(client as never, subject([], null))).toEqual({ kind: 'none' });
    expect(
      await loadDataScope(client as never, { userId: '1', deptId: null, dataScopes: [] }),
    ).toEqual({ kind: 'all' });
    expect(client.dept.findMany).not.toHaveBeenCalled();
  });

  it('只有本部门及以下才按 ancestors 边界查询子树', async () => {
    const client = prisma([{ deptId: 10n }, { deptId: 12n }]);
    expect(await loadDataScope(client as never, subject([scope(DATA_SCOPE.DEPT_AND_CHILD)]))).toEqual(
      { kind: 'limited', deptIds: ['10', '12'], selfUserId: null },
    );
    expect(client.dept.findMany).toHaveBeenCalledWith({
      where: { delFlag: '0', ancestors: { contains: '/10/' } },
      select: { deptId: true },
      orderBy: { deptId: 'asc' },
    });
    client.dept.findMany.mockClear();
    await loadDataScope(client as never, subject([scope(DATA_SCOPE.SELF)]));
    expect(client.dept.findMany).not.toHaveBeenCalled();
  });

  it('用户没有部门时不查子树', async () => {
    const client = prisma();
    expect(
      await loadDataScope(client as never, subject([scope(DATA_SCOPE.DEPT_AND_CHILD)], null)),
    ).toEqual({ kind: 'none' });
    expect(client.dept.findMany).not.toHaveBeenCalled();
  });
});

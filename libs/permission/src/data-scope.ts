import type { RoleScope } from '@app/auth';
import type { PrismaService } from '@app/database';
import { ForbiddenException } from '@nestjs/common';
import { isSuperAdmin } from './permission.constants.js';

/**
 * 数据范围码，与 RuoYi `DataScopeType` 一一对应。
 *
 * 与 Java 的差异只在执行方式：Java 在 MyBatis 拦截器里改写 SQL，Prisma 没有等价拦截点，
 * 所以这里产出**可组合的查询条件**，由业务 service 显式合入 `where`。
 * 语义（范围码含义、多角色并集、失败关闭）保持一致。
 */
export const DATA_SCOPE = {
  /** 全部数据。 */
  ALL: '1',
  /** 自定义：`RoleDept` 指定的部门。 */
  CUSTOM: '2',
  /** 本部门。 */
  DEPT: '3',
  /** 本部门及以下。 */
  DEPT_AND_CHILD: '4',
  /** 仅本人。 */
  SELF: '5',
  /** 部门及以下或本人。 */
  DEPT_AND_CHILD_OR_SELF: '6',
} as const;

/** 解析结果：查询层可直接消费的范围条件。 */
export type DataScopeFilter =
  /** 不受限。 */
  | { readonly kind: 'all' }
  /** 空范围：任何记录都不可见，必须退化成恒假条件，不能当成不受限。 */
  | { readonly kind: 'none' }
  /** 受限：部门集合与本人，二者取并集。 */
  | {
      readonly kind: 'limited';
      readonly deptIds: readonly string[];
      readonly selfUserId: string | null;
    };

/** 解析数据范围所需的当前用户信息。 */
export interface DataScopeSubject {
  readonly userId: string;
  readonly deptId: string | null;
  readonly dataScopes: readonly RoleScope[];
}

/** 范围声明里的部门归属列与归属人列；模型没有对应列时省略。 */
export interface DataScopeColumns {
  /** 部门归属列，如 `User.deptId`、`Dept.deptId`。 */
  readonly dept?: string;
  /** 归属人列，如 `createBy`。 */
  readonly owner?: string;
}

/** 该范围集合是否需要"本部门及以下"的部门子树。 */
export function needsDeptAndChild(scopes: readonly RoleScope[]): boolean {
  return scopes.some(
    (scope) =>
      scope.dataScope === DATA_SCOPE.DEPT_AND_CHILD ||
      scope.dataScope === DATA_SCOPE.DEPT_AND_CHILD_OR_SELF,
  );
}

/**
 * 把多个角色的数据范围合并成一份并集条件。
 *
 * 规则与 Java 一致：
 * - 任一有效角色为 `1`（全部）即不受限；
 * - `2` 只取 `RoleDept` 明确指定的部门，**不自动展开下级**（Java 的 `getRoleCustom` 同样不展开）；
 * - `3` 只取当前部门；`4`/`6` 取当前部门及全部后代（由调用方传入）；
 * - `5`/`6` 追加"本人"分支；
 * - 用户没有部门时，`3`/`4`/`6` 不贡献部门条件；
 * - 合并后既无部门也无本人 → 空范围（拒绝），不退化成全量。
 *
 * 未知范围码按配置错误处理并拒绝访问（Java 抛 `ServiceException`，这里抛 403，失败关闭）。
 */
export function resolveDataScope(
  subject: DataScopeSubject,
  deptAndChild: readonly string[] = [],
): DataScopeFilter {
  const { dataScopes } = subject;
  if (!dataScopes.length) return { kind: 'none' };
  if (dataScopes.some((scope) => scope.dataScope === DATA_SCOPE.ALL)) return { kind: 'all' };

  const deptIds = new Set<string>();
  let selfUserId: string | null = null;
  for (const scope of dataScopes) {
    switch (scope.dataScope) {
      case DATA_SCOPE.CUSTOM:
        for (const deptId of scope.deptIds) deptIds.add(deptId);
        break;
      case DATA_SCOPE.DEPT:
        if (subject.deptId !== null) deptIds.add(subject.deptId);
        break;
      case DATA_SCOPE.DEPT_AND_CHILD:
        for (const deptId of deptAndChild) deptIds.add(deptId);
        break;
      case DATA_SCOPE.SELF:
        selfUserId = subject.userId;
        break;
      case DATA_SCOPE.DEPT_AND_CHILD_OR_SELF:
        for (const deptId of deptAndChild) deptIds.add(deptId);
        selfUserId = subject.userId;
        break;
      default:
        throw new ForbiddenException(`角色 ${scope.roleId} 的数据范围配置异常`);
    }
  }
  if (!deptIds.size && selfUserId === null) return { kind: 'none' };
  return { kind: 'limited', deptIds: [...deptIds], selfUserId };
}

/**
 * 解析当前用户的数据范围，必要时查询部门子树。
 *
 * 超管直接不受限，不产生任何额外查询；只有 `4`/`6` 才会读 `Dept.ancestors`。
 */
export async function loadDataScope(
  prisma: Pick<PrismaService, 'dept'>,
  subject: DataScopeSubject,
): Promise<DataScopeFilter> {
  if (isSuperAdmin(subject.userId)) return { kind: 'all' };
  if (!subject.dataScopes.length) return { kind: 'none' };
  const deptAndChild =
    subject.deptId !== null && needsDeptAndChild(subject.dataScopes)
      ? await findDeptAndChild(prisma, subject.deptId)
      : [];
  return resolveDataScope(subject, deptAndChild);
}

/**
 * 当前部门及全部后代。
 *
 * `Dept.ancestors` 是含自身的物化路径（`/1/2/3/`），用带分隔符的子串匹配，
 * 避免 `1` 命中 `10` 这类前缀碰撞；已删除部门不授予范围。
 */
async function findDeptAndChild(
  prisma: Pick<PrismaService, 'dept'>,
  deptId: string,
): Promise<string[]> {
  const rows = await prisma.dept.findMany({
    where: { delFlag: '0', ancestors: { contains: `/${deptId}/` } },
    select: { deptId: true },
    orderBy: { deptId: 'asc' },
  });
  return rows.map((row) => String(row.deptId));
}

/**
 * 目标部门是否落在当前范围内。
 *
 * 写操作用它校验"要写入的部门"，避免越权创建：新建的记录一旦落在范围外，
 * 创建者自己就再也看不到、改不了它。`null` 表示不归属任何部门，受限范围下同样拒绝。
 */
export function isDeptInScope(filter: DataScopeFilter, deptId: string | null): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'none' || deptId === null) return false;
  return filter.deptIds.includes(deptId);
}

/**
 * 把范围条件合入 Prisma `where`。
 *
 * 用 `AND` 包住原条件而不是直接展开字段，避免覆盖调用方已有的 `OR`（例如关键字搜索）。
 * `kind: 'none'` 生成 `IN ()` 恒假条件：宁可查不到，也不能退化成全量。
 *
 * 读写使用同一份并集条件——"只能改自己能看到的"。
 * 这与 Java 在 UPDATE/DELETE 上用 `AND` 串接各角色条件的做法不同：多角色时 Java 会要求
 * 记录同时满足所有角色的范围（部门角色 + 本人角色 → 必须是本部门且本人创建），
 * 比"可见即可改"更严，也更容易把合法操作挡掉。此处按可见范围收敛。
 */
export function withDataScope<T>(
  where: T,
  filter: DataScopeFilter,
  columns: DataScopeColumns,
): T {
  if (filter.kind === 'all') return where;
  const branches: Record<string, unknown>[] = [];
  if (filter.kind === 'limited') {
    if (columns.dept !== undefined && filter.deptIds.length) {
      branches.push({ [columns.dept]: { in: filter.deptIds.map((deptId) => BigInt(deptId)) } });
    }
    if (columns.owner !== undefined && filter.selfUserId !== null) {
      branches.push({ [columns.owner]: BigInt(filter.selfUserId) });
    }
  }
  if (!branches.length) {
    const column = columns.dept ?? columns.owner;
    if (column === undefined) throw new Error('数据范围缺少可用的归属列');
    branches.push({ [column]: { in: [] } });
  }
  return { AND: [where, branches.length === 1 ? branches[0] : { OR: branches }] } as T;
}

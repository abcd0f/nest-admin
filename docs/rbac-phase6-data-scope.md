# RBAC 阶段 6：数据范围落地到业务查询

对应 `docs/rbac-implementation-plan.md` 的阶段 6，目标是把 `Role.dataScope` 从"存了不用的配置"变成真正的查询约束，语义对齐 RuoYi-Vue-Plus 的 `DataScopeType`。

## 1. 结论与设计取舍

Prisma 没有 MyBatis 那种 SQL 拦截点，**不能照搬 Java 的 SQL 改写**。这里改成"产出可组合的 `where` 片段，由业务 service 显式合入"：

| 项 | RuoYi-Vue-Plus | 本项目 |
| --- | --- | --- |
| 声明方式 | Mapper 方法上的 `@DataPermission` + `@DataColumn` | service 里显式调用 `loadDataScope` / `withDataScope` |
| 生效方式 | MyBatis 拦截器用 JSqlParser 改 SQL | Prisma `where` 条件 |
| 归属列 | 注解里写 `dept_id` / `create_by`（可带表别名） | 调用点传 `{ dept: 'deptId', owner: 'createBy' }` |
| 绕过方式 | `DataPermissionHelper.ignore()` | 不调用即不受限（见第 6 节的风险说明） |

代价是每个需要隔离的查询都要显式接入，做不到 Java 那种"加个注解就完事"。收益是条件可见、可单测、不会在 ORM 层产生意外 SQL。

### 数据范围为什么不进会话快照

功能权限走"登录快照 + 变更踢人"，数据范围**没有**跟着走，而是在认证守卫每次请求加载用户时一并读取（`AuthService.loadUser`）。

理由：

1. 功能权限要 join 角色→菜单，成本高，才值得用快照换性能；数据范围只需要角色和 `RoleDept`，挂在已有的用户查询上几乎零成本。
2. 实时读取意味着调整 `Role.dataScope` 或 `RoleDept` **立即生效**，不需要踢人。
3. Java 在这里有陈旧快照问题：`SysRoleController` 的 `/dataScope` 端点只写库、不调 `cleanOnlineUserByRole`，已登录用户的 `LoginUser.roles[].dataScope` 会一直是旧值，直到重新登录。本项目不复刻这个缺陷。

因此：**改功能权限要踢人，改数据范围不用**。这个不对称是刻意的。

## 2. 六种范围

`DATA_SCOPE`（`libs/permission/src/data-scope.ts`）与 Java `DataScopeType` 一一对应：

| code | 语义 | 生成的查询条件 |
| --- | --- | --- |
| `1` | 全部 | 不附加条件 |
| `2` | 自定义 | `deptId IN (RoleDept 指定的部门)`，**不自动展开下级** |
| `3` | 本部门 | `deptId = 当前用户部门` |
| `4` | 本部门及以下 | `deptId IN (当前部门及全部后代)` |
| `5` | 仅本人 | `createBy = 当前用户` |
| `6` | 部门及以下或本人 | `deptId IN (部门子树) OR createBy = 当前用户` |

多角色**取并集**：任一角色为 `1` 即不受限，其余角色分别解析后合并去重。

部门子树用 `Dept.ancestors` 的带分隔符子串匹配（`contains: '/10/'`），避免 `1` 命中 `10` 的前缀碰撞；已删除部门不授予范围。

## 3. 失败关闭

| 情况 | 结果 |
| --- | --- |
| 用户没有任何有效角色 | 空范围（`IN ()` 恒假），不放行 |
| `3`/`4`/`6` 但用户 `deptId` 为空 | 不贡献部门条件；若同时无本人分支 → 空范围 |
| `2` 但 `RoleDept` 为空 | 空范围 |
| 未知范围码 | 抛 403 `角色 N 的数据范围配置异常` |
| 超管（`userId == 1`） | 不受限，且不产生任何额外查询 |

Java 在多角色为空时是**不加条件**（fail open），本项目改成 fail closed。正常情况下无角色用户拿不到 `system:*` 权限、进不来，但兜底不能靠这个假设。

## 4. 已接入的查询

| 服务 | 方法 | 归属列 |
| --- | --- | --- |
| `UserService` | `findAll` / `findOne` / `update` / `assignRoles` / `remove` / `create` | `deptId` + `createBy` |
| `DeptService` | `findAll` / `findOne` / `update` / `remove` / `create` | `deptId` + `createBy` |
| `RoleService` | `deptTreeSelect`（转调 `DeptService.findAll`） | 同上 |

具体行为：

- **列表**：范围条件用 `AND` 包住原 `where`，不覆盖调用方已有的 `OR`（关键字搜索）。分页的 `count` 用同一份条件。
- **详情 / 更新 / 删除 / 分配角色**：把范围条件加进"目标存在性"查询。范围外按 `404 用户不存在` 处理，不区分"没有这条"和"看不到这条"，避免探测。
- **创建**：校验目标部门是否在范围内，范围外直接 403。否则会造出创建者自己既看不见也改不了的记录。
- **部门树**：范围过滤可能裁掉父部门，此时把可见节点重挂到根上；未受限时保持原样，缺父节点仍按数据损坏报 409。
- **角色的部门树**：同样受限——看不到的部门不能被授予数据范围。

## 5. 与 Java 的两处有意偏离

### 5.1 写操作使用并集，而不是 AND 串接

Java `buildDataFilter` 在 UPDATE/DELETE 时用 `AND` 串接每个角色、每一列的模板条件。多角色下会变成"必须同时满足所有角色的范围"：

- 角色 A 本部门（`3`）、角色 B 仅本人（`5`）→ 记录必须**既是本部门又是我创建的**才能改。
- 用户能看见的、合法属于自己范围的数据，却改不了。

本项目按"**可见即可改**"处理：读写共用同一份并集条件。安全边界仍然成立（不能改自己看不到的记录），但不会把合法操作挡掉。

### 5.2 未接入的模型

| 模型 | 状态 | 原因 |
| --- | --- | --- |
| `Role` | 未接入 | Prisma `Role` 没有 `createDept` 列（Java 的 `sys_role` 有），无法按部门归属过滤；只按 `createBy` 过滤会把"本部门"范围的角色全部挡掉 |
| `Menu` | 未接入 | 菜单是全局配置，没有部门归属 |
| `Post` | 未接入 | 表存在但没有 service/controller |

要完整对齐 Java 的角色列表过滤，需要给 `sys_role` 加 `create_dept` 列并回填历史数据。这是一次 schema 变更，未在本次改动范围内。

## 6. 使用方式与注意事项

```ts
import { loadDataScope, withDataScope } from '@app/permission';

// 列表：合入 where
const where = withDataScope<Prisma.UserWhereInput>(
  { delFlag: '0' },
  await loadDataScope(this.prisma, actor),
  { dept: 'deptId', owner: 'createBy' },
);

// 详情/写操作：加进存在性判断，查不到就是 404
const row = await this.prisma.user.findFirst({
  where: withDataScope({ userId, delFlag: '0' }, await loadDataScope(this.prisma, actor), COLUMNS),
});

// 创建：校验目标部门
if (!isDeptInScope(await loadDataScope(this.prisma, actor), body.deptId ?? null)) {
  throw new ForbiddenException('无权在目标部门创建用户');
}
```

接入新模型时：

1. 确认模型有部门归属列和/或创建人列，没有就明确决定"不开放该范围"，不要静默跳过过滤。
2. 用 `{ dept, owner }` 传真实列名，不要写死。
3. 列表、详情、写操作三处都要接，只过滤列表等于没做。
4. 补一条"范围外按 ID 直接访问被拒"的测试。

**风险提示**：`withDataScope` 是显式调用，忘记调用就等于不受限。新增管理类查询时，必须确认它是否需要数据隔离。这是"不照搬 SQL 改写"的固有代价。

## 7. 验证

```
npx vitest run libs/permission apps/gateway libs/auth
  ✓ libs/permission/src/data-scope.spec.ts (19 tests)
  ✓ apps/gateway/src/modules/system/system-management.spec.ts (33 tests)
  ✓ libs/auth/src/auth.service.spec.ts (9 tests)
  ...
  Tests  176 passed (176)

npx nest build gateway        # 通过
npx eslint "libs/permission/src/**/*.ts" "libs/auth/src/**/*.ts" "apps/gateway/src/modules/system/**/*.ts"   # 0 error
```

全量 `npx vitest run`：344 passed / 3 failed，失败全部在 `libs/logger/src/logger.transport.spec.ts`（Windows 下 `mkdir` 返回 `ENOTDIR`、文件轮转保留用例超时），与本次改动无关，改动前即失败。

覆盖的边界：六种范围码、多角色并集去重、未知码 403、空角色/无部门、子树边界匹配、条件合并不覆盖 `OR`、无归属列时忽略本人分支、范围外 404、受限用户越权创建 403、部门树裁父后重挂根。

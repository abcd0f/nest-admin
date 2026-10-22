# RBAC 阶段 3：当前用户权限加载

阶段 3 已将默认空权限源替换为基于现有 Prisma 关系的查询实现。没有修改 Prisma schema、迁移、配置或依赖，也没有写入业务数据。本阶段不新增业务 HTTP API；登录、当前用户信息和菜单树在阶段 4 接入，管理 CRUD 在阶段 5 接入。

## 1. 查询与模块接入

| 文件                                              | 职责                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `libs/permission/src/permission.source.ts`        | 定义 `UserAuthorization` 和 `PermissionSource.getAuthorization(userId)` 边界。                           |
| `libs/permission/src/prisma-permission.source.ts` | 使用 `PrismaService` 查询 `User.roles -> UserRole.role -> Role.menus -> RoleMenu.menu`，筛选并聚合授权。 |
| `libs/permission/src/permission.module.ts`        | 将 `PermissionSource` 绑定到真实 Prisma 实现，移除默认空权限源。                                         |
| `libs/permission/src/permission.service.ts`       | 对外提供当前角色/权限查询；一组装饰器只加载一份授权结果，再执行既有组合规则。                            |

`AppModule` 继续直接导入 `AuthModule`、`PermissionModule` 并先认证后授权，不新增独立组合模块。查询使用主模块中全局注册的 `PrismaService`，不创建第二个数据库客户端。

权限源接口从分别查询权限/角色调整为一次返回 `{ roles, permissions }`，避免同一组注解分别加载、重复遍历用户关系。使用 Prisma 的嵌套 `select`，只读取用户状态、角色状态/标识和菜单状态/类型/权限码，不读取密码、联系方式或审计字段。这里的一次是指一次 Prisma 查询调用，不假设关系加载只产生一条 SQL。

## 2. 授权计算规则

1. 用户 ID 必须是规范的正十进制字符串，且不超过 PostgreSQL 有符号 BigInt 上限。沿用认证库的 `isUserId` 校验，转换时直接使用 `BigInt`，不经过 `Number`。
2. 用户必须存在，且 `status === '0'`、`delFlag === '0'`；不满足时返回 401，不允许通过角色兜底继续授权。
3. 仅 `status === '0'`、`delFlag === '0'` 的已关联角色贡献授权。没有有效角色时返回空角色、空权限。
4. `roles` 使用有效角色的 `roleKey`，不是 `roleName`。角色标识必须非空、无首尾空白且不含 `*`；非法角色标识不参与角色匹配，但有效角色明确关联的菜单权限仍独立计算。
5. 从有效角色关联的菜单中，取 `status === '0'` 且 `menuType` 为 `C` 或 `F` 的 `perms`。`M` 是目录，不贡献操作权限；未知类型不贡献权限。`Menu` 没有 `delFlag`，因此不添加不存在的过滤字段。
6. `perms` 是一个完整的精确匹配字符串。不拆分逗号、不 trim、不展开通配符；空值、空字符串、首尾空白、包含 `*` 的值不贡献权限。多个有效角色的权限取并集，结果去重并按字符串顺序排序。
7. `visible` 只控制展示，不作为功能授权条件。授权基于直接关联菜单的状态，不自动授予祖先/后代权限，也不通过目录状态隐式递归撤销按钮权限。需要撤销某项功能时，停用对应菜单/按钮或移除相应角色菜单关联。
8. 用户 ID 为 1 或角色标识为 `admin` 都不产生隐式超级权限。管理员仍需分配菜单权限；只有显式声明了角色要求或角色兜底的注解才会检查对应角色标识。

现有装饰器写法保持 `Mode` 和 `role` 参数：

```ts
import { Mode, Permission, Role } from '@app/permission';

// 同一注解内默认 AND。
@Permission({ value: ['system:user:edit', 'system:log:view'] })
edit() {}

@Permission({ value: ['system:user:add', 'system:user:delete'], mode: Mode.OR })
change() {}

// 当前注解：export 权限 OR admin/operator 中任一角色。
@Permission({ value: 'system:user:export', role: ['admin', 'operator'] })
exportUsers() {}

// 多条注解固定 AND：角色与权限都需要满足。
@Role('admin')
@Permission('system:user:all')
manage() {}
```

类和方法上的全部注解继续固定 AND。单条注解中的 OR 或角色兜底不能绕过其他注解，`@Authenticated()` 也不能清除已有要求。

## 3. 生效时间与失败处理

- 不使用进程缓存、Redis 权限缓存或 JWT 角色/权限快照。每次需要角色/权限的请求重新查询当前数据库关系。
- 用户角色、角色菜单关联修改，以及角色/菜单状态修改提交后，下一次授权查询使用更新后的关系；无需重新登录或刷新 JWT。已执行完授权检查的请求不回滚，数据库变更与业务操作的并发约束仍由具体业务事务负责。
- 认证阶段先检查 JWT、Redis 会话和用户，权限阶段再次检查用户有效性。正常功能请求包含一次认证用户查询和一次授权关系查询；多个装饰器共享后一份结果。
- `@Public()` 跳过认证及授权；只有 `@Authenticated()` 的接口通过认证即可，不额外查询角色菜单。未标策略的接口仍拒绝访问。
- 用户失效返回 401，正常加载但不满足声明返回 403。授权查询异常包装为 `ServiceUnavailableException`，通过既有异常过滤器返回统一 503，不能使用上一次成功结果或把查询故障解释为允许。原始数据库异常作为 cause 留在服务端，不进入响应。
- 用户 ID 只从认证后的上下文获得；请求中的 `userId`、角色数组、权限数组不会进入授权计算。

## 4. 后续当前用户接口如何复用

业务模块导入 `PermissionModule`，注入 `PermissionService`，用认证上下文的 `userId` 调用：

```ts
const { roles, permissions } = await this.permissions.getAuthorization(user.userId);
```

返回类型为 `UserAuthorization`，包含两个只读字符串数组。阶段 4 的 `/auth/profile` 将它们映射到既有 `ProfileResponseDto.roles`、`permissions`；不得接受客户端指定任意用户来查询本人权限。

本阶段不提前开放 `/auth/profile`、`/auth/menus` 或管理接口，也不为 `example` 生成没有实际用户管理含义的 `system:user:*` 权限。现有 example 继续默认拒绝；阶段 5 的真实管理接口按以下命名约定逐一声明：

| 资源 | 权限码约定                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 用户 | `system:user:list`、`system:user:query`、`system:user:add`、`system:user:edit`、`system:user:delete` |
| 角色 | `system:role:list`、`system:role:query`、`system:role:add`、`system:role:edit`、`system:role:delete` |
| 菜单 | `system:menu:list`、`system:menu:query`、`system:menu:add`、`system:menu:edit`、`system:menu:delete` |
| 部门 | `system:dept:list`、`system:dept:query`、`system:dept:add`、`system:dept:edit`、`system:dept:delete` |

每个实际操作都需要分配完整权限码。关联分配等操作在阶段 5 实现时单独声明对应权限，不通过角色标识自动绕过。

## 5. 验证范围

- `prisma-permission.source.spec.ts`：多个角色并集、去重排序、无角色/菜单、禁用/删除角色、禁用/未知状态菜单、目录/菜单/按钮、非法权限码、管理员无隐式权限、BigInt 边界、用户失效与查询故障。
- `permission.service.spec.ts`：模块实际绑定 Prisma 权限源，空授权拒绝访问；权限精确匹配。
- 原守卫测试继续验证默认 AND、显式 OR、角色兜底、角色与权限/相同装饰器叠加、类/方法约束及未认证拒绝。
- `test/rbac.e2e-spec.ts`：实际 AppModule、真实权限源及守卫，mock Prisma 和会话存储，不覆盖 PermissionSource；同一 JWT 下修改角色状态、删除标志、用户角色/角色菜单关联、菜单状态后，下一次 HTTP 请求为 403；另验证多角色并集、一次授权查询、伪造参数无效和数据库故障为 503。

测试不写真实数据库。类型检查和 Prisma 客户端生成验证代码与现有关系 API 一致；Prisma schema/迁移 diff 必须为空。

### 本阶段验证结果

- `pnpm exec prisma generate`：生成现有 Prisma Client 成功，无 schema/迁移修改。
- `pnpm build`、`pnpm exec tsc --noEmit --incremental false`：通过。
- `pnpm exec vitest run --exclude libs/logger/src/logger.transport.spec.ts`：21 个测试文件、229 项用例通过；沿用既有日志轮转失败文件的排除范围，没有修改该文件或日志实现。
- `pnpm exec vitest run --config vitest.config.e2e.ts`：32 项用例通过；未设置外部 Redis 测试地址，16 项外部依赖用例跳过。
- 相关文件 ESLint、Prettier、`git diff --check` 通过；`git diff -- prisma` 为空。数据库访问使用 mock 验证，未运行真实数据库写入或迁移。

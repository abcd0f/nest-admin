# RBAC 实现对比：RuoYi-Vue-Plus 5.X vs nest-admin

> 对比基线
>
> - Java 侧：`E:\test\nest-vben-admin\RuoYi-Vue-Plus-5.X`（Spring Boot 3 + Sa-Token + MyBatis-Plus，含多租户）
> - Node 侧：`E:\test\nest-vben-admin\nest-admin`（NestJS + Fastify + Prisma 7 + PostgreSQL，无多租户）
> - 本文档为 `docs/rbac-implementation-plan.md`、`docs/rbac-phase3-permission-loading.md` 中引用的"当前实现基准"。

---

## 0. 结论先行

两个项目的**模型层几乎同构**（`sys_user` / `sys_role` / `sys_menu` / `sys_dept` + 三张关联表，权限码都放在 `sys_menu.perms`，超管都是 `userId == 1`），但**执行层是两种完全不同的架构**：

| 维度 | RuoYi-Vue-Plus | nest-admin | 差异性质 |
| --- | --- | --- | --- |
| 权限判定入口 | 208 处 `@SaCheckPermission` 注解 + Sa-Token 拦截器 | 1 个全局 `PermissionGuard` + 25 处 `@Permission` 注解 | 同为注解式，nest 表达力更强（AND/OR/角色兜底） |
| 权限载体 | `LoginUser` 对象存 Sa-Token Token-Session（内存 + Redis 持久化） | Redis 里显式序列化的 `AuthSession{roles,permissions}` 快照 | 语义相同，实现不同 |
| **数据权限** | MyBatis-Plus 拦截器 + JSqlParser **改写 SQL**，6 种范围全自动 | Prisma `where` 条件构造器（`libs/permission/src/data-scope.ts`），6 种范围显式接入 | 语义对齐，执行方式不同 |
| 多租户 | `tenant_id` 列 + 租户行拦截器自动拼 `WHERE` + 租户套餐 | 无（表里连 `tenant_id` 都没有） | 按需求有意裁剪 |
| 权限变更生效 | 遍历**全部在线 token** 匹配后踢人 | 按 `auth:user:{id}` 索引**精确撤销**该用户会话 | nest 更高效，且覆盖菜单变更 |
| 分层方式 | `ruoyi-common-*` starter 自动装配 | `libs/*` 显式 Module + `apps/gateway` 业务模块 | 框架生态差异 |

一句话总结：**RuoYi 的 RBAC = 功能权限（注解）+ 数据权限（SQL 改写）+ 租户隔离（SQL 改写），三层都在框架层自动完成；nest-admin 实现了前两层（第二层靠条件构造器而非 SQL 改写），第三层按需求移除。**

---

## 1. 技术栈与模块基线

### 1.1 RuoYi-Vue-Plus

```
ruoyi-admin/            # Web 入口：AuthController、SysLoginService、登录策略
ruoyi-modules/
  ruoyi-system/         # 用户/角色/菜单/部门/岗位/租户/日志 的 Controller+Service+Mapper
  ruoyi-workflow/ ...
ruoyi-common/
  ruoyi-common-core         # LoginUser、SystemConstants、TenantConstants
  ruoyi-common-satoken      # StpInterface 实现、LoginHelper、PlusSaTokenDao
  ruoyi-common-security     # SecurityConfig：SaInterceptor 注册、全 URL 登录校验
  ruoyi-common-mybatis      # 数据权限拦截器、DataPermission 注解、分页
  ruoyi-common-tenant       # 租户行处理器、TenantHelper、租户缓存/SaToken 隔离
```

关键点：这些 `common-*` 是 **Spring Boot Starter**，靠 `@AutoConfiguration` 自动生效。`ruoyi-common-security` 一进 classpath，全站登录校验就挂上了，业务代码零感知。

### 1.2 nest-admin

```
apps/gateway/
  src/app.module.ts                    # 全局装配：AuthGuard → PermissionGuard
  src/modules/system/{auth,user,role,menu,dept}/
libs/
  auth/          # JWT 签发/校验、Redis 会话、AuthGuard、@Public/@CurrentUser
  permission/    # @Permission/@Role/@Authenticated、PermissionGuard、PermissionSource
  database/      # PrismaService + 生成的 client
  cache/         # Redis 封装
  crypto/        # Argon2id、API 加解密
  config/        # 分层 YAML 配置域（含 auth 域）
```

关键点：Nest 没有"starter 自动装配"，所有能力必须**显式 import Module**。权限判定被收拢到 `libs/permission` 一个包里，业务模块只写注解。

---

## 2. 数据模型对比

### 2.1 表结构

| 表 | RuoYi-Vue-Plus | nest-admin | 差异 |
| --- | --- | --- | --- |
| `sys_user` | 有 `tenant_id`、`create_dept` | 无 `tenant_id`、**无 `create_dept`**（已移除，见 2.2） | 租户字段裁掉；死字段清理 |
| `sys_role` | `tenant_id`、`role_sort`、`data_scope`(默认 `'1'`)、`menu_check_strictly`、`dept_check_strictly` | `order_num`、`data_scope`(**默认 `'5'`**)、`menu_check_strictly`、`dept_check_strictly` | 默认数据范围不同 |
| `sys_menu` | 无 `del_flag`、有 `create_dept`、`query_param` | 无 `del_flag`、有 `query`、无 `create_dept` | 字段改名 |
| `sys_dept` | `tenant_id`、`dept_category`、`leader`/`phone`/`email` | `leader_id`，无 `dept_category`/`phone`/`email` | 精简 |
| `sys_post` | `dept_id`(非空)、`post_category`、`post_sort`，**物理删除**（无 `del_flag`） | `dept_id`(可空)、无 `post_category`、`order_num`，**逻辑删除** `del_flag='2'` | 结构对齐，删除语义不同 |
| `sys_user_role` / `sys_role_menu` / `sys_role_dept` | 有 | 有（复合主键 + `onDelete: Cascade`） | 一致 |
| 租户套餐 | `sys_tenant_package`（`menu_ids` 字符串） | 无 | 无租户 |

### 2.2 语义差异（容易踩坑的四处）

1. **`data_scope` 默认值不同**：RuoYi 建角色默认 `'1'`（全部数据），nest 默认 `'5'`（仅本人）。nest 走"默认最小权限"，新建角色立刻就是"只看自己"，需要显式放开——迁移历史角色时要逐条核对，别以为默认值和 Java 一样。
2. **`del_flag` 取值不同**：RuoYi 是 `'0'` 存在 / `'1'` 删除；nest 逻辑删除写 `'2'`（见 `user.service.ts` 的 `delFlag: '2'`），判定仍是 `!== '0'` 即无效。跨系统导数据时要注意。
3. **`sys_menu` 没有 `del_flag`**：两边一致，菜单只能物理删除或停用。nest 的 `menu.service.ts` 因此对菜单权限码的过滤条件只有 `status === '0'`。
4. **`sys_user.create_dept` 已移除**（2026-10-23）：这一列在 Java 里是数据权限锚点（`SysRoleMapper` 用 `create_dept` 过滤角色可见范围），但 nest 侧只有 `User` 有它、且只写不读，用户表的部门归属本来就用 `dept_id`。移除后角色列表无法按部门过滤，原因见 5.4。

---

## 3. 认证层对比

### 3.1 登录

| 项 | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 端点 | `POST /auth/login`（`AuthController`） | `POST /auth/login`（`SystemAuthController`） |
| 凭证 | `clientId` + `grantType` + `tenantId` + 账号密码/短信/社交 | 仅 `userName` + `password` |
| 策略 | `IAuthStrategy` 策略模式，password/sms/social/miniapp 可扩展 | 单一实现 |
| 租户校验 | `SysLoginService.checkTenant`（存在/停用/过期） | 无 |
| 客户端校验 | `sys_client` 表校验 `clientId` 与 `grantType`，且 token 里的 `clientid` 必须与 header/param 一致 | 无 clientId 概念 |
| 防枚举 | 无（依赖验证码 + 错误次数锁定） | 无匹配账号也跑一次 Argon2id（`dummyPasswordHash`） |
| 暴力破解 | Redis 计数 `PWD_ERR_CNT_KEY`，超阈值锁定 | **无**（只有全局 ThrottlerGuard 限流） |
| 验证码 | 有 `/captchaImage` | 无 |
| 密码算法 | BCrypt（`BCrypt.checkpw`） | Argon2id（`PasswordHashService`） |

### 3.2 会话与令牌

**RuoYi**：Sa-Token 整合 JWT 简单模式（`StpLogicJwtForSimple`），`LoginHelper.login()` 把整个 `LoginUser` 塞进 `StpUtil.getTokenSession()`：

```java
StpUtil.login(loginUser.getLoginId(), model.setExtra(TENANT_KEY, ...).setExtra(USER_KEY, ...)...);
StpUtil.getTokenSession().set(LOGIN_USER_KEY, loginUser);
```

`LoginUser` 里带的授权数据：`menuPermission`（`Set<String>`）、`rolePermission`（`Set<String>`）、`roles`（`List<RoleDTO>`，**含 roleId + dataScope**）、`posts`、`deptId`、`deptName`、`deptCategory`、`tenantId`、`userType`。

注意 `roles` 带 `dataScope`——这是数据权限能在 SQL 层直接展开的前提。

**nest-admin**：Access JWT（HS256，15 分钟）+ Redis Refresh Token（7 天绝对期限），Redis 里存的是**显式快照**：

```ts
// libs/auth/src/session.store.ts
export interface AuthSession extends AuthSnapshot {
  userId: string;
  refreshHash: string;   // SHA-256 摘要
  expiresAt: number;
  roles: string[];       // 只有 roleKey
  permissions: string[]; // 只有权限码
}
```

三个 Redis key：`auth:session:{sid}`、`auth:used:{sid}`（防重放）、`auth:user:{userId}`（会话索引，用于踢人）。

| 能力 | RuoYi | nest-admin |
| --- | --- | --- |
| 多设备会话 | 支持（按 device 区分 loginId） | 支持（每次登录一个 `sid`） |
| Refresh 轮换 | Sa-Token 内建 | 手写 Lua 原子轮换 + 重放即撤销会话（`ROTATE_REFRESH_TOKEN`） |
| 登出粒度 | 当前 token | 当前 `sid`（其他设备不受影响） |
| 权限数据载体 | `LoginUser` 对象（含 dataScope） | `AuthSession` 快照（roleKey + 权限码）+ `dataScopes`（请求期实时加载） |

会话快照只装功能权限，数据范围不走快照而是每次请求随用户加载（见 5.3）。两者分开的理由是成本：菜单 join 贵，值得用快照换；角色 + `RoleDept` 便宜，实时读更准。

### 3.3 请求期校验

| 项 | RuoYi | nest-admin |
| --- | --- | --- |
| 入口 | `SaInterceptor`（Spring MVC 拦截器，`SecurityConfig`） | `AuthGuard`（Nest 全局 Guard，`APP_GUARD` 第一个） |
| 登录校验 | `StpUtil.checkLogin()`，路径白名单由 `SecurityProperties.excludes` + `@SaIgnore` 控制 | `@Public()` 元数据，默认全部需要认证 |
| 用户有效性 | 不查库（信任 token session），用户被停用后靠踢人 | **每次请求查库** `loadUser()`，校验 `status/delFlag` |
| 客户端绑定 | 校验 `clientid` 与 token 一致 | 无 |
| 上下文注入 | `LoginHelper.getLoginUser()` 静态方法 | `@CurrentUser()` 参数装饰器，只从 `request.user` 读 |

nest 的 `authenticate()` 每个请求都会 `prisma.user.findUnique`，换来的是"用户被停用/删除立即失效"；RuoYi 靠 token session + 踢人达到近似效果，代价是踢人失败时会留活口。

---

## 4. 功能权限（授权判定）对比

### 4.1 判定链路

**RuoYi**：

```
@SaCheckPermission("system:role:list")
  → SaInterceptor / Sa-Token AOP
    → StpInterface.getPermissionList(loginId, loginType)   // SaPermissionImpl
      → LoginHelper.getLoginUser().getMenuPermission()     // 读 token session
        → 登录时 SysPermissionServiceImpl.getMenuPermission() 算好的 Set
          → SaFoxUtil.vagueMatch 通配匹配
```

**nest-admin**：

```
@Permission('system:role:list')
  → PermissionGuard.canActivate()          // libs/permission/src/permission.guard.ts
    → Reflector 收集类+方法上的 AccessRequirement[]
      → PermissionService.isAllowed(user, requirements)
        → createMatcher(user.permissions)  // 精确 Set + 通配线性扫描
```

两条链路的结构高度对应：**登录时算一次 → 存会话 → 请求期只读会话 → 变更时踢人**。nest 的 `permission.constants.ts` 头部注释明确写了"取值与语义对齐 RuoYi-Vue-Plus"，包括 `vagueMatch` 对 `SaFoxUtil.vagueMatch` 的复刻。

### 4.2 注解表达力

| 能力 | RuoYi | nest-admin |
| --- | --- | --- |
| 单权限码 | `@SaCheckPermission("a:b:c")` | `@Permission('a:b:c')` |
| 多权限码 | `@SaCheckPermission(value={"a","b"}, mode=SaMode.AND/OR)` | `@Permission({value:['a','b'], mode: Mode.AND\|OR})` |
| 角色校验 | `@SaCheckRole("admin")`（35 处） | `@Role('admin')` / `@Role({value:[...], mode:OR})`（**当前控制器零使用**） |
| 权限 OR 角色 | `@SaCheckPermission(value="x", orRole="admin")` | `@Permission({value:'x', role:['admin','operator']})` |
| 多注解叠加 | 不适用（一个方法多个注解各自独立生效） | **固定 AND**，且 `@Authenticated()` 不能清除已有要求 |
| 通配符 | Sa-Token 原生 `*` 匹配 | 自实现 `vagueMatch`，额外做正则元字符转义（比 Java 版更安全） |
| 使用密度 | 208 处 `@SaCheckPermission` + 35 处 `@SaCheckRole` + 8 处 `@SaIgnore` | 25 处 `@Permission` + 2 处 `@Authenticated`（仅 5 个管理模块） |

nest 的组合语义更严格也更清晰（多注解 AND 是显式设计，见 `permission.guard.spec.ts` 的用例矩阵），但 `@Role` 目前是"有实现无使用"的状态。

### 4.3 权限码来源

两边完全一致：

- 只取 `menu_type in ('C','F')` 且 `status='0'` 的 `perms`；`M`（目录）不贡献权限码。
- 多角色取并集，去重。
- `visible` 只影响菜单树展示，不影响功能授权。
- 菜单树：`M`/`C` 参与，超管分支**不过滤 `visible`**（RuoYi `selectMenuTreeAll()` 也不过滤），普通用户分支过滤 `visible='0'`。nest 的 `SystemAuthService.superAdminMenus/grantedMenus` 精确复刻了这个不对称行为。

### 4.4 超级管理员

| 项 | RuoYi | nest-admin |
| --- | --- | --- |
| 判定 | `SystemConstants.SUPER_ADMIN_ID == 1L` | `SUPER_ADMIN_ID = '1'`（字符串比较） |
| 注入角色 | `superadmin` | `superadmin` |
| 注入权限 | `*:*:*` | `*:*:*`（`ALL_PERMISSION`） |
| 依赖角色行 | 否（`getRolePermission` 直接短路） | 否（`PrismaPermissionSource` 直接短路） |
| 账号保护 | `checkUserAllowed` 拒绝对 1 号用户操作；`checkRoleAllowed` 拒绝 roleId==1 | `assertNotSuperAdmin`；`assertRoleKeyAvailable/NotReserved` 保护 `superadmin`/`admin` 标识 |
| 菜单 | 全量启用 `M`/`C` | 全量启用 `M`/`C` |
| 停用后 | 仍能通过（token 已发） | **被拦**（`loadUser` 每次查库，`assertActiveUser` 兜底） |

RuoYi 还有一个 nest 没有的概念：**租户管理员**（`roleKey == 'admin'`）。它享受数据权限豁免（`PlusDataPermissionHandler` 里 `isSuperAdmin() || isTenantAdmin()` 直接返回原 `where`），但不是全权限。nest 保留了这个 `roleKey` 作为禁占用标识，但没有对应语义。

---

## 5. 数据权限对比 —— 同语义、不同执行方式

### 5.1 RuoYi：SQL 改写，全自动

四层协作：

1. **注解声明**（`@DataPermission` + `@DataColumn`）标在 Mapper 方法上：

```java
// SysUserMapper.java:31
@DataPermission({
    @DataColumn(key = "deptName", value = "dept_id"),
    @DataColumn(key = "userName", value = "create_by")
})
default Page<SysUserVo> selectPageUserList(Page<SysUser> page, Wrapper<SysUser> queryWrapper) { ... }
```

`key` 是 SQL 模板里的占位符名，`value` 是真实列名（可带表别名 `d.dept_id`），`permission` 可选——拥有该权限码的角色跳过这条列的过滤。

2. **切面存注解**：`DataPermissionAdvice` 把方法/类上的注解放进 `DataPermissionHelper` 的 ThreadLocal。

3. **拦截器改写 SQL**：`PlusDataPermissionInterceptor` 实现 MyBatis-Plus `InnerInterceptor`，在 `beforeQuery`（SELECT）和 `beforePrepare`（UPDATE/DELETE）阶段用 JSqlParser 解析并重写 `WHERE`。

4. **条件生成**：`PlusDataPermissionHandler.buildDataFilter()` 遍历当前用户的**每个有效角色**，按 `DataScopeType` 的 SpEL 模板渲染出 SQL 片段，再用 `OR`（SELECT）或 `AND`（UPDATE/DELETE）拼起来。

六种范围的模板（`DataScopeType.java:31-56`）：

| code | 语义 | SQL 模板 |
| --- | --- | --- |
| `1` | 全部 | 空（直接返回原 `where`） |
| `2` | 自定义 | `#{#deptName} IN (#{@sdss.getRoleCustom(#user.roleId)})` |
| `3` | 本部门 | `#{#deptName} = #{#user.deptId}` |
| `4` | 本部门及以下 | `#{#deptName} IN (#{@sdss.getDeptAndChild(#user.deptId)})` |
| `5` | 仅本人 | `#{#userName} = #{#user.userId}` |
| `6` | 部门及以下或本人 | 上面两条 `OR` |

关键设计细节，值得 nest 实现时逐条照抄：

- **SELECT 用 OR 合并多角色，UPDATE/DELETE 用 AND**——查询要"任一角色可见即可见"，写操作必须"所有角色都允许才允许"。这个不对称是安全边界，不能统一。
- **`elseSql` 兜底**：模板渲染不出条件时（比如注解只声明了 `deptName` 但角色范围是 `5`），落 `1 = 0`，**失败关闭**，不会退化成全量。
- **`NullSafeStandardEvaluationContext`**：SpEL 里取不到的变量返回 `-1` 而不是 null，避免 `IN (null)` 这种语义漂移。
- **`DataPermissionHelper.ignore()`**：显式绕过。用于"查自己"的场景，比如 `SysUserController.getInfo` 里 `DataPermissionHelper.ignore(() -> userService.selectUserById(...))`，否则 5 号范围用户查自己会被过滤掉。
- **操作级校验**：`checkUserDataScope(userId)` / `checkRoleDataScope(roleId)` 用带数据权限的 `count` 查询判断目标记录是否在范围内，防"列表看不到但按 ID 能改"。这是列表过滤之外的第二道闸。

### 5.2 nest-admin：条件构造器，显式接入

Prisma 没有 MyBatis 那种 SQL 拦截点，所以不做 SQL 改写，改成**产出可组合的 `where` 片段**，由 service 显式合入（`libs/permission/src/data-scope.ts`）：

| 能力 | 函数 | 作用 |
| --- | --- | --- |
| 解析 | `resolveDataScope(subject, deptAndChild)` | 纯函数：多角色范围 → `{kind:'all' \| 'none' \| 'limited'}` |
| 加载 | `loadDataScope(prisma, subject)` | 超管短路；仅 `4`/`6` 才查 `Dept.ancestors` 子树 |
| 合入 | `withDataScope(where, filter, columns)` | 用 `AND` 包住原条件，不覆盖已有 `OR` |
| 写入校验 | `isDeptInScope(filter, deptId)` | 创建时校验目标部门，越权 403 |

已接入的查询：

| 服务 | 方法 | 归属列 |
| --- | --- | --- |
| `UserService` | `findAll` / `findOne` / `update` / `assignRoles` / `remove` / `create` | `deptId` + `createBy` |
| `DeptService` | `findAll` / `findOne` / `update` / `remove` / `create` | `deptId` + `createBy` |
| `RoleService` | `deptTreeSelect`（转调 `DeptService.findAll`） | 同上 |

三个实现要点：

1. **范围条件用 `AND` 包住原 `where`**，不展开字段——否则会覆盖调用方已有的 `OR`（关键字搜索），把范围变成"或"的一部分。
2. **范围外按 404 处理**，不区分"没有这条"和"看不到这条"，避免探测。
3. **部门树被裁掉父节点时把可见节点重挂到根**；未受限时保持原样，缺父节点仍按数据损坏报 409。

与 Java 一样，空范围、未知范围码一律失败关闭：前者生成 `IN ()` 恒假条件，后者抛 403。Java 在多角色为空时是**不加条件**（fail open），这里没有照抄。

### 5.3 数据范围为什么没进会话快照

功能权限走"登录快照 + 变更踢人"，数据范围**没跟着走**：它在 `AuthService.loadUser` 里随用户一起加载（每次请求），落在 `AuthenticatedUser.dataScopes`。

| 项 | RuoYi | nest-admin |
| --- | --- | --- |
| 载体 | `LoginUser.roles[].dataScope` | `AuthenticatedUser.dataScopes` |
| 时机 | 登录时算一次 | 每次请求随用户加载 |
| 变更生效 | 需重新登录 | 立即生效 |
| 是否踢人 | 否（`/dataScope` 端点不调 `cleanOnlineUserByRole`） | 不需要 |

理由：功能权限要 join 角色→菜单，成本高才值得用快照换性能；数据范围只需要角色和 `RoleDept`，挂在已有的用户查询上几乎零成本。顺带修掉了 Java 的陈旧快照问题——那边改完角色数据范围，已登录用户手里的 `LoginUser` 还是旧值，直到重新登录。

### 5.4 与 Java 的两处有意偏离

**写操作使用并集，不是 AND 串接。** Java `buildDataFilter` 在 UPDATE/DELETE 时用 `AND` 串接每个角色、每一列的模板条件。多角色下会变成"必须同时满足所有角色的范围"：角色 A 本部门 + 角色 B 仅本人 → 记录必须既是本部门又是我创建的才能改。用户能看见、合法属于自己的数据却改不了。本项目按"**可见即可改**"处理，读写共用同一份并集条件，安全边界不变。

**`Role` / `Menu` 未接入。** Prisma `Role` 没有 `createDept` 列（Java 的 `sys_role` 有），只按 `createBy` 过滤会把"本部门"范围的角色全部挡掉；`Menu` 是全局配置无部门归属；`Post` 表存在但没有 service。要完整对齐 Java 的角色列表过滤，需要给 `sys_role` 加 `create_dept` 列并回填数据，属于独立的 schema 变更。

注意别把它加到 `User` 上：`sys_user.create_dept` 已于 2026-10-23 移除（只写不读）。真要补角色范围，加在 `sys_role` 才是对的——那是 Java 原本的用法。

---

## 6. 多租户对比

| 项 | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 存储 | 每张业务表加 `tenant_id varchar(20) default '000000'` | 无 |
| 隔离机制 | MyBatis-Plus `TenantLineInnerInterceptor` + `PlusTenantLineHandler` 自动拼 `WHERE tenant_id = ?` | 无 |
| 实体基类 | `TenantEntity extends BaseEntity`（带 `tenantId`） | 无 |
| 忽略隔离 | `TenantHelper.ignore()`，`tenant.excludes` 配置表白名单 | 无 |
| 租户识别 | `TenantHelper.getTenantId()`：动态租户 → 登录用户 → 表头 | 无 |
| 超级管理员跨租户 | `TenantHelper.setDynamic(tenantId)` 动态切换，Redis 存 `dynamicTenant:{userId}` | 无 |
| 租户套餐 | `sys_tenant_package.menu_ids`，建租户时按套餐批量写 `sys_role_menu` | 无 |
| 缓存隔离 | `TenantSpringCacheManager` + key 前缀 | 无 |
| 会话隔离 | `TenantSaTokenDao` / `TenantKeyPrefixHandler` | 无（`auth:*` 全局命名空间） |

nest-admin 的取舍很明确：`permission.constants.ts` 里保留了 `RESERVED_TENANT_ADMIN_ROLE_KEY = 'admin'`，注释写的是"本项目没有多租户，但为与 Java 侧保持一致，仍把它列为保留标识，禁止普通角色占用，避免与 RuoYi 的数据/权限码迁移冲突"。也就是说**只保留了迁移兼容性，没有保留能力**。

需要提醒的是：一旦将来要加租户，改动面比想象的大——不只是加列，还要动 `AuthSession`（要带 tenantId）、Redis key 前缀、所有 `@@unique` 约束（`userName` 在租户内唯一而非全局唯一）、以及所有查询的默认过滤。现在 `userName` 连全局唯一约束都没有（`login()` 里靠 `take: 2` 检测歧义），加租户时这块要先补。

---

## 7. 变更生效与一致性

这是两边差异最"工程化"的一块，也是 nest 做得更好的地方。

### 7.1 RuoYi：扫全量 token

```java
// SysRoleServiceImpl.cleanOnlineUser(List<Long> userIds)
List<String> keys = StpUtil.searchTokenValue("", 0, -1, false);   // 扫全部在线 token
keys.parallelStream().forEach(key -> {
    LoginUser loginUser = LoginHelper.getLoginUser(token);
    if (userIds.contains(loginUser.getUserId())) StpUtil.logoutByTokenValue(token);
});
```

- 复杂度 **O(在线用户总数)**，注释里自己写了"在线用户量过大时可能导致 Redis 阻塞，需谨慎调用"。
- `cleanOnlineUserByRole` 更重：先拉角色下全部用户，再扫全部 token。
- **只覆盖**：角色修改/删除、用户角色授权变更、用户删除/停用。
- **不覆盖**：菜单 `perms` 修改（`SysMenuServiceImpl.updateMenu` 只做 `updateById`）、菜单停用、部门变更。也就是说改了按钮权限码，已登录用户的旧权限会一直生效到 token 过期。

### 7.2 nest-admin：按用户索引精确撤销

```ts
// libs/auth/src/session.store.ts:133
async revokeUser(userId: string): Promise<number> {
  const sids = await this.redis.execute((c) => c.sMembers(this.redis.key(this.userKey(userId))));
  const keys = sids.flatMap((sid) => [this.sessionKey(sid), this.usedKey(sid)]);
  keys.push(indexKey);
  await this.redis.execute((c) => c.unlink(keys));   // UNLINK 非阻塞删除
  return sids.length;
}
```

- 复杂度 **O(该用户的会话数)**，与在线用户总量无关。
- 触发点覆盖（`session-invalidation.ts`）：
  - 用户状态/删除/角色变更 → `revokeSessions(auth, [userId])`
  - 角色状态/roleKey/菜单集合变更 → `revokeSessions(auth, usersOfRole(roleId))`
  - **菜单变更 → `revokeSessions(auth, usersOfMenu(menuId))`**（`menu.service.ts:174`，菜单→角色→用户三段查）
- 失败策略：业务事务已提交，踢人失败只 `logger.warn`，不让调用方看到 500 后重试（`revokeSessions` 的 try/catch）。
- **不覆盖**：部门变更（`dept.service.ts` 无 `revokeSessions`）。这是对的：数据范围在请求期按 `Dept.ancestors` 实时解析子树，部门层级一变，下一次查询就用新结构，不需要踢人。会话里只存了功能权限和 `RoleDept` 的部门 ID，前者与部门无关，后者不受层级影响。

### 7.3 结论

nest 的"按用户索引 + 覆盖菜单变更"在正确性和性能上都优于 RuoYi 的"扫全量 token + 漏菜单变更"。这块不需要向 Java 看齐，保持现状即可。

---

## 8. 分层与架构风格对比

| 维度 | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 装配方式 | Spring Boot Starter 自动装配（`@AutoConfiguration`），加依赖即生效 | Nest Module 显式 import，依赖关系在代码里可见 |
| 权限判定位置 | 分散：Controller 注解 + Service `checkXxx` 方法 + Mapper 注解 + Interceptor | 集中：`PermissionGuard` 一个入口，业务只写注解 |
| 数据权限位置 | Mapper 注解 + 全局拦截器（跨层） | service 内显式合入 `where`（同层） |
| 会话实现 | Sa-Token 框架托管（`StpUtil` 静态调用） | 自研 `SessionStore`，Redis 操作显式可见 |
| 超管判定 | `LoginHelper.isSuperAdmin()` 静态工具 | `isSuperAdmin(userId)` 纯函数 |
| 权限码常量 | 散落在注解字符串里 | 同样散落在注解字符串里（`@Permission('system:user:list')`） |
| 错误码 | `ServiceException` + 全局 Handler | `BusinessException` / `ForbiddenException` / `UnauthorizedException` + `AllExceptionsFilter` |
| 可测试性 | 依赖 Spring 容器，`@SpringBootTest` 重 | 纯函数 + DI，`vitest` 里直接 new Guard（见 `permission.guard.spec.ts`） |
| 类型安全 | 编译期弱（注解字符串） | 编译期强（`AccessRequirement` 联合类型、`Mode` 枚举、`readonly string[]`） |

nest 的架构优势在于**可测试和可推理**：`PermissionService.isAllowed` 是纯函数，`PermissionSource` 是抽象类可替换，`PermissionGuard` 在单测里 `new` 出来就能跑。RuoYi 的拦截器 + ThreadLocal + 静态工具链，调试时得顺着 Sa-Token 的调用栈往上翻。

RuoYi 的优势在于**能力密度**：一个注解就把 SQL 改了，业务代码零改动。nest 要补数据权限，必须在每个 service 的查询里显式合入条件——这是 Prisma 路线的固有代价，接受它，但要用统一构造器把成本降到最低。

---

## 9. 功能完整度盘点

| 能力 | RuoYi-Vue-Plus | nest-admin | 备注 |
| --- | --- | --- | --- |
| 用户 CRUD | ✅ | ✅ | |
| 角色 CRUD | ✅ | ✅ | |
| 菜单/按钮 CRUD | ✅ | ✅ | |
| 部门树 CRUD | ✅ | ✅ | |
| 岗位管理 | ✅ | ✅ | 见 `docs/post-module.md` |
| 用户-角色分配 | ✅ | ✅ | |
| 角色-菜单分配 | ✅ | ✅ | 都实现了 `menuCheckStrictly` 父节点裁剪 |
| 角色-部门（自定义范围） | ✅ | ✅ | 已用于数据范围过滤 |
| 功能权限判定 | ✅ | ✅ | |
| **数据权限判定** | ✅ SQL 改写 | ✅ `where` 构造器 | 阶段 6 已交付 |
| 数据权限操作级校验 | ✅ `checkUserDataScope` | ✅ 范围条件进存在性判断 | 越权按 404 处理 |
| 多租户 | ✅ | ❌（按需求移除） | |
| 租户套餐 | ✅ | ❌ | |
| 操作日志 | ✅ 132 处 `@Log(title=...)` + 异步落库 | ❌ 仅 `OperLog` model | 无 AOP/拦截器写入 |
| 登录日志 | ✅ 事件异步落库 | ❌ 仅 `LoginLog` model | |
| 在线用户管理 | ✅ | ❌ | 有会话索引，没做管理接口 |
| 验证码 | ✅ | ❌ | |
| 登录失败锁定 | ✅ | ❌ | 仅全局限流 |
| Refresh 重放防护 | 框架默认 | ✅ Lua 原子轮换 | nest 更强 |
| 防账号枚举 | ❌ | ✅ dummy hash | nest 更强 |
| 客户端（clientId）绑定 | ✅ | ❌ | |
| 社交/短信登录 | ✅ | ❌ | |
| API 加解密 | ✅ `@ApiEncrypt` | ✅ `libs/crypto` | |
| 幂等提交 | ✅ `@RepeatSubmit` | ❌ | |

---

## 10. 给 nest-admin 的行动建议

按优先级排序，只列有实际影响的：

1. ~~补数据权限执行器~~ 已完成，见 `docs/rbac-phase6-data-scope.md`。
2. ~~补操作级数据权限校验~~ 已完成：详情/更新/删除/分配角色都带范围条件，越权返回 404；创建校验目标部门。
3. ~~补岗位模块或删表~~ 已完成：`/system/posts` CRUD + 下拉，用户创建/更新时提交 `postIds`。见 `docs/post-module.md`。
4. **补操作日志（P1）**。`OperLog`/`LoginLog` 两个 model 空转，合规审计场景会卡住。Nest 里用 Interceptor + `@Log()` 装饰器实现，比 Spring AOP 更简单。
5. **补登录失败锁定（P2）**。`dummyHash` 只防枚举，不防爆破；`ThrottlerGuard` 是全局限流，不能替代按账号计数。
6. **菜单权限码常量化（P2）**。`'system:user:list'` 这类字符串散落在 25 个注解里，改名靠全局搜索。抽成 `const PERMISSIONS = { user: { list: 'system:user:list', ... } }` 能消掉一类低级错误。
7. **`@Role` 要么用起来要么删掉（P3）**。现在零使用，测试覆盖着但生产不跑，属于"看起来有其实没有"的能力。

不需要改的：会话撤销机制、通配匹配、注解组合语义、超管保护。这几块已经优于 Java 侧。

---

## 11. 速查对照表

| 概念 | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 权限码容器 | `sys_menu.perms` | `sys_menu.perms` |
| 权限码集合 | `LoginUser.menuPermission` | `AuthSession.permissions` |
| 角色标识集合 | `LoginUser.rolePermission` | `AuthSession.roles` |
| 角色详情（含 dataScope） | `LoginUser.roles`（`List<RoleDTO>`） | ❌ 会话里没有 |
| 权限注解 | `@SaCheckPermission` | `@Permission` |
| 角色注解 | `@SaCheckRole` | `@Role` |
| 公开接口 | `@SaIgnore` / `SecurityProperties.excludes` | `@Public()` |
| 登录校验 | `StpUtil.checkLogin()` | `AuthGuard` |
| 权限校验 | Sa-Token AOP | `PermissionGuard` |
| 数据权限声明 | `@DataPermission` + `@DataColumn` | `loadDataScope` + `withDataScope`（service 内） |
| 数据权限执行 | `PlusDataPermissionInterceptor`（JSqlParser） | Prisma `where` 条件 |
| 数据范围枚举 | `DataScopeType`（6 种 + SpEL 模板 + elseSql） | `DATA_SCOPE`（6 种 + 条件构造） |
| 数据范围载体 | `LoginUser.roles[].dataScope`（登录快照） | `AuthenticatedUser.dataScopes`（每次请求实时读） |
| 绕过数据权限 | `DataPermissionHelper.ignore()` | 不调用即不受限 |
| 租户隔离 | `PlusTenantLineHandler` | ❌ |
| 会话存储 | Sa-Token Token-Session | Redis `auth:session:{sid}` |
| 踢人 | `cleanOnlineUser`（扫全量 token） | `revokeUserSessions`（按用户索引） |
| 超管判定 | `userId == 1` | `userId === '1'` |
| 超管角色 | `superadmin` | `superadmin` |
| 超管权限 | `*:*:*` | `*:*:*` |
| 保留角色标识 | `superadmin`、`admin` | `superadmin`、`admin` |
| 菜单树接口 | `GET /system/menu/getRouters` | `GET /auth/menus` |
| 用户信息接口 | `GET /system/user/getInfo` | `GET /auth/profile` |
| 密码算法 | BCrypt | Argon2id |
| 令牌 | JWT（Sa-Token 简单模式） | JWT HS256 + Redis Refresh |
| 主键类型 | `Long`（bigint） | `BigInt` → JSON 十进制字符串 |
| 数据访问 | MyBatis-Plus | Prisma 7 |

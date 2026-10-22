# RBAC 实现对比：RuoYi-Vue-Plus-5.X（Java） vs nest-admin（Node/NestJS）

> 对比对象
>
> - A 侧：`E:\test\nest-vben-admin\RuoYi-Vue-Plus-5.X`（Spring Boot 3 + Sa-Token + MyBatis-Plus + 多租户）
> - B 侧：`E:\test\nest-vben-admin\nest-admin`（NestJS + Fastify + Prisma + PostgreSQL + JWT，**无租户**）
>
> 结论基于源码阅读，关键判断均附文件位置。B 侧文档 `docs/rbac-phase*.md` 是设计意图的一手说明，已一并对照。

---

## 0. 一句话结论

**两者是同一套 RuoYi RBAC 数据模型（user / role / menu / dept / 四张关联表）的两种"授权执行哲学"：**

| | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 超级管理员 | **有**，靠 `userId == 1` 硬编码 + `superadmin` 角色标识 + `*:*:*` 通配权限，全链路特判 | **已按同款实现**：`userId == 1` + 注入 `superadmin` / `*:*:*`，超管账号不可操作 |
| 权限载体 | 登录时把 `menuPermission` / `rolePermission` **快照**进 Token Session | 同款：登录时算 `roles` / `permissions` 写进 Redis 会话，鉴权只读上下文 |
| 数据权限 | SQL 层拦截器自动拼 `where`，超管/租户管理员直接跳过 | **只有配置，没有执行**（`Role.dataScope` 落库但无任何查询使用它） |
| 多租户 | 有，且与超管逻辑深度耦合（动态租户切换） | 无（用户已明确不需要） |

一句话：**RuoYi 用"一个上帝账号"解决问题；nest-admin 现在也引入了这个上帝账号，但同时保留了原有的"不可破坏约束"作为兜底。** 两边超管语义已对齐，剩余实质差异集中在数据权限（nest 仍只有配置、没有执行）。

> 第 5 节描述的是**当前代码状态**（2026-10-22 完成超管与通配权限移植后）。移植前的差异与决策过程见第 5.4 节。


---

## 1. 骨架对照

| 维度 | RuoYi-Vue-Plus | nest-admin |
| --- | --- | --- |
| 鉴权框架 | Sa-Token（`StpInterface` 实现权限源） | 自研 `libs/permission`（`PermissionSource` 抽象 + `PermissionGuard`） |
| 注解/装饰器 | `@SaCheckPermission("system:user:list")` | `@Permission('system:user:list')` / `@Role('x')` / `@Authenticated()` |
| 权限来源 | `LoginUser.menuPermission`（会话快照）→ 回退 DB | `AuthSession.roles/permissions`（会话快照），鉴权不再回退 DB |
| 权限匹配 | Sa-Token 默认**通配符匹配**（`*:*:*` 命中一切） | 同款 `vagueMatch` 语义（`permission.constants.ts`）：精确码走 Set，通配码走模式匹配 |
| 数据权限 | `@DataPermission` + JSqlParser 改写 SQL | 无 |
| 会话存储 | Redis（Sa-Token DAO） | Redis（`SessionStore`，sid + refresh 轮换） |
| 令牌 | Sa-Token Token | JWT（access）+ 不透明 refresh token |
| 审计字段 | `create_by / create_time / update_by / update_time` | 同名字段 + `create_dept` |
| 软删除 | `del_flag`（0/2） | 同 |

---

## 2. 数据模型：几乎一致，只有一处关键差异

B 侧 `prisma/models/*.prisma` 基本是 A 侧 `sys_*.sql` 的直译：

- `sys_user` / `sys_role` / `sys_menu` / `sys_dept` / `sys_post`
- `sys_user_role` / `sys_role_menu` / `sys_role_dept` / `sys_user_post`
- 状态码语义完全一致：`status='0'` 正常、`'1'` 停用；`del_flag='0'` 正常、`'2'` 删除
- 菜单类型一致：`M` 目录 / `C` 菜单 / `F` 按钮；权限码 `perms` 挂在 `C`/`F` 上

差异：

| 项 | RuoYi | nest-admin |
| --- | --- | --- |
| `tenant_id` | 每张业务表都有（`TenantEntity` 基类） | **不存在** |
| `user_type` | 有（区分 SYS_USER / APP_USER 多端体系） | 无 |
| 部门层级 | `ancestors` 祖级列表（`0,100,101`） | `ancestors` 改为**含自身的物化路径** `/1/100/101/`，长度上限 512，改父节点时递归重写子树 |
| 角色排序字段 | `role_sort` | `order_num`（与菜单统一） |
| 唯一约束 | 数据库层基本靠业务校验 | 同样靠业务校验（`userName` 无唯一索引，登录时用 `take: 2` 检测重名并拒绝） |

> 注意 B 侧部门 `ancestors` 的语义变化：RuoYi 是"祖级列表不含自身"，nest 是"含自身的完整路径"。迁移数据时必须重算，不能直接拷贝。

---

## 3. 认证与权限载体：两边都是登录快照

权限在**登录时算一次**，随会话保存，运行期鉴权只读会话——这一点两边已经一致。差异在存储结构、失效机制和覆盖范围。

### 3.1 RuoYi：快照进 Token Session

`ruoyi-admin/.../SysLoginService.java:150-161`：

```java
loginUser.setMenuPermission(permissionService.getMenuPermission(userId));
loginUser.setRolePermission(permissionService.getRolePermission(userId));
```

整个 `LoginUser`（含权限集合）被塞进 Token Session。鉴权时 `SaPermissionImpl` 优先读会话：

```java
// ruoyi-common-satoken/.../SaPermissionImpl.java
if (CollUtil.isNotEmpty(loginUser.getMenuPermission())) {
    return new ArrayList<>(loginUser.getMenuPermission());   // 快照命中，不查库
}
```

只有 `loginId` 与会话不匹配时才回退 `PermissionService` 查库。

失效靠 `cleanOnlineUser()` / `cleanOnlineUserByRole()`：遍历 Redis 里所有 token，匹配用户或角色后 `logoutByTokenValue`。

### 3.2 nest-admin：快照进 Redis 会话，鉴权只读上下文

登录时 `SystemAuthService.login` 先算快照，再交给 `AuthService.createSession`：

```ts
const snapshot = await this.permissions.snapshot(String(user.userId));
const tokens = await this.auth.createSession(String(user.userId), snapshot);
```

`AuthSession` 结构（`libs/auth/src/session.store.ts`）：

```ts
export interface AuthSession extends AuthSnapshot {
  userId: string;
  refreshHash: string;
  expiresAt: number;   // roles / permissions 来自 AuthSnapshot
}
```

`AuthService.authenticate` 校验完 JWT 与会话后，把快照直接挂到上下文：

```ts
return { ...user, sessionId: claims.sid, roles: session.roles, permissions: session.permissions };
```

守卫与 `profile` 都读这份数据，**鉴权阶段不再查角色/菜单关系**：

```ts
// permission.guard.ts
if (required.length && !this.permissions.isAllowed(user, required)) {
  throw new ForbiddenException('无访问权限');
}
```

`isAllowed` 是同步方法——`PermissionService.getAuthorization(user)` 只是回显上下文里的数组，没有任何 IO。

### 3.3 失效机制：按用户索引踢人

nest 用一条 Redis Set 索引避免 Java 那种全量遍历：

| key | 内容 |
| --- | --- |
| `auth:session:{sid}` | 会话 JSON（含快照） |
| `auth:used:{sid}` | 已消费的 refresh 摘要（重放检测） |
| `auth:user:{userId}` | 该用户所有 sid，创建会话时 `SADD` + `PEXPIRE` |

`SessionStore.revokeUser(userId)` 一次 `SMEMBERS` + 一次 `UNLINK` 清掉该用户所有会话与索引，复杂度 O(该用户会话数)，而不是 O(全站 token 数)。

触发点（事务提交后执行）：

| 操作 | 影响范围 |
| --- | --- |
| `UserService.assignRoles` | 该用户 |
| `UserService.update`（传了 `status`） | 该用户 |
| `UserService.remove` | 该用户 |
| `RoleService.assignMenus` | 该角色下所有用户 |
| `RoleService.update`（`status` 或 `roleKey` 变更） | 该角色下所有用户 |
| `MenuService.update`（`status` 或 `perms` 变更） | 引用该菜单的角色下所有用户 |

`RoleService.dataScope` 不踢人——数据范围不参与功能权限快照，且 nest 尚未执行数据权限（见第 7 节）。

踢人失败只记 `warn` 日志，不抛错：业务事务已提交，让调用方看到 500 只会诱导重试。残留会话会继续用旧快照直到过期，这是明确接受的降级。

**与 Java 的差异：** Java 只覆盖角色侧变更（`SysRoleController` 改角色时调 `cleanOnlineUserByRole`，角色授权用户时调 `cleanOnlineUser`），**用户角色变更和菜单变更不踢人**。nest 覆盖了全部六条路径，这是刻意收紧——快照模型下漏掉任何一条都是"改了权限不生效且没有补救手段"。

### 3.4 取舍

| | 快照（两边现状） | 实时查库（nest 旧实现） |
| --- | --- | --- |
| 鉴权延迟 | 极低，零 DB | 每次一次关联查询 |
| 权限变更生效 | 需踢人，用户需重新登录 | 立即 |
| 一致性风险 | 高（旧权限继续放行） | 低 |
| 实现复杂度 | 需要会话索引 + 踢人调用点 | 简单 |
| 高并发 DB 压力 | 低 | 需要读副本/缓存兜底 |

**判断：** 换成快照后，鉴权路径变干净，代价是**每个影响权限的写操作都必须记得踢人**。这是这套模型唯一的脆弱点：漏一个调用点就是静默的权限滞留。`session-invalidation.ts` 把踢人收敛成三个函数，但调用点仍然分散在三个 service 里，没有编译期保障。


---

## 4. 权限校验入口：注解语义

### 4.1 RuoYi

```java
@SaCheckPermission("system:user:list")
@GetMapping("/list")
```

- 单一维度：只校验权限码，角色维度用 `@SaCheckRole`。
- 匹配走 Sa-Token 的通配逻辑，`*:*:*` 可以命中任意权限码。
- 没有"AND/OR 组合"的一等公民表达，多权限只能写 `@SaCheckPermission(value = {"a","b"}, mode = SaMode.AND)`。

### 4.2 nest-admin

`libs/permission/src/permission.decorator.ts` 定义了两类要求，并明确区分"注解内"和"注解间"：

| 写法 | 语义 |
| --- | --- |
| `@Permission('a')` | 需要权限 `a` |
| `@Permission({ value: ['a','b'] })` | 默认 **AND**，`a` 和 `b` 都要有 |
| `@Permission({ value: ['a','b'], mode: Mode.OR })` | 注解内 OR |
| `@Permission({ value: 'a', role: ['admin'] })` | 有 `a` **或** 有 `admin` 角色即可（角色兜底） |
| `@Role('admin')` | 角色标识匹配（支持通配，如 `ops:*`） |
| `@Authenticated()` | 仅要求登录，**不清除**已有要求 |
| 多条注解叠加 | **固定 AND**，任一不满足即 403 |

硬性约束（`normalizeValues`）：

- **注解侧**权限码/角色标识必须非空、无首尾空白、**不含 `*`**，否则**启动期就抛错**。
- 通配只允许出现在**授权数据**（`sys_menu.perms`）里，由 `PermissionSource` 返回。需求侧写通配会被拒绝，避免开发者用 `@Permission('*:*:*')` 绕过全部检查。
- `@Public()` 跳过认证与授权；**未标任何策略的接口默认拒绝**（`permission.guard.ts` 里 `!required.length && !authenticated` 直接 403）。

**这一点比 RuoYi 严格得多**：RuoYi 里忘记加 `@SaCheckPermission` 的接口是"仅需登录"（默认放行），B 侧是"默认拒绝"。属于 fail-closed vs fail-open 的区别，B 侧明显更安全。

---

## 5. 超级管理员逻辑（重点）

### 5.1 RuoYi 的超管是"三重硬编码 + 全链路特判"

**(a) 身份硬编码：`userId == 1`**

```java
// SystemConstants
Long SUPER_ADMIN_ID = 1L;

// LoginHelper
public static boolean isSuperAdmin(Long userId) {
    return SystemConstants.SUPER_ADMIN_ID.equals(userId);
}
```

超管不是"某个角色"，而是"主键为 1 的那一行用户"。**不可转让、不可更换、不可删除**——因为所有校验都在拿 `userId` 跟常量 `1L` 比。

**(b) 权限硬编码：`*:*:*` 通配**

```java
// SysPermissionServiceImpl
if (LoginHelper.isSuperAdmin(userId)) {
    roles.add(TenantConstants.SUPER_ADMIN_ROLE_KEY);  // "superadmin"
    ...
    perms.add("*:*:*");
}
```

超管不需要任何 `sys_role_menu` 关联，直接注入通配权限。配合 Sa-Token 的通配匹配，`*:*:*` 命中所有 `@SaCheckPermission`。

**(c) 角色硬编码：`role_id == 1` / `role_key in ('superadmin','admin')`**

```java
// SysRoleServiceImpl.checkRoleAllowed
if (ObjectUtil.isNotNull(role.getRoleId()) && LoginHelper.isSuperAdmin(role.getRoleId())) {
    throw new ServiceException("不允许操作超级管理员角色");     // role_id == 1 不可操作
}
String[] keys = { SUPER_ADMIN_ROLE_KEY, TENANT_ADMIN_ROLE_KEY };
// 新增/改名时禁止占用 superadmin / admin 这两个标识
```

**(d) 业务特判散落各处**

| 位置 | 超管行为 |
| --- | --- |
| `SysMenuServiceImpl.selectMenuTreeByUserId` | 超管走 `selectMenuTreeAll()`，绕过角色关联 |
| `SysMenuServiceImpl.selectMenuList` | 非超管才追加 `inSql(buildMenuByUserSql)` 过滤 |
| `SysUserServiceImpl.checkUserAllowed` | 不允许操作 `userId==1` 的用户（改、删、重置密码全禁） |
| `SysUserServiceImpl.checkUserDataScope` | 超管直接 `return`，跳过数据权限校验 |
| `SysRoleServiceImpl.checkRoleDataScope` | 同上 |
| `SysUserServiceImpl.insertUserRole` | 非超管用户不允许被分配 `role_id==1` |
| `PlusDataPermissionHandler.getSqlSegment` | 超管/租户管理员**直接不拼 where**，看全库数据 |
| `SysUserController:151,270` | 非超管看不到 `superadmin` 角色选项（前端角色下拉过滤） |
| `TenantHelper` | 超管可动态切换租户（`DYNAMIC_TENANT_KEY`），登出时清理动态租户 |

**(e) 与租户耦合**

A 侧超管实际上承担了"平台方"角色：可以跨租户操作、可以动态切租户。`isSuperAdmin() || isTenantAdmin()` 在数据权限处理器里是同一个短路条件。**这套逻辑无法脱离多租户单独理解**。

### 5.2 nest-admin：同款超管，只靠"超管不可操作"兜底

B 侧已按 Java 语义移植超管，涉及三个文件：

| 文件 | 职责 |
| --- | --- |
| `libs/permission/src/permission.constants.ts` | `SUPER_ADMIN_ID` / `SUPER_ADMIN_ROLE_KEY` / `ALL_PERMISSION` / `vagueMatch` / `createMatcher` |
| `libs/permission/src/prisma-permission.source.ts` | 授权源超管短路 |
| `apps/gateway/src/modules/system/super-admin.ts` | 超管账号保护 + 保留角色标识校验 |

**(a) 身份：`userId == 1`**

```ts
export const SUPER_ADMIN_ID = '1';

export function isSuperAdmin(userId: string): boolean {
  return userId === SUPER_ADMIN_ID;
}
```

与 `SystemConstants.SUPER_ADMIN_ID = 1L` 一一对应。只接受规范化十进制字符串，`'01'`、`'1.0'`、`' 1'` 都不算超管。

**(b) 权限注入：`superadmin` + `*:*:*`**

```ts
// PrismaPermissionSource.getAuthorization
if (isSuperAdmin(userId)) {
  return { roles: [SUPER_ADMIN_ROLE_KEY], permissions: [ALL_PERMISSION] };
}
```

对应 `SysPermissionServiceImpl.getRolePermission` / `getMenuPermission` 的超管分支：不读角色菜单关联，直接返回通配。

差异：nest 仍先查一次库校验用户存在且 `status='0'`、`delFlag='0'`，因为它是实时鉴权而非登录快照。**停用或删除后的 1 号用户不会继续拿到通配权限**——这一点比 Java 更严（Java 快照在会话有效期内仍然放行）。

**(c) 通配匹配：Sa-Token `vagueMatch` 等价实现**

```ts
export function vagueMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const body = [...pattern]
    .map((char) => (char === '*' ? '.*' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'u').test(value);
}
```

`*:*:*` 展开为 `^.*:.*:.*$`，与 Sa-Token 行为一致；`system:user:*`、`system:*:list`、`*` 等段级通配同样支持。

与 Java 的唯一差异：Java 只做 `replace("*", ".*")`、不转义其它字符，权限码里出现正则元字符时行为未定义；这里做字面量转义。对正常权限码（字母、数字、`:`、`-`、`_`）结果完全相同。

`createMatcher` 把授权集合编译成「精确 Set + 通配数组」，绝大多数请求只有精确码，仍走 O(1) 命中；只有存在通配码时才线性扫描。

**(d) 业务分支**

| 位置 | 实现 |
| --- | --- |
| `SystemAuthService.menus` | 超管走 `prisma.menu.findMany({ status:'0', menuType:{ in:['M','C'] } })`，对应 `selectMenuTreeAll()`；**不过滤 `visible`**，与 Java 一致 |
| `UserService.update` / `assignRoles` / `remove` | `assertNotSuperAdmin(id)` 直接 409，不进事务 |
| `RoleService.create` / `update` | `assertRoleKeyAvailable` / `assertRoleKeyNotReserved` 拒绝 `superadmin`、`admin`；仅在标识实际变化时判定 |

**(e) 只有一层保护：超管不可操作**

B 侧**没有**"最后一位管理员"这类不变量，也没有 `managementPermissions` 硬编码清单——与 Java 完全一致。

理由：超管不可被改、删、停用，系统就永远存在一个能管全部功能的人。再加一层"权限集合完整性"检查是冗余的，而且那个清单本身就是维护负担（新增管理端点必须手工同步，漏了会静默偏松）。这层在 2026-10-22 被移除。

代价要认：**把某个普通管理员的权限撤光，不会有人拦你。** Java 也是这样。真正兜底的只有"1 号用户永远能动"。

**(f) 与 Java 的刻意偏离（2 处）**

1. **不移植 `role_id == 1` 的角色保护。** Java 的 `checkRoleAllowed` 用 `isSuperAdmin(role.getRoleId())` 把 1 号角色当成超管角色，这依赖初始化数据（`sys_role` 第一行恰好是超管角色）的巧合。nest 的超管由 `userId` 判定，角色表 1 号没有特殊语义；硬搬会让"随便建的第一个角色"永远不可删。只保留 `roleKey` 保留标识校验。
2. **注解侧仍禁止 `*`。** Java 无此校验，但在 `@Permission('*:*:*')` 里写通配等于需求侧绕过全部检查，是纯风险。通配只允许出现在授权数据（`sys_menu.perms`）里。

### 5.3 逐项对照（已对齐）

| 关注点 | RuoYi | nest-admin |
| --- | --- | --- |
| 超管如何识别 | `userId == 1L` | `userId == '1'`（同款） |
| 超管权限来源 | 代码注入 `*:*:*` | 代码注入 `*:*:*`（同款） |
| 超管角色标识 | 注入 `superadmin` | 注入 `superadmin`（同款） |
| 通配匹配语义 | Sa-Token `vagueMatch` | 同语义实现，支持段级通配 |
| 能否更换超管 | **不能**（硬编码 1） | **不能**（同款） |
| 能否删除超管 | 不能（`checkUserAllowed`） | 不能（`assertNotSuperAdmin`） |
| 能否停用超管 | 不能 | 不能 |
| 保留角色标识 | `superadmin` / `admin` 禁占用 | 同（同款） |
| 1 号角色保护 | 有（`role_id == 1` 不可操作） | **无**（刻意偏离，见 5.2(f)） |
| 超管菜单 | `selectMenuTreeAll`，不过滤 `visible` | 同（同款） |
| 越权写操作防护 | 按 ID 特判 | 按 ID 特判（同款，无额外不变量） |
| 并发安全 | 无特殊处理 | `Serializable` 事务 |
| 多租户 | 超管可跨租户、可动态切租户 | 无 |
| 默认管理员 | 初始化 SQL 内置 `admin`（1 号） | **无种子数据**，仍需手工建号 |
| 注解侧通配 | 允许（无校验） | 禁止（更严格） |

### 5.4 移植后的代价与遗留

**新增的代价：**

- **超管无法通过管理端点改自己资料或密码。** 这与 Java 一致（`checkUserAllowed` 同样拦截 1 号用户），Java 靠独立的 `/system/user/profile` 通道解决。nest 目前只有 `GET /auth/profile`，**没有 profile 更新接口**，所以超管当前改不了自己的密码。这是必须补的缺口。
- `1` 成为魔法值，与 Java 一样不可转让。换超管只能改数据库。
- **前端可能看不到按钮。** `GET /auth/profile` 对超管返回 `permissions: ['*:*:*']`。若前端用 `codes.includes(code)` 精确匹配，所有按钮都会判为无权限。需要前端支持通配，或后端在 profile 里为超管下发展开后的权限列表。
- **没有"最后一个管理员"兜底。** 撤光某个管理员的权限不会被拦。与 Java 一致，靠"1 号用户永远能动"兜底。

**RuoYi 侧同样存在、B 侧一并继承的问题：**

- `1L` 散落在多个文件，想做"平台超管 + 租户管理员"两级体系时只能继续加常量和分支。
- 超管绕过一切检查，1 号账号泄露 = 全库泄露，且无法通过"收回权限"降级（它本来就没有可收回的权限行）。
- 超管与"配齐了所有权限的普通角色"在前端无法区分。

**仍然保留的维护点：**

- 无种子数据。空库部署仍要手工建号，超管也不能凭空存在。


---

## 6. 管理面写操作的防护差异

| 场景 | RuoYi | nest-admin |
| --- | --- | --- |
| 修改 / 停用 / 删除超管账号 | 拒绝（`checkUserAllowed`） | 拒绝（`assertNotSuperAdmin`，409，不进事务） |
| 停用仍被用户引用的角色 | **拒绝**：`角色已分配，不能禁用!` | **允许**（与 Java 不同，见下方结论） |
| 删除仍被用户引用的角色 | 拒绝 | 拒绝（`角色仍被用户引用`） |
| 删除仍被角色引用的菜单 | 拒绝 | 拒绝（`菜单仍被角色引用`） |
| 删除仍有子节点的菜单/部门 | 拒绝 | 拒绝 |
| 占用 / 改名保留角色标识 | 拒绝（`superadmin`、`admin`） | 拒绝（同款） |
| 修改自己所属角色 | 拒绝（`不允许修改当前用户角色!`） | 无此限制，靠"不能删除/停用自己"兜底 |
| 角色标识重名 | 业务校验 | 业务校验 + `Serializable` 事务内 `count` |
| 菜单父链成环 | 未见显式校验 | **显式校验**：`checkParents` 沿父链走，检测自引用/后代引用/循环/父节点停用 |
| 菜单类型合法性 | 弱校验 | **强校验**：目录/菜单只能挂目录，按钮只能挂菜单且不能当父节点；`F` 必须有 `perms`，`M` 不能有 `perms` |
| 事务隔离 | 默认（`@Transactional`） | **显式 `Serializable`** |
| 逻辑删除级联 | 删角色清 `role_menu`/`role_dept` | 同，另外删用户时清 `user_role` |
| 在线会话处理 | 改角色时**主动踢人**（仅覆盖角色侧） | **主动踢人**，覆盖用户/角色/菜单共六条写路径 |

**结论：** B 侧在**数据完整性校验**上明显更细（菜单类型/父链/循环/事务隔离），A 侧在**业务状态约束**上更保守（角色有用户就不许禁用）。

---

## 7. 数据权限（dataScope）：一个是真功能，一个只是配置

这是 B 侧**最大的功能缺口**，必须点明。

### 7.1 RuoYi：SQL 层自动注入

`@DataPermission` 注解 + MyBatis 拦截器 + JSqlParser，按角色 `data_scope` 生成 `where` 片段：

```java
// DataScopeType
ALL("1", "", ""),
CUSTOM("2", " #{#deptName} IN ( #{@sdss.getRoleCustom(#user.roleId)} ) ", "1=0"),
DEPT("3", " #{#deptName} = #{#user.deptId} ", "1=0"),
DEPT_AND_CHILD("4", " #{#deptName} IN ( #{@sdss.getDeptAndChild(#user.deptId)} )", "1=0"),
SELF("5", " #{#userName} = #{#user.userId} ", "1=0"),
DEPT_AND_CHILD_OR_SELF("6", " ... ", "1=0");
```

特点：
- 业务 SQL 完全不感知数据权限，框架在拦截器里改写。
- 多角色时 SELECT 用 `OR` 合并、UPDATE/DELETE 用 `AND` 合并。
- 自定义范围走 `sdss.getRoleCustom(roleId)` 查 `sys_role_dept`，带 Spring Cache。
- **超管和租户管理员直接 `return where`，不拼任何条件。**

### 7.2 nest-admin：只存不用

```ts
// prisma/models/role.prisma
/// 数据范围：1 全部、2 自定义、3 本部门、4 本部门及以下、5 本人、6 部门及以下或本人
dataScope String @default("5") @map("data_scope") @db.Char(1)
```

`role.service.ts` 的 `dataScope()` 完整实现了配置写入（校验 `dataScope=2` 必须有部门、非 2 不能带部门、部门必须启用、事务内全量替换 `sys_role_dept`）。

**但是：全代码库搜 `dataScope`，除了角色配置模块自身，没有任何一处查询使用它。** `dept.service.ts`、`user.service.ts`、`menu.service.ts` 全部是 `findMany` 无数据范围过滤。B 侧文档也承认了这点：

> 此阶段提供范围配置，不将范围过滤静默应用到没有业务归属字段的模型；实际业务读写隔离属于阶段 6。

**判断：**
- 对纯 RBAC 骨架来说，先把配置面做完、执行面后置，是可接受的阶段性取舍。
- 但如果直接拿这套去接业务表，**必须知道现在 `dataScope` 是个纯装饰字段**——普通角色查用户列表能看到全公司用户。这是个真实越权风险，不能默认它生效。
- 移植成本不低：Prisma 没有 MyBatis 那种 SQL 拦截器，要么用 `$extends` 查询扩展给每个业务模型注入 `where`，要么在 service 层显式拼 `deptId in (...)`。前者需要一套"哪些模型有 deptId 归属"的元数据约定。

---

## 8. 菜单/路由下发

| | RuoYi | nest-admin |
| --- | --- | --- |
| 接口 | `GET /getRouters` | `GET /auth/menus` |
| 超管分支 | 有：`selectMenuTreeAll()` 返回全表 | 有：`superAdminMenus()`，条件与 Java 完全一致 |
| 过滤条件（普通用户） | `menuType in (M,C)` + `status='0'` + 角色关联 | `menuType in (M,C)` + `status='0'` + `visible='0'` + 角色关联 |
| 过滤条件（超管） | `menuType in (M,C)` + `status='0'`，**不过滤 `visible`** | 同（`status='0'` + `menuType in (M,C)`，不过滤 `visible`） |
| 树构建 | `getChildPerms` 递归 | 先按 `orderNum`/`menuId` 排序，再一次遍历挂载；**只返回根可达节点**，缺失父节点/失效父分支/环都不会进响应 |
| 按钮权限 | 单独走 `getInfo` 的 `permissions` | 同，`GET /auth/profile` 返回 `permissions` 数组；超管为 `['*:*:*']` |
| 缓存头 | 无特殊处理 | `Cache-Control: no-store` |

B 侧的"只返回根可达节点"是一个细节上的正确性改进：RuoYi 如果数据里出现孤儿子菜单（父节点被删），可能出现菜单丢失但权限仍生效的诡异状态。

---

## 9. 多租户对 RBAC 的影响（A 侧有，B 侧无）

用户已明确 B 侧不需要多租户，但要说清 A 侧因此多了什么，避免以后回补时踩坑：

1. **权限查询全部带租户条件。** `TenantEntity` + `PlusTenantLineHandler` 自动给所有 SQL 加 `tenant_id = ?`，`sys_user`/`sys_role`/`sys_menu` 都在其中。
2. **角色体系分两级。** `superadmin`（平台超管，跨租户）+ `admin`（租户管理员，仅本租户）。`LoginHelper.isTenantAdmin()` 就是判断角色集合里有没有 `admin`。
3. **数据权限里租户管理员也跳过过滤**——注意这个语义：租户管理员在本租户内等于"看全部"，而不是"看自己部门"。
4. **超管可动态切租户。** `TenantHelper.dynamic(tenantId, () -> ...)`，切租户状态存在 Redis（`dynamicTenant:{userId}`），登出时清理。这是 A 侧超管最"上帝"的地方。
5. **缓存 key 带租户前缀。** `TenantKeyPrefixHandler` 给 Redis key 加租户维度，避免跨租户串权限。

**B 侧去掉租户后的简化：** 没有 `tenant_id` 列、没有租户上下文、没有动态切换、缓存 key 不用加前缀、超管/租户管理员两级塌缩成"管理员"一级。这是 B 侧代码量显著小于 A 侧的主要原因之一。

---

## 10. 安全面横向比较

| 风险点 | RuoYi | nest-admin |
| --- | --- | --- |
| 未标注权限的接口 | 默认仅需登录（fail-open） | **默认 403**（fail-closed） |
| 通配权限 | 支持 `*:*:*`，且是超管核心机制 | 支持同款 `vagueMatch` 语义；**注解侧禁止**、授权数据侧允许 |
| 权限码注入 | `perms` 直接参与匹配，无 trim 校验 | 必须非空、无首尾空白，否则不计入；含 `*` 的按模式解释 |
| 普通角色被授予 `*:*:*` | 等于提权为全权限 | 同（移植后行为一致，属已知风险） |
| 账号枚举 | 账号不存在/密码错返回不同提示 | 无匹配账号也执行同参数 Argon2id 校验（`dummyPasswordHash`），统一返回"账号或密码错误" |
| 同名账号 | 依赖唯一索引 | `take: 2` 检测重名，多行即拒绝登录 |
| Token 重放 | Sa-Token 标准机制 | refresh token **轮换 + 重放检测**：命中已用摘要则撤销整个会话（Lua 脚本原子执行） |
| 密码哈希 | BCrypt | Argon2id |
| 越权改自己权限 | 拒绝改自己角色 | 不禁止改自己角色，但禁止删除/停用自己 |
| 权限变更生效 | 需踢人或重登（且用户角色/菜单变更不踢） | 需踢人（覆盖全部六条写路径），用户需重新登录 |
| 踢人失败 | 抛异常，业务已提交 | 只记 `warn`，不阻断响应 |
| 超管账号被改/删/停用 | 拒绝 | 拒绝（同款） |
| 数据越权 | 由 dataScope 拦截器覆盖 | **无覆盖**（dataScope 未执行） |

**结论：** B 侧在认证与会话安全上更现代（Argon2id、refresh 轮换、防枚举、fail-closed）；A 侧在数据级越权上有完整方案而 B 侧还没有。**两边的强项不重叠。** 超管与通配权限已对齐后，B 侧在这一点上不再有"更安全"的优势——它继承了与 Java 相同的上帝账号风险。

---

## 11. 后续对齐建议

按优先级：

1. **补数据权限执行层（高优）。** 否则任何接入业务表的模块都是全量可见。做法：给 Prisma 加一个 `dataScopeExtension`，约定"含 `deptId` 字段的模型自动注入范围条件"，超管跳过。同时把 `DataScopeType` 的 6 种语义原样搬过来，别自己发明。**注意超管跳过条件要和 `isSuperAdmin` 共用同一处判定，避免两套逻辑漂移。**
2. **补 profile 更新接口（高优）。** 超管被 `assertNotSuperAdmin` 锁死，无法通过管理端点改自己密码。需要独立的 `PATCH /auth/profile`（或 `/system/user/profile`）通道，且该通道不做超管拦截——这与 Java 的 `/system/user/profile` 设计一致。
3. **确认前端通配兼容（高优）。** 超管 `profile.permissions` 是 `['*:*:*']`。前端若精确匹配会导致按钮全隐藏。二选一：前端 `hasAccessByCodes` 支持通配，或后端对超管下发按菜单展开的完整权限码列表。
4. **补 bootstrap 脚本（中优）。** 空库部署需要能一键创建"1 号超管 + 基础菜单"。超管身份是硬编码的，所以种子脚本必须保证 `user_id = 1` 那行存在。
5. **给踢人调用点加回归保护（中优）。** 快照模型下漏一个调用点就是静默的权限滞留，而目前只有 `RoleService.assignMenus` 有单测断言。建议在 `system-management.spec.ts` 里为六条路径各补一条 `revokeUserSessions` 断言，或抽一个"写操作 → 应踢人"的矩阵测试。
6. **补"角色有用户时禁止禁用"的可选约束（低优）。** 这是 A 侧的保守策略，B 侧当前允许禁用，行为差异需要产品确认。
7. **不要移植 `role_id == 1` 的角色保护。** 见 5.2(f)，那是 Java 依赖初始化数据的耦合，在 nest 里没有语义。
8. **在线用户列表（可选）。** 现在只有底层 `revokeUserSessions`，没有 Java `SysUserOnlineController` 那种"查看在线会话 / 单个踢出"的管理接口。需要时基于 `auth:user:{userId}` 索引扩展即可。

---

## 12. 附录：关键文件索引

**RuoYi-Vue-Plus-5.X**

| 关注点 | 文件 |
| --- | --- |
| 超管 ID 常量 | `ruoyi-common/ruoyi-common-core/.../constant/SystemConstants.java` |
| 超管/租户管理员判定 | `ruoyi-common/ruoyi-common-satoken/.../utils/LoginHelper.java` |
| 权限源（会话快照） | `ruoyi-common/ruoyi-common-satoken/.../service/SaPermissionImpl.java` |
| 超管权限注入 | `ruoyi-modules/ruoyi-system/.../service/impl/SysPermissionServiceImpl.java` |
| 角色保留标识校验 | `ruoyi-modules/ruoyi-system/.../service/impl/SysRoleServiceImpl.java` |
| 用户超管保护 | `ruoyi-modules/ruoyi-system/.../service/impl/SysUserServiceImpl.java` |
| 菜单超管分支 | `ruoyi-modules/ruoyi-system/.../service/impl/SysMenuServiceImpl.java` |
| 数据权限 SQL 改写 | `ruoyi-common/ruoyi-common-mybatis/.../handler/PlusDataPermissionHandler.java` |
| 数据范围枚举 | `ruoyi-common/ruoyi-common-mybatis/.../enums/DataScopeType.java` |
| 登录权限快照 | `ruoyi-admin/.../web/service/SysLoginService.java` |
| 动态租户 | `ruoyi-common/ruoyi-common-tenant/.../helper/TenantHelper.java` |

**nest-admin**

| 关注点 | 文件 |
| --- | --- |
| **超管常量与通配匹配** | `libs/permission/src/permission.constants.ts`（`SUPER_ADMIN_ID`、`SUPER_ADMIN_ROLE_KEY`、`ALL_PERMISSION`、`vagueMatch`、`createMatcher`） |
| 权限装饰器 | `libs/permission/src/permission.decorator.ts` |
| 权限守卫（读快照） | `libs/permission/src/permission.guard.ts` |
| 权限判定（精确 + 通配） | `libs/permission/src/permission.service.ts`（`snapshot` 登录期 / `isAllowed` 运行期） |
| 授权快照来源 | `libs/permission/src/prisma-permission.source.ts` |
| **会话与快照载体** | `libs/auth/src/auth.types.ts`（`AuthSnapshot`）、`libs/auth/src/session.store.ts`（`AuthSession`、`revokeUser`）、`libs/auth/src/auth.service.ts`（`createSession`、`authenticate`、`revokeUserSessions`） |
| **踢人入口** | `apps/gateway/src/modules/system/session-invalidation.ts`（`revokeSessions`、`usersOfRole`、`usersOfMenu`） |
| **超管写保护** | `apps/gateway/src/modules/system/super-admin.ts`（`assertNotSuperAdmin`、`assertRoleKeyAvailable`、`assertRoleKeyNotReserved`） |
| 超管菜单分支 | `apps/gateway/src/modules/system/auth/auth.service.ts`（`superAdminMenus`） |
| 认证/会话 | `libs/auth/src/auth.service.ts`、`libs/auth/src/session.store.ts` |
| 角色管理 | `apps/gateway/src/modules/system/role/role.service.ts` |
| 用户管理 | `apps/gateway/src/modules/system/user/user.service.ts` |
| 菜单管理 | `apps/gateway/src/modules/system/menu/menu.service.ts` |
| 部门管理 | `apps/gateway/src/modules/system/dept/dept.service.ts` |
| 数据模型 | `prisma/models/*.prisma` |
| 设计意图 | `docs/rbac-phase1~5-*.md` |
| 相关测试 | `libs/permission/src/permission.constants.spec.ts`、`prisma-permission.source.spec.ts`、`permission.service.spec.ts`、`apps/gateway/src/modules/system/administrator.spec.ts` |

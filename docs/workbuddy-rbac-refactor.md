# WorkBuddy RBAC 全量重构方案

> **立场**：推翻重来。不写兼容层，不留旧表，不保留旧权限码，不做双写/影子/灰度共存。
> **基线**：`nest-admin` 当前工作区（NestJS 12 + Fastify + Prisma 7 + PostgreSQL + Redis），文中所有旧系统结论均逐行核对过源码。
> **上游依据**：`docs/rbac-rearchitecture.md`（架构提案）。本文是它的执行版，且**砍掉了提案里所有迁移期妥协**。
> **读者**：执行重构的工程师、评审者、配合改造的前端负责人。

---

## 0. 这次重构的立场

### 0.1 明确不做的事

| 不做 | 理由 |
| --- | --- |
| 双写 `sys_*` + `iam_*` | 两套事实来源必然漂移，对账脚本本身就是新的技术债 |
| 回填 + 对账 | 一次性 ETL 就够，不需要长期并跑 |
| 影子判定 / 新旧结果比对 | 旧引擎的语义本身就是错的（默认放行），比对它没有意义 |
| 权限码别名表 | 旧码的 `add/edit/query` 命名本来就要废，直接换 |
| `@Permission` 兼容适配层 | 31 处注解，一次改完比维护两套 DSL 便宜 |
| 保留旧表 / 旧列 | 保留 = 有人会去读它 = 新的耦合 |
| 按用户灰度、header 开关 | 两套代码路径同时在线，测试矩阵翻倍 |
| 保留旧 `/auth/menus` | 契约直接换，前端同一个窗口改完 |

### 0.2 必须接受的代价（4 条，写清楚免得后面扯皮）

1. **停机窗口**：切换当天需要 30–60 分钟只读/停机。不做双写就没有热切换的可能。
2. **全员重新登录**：会话结构彻底改变，存量 Redis 会话全部作废。这不是缺陷，是"不留兼容分支"的直接结果。
3. **前端必须同步发版**：字段名、枚举值、`/auth/menus` → `/auth/routes` 都变。前后端必须同一发布窗口。
4. **回滚只有一条路**：从备份恢复数据库 + 回退代码版本。没有"开关切回去"。

### 0.3 为什么值得

兼容式重构需要 8 个批次、9 周、双写层、别名表、影子比对、5 个开关。全量重构需要 5 个阶段、6 周、一次停机，**但代码库里不会留下任何过渡期产物**。

关键判断：这个项目的旧系统只有 5000 行量级（`libs/auth` 229 行 + `libs/permission` 约 300 行 + 5 个 system service 1450 行），重构成本主要在**设计**而不是**代码量**。给 5000 行代码配一套双写 + 对账 + 灰度，是给 30 平米的房子装电梯。

---

## 1. 为什么小修不行

不是缺陷清单，是"为什么补丁解决不了"的结构性理由。每条都对应旧系统的物理位置。

### 1.1 `sys_menu` 一表三职，导航被权限绑死

`menu.prisma:42` 的 `perms` 列让"按钮权限"必须造一条 `menuType='F'` 的菜单行；`menu.service.ts:174-175` 又规定"菜单被角色引用就不能删"。

后果：**权限点的生命周期被导航结构的生命周期绑架**。想加一个"导出"权限，得先造一条菜单；想删一个废弃权限，得先解绑所有角色。这不是 bug，是建模错误，只能换表。

### 1.2 两条链路的安全基线相反

| 链路 | 基线 | 证据 |
| --- | --- | --- |
| 功能权限 | **默认拒绝**：控制器没写注解就是 403 | `permission.guard.ts:32-37` |
| 数据范围 | **默认放行**：`withDataScope` 是纯函数，service 忘了调用就全量可见 | `data-scope.ts:180`；14 处调用点全靠自觉 |

一条默认拒绝、一条默认放行，任何"补一下"的方案都只能靠 code review 保证。要变成默认拒绝，必须让"访问数据"这件事**没有绕过入口**——即仓储层强制。

### 1.3 授权链没有约束，存在真实提权路径

`role.service.ts:254-260` 的 `assignMenus` 只校验"菜单存在且启用"，不校验"授予者是否拥有该权限"；`user.service.ts:243-245` 只挡住"改自己的角色"。

组合起来：拥有 `system:role:assignMenus` 的部门管理员 → 造一个挂着任意权限的新角色 → 用 `system:user:assignRoles` 分给同部门同事 → 以同事身份登录。**这是一条完整的、可复现的提权链**，不是理论风险。

修它需要 `roles.level`（角色等级）这个字段，而旧表没有。

### 1.4 每请求查库，且查询形状随业务变化

`auth.service.ts:165` 每次 `authenticate` 调 `loadUser`（`roles → role → depts` 嵌套），`prisma-permission.source.ts:36` 登录时另查一次菜单。前者每请求都跑。

旧设计"数据范围不进快照"是个正确取舍（改了立即生效、不用踢人），但它把成本压在了最热的路径上。新设计要同时拿到"即时生效"和"零查询"——靠版本号，不是靠取舍。

### 1.5 状态字段用字符串，类型系统全程兜不住

`status String @db.Char(1)` 默认 `'0'`、`delFlag String @db.Char(1)` 三态（`'0'` 正常 / `'2'` 删除）。全仓 60+ 处 `=== '0'` 判断，写错一个字符就是"查询结果莫名少一半"，且编译期零提示。

`role.prisma:11` 的注释写的是 RuoYi 编码（2 自定义 / 5 本人 / 6 部门及以下或本人），实现是（2 本部门 / 3 本部门及以下 / 4 仅本人 / 5 自定义，**无 6**）——`data-scope.ts:21-32`。注释和实现不一致到这种程度，就是因为类型系统没有话语权。

### 1.6 RuoYi 语义渗透到每一层

`perms` / `roleKey` / `dataScope` 单值 / `menuCheckStrictly` / `isFrame` / `query`——这些名字不是本项目的语言，是移植带来的。每多一层转述，就多一处理解成本。

全量重构的价值之一就是：**把 RuoYi 的词汇从代码里清出去**，让表名、字段名、权限码都说本项目的语言。

---

## 2. 目标系统：领域划分

```
┌──────────────────────────────────────────────────────────┐
│  gateway（控制器 / DTO / 全局管道）                        │
└───────────┬──────────────────────────┬───────────────────┘
            │                          │
┌───────────▼──────────┐  ┌────────────▼──────────────────┐
│  identity（认证）     │  │  access（授权）                │
│  登录/会话/凭据/锁定   │  │  判定引擎/快照/数据范围/授予约束 │
└───────────┬──────────┘  └────────────┬──────────────────┘
            │                          │
            └──────────┬───────────────┘
                       │
            ┌──────────▼──────────┐
            │  organization（组织） │
            │  用户/部门/岗位       │
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │  persistence         │
            │  Prisma / 仓储基类    │
            └─────────────────────┘
```

四个限界上下文，依赖严格单向：

- **identity** 只依赖 persistence。不知道权限是什么，只回答"你是谁"。
- **access** 依赖 identity（要读会话）+ persistence。回答"你能做什么、能看哪些数据"。
- **organization** 依赖 persistence + access（要受数据范围约束）。
- **gateway** 依赖全部，只做编排。

`access` 不允许反向依赖 `organization`——授权不能知道"用户表长什么样"，只能知道"某个 actor 有什么权限、什么范围"。

---

## 3. 数据模型（全新）

### 3.1 三个命名决策

**决策 1：丢掉 `sys_` 前缀，改用复数无前缀表名。**

理由有三：
- 旧表全部 DROP，不存在"前缀区分新旧"的需要。
- `sys_` 是 RuoYi 的命名，本项目不是 RuoYi。
- 切换窗口内一眼能看出哪张是新表（`users` vs `sys_user`）。

表名：`users` `depts` `dept_closure` `posts` `user_posts` `roles` `permissions` `role_permissions` `user_roles` `role_scopes` `role_scope_depts` `routes` `role_routes` `audit_logs`。

**决策 2：`delFlag Char(1)` → `deletedAt Timestamptz?`。**

软删除用时间戳而不是标志位，好处是"什么时候删的"免费拿到，且 `deletedAt IS NULL` 是唯一的"存在"判据，不会出现 `'0'/'2'` 之外的值。

**代价（必须处理）**：唯一约束要改成部分索引，Prisma 表达不了，写进迁移 SQL。

```sql
-- Prisma 的 @unique 是全表唯一，会让"已删除的 admin"永久占用 admin 这个名字
CREATE UNIQUE INDEX uk_users_user_name ON users (user_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uk_roles_role_key  ON roles  (role_key)  WHERE deleted_at IS NULL;
```

**决策 3：`status Char(1)` → Prisma enum。**

```prisma
enum RecordStatus { ACTIVE DISABLED }
```

全仓 `=== '0'` 变成 `=== 'ACTIVE'`，拼错编译期就报。

**不做的改动**：`sex Char(1)` 保留。它是纯展示字段，改枚举对安全、性能、可维护性都无收益，只会增加前端改动面。**重构要推翻结构，不是推翻一切。**

### 3.2 Schema

`prisma/schema.prisma` 只放 `datasource` / `generator` / 枚举；模型按上下文拆文件，沿用现有 `prisma/models/` 的分文件习惯。

```prisma
// prisma/models/enums.prisma

/// 通用记录状态。替代旧的 status Char(1)。
enum RecordStatus {
  ACTIVE
  DISABLED

  @@map("record_status")
}

/// 权限效果。DENY 优先于 ALLOW。
enum PermissionEffect {
  ALLOW
  DENY

  @@map("permission_effect")
}

/// 数据范围类型。
enum ScopeType {
  /// 全部数据。
  ALL
  /// 本部门。
  DEPT
  /// 本部门及以下。
  DEPT_AND_CHILD
  /// 仅本人（只有带 owner 列的模型支持）。
  SELF
  /// 自定义部门集合。
  CUSTOM

  @@map("scope_type")
}

/// 路由类型。替代旧的 menuType M/C/F。
enum RouteType {
  DIR
  PAGE
  LINK

  @@map("route_type")
}
```

```prisma
// prisma/models/user.prisma

/// 用户。
model User {
  userId            BigInt       @id @default(autoincrement()) @map("user_id")
  userName          String       @map("user_name") @db.VarChar(64)
  nickName          String       @map("nick_name") @db.VarChar(100)
  email             String?      @db.VarChar(254)
  phoneNumber       String?      @map("phone_number") @db.VarChar(32)
  /// 保留 char(1)：纯展示字段，改枚举无收益。
  sex               String       @default("2") @db.Char(1)
  passwordHash      String       @map("password_hash") @db.VarChar(255)

  deptId            BigInt?      @map("dept_id")
  status            RecordStatus @default(ACTIVE)

  /// 授权快照版本号。任何影响该用户授权的变更都要 +1。
  authzVersion      Int          @default(0) @map("authz_version")

  /// 连续登录失败次数，成功登录清零。
  failedCount       Int          @default(0) @map("failed_count")
  /// 锁定到期时间。null 表示未锁定。
  lockedUntil       DateTime?    @map("locked_until") @db.Timestamptz(6)
  /// 密码最后修改时间，用于"改密后其他会话立即失效"。
  passwordChangedAt DateTime     @default(now()) @map("password_changed_at") @db.Timestamptz(6)

  loginIp           String?      @map("login_ip") @db.VarChar(128)
  loginAt           DateTime?    @map("login_at") @db.Timestamptz(6)

  remark            String?      @db.VarChar(500)
  createdAt         DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt         DateTime?    @map("deleted_at") @db.Timestamptz(6)

  dept  Dept?      @relation(fields: [deptId], references: [deptId])
  roles UserRole[]
  posts UserPost[]

  @@index([deptId])
  @@index([deletedAt])
  @@map("users")
}
```

```prisma
// prisma/models/org.prisma

/// 部门。
model Dept {
  deptId    BigInt       @id @default(autoincrement()) @map("dept_id")
  parentId  BigInt       @default(0) @map("parent_id")
  deptName  String       @map("dept_name") @db.VarChar(64)
  orderNum  Int          @default(0) @map("order_num")
  leaderId  BigInt?      @map("leader_id")
  status    RecordStatus @default(ACTIVE)
  remark    String?      @db.VarChar(500)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt DateTime?    @map("deleted_at") @db.Timestamptz(6)

  users     User[]
  children  Dept[]         @relation("DeptTree")
  parent    Dept?          @relation("DeptTree", fields: [parentId], references: [deptId])
  closures  DeptClosure[]  @relation("Ancestor")
  closureOf DeptClosure[]  @relation("Descendant")
  roleScope RoleScopeDept[]

  @@index([parentId])
  @@index([deletedAt])
  @@map("depts")
}

/// 部门闭包表：任意两节点的祖孙关系与深度。
/// 唯一维护点是 DeptRepository，禁止其他位置直接写。
model DeptClosure {
  ancestorId   BigInt @map("ancestor_id")
  descendantId BigInt @map("descendant_id")
  /// 0 表示自身。
  depth        Int    @map("depth")

  ancestor   Dept @relation("Ancestor", fields: [ancestorId], references: [deptId], onDelete: Cascade)
  descendant Dept @relation("Descendant", fields: [descendantId], references: [deptId], onDelete: Cascade)

  @@id([ancestorId, descendantId])
  @@index([descendantId])
  @@map("dept_closure")
}

/// 岗位。不参与授权计算，只是用户属性。
model Post {
  postId    BigInt       @id @default(autoincrement()) @map("post_id")
  deptId    BigInt?      @map("dept_id")
  postCode  String       @map("post_code") @db.VarChar(64)
  postName  String       @map("post_name") @db.VarChar(64)
  orderNum  Int          @default(0) @map("order_num")
  status    RecordStatus @default(ACTIVE)
  remark    String?      @db.VarChar(500)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt DateTime?    @map("deleted_at") @db.Timestamptz(6)

  users UserPost[]

  @@index([deptId])
  @@map("posts")
}
```

```prisma
// prisma/models/access.prisma

/// 角色。
model Role {
  roleId    BigInt       @id @default(autoincrement()) @map("role_id")
  roleKey   String       @map("role_key") @db.VarChar(64)
  roleName  String       @map("role_name") @db.VarChar(64)
  /// 角色等级：数字越小等级越高。授予约束的核心依据。
  level     Int          @default(100)
  orderNum  Int          @default(0) @map("order_num")
  status    RecordStatus @default(ACTIVE)
  remark    String?      @db.VarChar(500)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt DateTime?    @map("deleted_at") @db.Timestamptz(6)

  permissions RolePermission[]
  routes      RoleRoute[]
  scopes      RoleScope[]
  users       UserRole[]

  @@index([deletedAt])
  @@map("roles")
}

/// 权限点。与导航完全解耦：没有 parentId，没有菜单语义。
model Permission {
  permId    BigInt       @id @default(autoincrement()) @map("perm_id")
  /// 唯一权限码，形如 system:user:create。DB 层禁止通配符。
  code      String       @unique @db.VarChar(100)
  /// 分组用的模块名，如 system。仅用于 UI 归类，不参与判定。
  module    String       @db.VarChar(64)
  resource  String       @db.VarChar(64)
  action    String       @db.VarChar(32)
  name      String       @db.VarChar(100)
  /// 敏感操作标记，供审计与二次确认使用。
  riskLevel String       @default("LOW") @map("risk_level") @db.VarChar(16)
  status    RecordStatus @default(ACTIVE)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)

  roles RolePermission[]

  @@index([module])
  @@map("permissions")
}

/// 角色-权限。effect 为 DENY 时优先于任何 ALLOW。
model RolePermission {
  roleId BigInt           @map("role_id")
  permId BigInt           @map("perm_id")
  effect PermissionEffect @default(ALLOW)

  role       Role       @relation(fields: [roleId], references: [roleId], onDelete: Cascade)
  permission Permission @relation(fields: [permId], references: [permId], onDelete: Cascade)

  @@id([roleId, permId])
  @@index([permId])
  @@map("role_permissions")
}

/// 用户-角色。
model UserRole {
  userId    BigInt    @map("user_id")
  roleId    BigInt    @map("role_id")
  grantedBy BigInt?   @map("granted_by")
  grantedAt DateTime  @default(now()) @map("granted_at") @db.Timestamptz(6)
  /// 临时授权到期时间；null 表示长期。
  validTo   DateTime? @map("valid_to") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [userId], onDelete: Cascade)
  role Role @relation(fields: [roleId], references: [roleId], onDelete: Cascade)

  @@id([userId, roleId])
  @@index([roleId])
  @@map("user_roles")
}

/// 数据范围：(角色, 资源) 一行。
/// 与旧系统最大的结构差异——旧系统是 Role.dataScope 单值管所有资源。
model RoleScope {
  roleId    BigInt    @map("role_id")
  /// 资源标识，与 Permission.resource 同命名空间；'*' 表示所有资源的默认范围。
  resource  String    @db.VarChar(64)
  scopeType ScopeType @map("scope_type")

  role  Role            @relation(fields: [roleId], references: [roleId], onDelete: Cascade)
  depts RoleScopeDept[]

  @@id([roleId, resource])
  @@map("role_scopes")
}

/// 自定义范围的部门明细，仅 scopeType = CUSTOM 时有行。
model RoleScopeDept {
  roleId   BigInt @map("role_id")
  resource String @db.VarChar(64)
  deptId   BigInt @map("dept_id")

  scope RoleScope @relation(fields: [roleId, resource], references: [roleId, resource], onDelete: Cascade)
  dept  Dept      @relation(fields: [deptId], references: [deptId], onDelete: Cascade)

  @@id([roleId, resource, deptId])
  @@index([deptId])
  @@map("role_scope_depts")
}

/// 用户-岗位。
model UserPost {
  userId BigInt @map("user_id")
  postId BigInt @map("post_id")

  user User @relation(fields: [userId], references: [userId], onDelete: Cascade)
  post Post @relation(fields: [postId], references: [postId], onDelete: Cascade)

  @@id([userId, postId])
  @@index([postId])
  @@map("user_posts")
}
```

```prisma
// prisma/models/route.prisma

/// 前端路由。只有导航语义，没有任何权限字段。
model Route {
  routeId   BigInt       @id @default(autoincrement()) @map("route_id")
  parentId  BigInt       @default(0) @map("parent_id")
  /// 路由名，前端 keep-alive 与权限无关的唯一标识。
  name      String       @db.VarChar(100)
  path      String       @db.VarChar(200)
  component String?      @db.VarChar(255)
  redirect  String?      @db.VarChar(200)
  routeType RouteType    @default(PAGE) @map("route_type")
  icon      String?      @db.VarChar(100)
  orderNum  Int          @default(0) @map("order_num")
  /// 是否在导航中显示。
  visible   Boolean      @default(true)
  /// 是否 keep-alive。
  keepAlive Boolean      @default(false) @map("keep_alive")
  /// 外链地址，仅 routeType = LINK 时有值。
  external  String?      @db.VarChar(500)
  status    RecordStatus @default(ACTIVE)
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt DateTime?    @map("deleted_at") @db.Timestamptz(6)

  roles RoleRoute[]

  @@index([parentId])
  @@map("routes")
}

/// 角色-路由。只影响导航可见性，不影响权限判定。
model RoleRoute {
  roleId  BigInt @map("role_id")
  routeId BigInt @map("route_id")

  role  Role  @relation(fields: [roleId], references: [roleId], onDelete: Cascade)
  route Route @relation(fields: [routeId], references: [routeId], onDelete: Cascade)

  @@id([roleId, routeId])
  @@index([routeId])
  @@map("role_routes")
}
```

```prisma
// prisma/models/audit.prisma

/// 授权变更审计。唯一写入方是 AuditService，必须与业务同事务。
model AuditLog {
  id         BigInt   @id @default(autoincrement())
  /// 操作人。null 表示系统操作。
  actorId    BigInt?  @map("actor_id")
  /// 操作类型，如 role.assign_permissions。
  action     String   @db.VarChar(64)
  targetType String   @map("target_type") @db.VarChar(64)
  targetId   String?  @map("target_id") @db.VarChar(64)
  before     Json?
  after      Json?
  ip         String?  @db.VarChar(128)
  userAgent  String?  @map("user_agent") @db.VarChar(500)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([actorId])
  @@index([createdAt])
  @@index([targetType, targetId])
  @@map("audit_logs")
}
```

### 3.3 迁移期必须补的 SQL

Prisma 表达不了、但模型正确性依赖的约束，全部写进迁移文件：

```sql
-- 1. 软删除 + 唯一约束：部分索引
CREATE UNIQUE INDEX uk_users_user_name ON users (user_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uk_roles_role_key  ON roles  (role_key)  WHERE deleted_at IS NULL;

-- 2. 权限码格式与禁用通配符
ALTER TABLE permissions ADD CONSTRAINT chk_permission_code_format
  CHECK (code ~ '^[a-z][a-z0-9]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$');
ALTER TABLE permissions ADD CONSTRAINT chk_permission_code_no_wildcard
  CHECK (code NOT LIKE '%*%');

-- 3. 角色等级非负
ALTER TABLE roles ADD CONSTRAINT chk_role_level_non_negative CHECK (level >= 0);

-- 4. 闭包表：自身深度为 0，非自身深度 > 0
ALTER TABLE dept_closure ADD CONSTRAINT chk_closure_depth
  CHECK ((ancestor_id = descendant_id AND depth = 0) OR (ancestor_id <> descendant_id AND depth > 0));

-- 5. CUSTOM 范围必须有部门明细（应用层事务保证，DB 层触发器兜底）
CREATE OR REPLACE FUNCTION check_custom_scope_has_dept() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM role_scopes s
    WHERE s.scope_type = 'CUSTOM'
      AND NOT EXISTS (
        SELECT 1 FROM role_scope_depts d
        WHERE d.role_id = s.role_id AND d.resource = s.resource
      )
  ) THEN
    RAISE EXCEPTION 'CUSTOM 范围缺少部门明细';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_custom_scope_has_dept
  AFTER INSERT OR UPDATE ON role_scopes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_custom_scope_has_dept();
```

### 3.4 删掉的旧列（不再有对应物）

| 旧列 | 为什么删 |
| --- | --- |
| `sys_menu.perms` | 权限码独立成 `permissions.code` |
| `sys_menu.menu_type = 'F'` | 按钮不是菜单，不存在"按钮行" |
| `sys_role.data_scope` | 换成 `role_scopes` 多行 |
| `sys_role.menu_check_strictly` / `dept_check_strictly` | 树联动是前端渲染问题，不该由后端裁剪返回值 |
| `sys_menu.query` | 路由参数塞进 path 即可 |
| `sys_menu.is_frame` / `is_cache` | 换成 `route_type` / `keepAlive` 布尔 |
| `sys_user.del_flag` 三态 | 换成 `deletedAt` |
| `sys_login_log` / `sys_oper_log` | 从未有写入方（全仓 grep `loginLog\|operLog` 零结果），直接不存在 |

> `menuCheckStrictly` 的删除顺带干掉了两个方法：`role.service.ts:146-164` 的 `dropParentMenus` / `dropParentDepts`。新契约**永远返回完整的已授权集合**，父节点是否半选由前端树组件自己推导。

---

## 4. 认证（identity）

### 4.1 会话模型

Redis 里的会话只保留"身份 + 版本"，**不再存角色和权限**（它们进快照缓存）：

```ts
// libs/identity/src/session/session.types.ts
export interface Session {
  readonly userId: string;
  readonly refreshHash: string;
  /** 毫秒时间戳，刷新时不变。 */
  readonly expiresAt: number;
  /** 登录时读到的 authzVersion，用于判断快照是否需要重建。 */
  readonly authzVersion: number;
  /** 密码最后修改时间，改密后其他会话自动失效。 */
  readonly passwordChangedAt: number;
  readonly ip: string;
  readonly userAgent: string;
  readonly createdAt: number;
}
```

`passwordChangedAt` 是关键补充：旧系统改密码不踢会话（只有 `status` 变更才 revoke，`user.service.ts:232`），等于改密无效。新设计让每个请求比对一次，改密即全端下线，不需要额外调用。

### 4.2 登录流程

```
POST /auth/login { userName, password }
  ↓
1. 按 userName 精确查（部分唯一索引保证最多一条）
2. 校验 lockedUntil：未到期直接 423
3. Argon2id 校验；失败 → failedCount + 1，达阈值则 lockedUntil = now + 15min，返回 401
4. 成功 → failedCount 清零，写 loginIp / loginAt
5. 读 authzVersion → 写会话（Redis，TTL = refreshTokenTtl）
6. 签发 accessToken（sub / sid / jti / iat / exp）+ refreshToken（sid.random）
  ↓
{ accessToken, refreshToken, tokenType, expiresIn, user: { userId, userName, nickName, deptId } }
```

**与旧实现的三处差异**：

| 差异 | 旧 | 新 | 为什么 |
| --- | --- | --- | --- |
| 账号查询 | `findMany take: 2` 兜"可能重名"（`auth.service.ts:56-73`） | `findUnique` | 唯一索引保证不存在重名；兜底逻辑是缺陷的补丁 |
| 失败计数 | 无 | `failedCount` + `lockedUntil` | 旧系统可无限撞库 |
| 快照计算 | 登录时算 `roles/permissions` 写进会话 | 登录只记 `authzVersion`，快照懒加载 | 会话体变小；快照有独立缓存层 |

### 4.3 Token 与刷新

沿用旧实现里做对的部分（`session.store.ts:23-40` 的 Lua 脚本：轮换 + 重放检测 + `KEEPTTL`），因为这段逻辑本身没问题。**但要重写进 `libs/identity`，不复用旧文件。**

新增两条：

1. **刷新时校验 `passwordChangedAt`**：会话里的值 < DB 里的值 → 401。改密后所有 refresh token 立即失效。
2. **`exp` 上限不变**：`exp = min(now + accessTokenTtl, session.expiresAt / 1000)`，且要求 `exp - iat <= accessTokenTtl`（旧实现有这条校验，`auth.service.ts:154`，保留）。

### 4.4 会话管理端点（新增）

旧系统只能登出当前设备。新系统补三个：

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `GET /auth/sessions` | `authenticated` | 列出当前用户全部在线设备 |
| `DELETE /auth/sessions/:sid` | `authenticated` | 下线指定设备（校验 `sid` 属于自己） |
| `DELETE /auth/sessions` | `authenticated` | 下线除当前设备外的全部设备 |

管理员端点：

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `DELETE /system/user/sessions/:id` | `system:user:session:revoke` | 强制某用户下线 |
| `POST /system/user/:id/unlock` | `system:user:unlock` | 解除锁定 |

---

## 5. 授权（access）

### 5.1 权限码规范

格式：`module:resource:action`，全小写，三段，冒号分隔，**禁止通配符**（DB CHECK 已强制）。

| 段 | 取值 | 示例 |
| --- | --- | --- |
| module | `system` / `auth` | `system` |
| resource | 资源名，与 `RoleScope.resource` 同命名空间 | `user`、`role`、`route`、`dept`、`post` |
| action | 见下表 | `create` |

| action | 语义 | 旧码对应 |
| --- | --- | --- |
| `list` | 列表/分页 | `list` |
| `read` | 详情/单条/树 | `query` |
| `create` | 新建 | `add` |
| `update` | 修改 | `edit` |
| `delete` | 删除 | `delete` |
| `assign` | 分配关联（角色权限、用户角色、角色路由） | `assignMenus` + `assignRoles` |
| `scope` | 设置数据范围 | 从 `dataScope` 拆出 |
| `session:revoke` | 强制下线 | 新增 |
| `unlock` | 解除锁定 | 新增 |

**`assign` 和 `scope` 为什么拆开**：旧系统用 `system:role:dataScope` 一个码管"改数据范围"。但数据范围比功能授权更敏感（能改范围 = 能扩大可见面），必须能单独授予/收回。合成一个码等于逼所有人要么都能改、要么都不能改。

完整清单见附录 A。

### 5.2 判定引擎

AST 与求值器是纯函数，零 Nest 依赖，可单测到 100% 分支覆盖。

```ts
// libs/access/src/requirement/requirement.ts
export type Requirement =
  | { readonly op: 'perm'; readonly all?: readonly string[]; readonly any?: readonly string[] }
  | { readonly op: 'role'; readonly any: readonly string[] }
  | { readonly op: 'and'; readonly of: readonly Requirement[] }
  | { readonly op: 'or'; readonly of: readonly Requirement[] }
  | { readonly op: 'not'; readonly of: Requirement };
```

```ts
// libs/access/src/requirement/evaluate.ts
export function evaluate(req: Requirement, snapshot: AuthzSnapshot): boolean {
  switch (req.op) {
    case 'perm': {
      if (req.all?.some((code) => !snapshot.perms.has(code))) return false;
      if (req.any?.length && !req.any.some((code) => snapshot.perms.has(code))) return false;
      return true;
    }
    case 'role':
      return req.any.some((key) => snapshot.roles.has(key));
    case 'and':
      return req.of.every((sub) => evaluate(sub, snapshot));
    case 'or':
      return req.of.some((sub) => evaluate(sub, snapshot));
    case 'not':
      return !evaluate(req.of, snapshot);
    default: {
      // 新增 op 时这里编译失败，强制补分支
      const exhaustive: never = req;
      throw new Error(`未知的 requirement：${JSON.stringify(exhaustive)}`);
    }
  }
}
```

**四条必须由单测锁定的性质**：纯函数、`and`/`or` 短路、总函数（`never` 断言）、不抛异常（空数组、重复码、三层 `not`）。

**与旧引擎的能力对比**：旧实现只支持"单条注解内 AND/OR + 注解间 AND + role 兜底"（`permission.service.ts:40-50`），不支持 `not`、不支持嵌套。新引擎全支持，"注解间 AND"变成 AST 的一层 `and` 节点——语义等价但可组合。

### 5.3 注解 DSL

```ts
// libs/access/src/decorator/require-permission.ts
/** 单一权限码。 */
@RequirePermission(PERM.SYSTEM_USER_CREATE)

/** 多个码，默认 AND。 */
@RequirePermission({ all: [PERM.SYSTEM_USER_CREATE, PERM.SYSTEM_USER_UPDATE] })

/** 多个码，任一即可。 */
@RequirePermission({ any: [PERM.SYSTEM_USER_UPDATE, PERM.SYSTEM_ROLE_ASSIGN] })

/** 角色兜底：有该权限，或有该角色。 */
@RequirePermission({ all: [PERM.SYSTEM_USER_DELETE], fallbackRole: 'superadmin' })
```

复杂场景直接写 AST：

```ts
// libs/access/src/decorator/require-access.ts
@RequireAccess({
  op: 'and',
  of: [
    { op: 'perm', all: [PERM.SYSTEM_ROLE_ASSIGN] },
    { op: 'not', of: { op: 'role', any: ['readonly'] } },
  ],
})
```

**没有 `@Permission`、没有 `Mode` 枚举、没有 `RequirePermissions(...args)` 别名。** 31 处注解一次性改成 `@RequirePermission(PERM.X)`，改完旧装饰器文件删除。

**守卫语义（与旧系统保持一致，这条不能变）**：控制器方法/类上**没有任何访问注解 → 403**。这是"默认拒绝"的基石，`permission.guard.ts:32-37` 的做法是对的，新守卫照做。

### 5.4 快照：版本号 + 懒重建

```ts
// libs/access/src/snapshot/snapshot.types.ts
export interface AuthzSnapshot {
  readonly userId: string;
  readonly version: number;
  /** roleKey 集合，用于 @Role 判定与 fallbackRole。 */
  readonly roles: ReadonlySet<string>;
  /** 权限码集合，DENY 已扣除。 */
  readonly perms: ReadonlySet<string>;
  /** resource → 合并后的范围。没有条目 = NONE（默认拒绝）。 */
  readonly scopes: ReadonlyMap<string, ScopeFilter>;
  /** 用户自身等级（其角色中最小的 level），用于授予约束。 */
  readonly level: number;
}
```

加载路径：

```
请求 → AuthGuard 解 token → SessionStore.get(sid)
     → SnapshotService.load(userId, session.authzVersion)
         ├─ 版本一致：L1（进程内 LRU，10s）→ L2（Redis）→ 都没有则重建
         └─ 版本不一致：重建 → 写 L2 → 写 L1
```

**缓存 key 含版本号**：`authz:{userId}:{version}`。版本一变，旧 key 自然不再被访问，靠 TTL 淘汰。**不要改成"删除旧 key"**——删除会引入"删失败就脏读"的路径，带版本的 key 天然免疫。

重建只发一次查询（一个 `findUnique` 带三层嵌套 `select`），见附录 B。

**重建率是核心指标**：突增说明某处写操作在循环里 bump。

### 5.5 bump：授权变更的唯一传播机制

```ts
// libs/access/src/snapshot/authz-version.service.ts
async bump(userIds: Iterable<bigint>): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await this.prisma.$transaction(
    ids.map((userId) =>
      this.prisma.user.update({ where: { userId }, data: { authzVersion: { increment: 1 } } }),
    ),
  );
  // DB 提交后再更新 Redis 版本水位；失败只告警，影响是"旧快照继续用"（不是越权读新数据）
  await this.redis
    .multi(ids.map((userId) => ['INCR', `authz:ver:${userId}`]))
    .catch((cause) => this.logger.warn({ cause }, 'authz 版本水位更新失败'));
}
```

**纪律：bump 必须在业务事务提交后调用。** 事务内 bump 会在回滚时留下"版本涨了但数据没变"的假象，把真实问题掩盖成"偶发重建"。

**bump 触发点必须穷举**（漏一个就是长期越权）：

| 变更 | bump 范围 |
| --- | --- |
| `role_permissions` 增删改 | 该角色下所有用户 |
| `role_scopes` / `role_scope_depts` 变更 | 该角色下所有用户 |
| `role_routes` 变更 | **不 bump**（导航不进快照） |
| `roles.status` / `roles.roleKey` / `roles.level` | 该角色下所有用户 |
| `user_roles` 增删 | 该用户 |
| `users.status` / `users.deptId` / `users.deletedAt` | 该用户 |
| `permissions.status` | 持有该权限的所有角色下的用户 |
| `depts` 移动 / 删除 | 该部门下用户 + 引用该部门的 `RoleScopeDept` 涉及的用户 |

最后一行是旧系统完全没有的：范围进快照后，**改部门结构会影响授权**，必须 bump。旧系统因为范围实时读，这一项免费；新系统用缓存换性能，就必须显式传播。

### 5.6 权限码注册表

构建期从 DB 生成，禁止手改：

```ts
// libs/access/src/registry/permission.registry.ts
// @generated by script/rbac/gen-permission-registry.mjs —— 禁止手改
export const PERM = {
  SYSTEM_USER_LIST: 'system:user:list',
  SYSTEM_USER_READ: 'system:user:read',
  SYSTEM_USER_CREATE: 'system:user:create',
  // ...
} as const;

export type PermissionCode = (typeof PERM)[keyof typeof PERM];
```

CI 三项检查，任一失败阻断合并：

| 检查 | 规则 |
| --- | --- |
| 注解 ↔ 注册表 | 注解参数必须是 `PERM.*`，不允许字面量字符串 |
| 注册表 ↔ DB | `permissions` 每行都必须出现在注册表里，反之亦然 |
| 注册表 ↔ 前端 | 前端 `v-access:code` 的字面量必须都在注册表里（告警不阻断） |

**为什么必须生成而不是手写**：`permissions` 是运行时数据（管理员能加），`PERM` 是编译期常量。两者漂移的后果是"注解写了一个不存在的码，所有人 403"。生成 + CI 校验是唯一能防住的方式。

---

## 6. 数据权限

### 6.1 `(role, resource)` 多行模型

旧系统 `Role.dataScope` 单值，导致"一个角色只能有一个范围"——想看所有用户但只能改本部门岗位，做不到。

新模型：

```
role_scopes      (role_id, resource, scope_type)          PK (role_id, resource)
role_scope_depts (role_id, resource, dept_id)             PK (role_id, resource, dept_id)
```

`resource` 与 `Permission.resource` 同命名空间（`user` / `dept` / `post` / `role` / `route`）。`resource = '*'` 表示"未单独配置的资源走这个默认值"。

**合并规则**（多角色并集，与旧系统语义一致）：

1. 任一有效角色在该资源上为 `ALL` → `ALL`（不受限）
2. `CUSTOM` 只取 `role_scope_depts` 明确指定的部门，**不自动展开下级**
3. `DEPT` 取当前部门；`DEPT_AND_CHILD` 取闭包表子树
4. `SELF` 追加"本人"分支，落到 `ScopeColumns.owner` 上
5. 用户无部门时，`DEPT` / `DEPT_AND_CHILD` 不贡献部门条件
6. **合并后既无部门也无本人 → `NONE`（拒绝），不退化成全量**
7. 未知 `scopeType` → 403（失败关闭，不猜）

规则 6 和 7 是旧系统做对的地方（`data-scope.ts:114`、`:110-112`），必须保留。

### 6.2 `ScopedRepository`：默认拒绝的物理保证

```ts
// libs/access/src/scope/scoped.repository.ts
export interface ScopeColumns {
  /** 部门归属列，如 'deptId'。 */
  readonly dept?: string;
  /** 归属人列，如 'userId'。没有就不支持 SELF。 */
  readonly owner?: string;
}

export abstract class ScopedRepository<TRow, TWhere> {
  /** 资源标识，必须与 Permission.resource 同名。 */
  protected abstract readonly resource: string;
  protected abstract readonly columns: ScopeColumns;

  constructor(@Inject(PrismaService) protected readonly prisma: PrismaService) {}

  /** 唯一的 where 构造入口。子类不允许自己拼 where。 */
  protected scoped(where: TWhere, actor: AuthContext): TWhere {
    const filter = actor.scope(this.resource);   // 缺省 NONE，不是 ALL
    if (filter.kind === 'all') return where;
    const branches: Record<string, unknown>[] = [];
    if (filter.kind === 'limited') {
      if (this.columns.dept && filter.deptIds.length) {
        branches.push({ [this.columns.dept]: { in: filter.deptIds.map(BigInt) } });
      }
      if (this.columns.owner && filter.selfUserId) {
        branches.push({ [this.columns.owner]: BigInt(filter.selfUserId) });
      }
    }
    // NONE 或没有可用列 → 恒假。宁可查不到，也不能退化成全量。
    if (!branches.length) {
      const column = this.columns.dept ?? this.columns.owner;
      if (!column) throw new Error(`${this.resource} 缺少可用的范围列`);
      branches.push({ [column]: { in: [] } });
    }
    return { AND: [where, branches.length === 1 ? branches[0] : { OR: branches }] } as TWhere;
  }
}
```

**`AuthContext.scope(resource)` 缺省返回 `NONE`**，这是"默认拒绝"落地的地方。旧系统是 `loadDataScope` 忘了调用 = 全量；新系统是忘了配置 = 空。

### 6.3 ESLint 强制：没有绕过入口

```js
// eslint.config.mjs
{
  files: ['apps/gateway/src/modules/**/*.service.ts'],
  rules: {
    'no-restricted-syntax': ['error', {
      selector: "MemberExpression[object.property.name='prisma'][property.name=/^(user|dept|post|role)$/]",
      message: '业务 service 不得直接访问受保护的模型，请通过对应 Repository。',
    }],
  },
},
```

这条规则是"数据范围不可绕过"的最后一道锁。**没有它，`ScopedRepository` 只是一个建议。**

注意 `files` 要写 `**/*.service.ts`——`apps/gateway/src/modules/system/user/user.service.ts` 能被 `apps/**/*.service.ts` 命中。`@antfu/eslint-config` 未禁用该规则，可直接加。

### 6.4 写路径校验

```ts
// create：目标部门必须在范围内
await this.assertTargetInScope(actor, dto.deptId);
// update：旧值必须可见（不可见 → 404），新值必须在范围内
const current = await this.findById(id, actor);       // 不可见返回 null
if (!current) throw new NotFoundException('记录不存在');
if (dto.deptId !== undefined) await this.assertTargetInScope(actor, dto.deptId);
// delete：旧值必须可见
```

**越权读一律 404，不是 403**（沿用 `user.service.ts:97-105` 的既有约定）——不区分"没有这条"和"看不到这条"。

**根节点规则显式化**：旧系统 `dept.service.ts:91` 用 `isDeptInScope(filter, parentId ?? '0')` 校验，受限范围下 `'0'` 必然不在范围内，导致受限管理员**永远建不了根部门**——这是个没人写进文档的副作用。

新规则写进代码注释 + 测试：

> 根部门（`parentId = 0`）只能由 `ALL` 范围或超管创建。受限范围的管理员在自己的子树下建部门，不能建根。

这是**业务规则**，不是"偶然的正确"。写清楚，后面才不会有人来"修 bug"。

### 6.5 部门闭包表

`dept_closure(ancestor_id, descendant_id, depth)`，主键覆盖"查子树"，`descendant_id` 索引覆盖"查祖先链"。

**唯一维护点是 `DeptRepository`**，其他任何地方写 `dept_closure` 都算 bug。加一条 e2e：每次部门写操作后，用递归 CTE 重算一遍闭包，与表内容逐行比对。

移动子树：

```sql
-- 1. 锁定被移动的子树
CREATE TEMP TABLE moved ON COMMIT DROP AS
  SELECT descendant_id FROM dept_closure WHERE ancestor_id = $deptId;

-- 2. 删除"旧外部祖先 → 子树"的关系
DELETE FROM dept_closure
WHERE descendant_id IN (SELECT descendant_id FROM moved)
  AND ancestor_id NOT IN (SELECT descendant_id FROM moved);

-- 3. 建立"新祖先 → 子树"的关系
INSERT INTO dept_closure (ancestor_id, descendant_id, depth)
SELECT a.ancestor_id, m.descendant_id, a.depth + m.depth + 1
FROM (
  SELECT ancestor_id, depth FROM dept_closure WHERE descendant_id = $newParentId
  UNION ALL SELECT $newParentId, 0
) a
CROSS JOIN moved m;
```

复杂度 O(子树大小 × 新祖先深度)。旧实现是全表加载 + BFS + 逐行 `update`（`dept.service.ts:162-206`），1000 个部门时事务里约 1000 次 update。

---

## 7. 导航与路由

### 7.1 `routes` 表只有导航语义

对比旧 `sys_menu`：

| 旧字段 | 新归属 |
| --- | --- |
| `menu_type` M/C/F | `route_type` DIR/PAGE/LINK，**没有 F** |
| `perms` | 删除，权限在 `permissions` |
| `is_frame` `'0'/'1'` | `route_type = LINK` + `external` |
| `is_cache` `'0'/'1'` | `keepAlive boolean` |
| `visible` `'0'/'1'` | `visible boolean` |
| `query` | 删除（路由参数写进 path） |
| `parent_id` | 保留 |

**"按钮不是菜单"是这次重构最重要的建模修正。** 加一个"导出"权限只需要插一行 `permissions`，不需要造菜单、不需要处理父子关系、不会因为"菜单被角色引用"而删不掉。

### 7.2 `GET /auth/routes`

替代 `/auth/menus`。

```ts
// 返回结构（与旧 /auth/menus 的差异：移除 perms，字段名统一）
interface AuthRouteDto {
  routeId: string;
  parentId: string;
  name: string;
  path: string;
  component: string | null;
  redirect: string | null;
  routeType: 'DIR' | 'PAGE' | 'LINK';
  icon: string | null;
  orderNum: number;
  visible: boolean;
  keepAlive: boolean;
  external: string | null;
  children: AuthRouteDto[];
}
```

超管分支不过滤 `visible`（与旧实现一致，`auth.service.ts:150-152` 的理由成立：可见性由前端处理）；普通用户过滤 `status = ACTIVE` 且 `visible = true`。

**父节点不可见 → 整枝丢弃**（沿用 `auth.service.ts:130-136`）。不重挂到根——重挂会让"隐藏的父目录"的子页面突然出现在顶层导航里，比丢掉更糟。

### 7.3 前端必须同步改的 6 处

| 前端位置 | 旧 | 新 |
| --- | --- | --- |
| 登录响应 | `{ accessToken, user }` | 增加 `expiresIn` 语义不变，`user` 字段名不变 |
| `/auth/menus` | 有 `perms` 字段 | `/auth/routes`，无 `perms` |
| 权限码 | `system:user:add` | `system:user:create` |
| `status` 判断 | `=== '0'` | `=== 'ACTIVE'` |
| `delFlag` | `=== '0'` | `deletedAt === null` |
| 角色数据范围 | `role.dataScope` 单值 | `role.scopes[]` 数组 |

**没有别名表兜底。** 前后端必须同一窗口发布。

---

## 8. 授予约束与审计

### 8.1 三条不变量

```ts
// libs/access/src/grant/grant.rules.ts

/** 授予者不能给出自己没有的权限。 */
export function assertGrantable(actor: AuthzSnapshot, codes: readonly string[]): void;

/** 授予者不能操作等级高于自己的角色（level 越小等级越高）。 */
export function assertRoleLevel(actorLevel: number, target: { level: number }): void;

/** 不能给自己授权，也不能操作等级更高的用户。 */
export function assertAssignable(
  actor: AuthzSnapshot,
  actorId: string,
  target: { userId: string; level: number },
): void;
```

落点：

| 方法 | 不变量 | 旧系统缺口 |
| --- | --- | --- |
| `RoleService.assignPermissions` | `assertGrantable` + `assertRoleLevel` | `role.service.ts:254-260` 只校验菜单存在 |
| `RoleService.setScope` | `assertRoleLevel` + 范围不超出授予者 | `role.service.ts:280-323` 无任何校验 |
| `RoleService.assignRoutes` | `assertRoleLevel` | 无校验 |
| `UserService.assignRoles` | `assertAssignable` + 每个目标角色 `assertRoleLevel` | `user.service.ts:243-245` 只挡"改自己" |

第四条额外规则（旧系统完全没有）：**授予者不能给出比自己更大的数据范围**。否则部门管理员可以给自己的角色设 `ALL`，绕过所有数据隔离。

```ts
/** 目标范围必须是授予者范围的子集。 */
export function assertScopeWithin(actorScope: ScopeFilter, targetScope: ScopeFilter): void;
```

**没有"观察模式"，直接阻断。** 全量重构的前提是设计正确；上线时若真有管理员被挡，那是设计漏了规则，应该改规则而不是加开关。

### 8.2 审计

```ts
// libs/access/src/audit/audit.service.ts
/**
 * 授权变更审计的唯一写入方。
 *
 * 必须与业务同事务：异步写会丢，而审计不能丢。
 */
async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({ data: { ...entry, createdAt: new Date() } });
}
```

写入点（穷举）：`role.create/update/delete`、`role.assignPermissions`、`role.setScope`、`role.assignRoutes`、`user.assignRoles`、`user.update`（仅 `status` / `deptId` 变更）、`user.resetPassword`、`user.unlock`、`permission.create/update/disable`。

---

## 9. 代码结构

### 9.1 目标目录

```
libs/
├── identity/src/                    # 认证
│   ├── identity.module.ts
│   ├── auth.service.ts              # 登录/刷新/登出
│   ├── auth.guard.ts
│   ├── session/{session.types,session.store}.ts
│   ├── credential/
│   │   ├── password-hash.service.ts # 从 libs/crypto 迁入
│   │   └── login-throttle.service.ts# failedCount / lockedUntil
│   └── decorator/current-user.ts
│
├── access/src/                      # 授权
│   ├── access.module.ts
│   ├── permission.guard.ts
│   ├── permission.service.ts
│   ├── requirement/{requirement,evaluate}.ts
│   ├── decorator/{require-permission,require-access}.ts
│   ├── snapshot/{snapshot.types,snapshot.service,authz-version.service}.ts
│   ├── scope/{scope.types,scope.resolve,scoped.repository,tree-prune}.ts
│   ├── grant/grant.rules.ts
│   ├── registry/permission.registry.ts   # 生成
│   └── audit/audit.service.ts
│
├── organization/src/                # 组织（原 system 的领域部分）
│   ├── user/{user.repository,user.service}.ts
│   ├── dept/{dept.repository,dept.service}.ts
│   └── post/{post.repository,post.service}.ts
│
├── common/  core/  config/  cache/  database/  logger/  swagger/
│   （保留，仅做必要适配）
└── crypto/                          # 只留 API 加解密，密码哈希迁到 identity
```

`apps/gateway/src/modules/` 只保留控制器、DTO、模块装配：

```
apps/gateway/src/modules/
├── auth/{auth.controller,auth.module}.ts
└── system/
    ├── user/{user.controller,dto,module}.ts
    ├── role/…
    ├── route/…        # 原 menu
    ├── dept/…
    ├── post/…
    └── system.module.ts
```

**构建配置要同步改 4 处**（新建两个库、删一个库）：`nest-cli.json` 的 `projects`（删 `auth`/`permission`，加 `identity`/`access`/`organization`）、根 `tsconfig.json` 的 `paths`、各库的 `tsconfig.lib.json`、`package.json` 的依赖声明。漏一处就是 `nest build` 报模块找不到。

### 9.2 删除清单（一次性删干净）

| 路径 | 处理 |
| --- | --- |
| `libs/auth/` | 整体删除，内容重写进 `libs/identity/` |
| `libs/permission/` | 整体删除，内容重写进 `libs/access/` |
| `libs/permission/src/data-scope.ts` + `data-scope.spec.ts` | 删除，逻辑重写进 `access/scope/` |
| `libs/permission/src/permission.constants.ts` | 删除（`vagueMatch` / `createMatcher` 不再需要，集合命中即可） |
| `libs/permission/src/permission.decorator.ts` | 删除（`Mode` / `Role` / `RequirePermissions` 全废） |
| `libs/permission/src/prisma-permission.source.ts` | 删除（权限来源变成快照重建） |
| `prisma/models/{user,role,menu,dept,post,relations,logs}.prisma` | 删除 |
| 5 个 `system/*/**.service.ts` | 重写（不是修改） |
| `test/rbac.e2e-spec.ts`、`test/auth.e2e-spec.ts`、`test/auth-session.e2e-spec.ts` | 重写 |
| `apps/gateway/src/modules/system/system-management.spec.ts`（933 行） | **删除**。白盒测试直接断言 prisma 入参，重写后必然全红，改它比重写贵 |

### 9.3 保留的部分

| 路径 | 为什么保留 |
| --- | --- |
| `libs/core`（BigIntIdPipe / DtoValidationPipe / 异常过滤器） | 与 RBAC 无关，且已经踩完坑 |
| `libs/cache`（Redis 封装） | 与 RBAC 无关 |
| `libs/config` | 只需新增 `authz` 段 |
| `libs/common`（regex / tree / dto 基类） | 工具层，无业务耦合 |
| `libs/crypto` 的 API 加解密 | 与 RBAC 无关；只把 `password-hash.service.ts` 迁走 |

---

## 10. 实施顺序

5 个阶段。**不是迁移阶段，是构建顺序**——P1–P4 期间旧代码仍在跑，但新代码只写不接；P5 一次性切换。

| 阶段 | 产出 | 完成判据 |
| --- | --- | --- |
| **P1 数据层** | 全部 14 张表 + 约束 + 枚举；Prisma 客户端生成；迁移 SQL | 从空库 `prisma migrate deploy` 一次建成功；`prisma db push` 无 diff |
| **P2 领域层** | `libs/identity` + `libs/access` 全部写完，含单测 | 单测全绿；求值器分支覆盖 100%；仓储层覆盖 `NONE` / `ALL` / `limited` 三态 |
| **P3 业务层** | `libs/organization` + 5 个控制器 + DTO | 单测全绿；所有写路径都有范围校验用例 |
| **P4 契约层** | `/auth/routes`、`/auth/sessions`、新错误码；前端改造 | 前端在预发环境跑通全部页面 |
| **P5 切换** | 数据转换、停机窗口、删旧代码、删旧表 | 验收 checklist 全绿 |

**P1–P4 期间不做双写。** 旧系统继续产生新数据，P5 用同一个转换脚本一次性搬——因为切换窗口内系统只读，不存在增量同步问题。

---

## 11. 数据转换（一次性，单向）

### 11.1 脚本设计

`script/rbac/convert.mjs`，四段，每段可单独重跑：

```
1. extract   旧库 → 内存（users/depts/posts/roles/menus/user_role/role_menu/role_dept）
2. transform 内存 → 新结构（字段映射 + 冲突处理 + 闭包计算）
3. load      新库（按依赖顺序插入，单事务）
4. verify    行数 + 关键不变量 + 抽样比对
```

**只读旧库，只写新库。** 脚本不允许 `UPDATE` / `DELETE` 旧表——切换失败要能原样重来。

### 11.2 字段映射规则

| 旧 | 新 | 规则 |
| --- | --- | --- |
| `sys_user.del_flag = '0'` | `users.deleted_at = NULL` | 其余值 → `deleted_at = now()` |
| `sys_user.status = '0'` | `users.status = 'ACTIVE'` | `'1'` → `DISABLED` |
| `sys_user.password` | `users.password_hash` | 值不变（已经是 Argon2id） |
| `sys_dept.ancestors` | `dept_closure` 全量重算 | **不信任旧路径**，从 `parent_id` 重建闭包 |
| `sys_role.data_scope` | `role_scopes(resource='*')` | 编码转换见下表 |
| `sys_role_menu` + `menu.perms` | `role_permissions` | 每个不同的 `perms` 造一行 `permissions`，再按 `role_menu` 关联 |
| `sys_role_menu`（`menu_type='M'/'C'`） | `role_routes` | 只搬导航，不搬按钮 |
| `sys_menu`（`menu_type='M'/'C'`） | `routes` | `is_frame='0'` → `route_type='LINK'` |
| `sys_menu`（`menu_type='F'`） | **丢弃** | 按钮不再是行，只贡献权限码 |
| `sys_role_dept` | `role_scope_depts(resource='*')` | 仅当该角色 `data_scope='5'` 时 |
| `sys_user_role` | `user_roles` | `grantedAt` 取 `now()`（旧表没有时间） |
| `sys_post` / `sys_user_post` | `posts` / `user_posts` | `del_flag` → `deleted_at` |

**`dataScope` 编码必须逐条对照**，这是最容易出错的一处。旧系统注释写的是 RuoYi 编码（`role.prisma:11`），实现用的是另一套（`data-scope.ts:21-32`），**以实现为准**：

| 旧值 | 实现语义 | 新 `ScopeType` |
| --- | --- | --- |
| `'1'` | 全部 | `ALL` |
| `'2'` | 本部门 | `DEPT` |
| `'3'` | 本部门及以下 | `DEPT_AND_CHILD` |
| `'4'` | 仅本人 | `SELF` |
| `'5'` | 自定义 | `CUSTOM` |
| `'6'` | **非法**（实现会抛 403） | 转换时报错，人工确认 |

### 11.3 冲突处理

| 冲突 | 检测 | 处理 |
| --- | --- | --- |
| 同名账号 | 附录 C 的查重 SQL | **阻断**，人工改名后再跑 |
| 重复权限码 | `perms` 去重后仍冲突 | 自动合并（同码即同权限） |
| 孤儿关联 | `role_menu` 引用的菜单不存在 | 丢弃 + 记日志 |
| `SELF` 挂在无 `owner` 列的资源上 | `resource in ('dept','post','role','route') and scope_type='SELF'` | 转成 `NONE`，写进报告（旧系统这些模型上也是空范围，行为不变） |
| `CUSTOM` 无部门明细 | `role_scopes` 有 `CUSTOM` 但 `role_scope_depts` 空 | 转成 `NONE`，写进报告 |

### 11.4 校验

```
行数：users / depts / posts / roles / permissions / role_permissions /
      user_roles / routes / role_routes 逐表比对
不变量：
  - 每个 ACTIVE 用户至少有一个角色（否则登录后什么都看不到，仅告警）
  - 每个 role_scopes.resource 必须存在于 permissions.resource ∪ {'*'}
  - dept_closure 与 parent_id 重算结果完全一致
  - 每个 permission.code 都匹配 CHECK 的正则
抽样：随机 20 个用户，逐字段比对旧库与新库的"人话视图"
      （用户名 / 部门 / 角色名 / 权限数 / 范围）
```

---

## 12. 切换与验收

### 12.1 停机窗口时间线

| 时刻 | 动作 | 负责 |
| --- | --- | --- |
| T-7d | 转换脚本在预发用**生产数据副本**演练，报告 0 阻断项 | 后端 |
| T-1d | 前端发版到预发，全部页面走通 | 前端 |
| T-0 00:00 | **置系统只读**（网关层拒绝非 GET） | 运维 |
| T+0:00 | 旧库全量备份（`pg_dump`） | 运维 |
| T+0:05 | 跑 `convert.mjs` | 后端 |
| T+0:20 | 跑 `verify`，0 错误才继续 | 后端 |
| T+0:25 | 部署新版本，旧表重命名为 `*_backup`（不 DROP） | 运维 |
| T+0:35 | 解除只读，通知全员重新登录 | 运维 |
| T+1d | 观察 401/403 率、快照重建率、慢查询 | 后端 |
| T+7d | `DROP` 备份表 | 运维 |

**窗口预估 35 分钟，留 60 分钟余量。** 转换脚本在预发用真实数据量演练过，耗时应该可预测。

### 12.2 验收 checklist

**安全**

- [ ] 无访问注解的端点返回 403
- [ ] 数据范围未配置返回空列表，不是全量
- [ ] 授予超出自身权限 → 403
- [ ] 授予超出自身数据范围 → 403
- [ ] 修改自己的角色 → 409
- [ ] 操作等级更高的角色 → 403
- [ ] 越权读 → 404
- [ ] `permissions.code` 无通配符（DB CHECK 生效）
- [ ] 连续 5 次密码错误 → 锁定 15 分钟
- [ ] 改密后其他设备立即失效
- [ ] 审计表覆盖全部授权写操作

**正确性**

- [ ] 每个 `ScopeType` 都有正向 + 反向用例
- [ ] 多角色范围并集正确
- [ ] `NONE` 退化成 `IN ()` 恒假
- [ ] 部门树受限裁剪不抛 409（父不可见 → 整枝丢弃）
- [ ] 根部门只能由 `ALL` / 超管创建
- [ ] 改角色权限后，该角色用户下一次请求即生效
- [ ] 改角色数据范围后，下一次请求即生效
- [ ] 移动部门后，受影响用户的范围立即更新
- [ ] 闭包表与 `parent_id` 重算一致

**性能**

- [ ] 快照 L1 命中 p99 < 1ms
- [ ] 快照 L2 命中 p99 < 3ms
- [ ] 快照重建 p99 < 20ms
- [ ] 版本命中时常规请求 0 次 DB 查询
- [ ] 1000 并发无 Redis 热点 key

**契约**

- [ ] 前端全部页面在新契约下可用
- [ ] `/auth/routes` 返回结构与 `AuthRouteDto` 完全一致
- [ ] 错误码语义不变（401/403/404/409/422/423）
- [ ] BigInt ID 全部以字符串进出

### 12.3 回滚：只有一条路

```
1. 部署旧版本代码
2. 恢复 T-0 的 pg_dump 备份
3. 清空 Redis（会话已全部失效）
4. 通知全员重新登录
```

**没有"开关切回去"。** 这是不做兼容的直接代价，接受它。因此 T-0 的备份必须验证可恢复（在预发演练过一次）。

---

## 13. 风险

| ID | 风险 | 触发信号 | 缓解 |
| --- | --- | --- | --- |
| R-01 | 转换脚本在真实数据上失败 | 预发演练报错 | T-7d 必须用生产数据副本演练，不能用种子数据 |
| R-02 | 停机窗口超时 | 转换耗时 > 30min | 脚本分批 + 进度输出；超时则回滚重来，不硬撑 |
| R-03 | 前端未同步 | 页面空白 | T-1d 预发验收，前后端同窗口发布 |
| R-04 | 数据范围收紧导致"看不到数据" | 上线后报障 | 转换报告列出每个角色的新旧范围对照，业务方上线前确认 |
| R-05 | 权限码迁移丢失 | 某功能永久 403 | 注册表 ↔ DB 双向校验；报告列出每个权限码的授予角色数 |
| R-06 | bump 漏点 | 改权限后旧权限仍生效 | 第 5.5 节表格 + 每条一个单测 |
| R-07 | 闭包表与 `parent_id` 漂移 | 子树查询错 | 唯一维护点 + 每日重算比对 |
| R-08 | 授予约束误伤 | 管理员无法分配 | 规则上线前用生产数据回放一遍，统计会被挡的操作 |
| R-09 | 审计表膨胀 | 单表过亿 | 按月分区，保留 12 个月 |
| R-10 | `Serializable` 冲突 500 | 并发改角色报 P2034 | 统一 `withSerializableRetry`（最多 3 次，指数退避）——旧系统 21 处事务全无重试 |

---

## 附录 A　权限码全表

无别名、无旧码兼容。前端按此表一次性替换。

| 码 | 端点 | 旧码 |
| --- | --- | --- |
| `system:user:list` | `GET /system/user/list` | `system:user:list` |
| `system:user:read` | `GET /system/user/:id` | `system:user:query` |
| `system:user:create` | `POST /system/user` | `system:user:add` |
| `system:user:update` | `PUT /system/user/:id` | `system:user:edit` |
| `system:user:delete` | `DELETE /system/user/:id` | `system:user:delete` |
| `system:user:assign` | `PUT /system/user/roles/:id` | `system:user:assignRoles` |
| `system:user:session:revoke` | `DELETE /system/user/sessions/:id` | 新增 |
| `system:user:unlock` | `POST /system/user/:id/unlock` | 新增 |
| `system:role:list` | `GET /system/role/list` | `system:role:list` |
| `system:role:read` | `GET /system/role/:id`、`/menuTree/:id`、`/deptTree/:id` | `system:role:query`（一码 3 端点） |
| `system:role:create` | `POST /system/role` | `system:role:add` |
| `system:role:update` | `PUT /system/role/:id` | `system:role:edit` |
| `system:role:delete` | `DELETE /system/role/:id` | `system:role:delete` |
| `system:role:assign` | `PUT /system/role/permissions/:id`、`PUT /system/role/routes/:id` | `system:role:assignMenus` |
| `system:role:scope` | `PUT /system/role/scope/:id` | `system:role:dataScope` |
| `system:route:list` | `GET /system/route/list` | `system:menu:list` |
| `system:route:read` | `GET /system/route/:id` | `system:menu:query` |
| `system:route:create` | `POST /system/route` | `system:menu:add` |
| `system:route:update` | `PUT /system/route/:id` | `system:menu:edit` |
| `system:route:delete` | `DELETE /system/route/:id` | `system:menu:delete` |
| `system:dept:list` | `GET /system/dept/list` | `system:dept:list` |
| `system:dept:read` | `GET /system/dept/:id` | `system:dept:query` |
| `system:dept:create` | `POST /system/dept` | `system:dept:add` |
| `system:dept:update` | `PUT /system/dept/:id` | `system:dept:edit` |
| `system:dept:delete` | `DELETE /system/dept/:id` | `system:dept:delete` |
| `system:post:list` | `GET /system/post/list` | `system:post:list` |
| `system:post:read` | `GET /system/post/:id`、`/optionselect` | `system:post:query`（一码 2 端点） |
| `system:post:create` | `POST /system/post` | `system:post:add` |
| `system:post:update` | `PUT /system/post/:id` | `system:post:edit` |
| `system:post:delete` | `DELETE /system/post/:id` | `system:post:delete` |

共 30 个码，覆盖 34 个端点（`system:role:read` 3 个、`system:post:read` 2 个、`system:role:assign` 2 个）。旧系统是 31 个端点 / 28 个码，新增的 3 个端点是会话强退、解锁、角色路由分配。

---

## 附录 B　快照重建的一次查询

```ts
async rebuild(userId: string, version: number): Promise<AuthzSnapshot> {
  const user = await this.prisma.user.findUnique({
    where: { userId: BigInt(userId) },
    select: {
      status: true,
      deletedAt: true,
      deptId: true,
      roles: {
        where: { OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
        select: {
          role: {
            select: {
              roleKey: true,
              level: true,
              status: true,
              deletedAt: true,
              permissions: {
                select: {
                  effect: true,
                  permission: { select: { code: true, status: true } },
                },
              },
              scopes: {
                select: {
                  resource: true,
                  scopeType: true,
                  depts: { select: { deptId: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user || user.status !== 'ACTIVE' || user.deletedAt !== null) {
    throw new UnauthorizedException('未认证');
  }

  // 超管：不读关联，直接全量。仍先校验用户有效——停用的 1 号用户不能继续通行。
  if (isSuperAdmin(userId)) {
    return {
      userId,
      version,
      roles: new Set([SUPER_ADMIN_ROLE_KEY]),
      perms: ALL_PERMS,
      scopes: ALL_SCOPES,
      level: 0,
    };
  }

  const allow = new Set<string>();
  const deny = new Set<string>();
  const roleKeys = new Set<string>();
  const scopes = new Map<string, RawScope[]>();
  let level = Number.MAX_SAFE_INTEGER;

  for (const { role } of user.roles) {
    if (role.status !== 'ACTIVE' || role.deletedAt !== null) continue;
    roleKeys.add(role.roleKey);
    level = Math.min(level, role.level);
    for (const { effect, permission } of role.permissions) {
      if (permission.status !== 'ACTIVE') continue;
      (effect === 'DENY' ? deny : allow).add(permission.code);
    }
    for (const scope of role.scopes) {
      const list = scopes.get(scope.resource) ?? [];
      list.push(scope);
      scopes.set(scope.resource, list);
    }
  }

  // DENY 优先：先收集全部 ALLOW，再整体扣除
  for (const code of deny) allow.delete(code);

  return {
    userId,
    version,
    roles: roleKeys,
    perms: allow,
    scopes: resolveScopes(scopes, user.deptId === null ? null : String(user.deptId), userId),
    level,
  };
}
```

**一次查询出全部**，这是"版本号 + 懒重建"的核心收益。旧系统每请求跑 `loadUser`（`auth.service.ts:165`，约 3 条 SQL），新系统版本命中时 0 条。

---

## 附录 C　转换前置检查 SQL

```sql
-- 1. 同名账号（必须为空）
SELECT user_name, COUNT(*) AS cnt, STRING_AGG(user_id::text, ',' ORDER BY user_id) AS ids
FROM sys_user WHERE del_flag = '0'
GROUP BY user_name HAVING COUNT(*) > 1;

-- 2. 非法 data_scope（必须为空，出现 '6' 或其他值要人工确认）
SELECT role_id, role_name, data_scope FROM sys_role WHERE data_scope NOT IN ('1','2','3','4','5');

-- 3. 孤儿角色菜单（必须为空）
SELECT rm.role_id, rm.menu_id FROM sys_role_menu rm
LEFT JOIN sys_menu m ON m.menu_id = rm.menu_id WHERE m.menu_id IS NULL;

-- 4. 权限码重复（输出供参考，不阻断——同码即同权限）
SELECT perms, COUNT(*) AS cnt FROM sys_menu
WHERE perms IS NOT NULL AND perms <> '' GROUP BY perms HAVING COUNT(*) > 1;

-- 5. 部门树环（必须为空）
WITH RECURSIVE walk AS (
  SELECT dept_id, parent_id, ARRAY[dept_id] AS path, false AS cycle
  FROM sys_dept WHERE del_flag = '0'
  UNION ALL
  SELECT d.dept_id, d.parent_id, w.path || d.dept_id, d.dept_id = ANY(w.path)
  FROM sys_dept d JOIN walk w ON d.parent_id = w.dept_id
  WHERE d.del_flag = '0' AND NOT w.cycle
)
SELECT DISTINCT dept_id FROM walk WHERE cycle;

-- 6. 每个权限码被授予的角色数（转换报告用，业务方确认）
SELECT m.perms, COUNT(DISTINCT rm.role_id) AS roles FROM sys_menu m
JOIN sys_role_menu rm ON rm.menu_id = m.menu_id
WHERE m.perms IS NOT NULL AND m.perms <> ''
GROUP BY m.perms ORDER BY roles DESC;
```

---

## 附录 D　本文与架构提案的差异

提案（`rbac-rearchitecture.md`）是架构设计，本文是执行方案。执行层面做了 6 处判断：

| # | 提案 | 本文 | 理由 |
| --- | --- | --- | --- |
| 1 | 保留 `sys_*`，新表用 `iam_*` 前缀 | **丢前缀，用复数表名** | 旧表全 DROP，前缀没有区分价值；`iam_` 是另一个舶来词 |
| 2 | 双写 + 回填 + 对账 + 影子 + 灰度 | **全部砍掉** | 5000 行代码不配 9 周迁移方案；一次性 ETL 更便宜 |
| 3 | 受保护模型 5 个 | **3 个**（user/dept/post） | `RoleService.findAll`、`MenuService.findAll()` 实测不接 `actor` |
| 4 | `assign` 合并 `assignMenus` + `dataScope` + `assignRoles` | **`assign` 与 `scope` 拆开** | 数据范围比功能授权更敏感，必须能单独授予/收回 |
| 5 | 未提 `menuCheckStrictly` | **删除** | 树联动是前端渲染问题；顺带干掉 `dropParentMenus` / `dropParentDepts` |
| 6 | 未提改密踢会话 | **新增 `passwordChangedAt` 比对** | 旧系统改密不踢会话（`user.service.ts:232` 只在 status 变更时 revoke），等于改密无效 |

**保留提案判断的部分**：版本号 + 懒重建、AST 判定、`ScopedRepository` + ESLint 强制、闭包表、`(role, resource)` 多行范围、DENY 优先、三条授予不变量、审计同事务。

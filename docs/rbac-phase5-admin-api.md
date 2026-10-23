# RBAC 阶段 5：管理 API

> **⚠️ 两处描述已被取代（2026-10-22）。**
>
> 1. **"最后一位管理员"保护已移除。** 不再有 `managementPermissions` 清单，也不再在事务内比较写入前后的管理员存在性。现在与 RuoYi 一致，只靠"1 号超管账号不可改/删/停用"兜底。
> 2. **权限载体改为登录快照。** 管理写操作提交后会调用 `revokeUserSessions` 撤销受影响用户的会话；下文第 66 行"管理员检查"相关表述不再适用。
>
> 3. **路由已改为对齐 RuoYi 命名**（2026-10-23）：资源名改单数、列表加 `/list`、动作段用 Java 的 `authRole` / `dataScope` / `deptTree` / `optionselect`。动词已改为 `PUT`（与 Java 一致），但 **id 仍在路径**、删除仍是 `DELETE /:id` 单条，未改成 Java 的 id 在 body 和批量删除。
>
> 当前实现以 `docs/rbac-compare-ruoyi-plus.md` 第 3、5 节为准。

阶段 5 在 `apps/gateway/src/modules/system` 加入 `user`、`role`、`menu`、`dept` 四个业务模块，均通过 `PrismaService` 使用现有 Prisma 模型。`SystemModule` 同时继续注册认证端点和示例模块。四个模型的 `updateTime` 使用 Prisma `@updatedAt` 客户端指令；没有修改数据库字段、表结构或迁移，也没有写入业务数据或创建默认管理员。

所有路由位于全局 `/api` 前缀下。管理读写端点默认要求认证，且每个 controller 方法均声明独立 `system:<resource>:<action>` 权限。成功响应沿用 `{ code: 0, data, message }`；BigInt ID 输入、输出都使用十进制字符串；列表使用 `{ items, meta }` 分页包装；响应 DTO 以 `@Exclude()` 和字段级 `@Expose()` 控制字段，ID 通过 `@Type(() => String)` 转换，日期统一使用 `@DateFormat()`（`YYYY-MM-DD HH:mm:ss`，Asia/Shanghai）。用户响应不返回密码、登录 IP、登录时间或令牌信息。服务响应分别通过 `toDto`、`toDtoList` 和 `toPageDto` 映射。

## 用户

| 方法   | 路径                       | 权限                      |
| ------ | -------------------------- | ------------------------- |
| GET    | `/system/user/list`        | `system:user:list`        |
| GET    | `/system/user/:id`         | `system:user:query`       |
| POST   | `/system/user`             | `system:user:add`         |
| PUT    | `/system/user/:id`         | `system:user:edit`        |
| PUT    | `/system/user/authRole/:id`| `system:user:assignRoles` |
| DELETE | `/system/user/:id`         | `system:user:delete`      |

列表直接调用 `paginate(this.prisma.user, { ...query, where })`，默认只查询 `delFlag='0'`，支持账号包含匹配、部门和状态精确筛选。可排序字段为 `userId`、`userName`、`nickName` 和 `createTime`，分页由 `PageQueryDto` 限制；当前页角色关联通过 `UserRole` 单独读取。创建时账号在未删除用户中精确查重；密码经现有 Argon2id `PasswordHashService` 哈希后写入，绝不进入响应。资料更新允许可选改密、部门和状态；部门必须启用且未删除，`deptId: null` 清除所属部门。

角色关联由完整替换端点管理，空数组会清除关联、重复 ID 会去重。先在 Serializable 事务内验证所有目标角色均存在且启用，然后删除旧关联并批量写入；输入有误时事务不会部分替换。用户逻辑删除使用 `delFlag='2'`，同时清除角色关联；仍担任有效部门负责人时拒绝删除。`UserPost` 不参与 RBAC，不被此端点修改。

## 角色

| 方法   | 路径                       | 权限                      |
| ------ | -------------------------- | ------------------------- |
| GET    | `/system/role/list`        | `system:role:list`        |
| GET    | `/system/role/:id`         | `system:role:query`       |
| GET    | `/system/role/menuTree/:id`| `system:role:query`       |
| GET    | `/system/role/deptTree/:id`| `system:role:query`       |
| POST   | `/system/role`             | `system:role:add`         |
| PUT    | `/system/role/:id`         | `system:role:edit`        |
| PUT    | `/system/role/menus/:id`   | `system:role:assignMenus` |
| PUT    | `/system/role/dataScope/:id`| `system:role:dataScope`  |
| DELETE | `/system/role/:id`         | `system:role:delete`      |

角色列表直接调用 `paginate(this.prisma.role, { ...query, where })`，角色菜单和自定义部门关联在分页后分别读取。角色键 `roleKey` 在未删除角色中精确查重；创建时默认 `dataScope='5'`、无菜单或自定义部门。菜单端点完整替换 `RoleMenu`，显式校验每个被关联菜单启用且存在，不会自动补父目录或授予子树。数据范围端点在同一事务更新 `Role.dataScope` 与 `RoleDept`：`dataScope='2'` 要求至少一个启用部门；其他范围拒绝非空 `deptIds` 并清除过期自定义关联。此阶段提供范围配置，不将范围过滤静默应用到没有业务归属字段的模型；实际业务读写隔离属于阶段 6。

角色逻辑删除使用 `delFlag='2'`，先拒绝仍有关联用户的角色，再清理菜单、部门关联。禁用/删除关联对象后的权限会按阶段 3 查询规则即时失效。

## 菜单

| 方法   | 路径                | 权限                 |
| ------ | ------------------- | -------------------- |
| GET    | `/system/menu/list` | `system:menu:list`   |
| GET    | `/system/menu/:id`  | `system:menu:query`  |
| POST   | `/system/menu`      | `system:menu:add`    |
| PUT    | `/system/menu/:id`  | `system:menu:edit`   |
| DELETE | `/system/menu/:id`  | `system:menu:delete` |

管理树通过 `libs/common/src/utils` 的 `toTree` 及 `Menu.parentId` 组装，包含 M/C/F、隐藏和停用节点，按 `orderNum`、BigInt ID 稳定排序。缺父节点或存在循环时返回冲突以便先修复数据。M/C 只能位于目录下，F 必须位于菜单下；目录不能设操作权限码，按钮必须填写不含通配符的权限码。更新父节点、类型及权限码前验证父链和直接子节点，禁止形成环或留下不兼容的子类型。菜单没有删除标记，因此物理删除前必须无子节点且无 `RoleMenu` 引用；不级联清除权限数据。

## 部门

| 方法   | 路径                | 权限                 |
| ------ | ------------------- | -------------------- |
| GET    | `/system/dept/list` | `system:dept:list`   |
| GET    | `/system/dept/:id`  | `system:dept:query`  |
| POST   | `/system/dept`      | `system:dept:add`    |
| PUT    | `/system/dept/:id`  | `system:dept:edit`   |
| DELETE | `/system/dept/:id`  | `system:dept:delete` |

管理树通过 `libs/common/src/utils` 的 `toTree` 组装，仅显示未删除部门并保留停用节点。`ancestors` 不接受客户端写入，由服务端按 `/根ID/.../自身ID/` 生成，超过既有 512 字符上限即拒绝。创建或移动时沿 `parentId` 解析完整启用父链，通过循环/后代检查后，在同一 Serializable 事务重算所有未删除后代路径。规范 ID 与 BigInt 路径长度均在转换时检查；不依赖字符串前缀判断父子边界。负责人必须是启用且未删除用户，也可显式设为 null。

部门逻辑删除使用 `delFlag='2'`，只有不存在未删除子部门、未删除用户或 `RoleDept` 自定义范围引用时才能删除。更改 `User.deptId` 和角色数据范围均验证目标部门有效。停用部门不自动更改既有用户、子部门或数据范围。

## 事务、唯一性與管理員保護

有状态的管理写入在 service 内通过 Serializable Prisma 交互式事务执行；查重、有效引用检查、关联替换、树迁移、管理员检查和软删除在同一事务内完成。Prisma `P2034`、`P2002` 唯一键冲突及 `P2003` 引用冲突沿用全局 Prisma 异常映射为 HTTP 409；引用不存在/无效为 422，资源不存在为 404，数据库依赖故障按全局规则失败关闭。关联端点在删除旧关联前验证完整输入，并以现有关联表复合主键避免重复行。

不假設 userName/roleKey 有資料庫唯一約束；帳號和角色標識只在未刪除記錄中查重。建立與修改皆在 Serializable 事務內重新查重，但外部直接寫資料庫不受服務層保護。

按確認的规则，禁止停用或逻辑删除当前认证用户。管理员定义为：至少关联一个启用且未删除角色，而该角色集合的有效 M/C/F 菜单权限并集中包含全部 23 个本阶段声明的管理权限码。任何可能撤销权限的用户角色、角色状态/删除/菜单、菜单状态/删除或权限码写入，在同一事务比较写入前后管理员是否存在；初始无管理员时允许初始化，已有管理员时最后一位失去完整管理能力会导致整个修改回滚。没有固定用户 ID 或 `admin` 角色键绕过。此规则不能防止多个事务之外的数据库直写或已经泄露的管理员凭据。

## 验证

- 管理服务测试覆盖规范 ID、BigInt 上限与字符串序列化、DTO 字段脱敏、日期格式、分页 delegate 参数、循环父链/菜单树、最后管理员保护和空库初始化。
- 管理服务单元测试覆盖密码哈希与脱敏、账号重名、引用完整性先于关联删除、部门数据范围规则、自停用/自删除/部门负责人引用、菜单类型约束和部门迁移后代路径。
- 网关 e2e 验证四类资源的读操作与关联写操作均在无令牌时返回 401，缺少对应权限时返回 403。
- `@updatedAt` 仅让 Prisma Client 在更新记录时维护 `updateTime`，不改变数据库字段或表结构。本阶段不会执行数据库迁移、`db push` 或种子写入。

### 验证记录（2026-10-22）

- `pnpm build`、`pnpm exec tsc --noEmit --incremental false` 和管理模块 ESLint 通过。
- `pnpm exec vitest run --exclude libs/logger/src/logger.transport.spec.ts`：25 个测试文件、278 项通过。
- `pnpm exec vitest run apps/gateway/src/modules/system/system-management.spec.ts apps/gateway/src/modules/system/administrator.spec.ts libs/common/src/utils/tree.spec.ts`：32 项通过。
- `pnpm exec vitest run --config ./vitest.config.e2e.ts test/rbac.e2e-spec.ts`：21 项通过，覆盖管理端点未认证为 401、缺权限为 403。
- 全量 `pnpm test` 有 286 项通过、1 项失败；唯一失败是未修改的 `libs/logger/src/logger.transport.spec.ts` 临时目录场景触发 `ENOTDIR`，并产生对应未处理异常。排除此既有日志测试文件后其余测试全部通过。
- `git diff --check` 通过；Prisma schema 仅增加四处 `@updatedAt` 指令，未修改数据库字段或迁移。

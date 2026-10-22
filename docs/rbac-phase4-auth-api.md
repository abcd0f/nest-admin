# RBAC 阶段 4：认证业务接口

> **⚠️ 部分描述已被取代（2026-10-22）。**
>
> 权限载体改为登录时快照：`login` 会先算 `PermissionService.snapshot()` 再写进会话，`profile` 读快照而不是实时查库。
> 本文中"实时权限查询""实时权限变化"相关表述已不成立；`menus` 仍然每次查库（与 RuoYi `getRouters` 一致），这部分描述依然有效。
> 当前实现以 `docs/rbac-compare-ruoyi-plus.md` 第 3 节为准。

阶段 4 在 `apps/gateway/src/modules/system/auth` 新增业务 controller、service 和 module，接入 `SystemModule`。复用 `@app/auth` 的 JWT/Redis 会话和 `@app/permission` 的权限查询，没有修改 Prisma schema、迁移、依赖、令牌协议或配置键，也没有创建默认账号。

## 1. 接口约定

所有路径位于 `app.api-prefix` 下，默认前缀为 `/api`。成功响应为既有 `{ code: 0, data, message: "操作成功" }`，五个接口均返回 HTTP 200，并设置 `Cache-Control: no-store`。

| 方法 | 路径            | 认证要求          | 请求 / data                                                  |
| ---- | --------------- | ----------------- | ------------------------------------------------------------ |
| POST | `/auth/login`   | 显式 `@Public()`  | body `{ userName, password }`；data 为令牌对和脱敏 `user`。  |
| POST | `/auth/refresh` | 显式 `@Public()`  | body `{ refreshToken }`；data 为新的令牌对。                 |
| POST | `/auth/logout`  | 当前 Access Token | 无业务入参；data 为 `null`，只撤销认证上下文的 `sessionId`。 |
| GET  | `/auth/profile` | 当前 Access Token | 无业务入参；data 为本人脱敏资料、`roles` 和 `permissions`。  |
| GET  | `/auth/menus`   | 当前 Access Token | 无业务入参；data 为本人可见的已授权目录/菜单树。             |

受保护的三个接口标注 `@Authenticated()`，不要求额外的管理权限。没有角色的有效用户仍可查询本人资料，角色、权限和菜单返回空数组。用户 ID、会话 ID、角色、权限均取自服务端验证结果，不接受客户端指定查询对象或登出其他设备。

登录 data 示例（仅示意响应形状，不包含可用凭据）：

```json
{
  "accessToken": "<Access JWT>",
  "refreshToken": "<当前 Refresh Token>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "user": {
    "userId": "9223372036854775807",
    "userName": "<账号>",
    "nickName": "<昵称>",
    "deptId": null
  }
}
```

`profile` 将上述四个用户字段与 `roles: string[]`、`permissions: string[]` 平铺返回。权限展示通过该接口查询，登录响应保持阶段 2 的 `LoginResponseDto` 协议。响应不包含密码哈希、内部会话标识、邮箱、手机号或审计字段。所有 BigInt ID 显式转换为十进制字符串，包括嵌套菜单 ID。

## 2. 登录流程和失败处理

1. `LoginDto` 校验非空字符串、账号最多 64 字符、密码最多 128 字符。精确匹配原始账号，不 trim 密码，不隐式转换数字。非法格式通过全局管道返回 HTTP 422 和既有字段错误结构，不回显提交的敏感值。
2. 查询 `delFlag='0'` 的同名账号，按用户 ID 稳定排序，最多读取两条。必须恰好一条且 `status='0'` 才有资格登录；不能用 `findFirst` 任意选中歧义账号。
3. 使用现有 `PasswordHashService.verifyPassword()` 校验 Argon2id。业务模块初始化时为随机值生成同参数的临时哈希；缺失、禁用、删除或歧义账号也执行密码校验，减少快速失败造成的账号枚举信号。该哈希不入库，不是默认凭据，不保证整个 HTTP 请求严格恒时。
4. 不存在账号、错误密码、禁用/删除账号、同名歧义及损坏密码哈希统一返回 HTTP 401，响应为 `{ code: 401, data: null, message: "账号或密码错误" }`。
5. 验证通过后，使用 `updateMany` 在用户 ID、启用状态、未删除标志和已校验密码哈希仍匹配时写入 `loginIp`、`loginDate`。IP 使用 Fastify `request.ip`；沿用现有反向代理配置。若验证期间状态或密码改变，拒绝建立会话。
6. 调用现有 `AuthService.createSession()`，再次检查用户有效性并建立当前设备的独立 Redis 会话。审计写入先于会话创建；两者不是跨数据库/Redis 事务，因此会话存储故障时可能已有审计时间，但不会返回可用令牌。数据库和会话依赖故障沿用统一 HTTP 503，内部异常不进入响应。

## 3. 刷新、登出和权限生效

- Access JWT、Refresh Token 摘要、原子轮换、绝对期限和失败关闭策略全部复用阶段 2。默认 Access 有效期 15 分钟，会话期限 7 天，刷新不延长绝对期限。
- 每次刷新后客户端必须替换 Refresh Token。正常刷新不会撤销同一会话内尚未到期的旧 Access Token；旧 Refresh Token 已被消费，再次提交会撤销该设备会话，其新旧 Access/Refresh 随即失效。
- 随机伪造的 Refresh Token 不撤销合法会话。同一 Refresh 并发提交至多一次轮换成功；另一请求构成重放时，成功响应中的新令牌也会因会话撤销而失效。
- 登出仅撤销 `@CurrentUser()` 提供的当前会话，忽略客户端提交的其他会话标识。其他设备会话不受影响。已撤销或过期的 Access 不能再次调用受保护接口。
- `profile` 每次使用可信用户 ID 调用 `PermissionService.getAuthorization()`，沿用阶段 3 的精确权限码、多角色并集、状态过滤和无隐式超级管理员规则。角色及菜单变化无需重新登录即可体现在下一次查询中。

## 4. 菜单树规则

`menus` 单独查询当前有效用户的角色及菜单关系，并用明确 `select` 白名单读取路由展示字段，不读取密码和审计字段，不缓存结果。

1. 仅启用且未删除的角色贡献菜单。菜单必须 `status='0'`、`visible='0'`，且类型为 `M` 或 `C`。按钮 `F` 不进入树，其操作权限由 `profile.permissions` 返回。
2. 多个有效角色直接关联的节点取并集，按菜单 ID 去重。不自动补入未分配的父目录，也不因分配目录而授予全部后代。
3. `parentId='0'` 为根。只返回可从根到达的节点；父节点未分配、缺失、隐藏、停用、类型无效时，整个不可达分支被省略。循环父链、自环及其不可达分支同样不会进入响应，也不会导致递归组装或循环 JSON。
4. 每层按 `orderNum` 升序，再按 BigInt 菜单 ID 升序，避免大 ID 经 Number 转换丢失精度。叶节点的 `children` 为 `[]`。
5. 每个节点只返回 `menuId`、`parentId`、`menuName`、`menuType`、`orderNum`、`path`、`component`、`query`、`isFrame`、`isCache`、`visible`、`icon` 和 `children`。可空路由字段保留 `null`，不假设前端存在 `name`、`redirect` 等字段。

菜单展示和功能授权分别计算。隐藏或停用父目录使该分支不展示，不会隐式撤销仍启用且直接关联的子菜单/按钮操作权限；撤销功能需停用对应节点或移除授权，遵循阶段 3 约定。维护角色菜单时，应明确分配完整的可见父链。

## 5. Swagger 与部署

- `SwaggerService` 注册 HTTP Bearer 方案。仅 `logout`、`profile`、`menus` 声明 Bearer 安全要求；`login`、`refresh` 保持公开。
- DTO 字段、继承、可空字符串及校验上限沿用 Nest Swagger 编译插件；递归 `children` 显式指定模型。成功响应文档包含全局包装，菜单 data 为数组，登出 data 为 `null`。
- 本地及部署仍需提供 auth 签名密钥并启用可用的 Redis，见[阶段 1 基线](./rbac-phase1-foundation.md)。没有会话存储时登录、认证、刷新均失败关闭。
- 不创建测试账号、不授予默认权限、不修改数据库。用户和角色管理仍由阶段 5 实现。

## 6. 自动化验证

- `apps/gateway/src/modules/system/auth/auth.service.spec.ts`：登录账号歧义、状态、密码、审计条件、依赖故障、BigInt 脱敏、本人权限和菜单树边界。
- `test/auth.e2e-spec.ts`：实际 AppModule、Fastify、全局守卫/校验/响应处理、真实 Argon2 与 JWT；只替换 Prisma 和会话存储，不连接或写入真实数据库。覆盖五个 HTTP 接口、未认证/参数校验、刷新/重放/并发、到期、多设备登出、实时权限变化、依赖故障和 Swagger。
- 实际 Redis Lua 原子轮换的集成验证沿用 `test/auth-session.e2e-spec.ts`，需显式提供独立本机测试地址 `RBAC_REDIS_TEST_URL`；未提供时跳过，不把内存会话 mock 当作 Redis 原子性证明。

验证命令：

```sh
pnpm exec prisma generate
pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm test
pnpm test:e2e
git diff --check
git diff -- prisma
```

### 本阶段验证结果（2026-10-22）

- 新增 17 项认证业务单元测试、13 项 HTTP e2e，全部通过。
- `pnpm exec prisma generate`、`pnpm build`、`pnpm exec tsc --noEmit --incremental false` 通过。
- `pnpm test` 复现既有 `libs/logger/src/logger.transport.spec.ts` 的两项失败：历史文件保留测试超时，以及目录不可用场景未按预期拒绝初始化。该失败的对象 diff 产生大量输出，记录失败后中止此轮；没有修改日志实现或测试。
- `pnpm exec vitest run --exclude libs/logger/src/logger.transport.spec.ts`：22 个文件、246 项用例通过。
- `pnpm test:e2e`：45 项通过、16 项依赖独立 Redis 测试地址的用例跳过。本次未提供外部 Redis 测试地址；新增 HTTP 用例使用隔离会话 mock。
- 对 Nest CLI 编译产物创建 OpenAPI 文档并验证五个端点：200 状态、统一成功包装、DTO 继承字段、可空字段、递归菜单数组、Bearer 声明和公开接口边界均通过。
- 本次涉及的 TypeScript 文件 ESLint、Prettier 和 `git diff --check` 通过；`git diff -- prisma` 为空。未执行迁移、`db push`、真实数据库写入或初始化。

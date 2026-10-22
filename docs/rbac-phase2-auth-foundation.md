# RBAC 阶段 2：认证与权限基础

本阶段已实现认证/授权守卫、JWT 与 Redis 会话、装饰器、认证 DTO 和全局 DTO 校验。Prisma schema、迁移和业务数据均未修改。账号密码登录控制器及实际角色/菜单查询分别按阶段 4、阶段 3 接入，本阶段没有新增可绕过密码验证的登录接口。

## 1. 模块和职责

| 位置                                                   | 已实现内容                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/auth/src/auth.module.ts`                         | 用 `JwtModule.registerAsync()` 注入阶段 1 的 auth 配置；签名固定 HS256、issuer、audience，验证限制算法和签发方/接收方。JWT 只通过 `@nestjs/jwt` 调用。 |
| `libs/auth/src/auth.service.ts`                        | 创建会话、验证 Access Token、刷新令牌、撤销会话；每次认证/刷新重新检查数据库中的用户状态，使用显式字段白名单且不读取密码。                             |
| `libs/auth/src/session.store.ts`                       | 复用现有 `RedisService`，保存摘要、原子轮换、检测重放、撤销及严格失败语义；不创建第二个 Redis 客户端。                                                 |
| `libs/auth/src/auth.guard.ts`                          | 读取 Bearer Token，清除未经验证的 `request.user`，完成认证后附加可信上下文。                                                                           |
| `libs/permission/src/permission.guard.ts`              | 解析角色/权限要求，默认拒绝没有策略的已认证接口；注解内部支持 AND/OR、角色兜底，注解之间固定 AND。                                                     |
| `libs/permission/src/permission.source.ts`             | `PermissionSource.getPermissions(userId)` 与 `getRoles(userId)` 是阶段 3 的查询接入点；当前默认源返回空权限和空角色。                                  |
| `apps/gateway/src/app.module.ts`                       | 直接导入 `AuthModule`、`PermissionModule`，在同一 providers 数组先后注册 `AuthGuard`、`PermissionGuard` 为全局守卫。没有独立的 AccessControlModule。   |
| `libs/core/src/pipes/validation.pipe.ts`               | 以 `APP_PIPE` 注册全局 DTO 校验，返回既有 422 + `errors` 结构。                                                                                        |
| `apps/gateway/src/modules/system/auth/dto/auth.dto.ts` | 登录/刷新入参，以及用户、令牌、登录、当前用户响应 DTO；后续 auth 业务模块直接复用。                                                                    |

`AuthModule` 使用网关已全局注册的 `DatabaseModule`、`CacheModule`、配置模块。其他业务模块需要调用 `AuthService` 时仍应显式导入 `AuthModule`；认证与权限库本身不重复注册全局守卫。

主模块中的注册方式如下，`useExisting` 复用所导入模块导出的守卫实例。Nest 按这里的顺序执行认证、授权；已有限流及加密守卫保留原注册。

```ts
imports: [/* 基础模块 */ AuthModule, PermissionModule],
providers: [
  { provide: APP_GUARD, useExisting: AuthGuard },
  { provide: APP_GUARD, useExisting: PermissionGuard },
],
```

## 2. 路由策略

认证和授权统一读取 `Public`，公开标记优先；`Public` 的方法配置覆盖类配置。角色/权限注解则逐条追加保存，类和方法的全部要求一起执行，固定 AND。`Authenticated` 使用独立标记，不能覆盖或清除已有要求。

| 声明                                                           | 行为                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@Public()`                                                    | 显式允许匿名访问，跳过认证和功能授权。仅应给登录、刷新和健康检查等有明确匿名用途的接口使用。 |
| 类 `@Public()` + 方法 `@Public(false)`                         | 方法恢复认证，仍需另行声明 `@Authenticated()` 或 `@RequirePermissions()`。                   |
| `@Authenticated()`                                             | 必须通过 JWT、会话和用户检查；没有其他角色/权限注解时仅需登录，否则继续检查全部要求。        |
| `@Permission('system:user:list')`                              | 必须精确匹配这一权限码。                                                                     |
| `@Permission({ value: ['a', 'b'] })`                           | 默认 AND，必须同时有 a 和 b；也可显式设置 `mode: Mode.AND`。                                 |
| `@Permission({ value: ['a', 'b'], mode: Mode.OR })`            | 有 a 或 b 即满足这一条注解。                                                                 |
| `@Permission({ value: 'a', role: ['admin', 'operator'] })`   | 有 a 权限，或具有任一列出的角色；不绕过其他注解。                                            |
| `@Role('admin')`                                               | 必须拥有精确匹配的 admin 角色标识。                                                          |
| `@Role({ value: ['admin', 'operator'], mode: Mode.OR })`       | 任一角色即可；Role 不指定 mode 时同样默认 AND。                                              |
| `@RequirePermissions('system:user:list', 'system:user:query')` | 保留旧调用方式，相当于一条默认 AND 的 `Permission` 注解。                                    |
| 无权限策略                                                     | 未登录为 401，已登录为 403；避免新增接口漏标权限导致开放。                                   |
| `@CurrentUser()`                                               | 参数装饰器返回守卫生成的用户上下文；没有上下文时抛出 401，不从 body/query 读取用户身份。     |

根欢迎/健康检查接口已明确标为 `@Public()`。原有 example 接口没有策略，因而默认受保护。Swagger 文档仍由既有开发环境配置控制，Fastify 直接注册的文档路由不经 Nest 控制器守卫。

后续控制器使用方式：

```ts
@Get('profile')
@Authenticated()
profile(@CurrentUser() user: AuthenticatedUser) {
  // 使用明确的响应 DTO 映射用户字段，不能直接输出内部 sessionId。
  return this.profileService.find(user.userId);
}

@Get()
@Permission('system:user:list')
findAll() {
  return this.userService.findAll();
}
```

示例中的 `Authenticated`、`Permission`、`Role`、`Mode` 和兼容入口 `RequirePermissions` 来自 `@app/permission`，`CurrentUser` 和 `AuthenticatedUser` 来自 `@app/auth`。在阶段 3 实现实际权限源前，带功能权限或角色要求的路由不会获得授权。

### Nest 装饰器组合示例

TypeScript 使用对象参数代替 Java 的命名参数语法。单条注解内 `mode` 只有一个开关，不接受逐项指定模式；以下示例分别放在控制器方法上：

```ts
import { Permission, Role, Mode } from '@app/permission';

// 必须同时拥有两个权限（省略 mode 也相同）。
@Permission({
  value: ['system:user:edit', 'system:log:view'],
  mode: Mode.AND,
})
edit() {}

// 拥有任一权限即可。
@Permission({
  value: ['system:user:add', 'system:user:delete'],
  mode: Mode.OR,
})
change() {}

// 有 export 权限，或拥有 admin/operator 中任一角色。
@Permission({ value: 'system:user:export', role: ['admin', 'operator'] })
exportUsers() {}

// 两条注解固定 AND：必须既有 admin 角色，又有 all 权限。
@Role('admin')
@Permission('system:user:all')
manage() {}

// 相同注解也能叠加：要求 (add OR delete) AND log:view。
@Permission({ value: ['system:user:add', 'system:user:delete'], mode: Mode.OR })
@Permission('system:log:view')
changeAndViewLogs() {}
```

每条 `Permission` 的判断为 `(按 mode 判断 value) OR (具有任一 role)`，然后所有 `Permission`、`Role` 注解结果固定 AND。装饰器书写顺序不改变结果。`role` 不受 `mode` 影响，始终是任一角色兜底，且只作用于当前注解；即使某条注解通过 admin 兜底，其他条目也必须满足。单个权限或角色可用字符串，多值使用 `value` 数组；`role` 同样支持字符串或数组。

空数组、空字符串、首尾空白、通配符和非法 mode 在装饰器创建时抛出配置错误；不做自动 trim 或通配符展开。角色使用阶段 3 查询返回的 `roleKey`，权限使用 `Menu.perms`，不把角色名当权限，不提供 admin 隐式超级权限。每次授权按需各查询一次权限/角色；叠加注解不会重复查询，查询异常不会转为空列表后放行。数据只来自可信权限源，不读取请求参数或 JWT 中的角色/权限。

## 3. 令牌和会话协议

### Access Token

- 包含 `sub`（规范的正整数用户 ID 字符串）、`sid`、`jti`、`iat`、`exp` 和配置的 issuer/audience。`sid`、`jti` 使用 UUID v4。
- 除 `@nestjs/jwt` 的签名/算法/issuer/audience 验证外，服务还检查必需 claims、时间字段、最大访问有效期、会话主体和会话绝对期限。
- 默认有效期 900 秒；会话剩余时间不足 900 秒时缩短 Access Token，不能超过会话期限。
- 每次受保护请求重新读取 Redis 会话和数据库用户。用户缺失、停用、逻辑删除、会话撤销或过期均返回 401；Redis 或用户查询依赖不可用返回 503，不能降级放行。
- 用户上下文只含字符串 `userId`、`userName`、`nickName`、可空字符串 `deptId` 和内部 `sessionId`。角色与权限不从 JWT 获取。

### Refresh Token

- 格式为 `<sid>.<32字节随机值的base64url编码>`，共 80 个字符。sid 用来定位会话；随机部分证明持有凭据。服务端保存完整 Refresh Token 的 SHA-256 摘要，不保存其原文。
- 每次登录独立创建会话，多设备互不覆盖。默认绝对有效期 604800 秒，刷新不延期。
- Redis 键通过现有 `RedisService.key()` 加入环境前缀：`auth:session:<sid>` 保存 `{userId, refreshHash, expiresAt}`，`auth:used:<sid>` 集合保存已消费摘要。所有键都有会话剩余 TTL。
- 刷新先检查会话/用户并生成候选令牌，随后一次 Lua 调用比较旧摘要、登记已消费摘要、替换当前摘要并保留 TTL；只有轮换成功才返回令牌。不能拆成独立 GET/SET。
- 提交已消费过的摘要时撤销该 sid；未知随机摘要只被拒绝，不能撤销会话。并发使用相同 Refresh Token 至多一次成功，另一次被视为重放并撤销该会话；客户端后续刷新必须串行且保存最新令牌。
- 普通刷新不撤销该 sid 已签发且尚未过期的 Access Token；退出、重放撤销或会话过期会使该 sid 下所有 Access Token 立即失效。其他设备 sid 不受影响。
- Redis 调用超时不表示服务端命令未执行，因此刷新遇到 503 后不得自动重试旧令牌；严格重放规则可能要求用户重新登录。

`AuthService.createSession(userId)` 仅供后续密码验证成功后的登录服务调用，不应直接暴露成凭 userId 签发令牌的 API。`refresh(refreshToken)` 返回新令牌对；`logout(sessionId)` 由已经认证的上下文提供 sid，仅撤销当前会话。退出业务接口无请求 DTO，返回值由响应拦截器包装为 `data: null`。

## 4. DTO 与全局校验

- `LoginDto`：`userName` 为非空字符串、最长 64；`password` 为非空字符串、最长 128，不 trim、不隐式把数字转成字符串。
- `RefreshTokenDto`：Refresh Token 必须满足长度及协议格式。
- 全局管道 `transform: true`，但 `enableImplicitConversion: false`；现有分页 DTO 的显式 `@Type(() => Number)` 继续工作。
- 开启字段白名单并拒绝未知字段；嵌套错误扁平化成 `items.0.name` 等路径。错误只包含字段和固定校验提示，不回显输入值、DTO target 或含 `$value` 的自定义敏感消息。
- HTTP 入参错误沿用 `BusinessException.validation()`：422、`code: 422`、`data: null` 和 `errors`。成功响应仍交给既有拦截器包装，不二次包装。

## 5. 验证与阶段边界

新增测试覆盖 JWT 伪造/过期、算法和签发方/接收方、缺失/非法 claims、无效会话、禁用/删除用户、刷新期限、存储故障、公开策略、权限精确匹配、默认/显式 AND、OR、role 兜底、Role 与 Permission 及相同注解叠加、类/方法固定 AND、仅登录标记不清除要求、认证先于授权、嵌套校验及真实网关的 401/403/422。

`test/auth-session.e2e-spec.ts` 使用真实本机 Redis 验证 Lua 轮换、重放撤销、随机伪造、不延长 TTL、并发刷新和多设备隔离；测试只写随机 `rbac-test:<uuid>` 命名空间，并删除自己创建的会话。设置 `RBAC_REDIS_TEST_URL` 后运行：

```sh
pnpm exec vitest run --config vitest.config.e2e.ts test/auth-session.e2e-spec.ts
```

未设置该变量时显式跳过这 3 项外部依赖测试。现有缓存集成测试的 `REDIS_TEST_URL` 规则保持不变。非数据库测试使用 Prisma mock；日志探针控制器只在测试中显式公开，以保留原日志测试目的。

阶段 3 需实现并替换 `PermissionSource` 的默认空权限源、查询有效角色/菜单、聚合权限并提供当前用户的角色与权限数据；阶段 4 再将本阶段的认证服务和 DTO 接到登录/刷新/退出/当前用户控制器。数据范围解析仍在阶段 6，不在本阶段提前实现。

### 本阶段验证结果

- `pnpm build`、`tsc --noEmit --incremental false` 通过。
- 排除阶段 1 已记录失败的 `libs/logger/src/logger.transport.spec.ts` 后，20 个单元测试文件、210 项用例通过；没有修改该文件或无关日志实现。
- 本次完整 e2e 运行中，24 项用例通过；未设置外部 Redis 测试地址，跳过 3 项会话测试和 13 项既有缓存外部依赖用例。包含主模块直接注册守卫后的实际 HTTP 认证、权限 AND/OR、角色兜底及叠加注解回归。
- 修改涉及文件的 ESLint、文档格式及 diff 空白检查通过；Prisma 文件没有差异，未进行数据库写入或迁移。

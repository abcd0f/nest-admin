# RBAC 阶段 1：模型、配置与依赖基线

本阶段落实模型核对、JWT 依赖、auth 配置域与启动校验，明确后续接口的 ID、分页和序列化约定。登录、会话及守卫由阶段 2 起实现。本阶段没有修改 Prisma 文件或数据库结构。

## 1. Prisma 模型核对

以 `prisma/models/*.prisma` 和重新生成的 Prisma Client 7.10.1 为准，数据库采用 PostgreSQL。下表列出后续模块可直接使用的模型关系与边界。

| 模型       | 主键/关系                                                             | RBAC 使用方式及限制                                                                                                                                |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`     | `userId` 为 BigInt；`dept`、`roles: UserRole[]`、`posts: UserPost[]`  | 登录按 `userName` 查询，凭据字段为 `password`；`deptId` 可空。`createBy` 是审计来源，不能和当前所属 `deptId` 混为一谈。（`createDept` 已于 2026-10-23 移除：只写不读，数据权限用 `deptId`。）              |
| `Role`     | `roleId` 为 BigInt；`users`、`menus: RoleMenu[]`、`depts: RoleDept[]` | `roleKey` 是角色标识，`dataScope` 字符范围为 `1` 至 `6`，缺省 `5`。                                                                                |
| `Menu`     | `menuId` 为 BigInt；`roles: RoleMenu[]`                               | `parentId=0` 为根；没有自关联外键，没有 `delFlag`。`menuType` 为 `M/C/F`；`perms` 可空、最长 100 字符；`visible` 只控制显示，不代表撤销 API 权限。 |
| `Dept`     | `deptId` 为 BigInt；`users`、`roleDepts`                              | `parentId=0` 为根；没有父部门自关联外键。`ancestors` 为含自身路径，最长 512 字符，schema 缺省 `/` 不能证明已有层级路径符合规范。                   |
| `Post`     | `postId` 为 BigInt；`users: UserPost[]`                               | 职位不是角色，不能由职位隐式推导权限；本阶段不新增职位模块。                                                                                       |
| `UserRole` | 复合主键 `[userId, roleId]`                                           | `user`、`role` 为真实外键关联，物理删除级联；逻辑删除不会触发级联。                                                                                |
| `RoleMenu` | 复合主键 `[roleId, menuId]`                                           | `role`、`menu` 为真实外键关联，物理删除级联。                                                                                                      |
| `RoleDept` | 复合主键 `[roleId, deptId]`                                           | 自定义范围只包含明确选中的部门，不自动扩展下级。                                                                                                   |
| `UserPost` | 复合主键 `[userId, postId]`                                           | 维护职位引用，不参与 RBAC 授权。                                                                                                                   |
| `LoginLog` | `infoId` 为 BigInt                                                    | 已有登录日志模型，无删除标志；不是令牌或会话存储。                                                                                                 |
| `OperLog`  | `operId` 为 BigInt                                                    | 记录操作审计，无部门归属字段；`operUserId` 是操作者，数据授权需按该模型单独定义。                                                                  |

### 唯一性与树结构

- schema 中 `userName`、`roleKey`、`postCode`、`Menu.perms` 均无 `@unique`，也没有对应复合唯一约束。生成的 `UserWhereUniqueInput` 必须包含 `userId`，`RoleWhereUniqueInput` 必须包含 `roleId`，不能只凭账号名或角色字符串调用 `findUnique`。
- 登录时对未删除的同名账号最多读取两条；必须恰好一条才继续验证状态和密码，出现歧义按认证失败处理，不能任意选取第一条。
- 管理服务后续需在 Serializable 事务中检查有效账号名/角色标识重复后写入，并针对 Prisma `P2034` 做有限重试。所有应用写入口须采用同一约定；外部直接写库不受服务层约束保护。不能在 schema 不变的前提下声称已有数据库唯一约束保证这些字段唯一。
- `perms` 允许多个菜单引用同一操作权限，加载时去重；判断使用精确匹配，不实现通配符或隐式超级管理员。
- `Dept.parentId`、`Menu.parentId`、`Dept.leaderId` 以及审计 ID 不是完整的外键关系；维护服务必须检查父节点存在、禁止自身/后代作为父节点，并在事务中处理树迁移及后代路径更新。
- 新建部门时拟统一为 `/根ID/.../自身ID/` 格式，根为 `/<deptId>/`；阶段 5 的部门写接口负责保证路径一致性与长度上限。未来如接入已有非规范数据，必须先核对路径，不能直接按字符串前缀扩大授权。

### 状态及删除语义

`User/Role/Dept/Post` 同时有 `status` 和 `delFlag`；正常值均为 `'0'`，非 `'0'` 作为不可用/已删除处理。菜单只有 `status`，删除菜单需检查子节点及关联后按明确的物理删除策略处理。逻辑删除用户/角色后，旧关联行可能仍在，权限查询必须过滤关联对象的状态与删除标志。

### 本机开发库核验

2026-10-22 使用现有 development 配置进行了 PostgreSQL 只读事务检查：11 个模型对应表均可查询，用户、角色、菜单、部门、职位、四张关联表及两张日志表的记录数均为 0。没有执行写入、初始化、迁移或结构变更。空库无法验证历史状态值、角色命名、部门路径和初始管理员约定；后续初始化以本文件规则为准，其他部署环境的数据需单独核验。

## 2. JWT 依赖和配置

用户指定 JWT 只使用 `@nestjs/jwt`。已新增直接依赖 `@nestjs/jwt@^12.0.3`，其声明支持当前 NestJS 12；业务代码不直接引入 `jsonwebtoken`、`jose` 或其他 JWT 库，也不新增对应直接依赖。`@nestjs/jwt` 内部依赖和类型由 pnpm 锁文件正常管理。

`libs/config/src/domains/auth.domain.ts` 已加入 `DOMAINS`，通过 `@app/config` 导出 `authConfig` 和 `AuthConfig`。现有 `AppConfigModule.forRoot()` 在注册 Nest DI 前解析并验证全部配置域；auth 配置错误会阻止启动。不存在 auth 开关、默认密钥或临时绕过认证的运行配置。

| YAML 配置键              | DI 属性           | 缺省值及校验                                                                                            |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `auth.jwt-secret`        | `jwtSecret`       | 必填；非空字符串，UTF-8 至少 32 字节；原样保留，不 trim；错误不输出原文。实际随机性由部署密钥生成保证。 |
| `auth.jwt-algorithm`     | `jwtAlgorithm`    | `HS256`；拒绝其他算法，包括 `none`。                                                                    |
| `auth.jwt-issuer`        | `jwtIssuer`       | `nest-admin`；非空字符串。                                                                              |
| `auth.jwt-audience`      | `jwtAudience`     | `nest-admin:gateway`；非空字符串。                                                                      |
| `auth.access-token-ttl`  | `accessTokenTtl`  | `900` 秒；正整数，上限 2147483647。                                                                     |
| `auth.refresh-token-ttl` | `refreshTokenTtl` | `604800` 秒；正整数，同上限，必须大于 Access Token TTL。                                                |

当前网关尚未导入认证库或注册 `JwtModule`；阶段 2 使用 `JwtModule.registerAsync()` 注入 `authConfig`，签名时固定 HS256、issuer、audience 和秒级有效期，验证时限定 `algorithms: ['HS256']` 并检查 issuer/audience、必需 claims 及会话。不能只调用 decode 或假设 `@nestjs/jwt` 自动验证所有自定义 claims。Refresh Token 沿用 Node `crypto` 生成和 SHA-256 摘要，不使用另一个 JWT 库。

### 本地及部署配置方式

`config/default.yaml` 只提交算法、issuer、audience、TTL 及说明，不提供真实密钥。首次启动需在已被 `.gitignore` 忽略的 `config/development.local.yaml` 设置：

```yaml
auth:
  jwt-secret: <替换为随机生成的密钥，不要提交>
```

使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 在本机生成值后填入；生产实例共享同一份受控密钥，通过 `config/production.local.yaml` 或文件密钥挂载提供。当前配置加载器读取 YAML 分层且设置 `skipProcessEnv: true`，不能假定设置 `JWT_SECRET` 环境变量会自动生效。未配置密钥时启动失败是本阶段明确引入的要求，不是启动回退缺陷。

测试只在调用完整配置入口的日志/加密测试中引入 `test/helpers/auth-config-source.ts`，注入每次进程随机生成的测试密钥；不会创建 local 文件，也不改变运行时配置加载器。配置域测试同时覆盖启动入口拒绝缺失密钥和 Nest DI 注册配置。

## 3. 可复用基础设施和后续接入点

| 现有能力                             | 后续使用方式                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrismaService` / `DatabaseModule`   | 全局客户端，业务 service 注入；关系更新用同一事务客户端，避免事务中调用外部 Prisma 根客户端。                                                                                                                        |
| `RedisService`                       | 严格失败接口；`get/set/del`、`consume(GETDEL)`、`execute` 支持原生命令/Lua。会话相关 key 经过 `key()` 生成环境隔离前缀，不用容错缓存的 miss 语义判断会话有效。TTL 传入前从配置秒转换为毫秒。                         |
| `RedisService.execute()`             | 刷新轮换采用一次原子 Lua 操作完成旧摘要检查、重放处理和新摘要保存；不能用分离的 `get`+`set` 实现轮换。单独 `consume` 后再写新值也不能保证完整轮换的原子性。                                                          |
| `PasswordHashService`                | 复用 Argon2id，密码不转成 JWT 密钥，不以 API 加密替代密码哈希。                                                                                                                                                      |
| `ResponseInterceptor`                | 成功返回 `{code:0,data,message}`；业务 DTO 只返回 data，不能二次包装。`instanceToPlain` 不是通用 BigInt 转换器。                                                                                                     |
| `BusinessException` / 全局异常过滤器 | 未认证 401、无权限 403、输入校验 422、冲突 409、依赖不可用 503；沿用既有错误体。业务专属码按模块划分，不滥增平台常量。                                                                                               |
| `CoreModule` / `CryptoModule`        | 已有全局限流与报文加密守卫。阶段 2 注册认证/授权守卫时需明确先后次序，不依赖偶然模块加载顺序。                                                                                                                       |
| DTO 校验                             | 已依赖 `class-validator`、`class-transformer`，但当前 `main.ts`/`CoreModule` 没有全局 `ValidationPipe` 或 `APP_PIPE`。后续增加 DTO 时必须同时接入校验管道和既有 422 错误约定，不能只写装饰器便认为 HTTP 输入已验证。 |
| ESM / Swagger                        | 相对导入保持 `.js`；运行时 DTO 使用普通值导入，类及字段注释沿用 `.dto.ts` + Swagger 编译插件。                                                                                                                       |

## 4. ID、分页和输出约定

- PostgreSQL BigInt ID 的对外格式为十进制字符串，例如 `"9223372036854775807"`。资源 ID 使用 `1..9223372036854775807`，仅树根 `parentId` 额外允许 `"0"`；可空 `deptId` 使用 `null` 或省略，不能以空字符串代替。
- 入参拒绝 JSON number、负数、小数、科学计数法、超范围值、空白和非规范前导零。先检查原始字符串，再转 `BigInt`；不得先 `Number()` 或让隐式字符串转换掩盖 JSON number。数组 ID 要逐项验证、去重；根 ID 的 `0` 例外不扩展到 userId/roleId 等资源 ID。
- 输出 DTO 显式将 ID 转成字符串，嵌套 ID 同样处理；用户查询使用明确 `select` 白名单，严禁直接返回包含 `password` 的 Prisma 用户。日期沿用现有 `DateFormat`/DTO 规则。
- 分页查询复用 `PageQueryDto`：`page=1`、`pageSize=20`，上限 200，非法 HTTP 入参按 422 处理。列表返回 `items` 与 `meta: {page,pageSize,total,totalPage}`，外层由全局响应拦截器包装。
- 复用 `@app/database` 的 `paginate()`，数据和 count 使用同一授权/筛选条件；其内部兜底与截断不替代 HTTP DTO 校验。排序字段必须在具体模块白名单内，不能把客户端任意字符串直接当 Prisma 排序字段。每个列表使用 ID 作为稳定排序的追加字段。
- 本阶段仅确定约定，不提前增加无调用方的 ID 装饰器、校验管道、业务 DTO 或分页抽象；在阶段 2/5 的真实接口中落实并测试。

## 5. 验证记录

- `prisma validate`、`prisma generate` 通过；仅重新生成忽略目录内的客户端。
- `tsc --noEmit --incremental false`、涉及 TypeScript 文件的 ESLint 和文档格式检查通过。
- `pnpm build` 通过；排除基线已失败的 `logger.transport.spec.ts` 文件后，16 个测试文件、154 项测试全部通过，其中包含 26 项 auth 配置测试；加密 e2e 的 9 项用例通过。
- 修改前的 `pnpm test` 基线为 135 项通过、2 项日志轮转失败，并有 1 个来自该测试的未处理异常。失败位置为 `libs/logger/src/logger.transport.spec.ts` 的历史文件保留和目录不可用场景，不属于 RBAC 改动。
- 安装依赖后 pnpm 提示 `tsconfck@3.1.6` 要求 TypeScript 5，而项目为 TypeScript 6.0.3；来自既有 `vite-tsconfig-paths`，`@nestjs/jwt` 的 Nest peer 依赖满足。
- Prisma 结构和迁移文件保持无改动；未写入初始管理员、角色或权限数据。

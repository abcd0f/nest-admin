# HTTP 限流实现计划

日期：2026-10-19

设计依据：[已通过的设计文档](../specs/2026-10-19-throttler-design.md)。

## 执行方式与完成标准

建议在当前对话由主代理依次实现并验证，不使用子代理。以下步骤具有依赖关系，按顺序执行；确认执行方式后完成全部步骤，不再增加设计确认环节。

完成条件：配置域参与启动校验；全局守卫在真实 Fastify 请求中生效；配置关闭、局部覆盖、豁免、隔离与时间恢复验证通过；README 可直接指导使用；构建通过；相关检查没有新增失败。既有无关测试失败需在交付中说明。

## 1. 配置域与启动校验

新增：

- `libs/config/src/domains/throttler.domain.ts`
- `libs/config/src/domains/throttler.domain.spec.ts`

修改：

- `libs/config/src/domains/index.ts`
- `config/default.yaml`

执行：

1. 先写配置测试，验证默认启用、`ttl=60000`、`limit=100`、`blockDuration` 缺省为 `undefined`；验证字符串数字、布尔开关、`block-duration` 的映射与 `0` 的合法性。
2. 用表驱动测试覆盖数值字段的非法类型、小数、非有限数和超出范围值；验证错误包含配置字段路径。
3. 实现 `ThrottlerConfig` 和 `throttlerDomain`，复用 `asObject` / `asBoolean` / `asInteger`。仅在该域内补充数值类型和空白字符串约束，不更改公共解析器。
4. 将域加入 `DOMAINS`，导出类型和 `throttlerConfig` 注入令牌。通过 `compileConfig(DOMAINS, snapshot)` 的失败测试证明该域已接入启动校验，测试后清理编译缓存。
5. 在默认 YAML 追加有中文注释的限流配置；`block-duration` 仅提供注释示例，避免将缺省时长固定为全局窗口。

验证：

```powershell
pnpm exec vitest run libs/config/src/domains/throttler.domain.spec.ts
```

预期先因缺少实现而失败，完成配置域后通过。

## 2. CoreModule 全局装配

修改：

- `libs/core/src/core.module.ts`
- `libs/core/src/filters/all-exceptions.filter.spec.ts`

执行：

1. 在 `CoreModule` 导入官方 `ThrottlerModule.forRootAsync()`，注入 `throttlerConfig.KEY`，使用显式的 `ThrottlerModuleOptions` 返回类型。
2. 配置单组 `default` 策略，将可选 `blockDuration` 原样传给官方模块。通过 `skipIf` 实现总开关，使用既有业务码对应的中文限流提示。
3. 以 `APP_GUARD` 注册官方 `ThrottlerGuard`，保留现有 `APP_FILTER`。不修改网关启动代码和异常过滤器实现。
4. 在原有 CoreModule 装配测试中显式导入 `AppConfigModule.forRoot()`，满足新增配置依赖；保持原有断言。

验收：模块可完成依赖注入；现有异常响应不变；独立 CoreModule 测试仍通过。

## 3. 实际请求与时间恢复验证

新增：

- `libs/core/src/guards/throttler.spec.ts`

执行：

1. 创建仅用于测试的控制器和 Fastify 应用，导入真实 `AppConfigModule` 与 `CoreModule`，覆盖 `throttlerConfig.KEY` 为小额度；沿用项目的测试元数据适配方式。
2. 验证未加装饰器的接口达到额度后返回 429，响应体为 `{ code: 42900, data: null, message: '请求过于频繁' }`；检查正常响应的限流头和拒绝响应的 `Retry-After`。
3. 用不同客户端地址与不同处理方法验证额度隔离；改变同一方法的查询参数和路径参数验证无法绕过额度。
4. 验证方法及控制器级 `@Throttle()` 覆盖、`@SkipThrottle()` 豁免，以及被豁免控制器中的 `@SkipThrottle({ default: false })` 恢复限流。
5. 验证 `enabled=false` 时普通接口和带限流装饰器的接口都正常通过，且没有限流头。
6. 以受控时钟推进 `Date.now()`，真实请求验证窗口过期与封禁结束恢复；省略 `block-duration` 并覆盖接口 `ttl`，确认不会继承全局 `ttl`；显式配置封禁时长及 `0` 的行为符合配置契约。避免真实等待 60 秒。
7. 每个测试关闭应用并恢复时间，确保官方存储的清理钩子运行，避免计数和计时器污染其他测试。

验证：

```powershell
pnpm exec vitest run libs/config/src/domains/throttler.domain.spec.ts libs/core/src/guards/throttler.spec.ts libs/core/src/filters/all-exceptions.filter.spec.ts
pnpm test:e2e
```

使用先验证失败场景、再装配守卫的顺序推进第 2、3 步，保留真实请求作为回归证据。

## 4. 使用文档与最终检查

修改：

- `README.md`

执行：

1. 增补中文限流说明：配置位置、默认每 IP 每接口额度、毫秒配置与秒响应头、控制器和方法装饰器示例、关闭开关、单进程内存存储与代理设置前提。
2. 保持官方 API，不新增业务装饰器封装、独立库、Redis 或动态配置刷新。
3. 对改动文件运行只读 lint、构建、相关测试和原有网关 e2e；检查最终 diff 只涉及计划文件。
4. 如运行完整单测，将输出保存为临时报告并仅展示失败摘要，避免已有日志测试的大对象错误输出淹没结果。除非出现新的疑点，不重复运行已通过的检查。

最终检查命令：

```powershell
pnpm exec eslint libs/config/src/domains/throttler.domain.ts libs/config/src/domains/throttler.domain.spec.ts libs/config/src/domains/index.ts libs/core/src/core.module.ts libs/core/src/guards/throttler.spec.ts libs/core/src/filters/all-exceptions.filter.spec.ts
pnpm build
git diff --check
```

交付说明包含配置与装饰器最小示例、验证结果和既有失败，不自动提交实现代码。

## 已知基线与边界

- 原有 `pnpm build` 通过；网关 e2e 为 5 项通过。
- 原有完整单测为 25 项通过、4 项失败，并有 1 项日志测试未处理异常。失败位于 `app.domain.spec.ts` 的 API 前缀默认值，以及 `logger.transport.spec.ts` 的轮转清理和目录初始化，不纳入限流修复。
- 用户已有 `libs/core/src/decorators/date-format.decorator.ts`、`package.json` 和 `pnpm-lock.yaml` 工作区修改，保留原样。`@nestjs/throttler` 已安装，无需重复安装依赖。
- 本计划共涉及 8 个实现、配置、测试和使用文档文件，另有已完成的设计文档与本计划文档；不扩展其他模块。

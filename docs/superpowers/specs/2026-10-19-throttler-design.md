# HTTP 限流集成设计

日期：2026-10-19

## 目标与已确认范围

在现有 NestJS / Fastify 项目中集成 `@nestjs/throttler`，配置遵循现有分层 YAML 和配置域机制，业务侧直接使用官方装饰器。

用户已确认采用单实例、内存计数，并认可下述推荐方案。该方案不增加 Redis、独立限流库、自定义计数算法或装饰器。

成功标准：配置错误在启动阶段暴露；所有 HTTP 控制器默认受限流保护；可通过配置关闭全部限流，通过装饰器覆盖或豁免特定接口；限流错误兼容已有响应结构；Fastify 实际请求验证通过。

## 现有接入点

- `libs/config`：`defineConfigDomain` 声明配置域，`DOMAINS` 统一驱动启动校验及依赖注入令牌注册。
- `config/default.yaml`：共享基线；依次被 `<environment>.yaml` 和 `<environment>.local.yaml` 覆盖。
- `libs/core/src/core.module.ts`：集中注册 `APP_*` 全局增强器。
- `libs/core/src/filters/all-exceptions.filter.ts`：已将 HTTP 429 映射为业务码 42900，保留公开提示。
- `libs/common/src/adapters/fastify.adapter.ts`：统一创建 Fastify 适配器，当前已设置 `trustProxy: true`。
- 工作区已安装 `@nestjs/throttler@6.7.1`，依赖声明和锁文件已有用户修改，本次沿用。

## 方案选择

采用“配置域 + CoreModule 直接装配官方模块与守卫”。配置归配置层，HTTP 行为归基础设施层，业务模块只声明例外策略。

独立新建限流库会增加模块及公共 API，目前没有跨应用自定义策略的需求；自定义守卫或装饰器也没有必要，当前官方版本直接支持 Fastify。

## 配置契约

新增 `throttler` 配置域，导出 `ThrottlerConfig` 类型和 `throttlerConfig` 注入令牌。原始 YAML 使用 kebab-case，解析后的 TypeScript 对象使用 camelCase。

| YAML 字段 | TypeScript 字段 | 默认值 | 校验与含义 |
| --- | --- | --- | --- |
| `enabled` | `enabled` | `true` | 使用现有布尔解析规则；关闭后跳过全部限流，包括声明 `@Throttle()` 的接口 |
| `ttl` | `ttl` | `60000` | 正整数，单位毫秒，计数有效期 |
| `limit` | `limit` | `100` | 正整数，同一计数键允许的请求数量 |
| `block-duration` | `blockDuration` | 未设置 | 可选的非负整数，单位毫秒；省略时由官方守卫采用该接口最终生效的 `ttl`；`0` 表示不附加封禁，等待计数过期后恢复 |

数值字段接受整数或可转换为整数的非空数字字符串；拒绝布尔值、空白字符串、数组、对象、非有限数和小数。`ttl` / `limit` 拒绝零及负数，`block-duration` 拒绝负数。复用现有解析器，必要的类型约束局限于新配置域，不改变其他配置域的行为。缺失值沿用现有解析约定。

`blockDuration` 必须保持可选，不能在配置解析阶段填入全局 `ttl`，否则接口通过 `@Throttle()` 覆盖 `ttl` 时仍会继承旧封禁时长。

共享配置示例（每一项附中文说明）：

```yaml
throttler:
  # 是否启用全部 HTTP 接口的限流
  enabled: true
  # 同一客户端对每个接口的计数有效期，单位毫秒
  ttl: 60000
  # 在有效期内允许的请求数量
  limit: 100
  # 超限后的封禁时长，单位毫秒；省略时使用接口生效的 ttl，0 表示不附加封禁
  # block-duration: 60000
```

环境差异继续写入现有环境 YAML，无需新增环境变量加载途径。

## 模块装配与请求行为

`CoreModule` 导入 `ThrottlerModule.forRootAsync()`，通过 `throttlerConfig.KEY` 注入已校验的配置。根应用继续先初始化 `AppConfigModule.forRoot()`，与现有 LoggerModule 的配置依赖约定保持一致。

在 `CoreModule` 通过 `APP_GUARD` 注册官方 `ThrottlerGuard`。仅配置一组名为 `default` 的策略，向官方模块传入：

- `throttlers: [{ ttl, limit, blockDuration }]`；
- `skipIf` 根据 `enabled` 跳过全部限流；
- `errorMessage` 复用已有 `DEFAULT_BUSINESS_MESSAGE[BUSINESS_CODE.TOO_MANY_REQUESTS]`。

请求链路为：Fastify 请求 → 官方全局限流守卫 → 控制器；超限时由已有异常过滤器输出错误。

计数键及 IP 规范化沿用官方实现：客户端 IP + 控制器/处理方法 + 策略名。每个处理方法独立计数；同一方法的路径参数或查询参数不会创建新额度。这里的“全局”表示守卫覆盖所有接口，不表示全部接口共用一个请求额度。计数存于进程内存，进程重启即清空，不在多进程间共享。

客户端身份使用 Fastify 的 `request.ip`，沿用当前适配器的代理设置，不自行解析转发头。使用反向代理部署时，代理需可靠覆盖客户端传入的转发头。

## 错误与响应头

超限返回 HTTP 429，JSON 为：

```json
{ "code": 42900, "data": null, "message": "请求过于频繁" }
```

保留官方默认的响应头行为：允许的请求带 `X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`；拒绝的请求带 `Retry-After`。时间响应头遵循官方定义，使用秒，与配置中的毫秒区分。

不修改现有异常过滤器，不把官方异常响应体直接暴露给客户端。

## 业务使用

默认无需在控制器或方法上添加装饰器。需要覆盖时直接从 `@nestjs/throttler` 导入：

```ts
import { SkipThrottle, Throttle, seconds } from '@nestjs/throttler';

// 写在控制器或方法上：每分钟最多 5 次
@Throttle({ default: { limit: 5, ttl: seconds(60) } })

// 写在控制器或方法上：豁免限流
@SkipThrottle()

// 在已豁免的控制器内，为特定方法恢复限流
@SkipThrottle({ default: false })
```

README 增补配置位置、默认行为、时间单位、装饰器示例、代理前提和单进程存储边界。

## 验证策略

1. 配置域测试：默认值、合法 YAML 字段映射、开关解析、可选封禁时长、非法类型与数值。通过配置编译入口证明非法限流配置参与启动校验。
2. Fastify 请求测试：使用真实 `CoreModule` 与配置令牌覆盖较小额度，证明全局装配、阈值拒绝、429 统一响应及头部、IP 和处理方法间隔离、查询及路径参数不绕过计数、方法和控制器覆盖/豁免、配置关闭时装饰器也不触发限流。
3. 恢复测试：使用受控时间验证计数有效期、封禁结束后的恢复，以及省略 `block-duration` 时跟随接口覆盖后的 `ttl`。
4. 执行相关测试、既有网关 e2e、TypeScript 构建及改动文件的只读 lint；有失败时对照基线，避免扩大修复范围。

现有仅导入 `CoreModule` 的测试需要显式初始化配置模块，符合 CoreModule 新增的配置前置依赖。测试适配 Vitest 未生成构造参数元数据的问题时沿用既有测试习惯，不改生产代码规避测试工具限制。

## 基线与修改边界

设计前已验证 `pnpm build` 和现有 `pnpm test:e2e`（5 项）通过。`pnpm test` 为 25 项通过、4 项失败，并有 1 项日志测试引发的未处理异常；失败涉及既有 API 前缀默认值和日志轮转/目录初始化。

只修改新配置域与注册表、CoreModule 装配、默认 YAML、直接受影响的测试及使用文档。保留工作区原有的日期装饰器、依赖声明和锁文件修改；不修复与限流无关的已有测试问题。

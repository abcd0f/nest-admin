# Core HTTP 基础设施设计

日期：2026-10-19

状态：待用户审阅；本文是设计，不代表核心功能已经实现。

## 1. 目标与项目事实

用户要求优先完善统一业务状态码、业务异常、全局异常过滤器、统一响应包装拦截器与管道，强调 core 的核心职责、高内聚、低耦合和扩展性。

当前项目采用 NestJS monorepo、Fastify、ESM、TypeScript strict、class-validator、class-transformer 和 Vitest。core 只有空模块、目录出口、日期装饰器和原始响应装饰器，尚未被 gateway 导入。

现有约定和验证证据：

- 同级 `frontend/apps/web-ele/src/api/request.ts` 使用 `code`、`data`，成功码为 `0`，错误提示读取 `message`。按这一已存在的集成约定设计响应，但本次不修改前端。
- `libs/common/src/dto/base.dto.ts` 和 `dto-transformer.ts` 的注释约定参数校验失败返回 HTTP 422。
- `@RawResponse()` 已支持控制器和方法级元数据，保留这个公共入口。
- logger 库当前没有日志行为；本次过滤器使用 Nest Logger，不依赖空的 LoggerService，也不扩展 logger 库。
- `pnpm test`：2 个测试通过。`pnpm build`：通过。
- `pnpm test:e2e`：失败，现有测试仍从 `../src/app.module.js` 导入已经迁移的模块，并默认创建 Express 应用，与实际 Fastify 启动方式不一致。

## 2. 方案选择与取舍

推荐直接利用 Nest 的依赖注入和全局增强器：core 提供契约、异常和 HTTP 基础设施，在 CoreModule 内统一注册，在 gateway 根模块导入一次。

相比把所有行为写入 main.ts，这能保留依赖注入、独立测试和统一装配入口；相比引入通用错误注册中心、动态配置框架、全套协议适配层，这个方案能完成当前 HTTP 应用的完整链路，且维护面更小。

此次业务异常采用 Nest HttpException 的子类。这会依赖 Nest 的 HTTP 契约，但符合当前 HTTP 应用，也能与原生异常处理机制协作。将来如果出现独立于 HTTP 的领域模型，再在业务边界引入纯领域异常及其映射，不提前增加抽象层。

## 3. 模块边界

| 单元 | 负责 | 直接依赖 |
| --- | --- | --- |
| constants | 平台通用业务码、默认提示与 HTTP 到业务码映射 | Nest 的 HttpStatus 常量（需要时） |
| interfaces | 响应契约、错误定义、字段校验错误类型 | TypeScript 类型 |
| exceptions | 表达可预期业务失败，保留原因链 | 公共错误契约、HttpException |
| pipes | DTO 实例转换与校验、规范化字段错误 | Nest ValidationPipe、class-validator |
| filters | 将异常转换为 HTTP 错误响应，记录服务端错误 | 错误契约、HttpAdapterHost、Nest Logger |
| interceptors | 为普通成功结果增加统一响应外壳 | 响应契约、Reflector、已有 RawResponse 元数据 |
| CoreModule | 通过 APP_FILTER、APP_PIPE、APP_INTERCEPTOR 装配 | 上述 HTTP 组件 |

依赖方向：`gateway -> core`，`业务模块 -> core 公共契约`。core 不反向导入 common、具体业务、数据库或 gateway。现有 `common -> core/decorators` 的依赖不会形成环。

core 的根出口导出本次公开能力，各子目录保留对应出口。内部使用具体文件路径导入，避免经根出口产生循环引用。保持现有 `.js` ESM 导入风格。

## 4. 状态码与响应契约

HTTP 状态描述请求在协议层的结果，业务码描述应用层原因；失败保留真实的 HTTP 4xx/5xx，普通 POST 保留 Nest 默认的 201。

通用业务码约定：

| 业务码 | 含义 | 默认 HTTP 状态 |
| --- | --- | --- |
| 0 | 成功 | 保留原接口状态 |
| 40000 | 请求不合法 | 400 |
| 40100 | 未认证 | 401 |
| 40300 | 无访问权限 | 403 |
| 40400 | 资源不存在 | 404 |
| 40900 | 资源冲突 | 409 |
| 42200 | 参数校验失败 | 422 |
| 42900 | 请求过于频繁 | 429 |
| 50000 | 系统内部错误 | 500 |
| 50300 | 服务不可用 | 503 |
| 100000 | 通用业务失败 | 400 |

其他 HTTP 异常使用 `HTTP 状态 * 100` 的稳定映射，保留原状态。平台区间为 40000–59999；业务模块从 100001 起按模块分配代码段，定义各自只读错误常量，不向 core 添加每一个业务场景。

正常响应：

```json
{ "code": 0, "data": { "id": "example" }, "message": "操作成功" }
```

错误响应：

```json
{ "code": 40400, "data": null, "message": "资源不存在" }
```

校验错误响应（HTTP 422）：

```json
{
  "code": 42200,
  "data": null,
  "message": "请求参数校验失败",
  "errors": [
    { "field": "items.0.name", "messages": ["name should not be empty"] }
  ]
}
```

`message` 始终为字符串，`errors` 仅提供字段路径和校验提示，不包含 DTO target、原始输入或异常堆栈。成功接口返回 undefined 时，data 规范化为 null；false、0、空字符串和空数组保持原值。

这次不默认增加时间戳、请求路径或 requestId 字段；当前没有请求上下文基础设施，这些字段也不是现有前端契约的要求。

## 5. 业务异常

提供 BusinessException 和只读 BusinessErrorDefinition。错误定义包含非零业务码、面向用户的默认消息和默认 HTTP 错误状态；异常构造时允许明确覆盖消息并传入 cause。

业务模块定义自己的错误常量后直接抛出 BusinessException。消息用于展示，业务码用于客户端判断，cause 用于服务器排查。core 不根据消息字符串判断错误类型，也不维护可变的全局业务错误注册表。

校验失败通过同一异常契约携带受控的字段错误，避免过滤器重新理解 class-validator 的树结构。普通业务失败无需继承大量细分异常类。

## 6. 全局异常过滤器

处理顺序：

1. BusinessException：提取稳定业务码、HTTP 状态及公开的消息或字段错误。
2. Nest HttpException：保留 HTTP 状态，使用平台业务码；只提取公开消息，不透传任意响应对象。
3. 未知错误或非 Error 抛出值：统一 HTTP 500、50000 和固定安全提示。

所有 HTTP 5xx 对外使用安全提示，内部记录原始异常及可用堆栈。4xx 使用可理解的业务或框架提示。日志不默认输出请求体、Authorization、Cookie 或完整查询参数。

通过 HttpAdapterHost 写回响应，不调用 Express 的 response.json 或 Fastify 的 reply.send 等平台专用 API。响应头已经发送时不尝试再次写入 JSON。

过滤器负责错误响应，成功拦截器不捕获并重新包装异常。格式错误 JSON、请求体过大等 Fastify 已适配的 HTTP 异常，也进入相同规范化路径。

本次定义的适用范围是 HTTP；不宣称 RPC 或 WebSocket 错误已得到支持。

## 7. 统一响应拦截器

普通控制器只返回业务数据，由拦截器添加外壳。每次请求只有一个统一包装位置。

方法或控制器上的 `@RawResponse()` 跳过成功包装；异常仍由全局过滤器统一处理。这个装饰器不改变已有注释中的成功响应语义。

保留 Nest 的特殊响应机制：StreamableFile、SSE、重定向、模板渲染和 HTTP 无实体响应（204、205、304）不进入普通 JSON 包装。测试这些边界，避免下载内容、SSE 事件或重定向 URL 被外壳破坏。

不使用“对象含 code、data、message 就认为已包装”的猜测逻辑，因为这些字段也可能是合法业务数据。确实需要手动构造完整响应的接口显式使用 `@RawResponse()`。直接使用 `@Res()` 的接口由 Nest 原生机制管理，明确建议只在必要的特殊接口使用。

## 8. 全局校验管道

在 Nest ValidationPipe 上集中定义项目策略：

- transform: true，将 DTO 转换为对应实例。
- whitelist: true、forbidNonWhitelisted: true，拒绝 DTO 未声明的输入字段，避免静默接受拼写错误。
- forbidUnknownValues: true，拒绝不能按预期校验的值。
- enableImplicitConversion: false，数值、布尔值等由 DTO 的显式装饰器决定转换方式，避免隐式转换掩盖错误。
- validationError.target 和 validationError.value 均为 false。
- 递归展开嵌套对象及数组的校验错误，生成稳定字段路径。
- 校验失败返回 HTTP 422 和 42200，与已有 DTO 约定一致。

不重新实现 ValidationPipe，不全局 trim 字符串，不修改已有日期装饰器，不为每一种内置 Parse 管道创建包装类。显式 ParseIntPipe 等管道抛出的 HTTP 异常仍经全局过滤器规范化，保留其原 HTTP 状态。

当前 Vitest 使用的转换链未保证 emitDecoratorMetadata。涉及 DTO 参数类型的 HTTP 验证必须显式确认运行时元数据存在；必要时只为测试补充元数据，不把测试限制带入生产 API。

## 9. 装配与变更范围

- 在 `libs/core/src` 增加上面列出的契约、异常、过滤器、拦截器、管道及其测试，更新 CoreModule 和目录出口。
- 在 `apps/gateway/src/app.module.ts` 中导入 CoreModule，main.ts 不重复注册全局增强器。
- 更新 `test/app.e2e-spec.ts`：使用迁移后的路径和 FastifyAdapter，通过实际 HTTP 注入验证统一链路。
- 提供 core 的使用说明，包括业务错误定义、抛异常、DTO 校验和 RawResponse 示例。
- 只调整完成这些功能所必要的既有文件；不改 common 的现有 DTO 行为，不扩展认证、缓存、数据库、日志库或配置库。

不引入新的生产依赖，不为了填满目录增加无实际行为的 guard、middleware 或 service，不建立 forRoot/forFeature 配置体系。

兼容变化：导入 CoreModule 后，根 GET 的响应从 `Hello World!` 变为统一 JSON；DTO 额外字段会返回 422。没有现存业务接口需要迁移。这两项是有意引入的全局 API 契约。

## 10. 验收条件

| 场景 | 可观察结果 |
| --- | --- |
| 普通 GET、POST | 包装一次；业务码 0；保留 HTTP 200/201 |
| false、0、空串、null、undefined | 不丢失假值；无值结果的 data 为 null |
| 自定义业务错误 | 保留业务码和指定的 HTTP 错误状态 |
| 原生 HTTP 400/401/403/404/409/429 | 使用统一外壳并保留 HTTP 状态 |
| 同步 Error、异步 rejection、抛出非 Error | 返回安全 500；不泄露内部消息 |
| 显式构造的 HTTP 5xx | 保留状态；不泄露内部原因 |
| 合法 DTO 与 PageQueryDto | 按显式转换规则校验，保留分页默认值 |
| DTO 额外字段、越界分页、嵌套数组错误 | HTTP 422、42200、可定位的字段错误 |
| malformed JSON | HTTP 400，统一错误外壳 |
| 方法级/控制器级 RawResponse | 成功响应原样返回 |
| StreamableFile、SSE、redirect、204/205/304 | 保留对应 Nest/HTTP 语义 |
| 已发送响应 | 不重复写回 |
| 业务数据含 code/data/message | 作为普通数据包装，不误判 |

最终执行单元测试、Fastify 端到端测试、构建与变更文件的非自动修复 lint。对测试发现的既有问题仅修复阻碍本次功能验证的部分。通过上述条件后停止扩展。

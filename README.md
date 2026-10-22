<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Redis 与缓存

网关已全局注册 `@app/cache`，直接注入 `CacheService` 使用 JSON 缓存，注入 `RedisService` 使用会话、一次性令牌、原子计数、租约锁与原生数据结构；整个应用共用一个连接。配置、示例、故障语义和单连接边界见 [Redis 模块文档](libs/cache/README.md)。

## Swagger 接口文档

启动 `pnpm start:dev` 后，开发环境默认地址：

- Swagger UI：`http://localhost:6688/api/docs`
- OpenAPI JSON：`http://localhost:6688/api/docs-json`
- OpenAPI YAML：`http://localhost:6688/api/docs-yaml`

文档路由自动跟随 `app.api-prefix`。在 `config/default.yaml` 的 `swagger` 节点可修改 `enabled`、`path`、`title`、`description` 和 `version`；生产环境在 `config/production.yaml` 中默认关闭，需要时可在 `config/production.local.yaml` 中设置 `swagger.enabled: true`。

项目已在 `nest-cli.json` 中启用官方 `@nestjs/swagger` 编译插件及 `introspectComments`。DTO 使用 `.dto.ts` 或 `.entity.ts` 文件名，声明为导出的 class，直接用文档注释描述字段，无需手写 `@ApiProperty()`：

```ts
// user.dto.ts
export class UserDto {
  /**
   * A list of user's roles
   * @example ['admin']
   */
  roles!: string[];

  /**
   * 用户昵称
   * @example '张三'
   */
  nickname?: string;
}
```

注释正文生成字段 `description`，`@example` 生成示例；插件根据 TypeScript 类型推导字段类型和数组元素，根据 `?` 判断是否必填。已有 `class-validator` 装饰器中的 `@Min()`、`@Max()` 等约束也会同步到文档；校验装饰器仍按业务需要保留，注释本身不执行运行时校验。

控制器使用 `.controller.ts` 文件名，方法注释生成接口摘要，`@remarks` 生成详细说明。声明具体的返回 DTO 类型，插件即可生成响应模型，无需手写 `@ApiOperation()`、`@ApiResponse()`：

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { UserDto } from './user.dto.js';

@Controller('users')
export class UsersController {
  /**
   * 创建用户
   * @remarks 根据提交的角色和昵称创建用户。
   */
  @Post()
  create(@Body() body: UserDto): UserDto {
    return body;
  }
}
```

DTO 应使用普通值导入，避免 `import type` 擦除运行时模型。TypeScript interface、内联对象以及泛型不能完整保留运行时模型；需要自动生成准确文档时，定义具体 DTO class，并使用具体的嵌套字段类型。

注释解析发生在编译阶段，使用 `pnpm start`、`pnpm start:dev` 或 `pnpm build`（均经过 Nest CLI）。单独运行 `tsc`、`tsx` 或 Vitest 默认转换链不会执行该插件。修改 `nest-cli.json` 后重启开发服务；`removeComments: true` 可以保留，因为插件会在移除注释前提取元数据。

## HTTP 限流

`CoreModule` 统一注册 `@nestjs/throttler` 的全局守卫，配置由 `AppConfigModule.forRoot()` 提前加载和校验。业务模块导入现有基础设施后，接口默认参与限流。

默认按客户端 IP 和控制器处理方法分别计数：每个接口在 60 秒内最多请求 100 次。修改同一接口的查询参数或路径参数不会获得新的额度。计数使用进程内存，重启清空，适用于单实例；多个进程的额度不共享。

在 `config/default.yaml` 配置默认规则，也可通过 `config/<环境>.yaml` 或 `config/<环境>.local.yaml` 覆盖：

```yaml
throttler:
  # 总开关；false 时所有接口都跳过限流，包括使用 @Throttle() 的接口
  enabled: true
  # 计数有效期，单位毫秒，必须为正整数
  ttl: 60000
  # 允许的请求数量，必须为正整数
  limit: 100
  # 超限后的封禁时长，单位毫秒；省略时采用接口最终生效的 ttl
  # block-duration: 60000
```

`block-duration` 可设为 `0`，表示不附加封禁，最早的计数过期后即可继续请求。关闭限流请使用 `enabled: false`。非法配置在启动阶段报错。

使用官方装饰器即可覆盖或豁免控制器、方法，不需要额外注册守卫：

```ts
import { Controller, Get, Post } from '@nestjs/common';
import { SkipThrottle, Throttle, seconds } from '@nestjs/throttler';

@Controller('example')
@Throttle({ default: { limit: 30, ttl: seconds(60) } }) // 可选：覆盖整个控制器
export class ExampleController {
  @Post('sensitive')
  @Throttle({ default: { limit: 5 } }) // 只覆盖次数，继承控制器的时间窗口
  sensitive() {
    return { ok: true };
  }

  @Get('health')
  @SkipThrottle() // 豁免此方法
  health() {
    return 'ok';
  }
}
```

也可在控制器上使用 `@SkipThrottle()` 豁免整个控制器，再在特定方法上使用 `@SkipThrottle({ default: false })` 恢复限流。策略名使用 `default`；装饰器的 `ttl` / `blockDuration` 同样以毫秒为单位，可使用官方的 `seconds()` 等时间工具。

超限返回 HTTP `429` 和统一错误体：

```json
{ "code": 429, "data": null, "message": "请求过于频繁" }
```

允许的请求带有 `X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset` 响应头；拒绝的请求带有 `Retry-After`。时间响应头使用秒。

客户端身份沿用 Fastify `request.ip`。当前适配器已启用 `trustProxy: true`，通过反向代理部署时，代理需可靠覆盖客户端传入的转发头，保证限流使用正确的客户端地址。

## API AES/RSA 加密

网关通过 `CryptoModule` 提供 API 报文加密，默认关闭。在不入库的 `config/<环境>.local.yaml` 或部署密钥挂载中启用：

```yaml
api-decrypt:
  enabled: true
  header-flag: encrypt-key
  private-key: <PKCS8 RSA 私钥 Base64>
  public-key: <SPKI RSA 公钥 Base64>
```

控制器从 `@app/crypto` 导入装饰器即可接入：

```ts
@Post()
@ApiEncrypt({ response: true })
create(@Body() body: CreateUserDto) {
  return this.userService.create(body);
}
```

完整协议、密钥格式、支持的 HTTP 方法、错误处理和 `PasswordHashService` 用法统一见 [Crypto 模块说明](libs/crypto/README.md)。

## Redis 缓存

`@app/cache` 已接入网关，默认关闭缓存，不要求本机运行 Redis。模块只依赖 `ioredis`，不使用 Keyv、cache-manager 或 `@nestjs/cache-manager`。开关、默认 TTL 和连接选项统一放在 `redis` 下，配置沿用现有分层 YAML。在 `config/development.local.yaml` 中覆盖以下配置，确保 Redis 已运行，再执行 `pnpm start:dev`：

```yaml
redis:
  enabled: true
  ttl: 60000 # 毫秒
  host: 127.0.0.1
  port: 6379
```

其余连接、重连、TLS、TTL 抖动和值大小选项见 `config/default.yaml`。已有本地配置需将原 `cache` 下的 `enabled`、`ttl` 移到 `redis` 下。生产凭据通过不入库的 `config/production.local.yaml` 挂载。

`CacheModule` 已标记为全局模块，业务模块可直接注入 `CacheService` 使用 `get/getMany/set/del/delMany/wrap`。TTL 统一为正整数毫秒，默认 60000，禁止 0/永久缓存。启用时连接失败阻止启动；运行期读取失败按未命中处理，写入、删除以及 wrap 的写入失败会抛出稳定错误。值使用版本化 JSON 编码，仅接受 JSON 安全的普通数据；旧 Keyv 条目会按未命中处理并在 TTL 后自然淘汰。

```ts
const user = await this.cache.wrap(`users:v1:${id}`, () => this.repo.findById(id), 30_000);
const health = await this.cache.health(); // up / down / disabled
const metrics = this.cache.getMetrics();
```

完整分层、配置表、失败语义、并发约定和生产接入清单见 [Cache 模块说明](libs/cache/README.md)；业务接入示例与 API 速查见 [Cache 使用文档](libs/cache/USAGE.md)。

```sh
# REDIS_TEST_URL 指向本机独立测试 Redis 后运行
pnpm test:cache:e2e
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

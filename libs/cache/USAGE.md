# Cache 模块使用文档

本文面向业务开发，说明如何在项目中使用 `@app/cache`。架构、配置字段和生产运维建议见 [README.md](README.md)。

## 目录

- [1. 快速开始](#1-快速开始)
- [2. API 速查](#2-api-速查)
- [3. 典型用法](#3-典型用法)
- [4. 键与值规则](#4-键与值规则)
- [5. 错误处理与降级](#5-错误处理与降级)
- [6. 健康检查与指标](#6-健康检查与指标)
- [7. 测试](#7-测试)
- [8. 常见问题](#8-常见问题)
- [9. 边界与限制](#9-边界与限制)

## 1. 快速开始

### 1.1 启用 Redis

默认 `redis.enabled: false`，此时不会创建 Redis 连接，缓存调用会安全退化。开发环境在 `config/development.local.yaml`（不入库）中启用：

```yaml
redis:
  enabled: true
  host: 127.0.0.1
  port: 6379
  # 默认 TTL，单位毫秒；不写时使用 default.yaml 的 60000
  ttl: 60000
```

生产环境通过部署平台或 `config/production.local.yaml` 注入地址、ACL 凭据和 TLS 配置，不要把密码提交到仓库。完整配置项见 [README.md#配置](README.md#配置)。

### 1.2 注入 CacheService

`CacheModule` 已标记为 `@Global()`，并在 `AppModule` 中导入。业务模块不需要重复 import，直接构造注入即可：

```ts
import { CacheService } from '@app/cache';
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  constructor(
    private readonly cache: CacheService,
    private readonly userRepository: UserRepository,
  ) {}

  findOne(id: string) {
    return this.cache.wrap(
      `users:v1:${id}`,
      () => this.userRepository.findById(id),
      30_000,
    );
  }
}
```

> 初始化顺序：`AppConfigModule.forRoot()` 必须先于 `CacheModule`。当前 `AppModule` 已经按该顺序声明，新增入口时不要打乱。

## 2. API 速查

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | 读取并解码；未命中返回 `undefined` |
| `getMany` | `getMany<T>(keys: readonly string[]): Promise<(T \| undefined)[]>` | 批量读取，按传入顺序返回 |
| `set` | `set<T>(key: string, value: T, ttl?: number): Promise<void>` | 写入；省略 TTL 时使用 `redis.ttl` |
| `del` | `del(key: string): Promise<boolean>` | 删除单个键，返回是否真的删除 |
| `delMany` | `delMany(keys: readonly string[]): Promise<number>` | 批量删除，返回实际删除数量 |
| `has` | `has(key: string): Promise<boolean>` | 存在性检查 |
| `ttl` | `ttl(key: string): Promise<number>` | 剩余毫秒；`-1` 无过期、`-2` 不存在 |
| `wrap` | `wrap<T>(key: string, loader: () => Promise<T>, ttl?: number): Promise<T>` | 读取；未命中时执行 loader 并写回 |
| `health` | `health(): Promise<RedisHealth>` | Redis 健康状态 |
| `getMetrics` | `getMetrics(): Readonly<CacheMetrics>` | 获取进程内累计指标 |
| `resetMetrics` | `resetMetrics(): void` | 重置指标，主要用于测试或周期采集 |

`CacheService` 只接收**业务键**，全局前缀由配置统一拼接，不要在业务代码里重复写 `nest-admin:cache`。

## 3. 典型用法

### 3.1 Cache-Aside：读时加载

最常用的模式是 `wrap`：先读缓存，未命中再查数据库并回填。

```ts
async findOne(id: string): Promise<User> {
  return this.cache.wrap(
    `users:v1:${id}`,
    () => this.userRepository.findByIdOrThrow(id),
    30_000,
  );
}
```

`wrap` 的行为：

1. 缓存命中：直接返回反序列化后的值。
2. 缓存未命中：执行 `loader`，成功后写入缓存并返回。
3. 同一进程内同键并发调用：只执行一次 `loader`，其余调用复用同一个 Promise。
4. `loader` 返回 `undefined`：不写缓存，直接返回 `undefined`。
5. `loader` 返回 `null`：作为合法负缓存写入。
6. 写回失败：`wrap` 抛出 `CacheUnavailableError`，不会静默返回旧值。

### 3.2 更新数据后失效缓存

推荐「先更新数据库，再删除缓存」。删除失败会抛错，调用方应感知：

```ts
async update(id: string, data: UpdateUserDto): Promise<User> {
  const user = await this.userRepository.update(id, data);
  await this.cache.del(`users:v1:${id}`);
  return user;
}
```

如果同时维护列表缓存，可以批量删除相关键：

```ts
await this.cache.delMany([
  `users:v1:${id}`,
  'users:list:v1',
  `users:page:v1:1:20`,
]);
```

不要依赖 Redis 事务保证数据库与缓存强一致；缓存是可选读加速，不是唯一数据源。

### 3.3 直接写入缓存

明确知道最新值时，可以跳过 `wrap` 直接写：

```ts
const user = await this.userRepository.update(id, data);
await this.cache.set(`users:v1:${id}`, user, 30_000);
return user;
```

`set` 需要整个值可 JSON 序列化。数据库实体、DTO 等如果包含 `Date`、`Map`、`BigInt` 或类实例，请先转换成普通对象：

```ts
await this.cache.set(`users:v1:${id}`, {
  id: user.id,
  nickname: user.nickname,
  createdAt: user.createdAt.toISOString(),
}, 30_000);
```

### 3.4 负缓存

对确认不存在的记录可以缓存 `null`，降低缓存穿透：

```ts
const user = await this.cache.wrap(
  `users:v1:${id}`,
  async () => (await this.userRepository.findById(id)) ?? null,
  10_000,
);

if (user === null) {
  // 已知不存在；不要与“缓存未命中”混淆
}
```

注意：负缓存 TTL 应短于正常数据，数据创建后必须主动删除对应键，否则会在 TTL 内持续返回 `null`。

### 3.5 批量读取

```ts
const ids = ['1', '2', '3'];
const users = await this.cache.getMany<User>(ids.map((id) => `users:v1:${id}`));

// users[0] 可能是 User，也可能是 undefined（未命中）
```

批量读取失败时，整个结果按未命中降级为 `undefined[]`，业务需要回源。需要回源后批量写回时，当前模块没有 `setMany`，可以对未命中的键使用 `Promise.all`：

```ts
const missingIds = ids.filter((_, index) => users[index] === undefined);
const loaded = await this.userRepository.findByIds(missingIds);

await Promise.all(
  loaded.map((user) => this.cache.set(`users:v1:${user.id}`, user, 30_000)),
);
```

### 3.6 带版本的键

推荐键格式：`<领域>:v<版本>:<标识>`。

```ts
const USER_CACHE_VERSION = 'v1';

function userKey(id: string) {
  return `users:${USER_CACHE_VERSION}:${id}`;
}
```

当缓存值结构发生不兼容变化时，把版本号从 `v1` 升到 `v2`。旧键不再被读取，会按原 TTL 自然淘汰，避免新旧结构混读。

### 3.7 高级命令

常规缓存操作不要直接使用原始客户端。确实需要 pipeline、Lua 或 Redis 模块命令时，注入 `RedisService` 并使用受控逃生口：

```ts
import { RedisService } from '@app/cache';

constructor(private readonly redis: RedisService) {}

async batchGet(keys: string[]): Promise<(string | null)[]> {
  return this.redis.execute(async (client) => {
    // 参数通过命令参数传递，不要拼接用户输入
    return client.mget(...keys);
  });
}
```

`execute` 仍然经过连接就绪检查和统一错误转换。不要绕过 `CacheService` 的键前缀、TTL 和序列化约定去写业务缓存。

## 4. 键与值规则

### 4.1 键

- 业务键不包含全局前缀，最终键为 `<redis.key-prefix>:<业务键>`。
- 完整键最多 **512 字节**，禁止空键和控制字符。
- 键会进入日志、慢查询和监控，禁止放密码、令牌、身份证号等敏感信息。
- 建议只使用字母、数字、`:`、`_`、`-` 等可读字符。

### 4.2 值

支持的类型：

- 字符串、有限数字、布尔值、`null`
- 由上述类型组成的数组
- 键为字符串、值为上述类型的普通对象

会被拒绝的类型：

- `undefined`（包括对象字段或数组元素中的 `undefined`）
- `NaN`、`Infinity`
- `Date`、`Map`、`Set`、类实例
- `BigInt`、函数、Symbol 键
- 循环引用、超过 32 层的嵌套
- 序列化后超过 `redis.max-value-bytes` 的值（默认 1 MiB）

如果业务模型包含上述类型，请在写缓存前显式转换。

### 4.3 TTL

- 单位统一为毫秒，必须是 `1..2147483647` 的整数。
- 禁止 `0` 和永久缓存。
- 省略 TTL 时使用 `redis.ttl`（默认 60000）。
- `redis.ttl-jitter > 0` 时，所有 TTL（包括显式传入）会在 `[ttl - ttl*jitter%, ttl]` 内随机缩短，最低 1 毫秒。

## 5. 错误处理与降级

### 5.1 默认语义

| 场景 | 行为 |
| --- | --- |
| Redis 未启用 | `get/getMany` 返回 `undefined`，`set/del/delMany` 为 no-op，`wrap` 直接执行 loader |
| 读取失败 | 按未命中返回 `undefined`，计入 `readErrors` |
| `has` 失败 | 返回 `false`，计入 `readErrors` |
| 写入失败 | 抛出 `CacheUnavailableError` |
| 删除失败 | 抛出 `CacheUnavailableError` |
| `ttl` 失败 | 抛出 `CacheUnavailableError` |
| `wrap` 读失败 | 继续执行 loader |
| `wrap` 写失败 | 抛出 `CacheUnavailableError` |

读取失败是「fail-open」，写入和删除失败是「fail-closed」。这样缓存故障不会阻断读路径，但调用方不会误以为写操作已经生效。

### 5.2 捕获缓存错误

```ts
import { CacheUnavailableError } from '@app/cache';

try {
  await this.cache.set(`users:v1:${id}`, user, 30_000);
} catch (error) {
  if (error instanceof CacheUnavailableError) {
    // 记录告警；根据业务决定是否让请求失败
    this.logger.warn('缓存写入失败，数据已写入数据库');
  }
  throw error;
}
```

错误消息固定为「Redis 缓存命令执行失败」或「Redis 缓存未启用」，不会泄露连接串、ACL 凭据或 ioredis 原始错误。原始异常仅作为 `cause` 保留在进程内，排查时查看应用日志。

### 5.3 参数错误

以下错误是编程错误，不依赖 Redis 状态，即使缓存关闭也会抛出：

- `CacheKeyError`（继承 `TypeError`）：空键、控制字符、超长键。
- `CacheTtlError`（继承 `RangeError`）：非法 TTL。
- `CacheValueError`（继承 `TypeError`）：不可序列化或超过大小限制的值。

## 6. 健康检查与指标

### 6.1 健康检查

```ts
const health = await this.cache.health();

// 启用且可用
// { status: 'up', latencyMs: 1 }

// 启用但不可用
// { status: 'down', latencyMs: 1001, error: 'Redis 不可用' }

// 未启用
// { status: 'disabled', latencyMs: 0 }
```

可以把结果接入现有健康检查接口，但不要把 `status: 'down'` 直接等同于应用不可用；是否阻塞流量取决于缓存对业务的重要程度。

### 6.2 指标

```ts
const metrics = this.cache.getMetrics();

const total = metrics.hits + metrics.misses;
const hitRate = total === 0 ? 0 : metrics.hits / total;
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `hits` | `get/getMany/wrap` 命中次数 |
| `misses` | 未命中次数 |
| `sets` | 成功写入次数 |
| `deletes` | 实际删除的键数量 |
| `readErrors` | 读取命令失败次数 |
| `writeErrors` | 写入命令失败次数 |
| `deleteErrors` | 删除命令失败次数 |
| `decodeErrors` | 值解码失败次数 |
| `coalesced` | 被 `wrap` single-flight 合并的并发加载次数 |

指标是**进程内**累计值，不跨实例聚合。多实例部署时，应在每个实例采集后汇总，或接入 Prometheus 等指标系统。

## 7. 测试

```sh
# 单元测试，不需要 Redis
pnpm test:cache

# 连接真实 Redis 的 e2e
REDIS_TEST_URL=redis://127.0.0.1:6379/0 pnpm test:cache:e2e
```

Windows PowerShell：

```powershell
$env:REDIS_TEST_URL = 'redis://127.0.0.1:6379/0'
pnpm test:cache:e2e
```

e2e 会使用随机前缀，不会清空现有数据。未设置 `REDIS_TEST_URL` 时，外部 Redis 用例会跳过，但仍会验证关闭缓存和启动失败路径。

## 8. 常见问题

### 8.1 启动时报 `Redis 连接失败`

应用在启动阶段对 Redis 是快速失败的。检查：

1. `redis.enabled` 是否误开。
2. `host`、`port`、`db` 是否可达。
3. ACL 用户名/密码是否正确。
4. TLS 是否启用，CA 是否通过 `NODE_EXTRA_CA_CERTS` 提供。
5. 网络策略、容器 DNS、Redis 最大连接数是否正常。

### 8.2 运行期日志出现 `Redis 缓存命令执行失败`

先调用 `cache.health()` 确认状态，再检查：

- Redis 是否短暂断连，客户端是否已经自动重连。
- 当前 ACL 是否允许对应命令（例如批量删除需要 `UNLINK`）。
- 命令是否超过 `redis.command-timeout`。
- Redis 是否触发 `maxmemory` 限制。
- 写入值是否触发 Redis 的协议或内存限制。

### 8.3 `get` 一直返回 `undefined`

按顺序检查：

1. `redis.enabled` 是否为 `true`。
2. 读写是否使用了完全相同的业务键。
3. `key-prefix` 是否在环境之间不一致。
4. 值是否已经超过 TTL 过期。
5. 是否读到了旧 Keyv/cache-manager 写入的键：新编码要求 `v1:` 前缀，旧值会按未命中处理。
6. 是否出现 `decodeErrors`，可查看日志中的解码失败告警。

### 8.4 `wrap` 的 loader 成功但请求仍然失败

说明 loader 之后的缓存写回失败。Redis 不可用、ACL 不允许 `SET` 或值超过大小限制都会导致该行为。如果缓存对当前业务是可选的，可以捕获 `CacheUnavailableError` 并返回 loader 结果；否则让请求失败是更安全的选择。

### 8.5 多实例重复执行 loader

`wrap` 的 single-flight 只在**当前进程内**生效。多实例同时未命中时，每个实例都可能执行一次 loader，这是预期行为。TTL 抖动可以降低同时过期概率；如果需要跨实例互斥，应使用独立的分布式锁方案，而不是把锁逻辑塞进缓存键。

### 8.6 内存持续增长

- 检查是否存在高基数、低命中的键。
- 确认 `ttl` 不是过长，且没有遗漏 TTL。
- 检查 `max-value-bytes` 是否被调得过大。
- 为 Redis 配置 `maxmemory` 和合适的 `maxmemory-policy`。
- 不要把会话、队列、排行榜等非缓存数据放进同一个键空间。

## 9. 边界与限制

- 只支持单机 Redis，不包含 Cluster/Sentinel 拓扑。
- 不提供 pub/sub、分布式锁、缓存标签/通配删除。
- 缓存值编解码固定为 `v1:` + JSON，不支持自定义序列化器。
- 缓存不是唯一数据源，不提供跨数据库与 Redis 的强一致事务。
- `getMany/delMany` 适合有限批量；超大集合应在业务层分页或分批。
- 原始 `RedisClient` 仅用于测试、健康检查和极少数高级场景，业务代码应使用 `CacheService`。

生产接入清单和安全建议见 [README.md#生产接入清单](README.md#生产接入清单)。

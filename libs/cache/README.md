# Cache 模块使用说明

`@app/cache` 是仅基于 `ioredis` 的 Redis 缓存基础设施，不依赖 Keyv、cache-manager 或 `@nestjs/cache-manager`。模块把「连接生命周期」「Redis 命令」「缓存语义」拆成三层，业务代码通常只需要注入 `CacheService`。

面向业务开发的快速接入、API 速查、典型用法和常见问题见 [USAGE.md](USAGE.md)；本文侧重于架构、配置与运维约定。

运行环境要求 Redis 4.0+（批量删除使用 `UNLINK`）；使用 ACL 用户名/密码需要 Redis 6.0+。

## 分层结构

| 层 | 类 | 职责 |
| --- | --- | --- |
| 连接层 | `RedisClient` | 创建/关闭 ioredis 客户端，启动快速失败、运行期指数退避重连、优雅退出、移除监听器 |
| 命令层 | `RedisService` | 统一的命令入口、健康检查、错误脱敏、`UNLINK` 批量删除、受控 `execute()` 逃生口 |
| 缓存层 | `CacheService` | 键命名空间、版本化 JSON 编解码、TTL/抖动、读取降级、写入失败上抛、`wrap` single-flight、进程内指标 |

ioredis 在一个 TCP 连接上多路复用命令，本模块每个进程只创建一个客户端，不需要额外连接池；不要按请求或按业务模块创建 `Redis` 实例。需要订阅/阻塞命令时应使用独立连接，本模块当前不提供 pub/sub。

模块标记为 `@Global()`，与 `DatabaseModule` 一致。`AppModule` 已导入，业务模块可直接注入，无需重复 import。初始化顺序上，`AppConfigModule.forRoot()` 必须先于 `CacheModule`，确保 `redis` 配置域已解析。

## 配置

配置位于 `config/default.yaml` 的 `redis` 节点，可由 `config/<环境>.yaml` 和 `config/<环境>.local.yaml` 覆盖。凭据不要入库，使用部署平台注入或挂载 local 配置。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关闭时不创建 ioredis 客户端，所有缓存调用退化为 no-op 或直接执行 loader |
| `ttl` | `60000` | 默认缓存毫秒数，1..2147483647，禁止 0 和永久缓存 |
| `ttl-jitter` | `0` | 默认 TTL 的随机缩短百分比，0..100；用于打散同时写入的过期时间 |
| `host` / `port` | `127.0.0.1` / `6379` | 单机 Redis 地址 |
| `username` / `password` | 空 | Redis 6+ ACL 凭据，可选 |
| `db` | `0` | 数据库编号，非负整数 |
| `key-prefix` | `nest-admin:cache` | 全局键前缀，最终键为 `<prefix>:<业务键>` |
| `connection-name` | `nest-admin-cache` | `CLIENT LIST` 中显示的连接名 |
| `connect-timeout` | `2000` | 首次建连超时，毫秒 |
| `command-timeout` | `1000` | 单条命令超时，毫秒 |
| `max-retries-per-request` | `0` | 单条命令重试次数；配合关闭离线队列，故障时快速失败 |
| `retry-delay` | `1000` | 运行期重连指数退避基数，毫秒 |
| `retry-max-delay` | `30000` | 重连最大退避，必须不小于 `retry-delay` |
| `keep-alive` | `30000` | TCP keep-alive 间隔，0 表示关闭 |
| `family` | `0` | 地址族：0 自动、4 IPv4、6 IPv6 |
| `max-value-bytes` | `1048576` | 单个值序列化后的最大字节数 |
| `tls-enabled` | `false` | 是否启用 TLS |
| `tls-reject-unauthorized` | `true` | TLS 是否校验证书链与主机名；生产必须为 true |

启动阶段连接失败会直接阻止应用启动；运行期断线由 ioredis 自动重连。因为显式关闭了 `enableOfflineQueue` 和自动重发，Redis 不可用时命令会立即失败，而不是在内存中无限堆积。

## 使用方式

```ts
import { CacheService } from '@app/cache';
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  constructor(
    private readonly cache: CacheService,
    private readonly repository: UserRepository,
  ) {}

  async findOne(id: string) {
    return this.cache.wrap(`users:v1:${id}`, () => this.repository.findById(id), 30_000);
  }

  async update(id: string, data: UpdateUserDto) {
    const user = await this.repository.update(id, data);
    await this.cache.set(`users:v1:${id}`, user, 30_000);
    return user;
  }

  async remove(id: string) {
    await this.repository.remove(id);
    await this.cache.del(`users:v1:${id}`);
  }
}
```

可用方法：

- `get<T>(key)` / `getMany<T>(keys)`：读取并解码，未命中返回 `undefined`。
- `set<T>(key, value, ttl?)`：写入，省略 TTL 时使用 `redis.ttl`。
- `del(key)` / `delMany(keys)`：删除，返回是否删除/删除数量。
- `has(key)`：存在性检查。
- `ttl(key)`：剩余毫秒，`-1` 无过期、`-2` 不存在；命令失败会抛出。
- `wrap<T>(key, loader, ttl?)`：读取或加载并写回。
- `health()` / `getMetrics()` / `resetMetrics()`：健康检查与进程内指标。

### 键命名约定

- 业务键不包含全局前缀，`CacheService` 只拼接一次，调用方不能绕过命名空间。
- 推荐 `<领域>:v<版本>:<标识>`，例如 `users:v1:42`、`roles:v2:list`。版本号用于数据结构变更时隔离新旧缓存。
- 缓存键会进入日志、慢查询和监控，禁止放入密码、令牌、身份证号等敏感信息。
- 键总长度限制 512 字节，含前缀；禁止控制字符和空键。

### 值与 TTL

- 值使用 `v1:` + JSON 编码，支持字符串、有限数字、布尔值、`null`、数组和普通对象。
- 拒绝 `undefined`、`Date`、`Map`、`Set`、类实例、`BigInt`、函数、Symbol 键、循环引用和超深嵌套，避免解码后类型失真。
- `NaN` 和 `Infinity` 会被 JSON 静默转成 `null`，因此写入前直接拒绝。
- `ttl-jitter > 0` 时所有 TTL（含显式传入）会在 `[ttl - ttl*jitter%, ttl]` 内随机缩短，最低 1 毫秒。
- 旧版本 Keyv/cache-manager 写入的键没有 `v1:` 前缀，新代码会将其视为未命中，等待 TTL 自然淘汰。升级后首次访问是冷缓存，不会读到错误格式的数据。

## 失败语义

| 操作 | Redis 不可用/命令失败 | 说明 |
| --- | --- | --- |
| `get` / `getMany` | 返回 `undefined` | 缓存故障不阻断业务读路径，计入 `readErrors` |
| `has` | 返回 `false` | 同上 |
| `ttl` | 抛出 `CacheUnavailableError` | 诊断类命令不静默降级 |
| `set` | 抛出 `CacheUnavailableError` | 调用方必须知道写入未生效 |
| `del` / `delMany` | 抛出 `CacheUnavailableError` | 删除失败不能假装成功 |
| `wrap` 读缓存 | 继续执行 loader | 读降级 |
| `wrap` 写回 | 抛出 `CacheUnavailableError` | loader 成功但缓存未写入，调用方需感知 |
| `enabled=false` | 读返回 `undefined`，写 no-op | 参数校验仍执行，`wrap` 直接执行 loader |

错误消息固定为「Redis 缓存命令执行失败」，不会拼接 ioredis 原始消息、连接串或 ACL 凭据。需要排查时读取进程日志，异常对象仅作为 `cause` 保留在进程内。

## 并发与一致性

- `wrap` 只做**进程内** single-flight：同一进程内同键并发请求只执行一次 loader。多实例之间不会合并，需要业务接受短暂的重复加载，或使用独立的分布式锁方案。
- TTL 抖动用于降低同一时刻批量过期导致的缓存击穿。
- 缓存是可选读加速，不是唯一数据源。更新数据时应采用「先更新数据库，再删除缓存」等明确的一致性策略，不要依赖缓存事务。
- 本模块面向单机 Redis，不包含 Cluster/Sentinel 拓扑。若后续需要，可在 `RedisClient` 创建处替换连接类型，并保持 `CacheService` 接口不变。

## 健康检查与指标

```ts
const health = await this.cache.health();
// { status: 'up' | 'down' | 'disabled', latencyMs: number, error?: string }

const metrics = this.cache.getMetrics();
// hits / misses / sets / deletes / readErrors / writeErrors /
// deleteErrors / decodeErrors / coalesced
```

指标是进程内累计值，适合暴露到日志或接入 Prometheus 适配器；`resetMetrics()` 主要用于测试和按周期采集。生产建议监控命中率、读取错误率、写入错误率、decode 错误和 Redis 连接数。

## 测试

```sh
# 单元测试（不需要 Redis）
pnpm test:cache

# 连接真实独立 Redis 的 e2e（会创建/删除独立命名空间的键）
REDIS_TEST_URL=redis://127.0.0.1:6379/0 pnpm test:cache:e2e
```

e2e 通过 `REDIS_TEST_URL` 显式启用，未设置时跳过外部 Redis 用例，但仍会验证关闭缓存与启动失败路径。测试覆盖 ACL 只读降级、socket 被 KILL 后重连、优雅关闭和监听器清理。

## 生产接入清单

1. 使用独立 Redis 实例或独立 DB，并为环境设置唯一的 `key-prefix`。
2. 生产启用 ACL 和 TLS；凭据通过密钥管理或挂载文件注入，不提交到仓库。
3. 为缓存实例配置 `maxmemory` 和 `maxmemory-policy`（纯缓存库通常使用 `allkeys-lru`）；不要让缓存挤占会话、队列等关键数据。
4. 保持 `max-retries-per-request: 0` 和离线队列关闭，配合业务超时与降级。
5. 观察命中率、错误率、P99 延迟和连接数；按业务调整 `ttl` 与 `ttl-jitter`。
6. 升级缓存值结构时修改业务键版本，或走独立迁移方案，不要直接改变 `v1:` 编码含义。

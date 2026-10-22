# Redis 与缓存

`CacheModule` 已在网关根模块注册为全局模块，业务服务直接注入 `CacheService` 或 `RedisService`。不要再次注册 Nest 的 `CacheModule.register()`，也不要在业务中创建客户端。

## 架构与依赖

```text
业务服务 ── CacheService ── cache-manager ── Keyv ── SharedRedisStore ─┐
        └─ RedisService ────────────────────────────────────────────┤
                                                                  ↓
                                         RedisClient（唯一连接所有者）
                                                                  ↓
                                                 redis / @redis/client
```

- `redis` 是 node-redis 的完整入口，底层为 `@redis/client`，不是两个独立 Redis 实现。
- 当前兼容组合：`redis` / `@redis/client` **5.12.1**、`@keyv/redis` **5.1.6**、`keyv` **5.6.0**、`cache-manager` **7.2.9**。锁文件固定实际版本。适配器 6 与 Keyv 6 的存储协议发生变化，升级时应整组检查，不能直接混用。
- `redis.client.ts` 负责配置、连接、重连、健康检查与关闭。只有这里调用 `createClient()` 和 `connect()`。
- `redis.store.ts` 把同一个客户端交给适配器；覆盖上游懒连接、断连和清理行为。`cache-manager.disconnect()` 无权关闭共享连接。
- `cache.service.ts` 负责可降级的 JSON 缓存与进程内回源合并。
- `redis.service.ts` 负责必须明确成功或失败的 Redis 操作，其他数据结构直接使用同一个原生客户端。

约束范围是**一个应用进程、一个 Nest 应用上下文、一个 Redis socket**；部署多个进程时各自有一个连接。运行期重连会替换断开的 socket，复用同一个客户端对象。静态模块重复导入不会重复创建提供者。不要在业务模块重新声明这些 service 为 provider。

## 配置

沿用项目配置层级：`default.yaml → <环境>.yaml → <环境>.local.yaml`。所有 Redis 配置都在 `redis` 域，启动时校验。开发环境已配置本地密码与独立前缀。

```yaml
redis:
  enabled: true
  host: 127.0.0.1
  port: 6379
  password: '123456'
  db: 0
  key-prefix: nest-admin:development
  ttl: 60000
```

实测本机 `127.0.0.0:6379` 无法连接，`127.0.0.1:6379` 使用上述密码可用。生产凭据写入不入库的 `config/production.local.yaml`，可同时配置 ACL `username`；密码必须是字符串，保留首尾空格。TLS 使用系统信任证书；自签证书可通过 Node 的 `NODE_EXTRA_CA_CERTS` 配置可信 CA。

`default.yaml` 中还有完整注释：连接超时 `connect-timeout`、服务层完整调用时限 `command-timeout`、重连起始延迟 `retry-delay`、队列上限 `commands-queue-max-length`、`tls`。

- 启用但首次连接/认证/握手失败：限时终止应用启动，不以假健康状态运行。
- 运行期断线：指数退避并抖动重连；离线命令立即失败，队列有上限。
- 关闭应用：在 HTTP 服务停止后的钩子中销毁 socket，尚未完成的 Redis 命令明确失败，避免退出挂起；网关已有 `enableShutdownHooks()`。
- `enabled: false`：不创建 Redis 连接，缓存读未命中、写删除不存储；严格 Redis 操作报未就绪。不会偷偷回退到进程内存。

## JSON 缓存

```ts
import { CacheService, RedisService } from '@app/cache';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PermissionCache {
  constructor(
    private readonly cache: CacheService,
    private readonly redis: RedisService,
  ) {}

  async permissions(tenantId: string, userId: string) {
    const key = `tenant:${tenantId}:permissions:v1:${userId}`;
    return this.cache.wrap(key, async () => {
      // 实际项目在这里查询数据库；null 可以短期缓存不存在的记录。
      return ['user:read'];
    }, 60_000);
  }

  invalidate(tenantId: string, userId: string) {
    return this.cache.del(`tenant:${tenantId}:permissions:v1:${userId}`);
  }
}
```

| API | 语义 |
| --- | --- |
| `get<T>(key)` | 未命中或读取故障返回 `undefined` |
| `set(key, value, ttl?)` | 写入，默认使用配置 TTL |
| `getMany<T>(keys)` | 与输入顺序一致，缺失位置为 `undefined` |
| `setMany([{ key, value, ttl? }])` | 批量写入，各项可设 TTL |
| `del(key)` / `delMany(keys)` | 删除缓存键 |
| `wrap(key, loader, ttl?)` | 缓存命中返回；同进程同 key 合并并发回源 |
| `ttl(key)` | 剩余毫秒；`-2` 不存在，`-1` 永久 |
| `deleteByPrefix(prefix)` | 按字面量前缀分批扫描、UNLINK，返回删除数 |
| `clear()` | 仅清理当前应用的 cache 命名空间 |
| `health()` | `up`（含 PING 耗时）、`down`、`disabled` |
| `getMetrics()` / `resetMetrics()` | 当前进程 hits/misses/sets/deletes/errors 快照与重置 |

TTL 统一为**毫秒**，单次操作传 `0` 为永久；配置默认 TTL 为正整数。当前上限为 `2_147_483_647` 毫秒。空白 key、非法 TTL、缓存值 `undefined` 会被拒绝。`null`、`false`、`0`、空字符串均为有效值。缓存适合 JSON 数据，不承诺还原 class、Date、Map、Set 的原型；不要缓存函数、循环引用、BigInt。

显式写入、删除和清理失败会抛异常；读取故障记录警告和 errors 指标并降级。`wrap` 的业务 loader 异常原样抛出，回填失败仍返回业务结果，`undefined` 不缓存。metrics 是进程内操作统计，deletes 按请求键数计，前缀清理数量直接取方法返回值；它不是 Redis 全局统计。

缓存更新应在数据库事务提交后失效。`wrap` 的合并只在当前进程有效；多实例热点可使用短租约锁协调。需要强一致的权限撤销、会话、验证码判断应走严格 Redis API。清理与正在执行的 loader 并非原子操作，涉及强制失效时可在业务中使用版本 key。

## 严格 Redis 操作

```ts
// 会话：由业务统一选择有效期，读取失败会抛出，不伪装成未登录。
await redis.set('session:token-id', JSON.stringify({ userId: '42' }), 3_600_000);
const session = await redis.get('session:token-id'); // string | null
await redis.expire('session:token-id', 3_600_000);

// 一次性令牌/验证码：GETDEL 保证并发下只有一个消费者拿到值。
await redis.set('captcha:challenge-id', 'expected-digest', 120_000);
const digest = await redis.consume('captcha:challenge-id');

// 幂等占位：NX + PX，不覆盖已有记录，不刷新其 TTL。
const first = await redis.setIfAbsent('idempotency:request-id', 'processing', 60_000);

// 固定窗口：Lua 将 INCRBY 与首次过期设置放在一个原子操作中。
const { value, ttl } = await redis.increment('login-fail:account-id', 60_000);
if (value > 5) { /* 由业务拒绝请求 */ }

await redis.del('session:token-id');
await redis.deleteByPrefix('login-fail:');
```

`setIfAbsent` 只是占位基础能力，业务失败后的重试、处理结果存储仍由业务决定。`consume` 会立刻删除令牌；验证码不匹配是否允许重试，需要在业务设计中确定。当前 HTTP Throttler 仍使用原有内存策略；这里提供的计数能力不会自动替换全局限流规则。

## 租约锁

```ts
const result = await redis.withLock('order:42', 10_000, async (lease) => {
  // 在租约内完成任务；长任务显式 await lease.extend(10_000) 并检查 boolean。
  return 'done';
});

const lease = await redis.acquireLock('job:daily', 30_000);
if (!lease) return; // 已被占用
try {
  // 有界任务
} finally {
  await lease.release();
}
```

使用随机 token + SET NX PX；释放和续租通过 Lua 比较持有者。旧持有者不能删除或续租后来者的锁。`withLock` 遇竞争立即抛 `RedisLockBusyError`，成功返回前发现租约丢失抛 `RedisLockLostError`，业务异常时尝试释放并保留原异常。

没有自动续租、无限等待或自动重试。租约过期不会中断正在运行的 JavaScript；单实例 Redis 故障切换也无法保证强一致互斥。资金/库存等必须结合数据库约束、幂等或 fencing token，不能只依靠租约锁。

## 原生数据结构与单连接边界

```ts
const userKey = redis.key('user:42'); // 自动加 data 命名空间
await redis.client.hSet(userKey, { name: 'Alice', role: 'admin' });
await redis.client.sAdd(redis.key('online-users'), '42');
await redis.client.zAdd(redis.key('ranking'), { score: 100, value: '42' });
await redis.client.lPush(redis.key('recent-actions'), 'login');
await redis.client.multi().hSet(userKey, 'role', 'reader').pExpire(userKey, 60_000).exec();

// 需要完整调用时限时，高级操作统一通过 execute（仍是同一个客户端）。
const profile = await redis.execute(client => client.hGetAll(userKey));
```

命名空间：`${keyPrefix}:cache:*`、`${keyPrefix}:data:*`、`${keyPrefix}:lock:*`。原生 API 必须调用 `redis.key()` 构造业务键，不手动读写 Keyv 的序列化内容。底层缓存由 Keyv 序列化并包含过期元数据，不能用 `RedisService.get()` 互读。

前缀删除用转义后的 SCAN + 分批 UNLINK，不使用 KEYS/FLUSHDB；它不是跨键原子操作，并发写入时不承诺清除瞬时新增键。MULTI/EXEC 可原子执行一组命令，执行期某条报错不会回滚其他命令。

共享连接不要执行 `SELECT`、`AUTH`、`QUIT`、`close/destroy`、`duplicate()`、`WATCH` 或订阅命令，也不要运行 BLPOP、BRPOP、XREAD BLOCK 等阻塞消费；它们会改变连接状态、阻塞其他请求或创建额外连接。Pub/Sub 消费、阻塞队列、BullMQ、Sentinel/Cluster 不在本次单连接模式范围内，要支持这些能力需调整连接约束。普通非阻塞 Stream 命令可直接使用。

node-redis 的 `commandOptions.timeout` 仅限制发送前排队。本模块为 `CacheService`、`RedisService` 方法及 `redis.execute()` 增加完整调用时限；直接操作 `redis.client` 或 `CACHE_MANAGER` 的高级调用仍遵循上游的时限规则。命令超时/连接中断只代表客户端没有获得成功确认，写入可能已在服务端执行，超时也不会撤销正在执行的命令。不要盲目重试扣减、计数等非幂等命令；按业务请求 ID 设计幂等。排队与在途命令总量受上限保护。适配器不会主动为离线操作重新建立连接；运行期重连仅由所有者负责。

如需兼容标准 Nest 注入，可使用导出的 `CACHE_MANAGER`；业务优先使用 `CacheService` 保持统一语义。未自动启用 HTTP `CacheInterceptor`，避免意外缓存包含身份、租户或权限的数据。

## 验证与上游规则

```powershell
pnpm test:cache
# 使用独立本机测试 Redis；测试仅清理随机前缀，并创建/删除临时 ACL 用户。
$env:REDIS_TEST_URL = 'redis://127.0.0.1:63681'
pnpm test:cache:e2e
```

未设置 `REDIS_TEST_URL` 时，集成测试仍执行禁用与启动失败用例，其余跳过。实际网关集成验证 CLIENT LIST 的连接数、对象身份、毫秒 TTL、缓存隔离、原子操作、锁归属、ACL 故障、离线失败、重连与关闭。

实现已检查安装版本的源码与类型：node-redis 的 socket/commands-queue 生命周期与超时、KeyvRedis 的 getClient/disconnect/命名空间/异常处理、Keyv 的序列化与 TTL、cache-manager 的读降级与写异常规则。后续升级对照：

- [node-redis](https://github.com/redis/node-redis/tree/redis%405.12.1)
- [Keyv Redis 适配器](https://keyv.org/docs/storage-adapters/redis/)
- [Keyv](https://keyv.org/docs/keyv/)
- [cache-manager](https://cacheable.org/docs/cache-manager/)

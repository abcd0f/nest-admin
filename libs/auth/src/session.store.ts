import type { AuthSnapshot } from './auth.types.js';
import { RedisService } from '@app/cache';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUserId } from './auth.types.js';

export interface AuthSession extends AuthSnapshot {
  userId: string;
  refreshHash: string;
  /** 毫秒时间戳，刷新时保持不变。 */
  expiresAt: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// 仅消费命中过的摘要才会加入重放集合；伪造摘要不会撤销受害者的会话。
const ROTATE_REFRESH_TOKEN = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local session = cjson.decode(raw)
if session.refreshHash ~= ARGV[1] then
  if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    redis.call('DEL', KEYS[1], KEYS[2])
  end
  return 0
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ttl)
session.refreshHash = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
return 1
`;

@Injectable()
export class SessionStore {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      // 不将 Redis 异常、凭据或令牌内容透传到 HTTP/日志。
      throw new ServiceUnavailableException('认证服务不可用');
    }
  }

  private sessionKey(sid: string): string {
    return `auth:session:${sid}`;
  }

  private usedKey(sid: string): string {
    return `auth:used:${sid}`;
  }

  /** 按用户维护的会话索引，用于权限快照失效时批量踢人。 */
  private userKey(userId: string): string {
    return `auth:user:${userId}`;
  }

  async create(sid: string, session: AuthSession): Promise<void> {
    const ttl = session.expiresAt - Date.now();
    if (ttl <= 0) throw new UnauthorizedException('未认证');
    const created = await this.execute(() =>
      this.redis.setIfAbsent(this.sessionKey(sid), JSON.stringify(session), ttl),
    );
    if (!created) throw new ServiceUnavailableException('认证服务不可用');
    // 索引与 TTL 一并写入；失败时抛出，由调用方重试登录，不留无法撤销的会话。
    await this.execute(() =>
      this.redis.execute((client) =>
        client
          .multi()
          .sAdd(this.redis.key(this.userKey(session.userId)), sid)
          .pExpire(this.redis.key(this.userKey(session.userId)), ttl)
          .exec(),
      ),
    );
  }

  async get(sid: string): Promise<AuthSession> {
    const raw = await this.execute(() => this.redis.get(this.sessionKey(sid)));
    if (!raw) throw new UnauthorizedException('未认证');
    let session: AuthSession;
    try {
      session = JSON.parse(raw) as AuthSession;
      if (
        !session ||
        !isUserId(session.userId) ||
        typeof session.refreshHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(session.refreshHash) ||
        !Number.isSafeInteger(session.expiresAt) ||
        !isStringArray(session.roles) ||
        !isStringArray(session.permissions)
      ) {
        throw new Error('invalid session');
      }
    } catch {
      throw new ServiceUnavailableException('认证服务不可用');
    }
    if (session.expiresAt <= Date.now()) throw new UnauthorizedException('未认证');
    return session;
  }

  async rotate(sid: string, oldHash: string, newHash: string): Promise<void> {
    const result = await this.execute(() =>
      this.redis.execute((client) =>
        client.eval(ROTATE_REFRESH_TOKEN, {
          keys: [this.redis.key(this.sessionKey(sid)), this.redis.key(this.usedKey(sid))],
          arguments: [oldHash, newHash],
        }),
      ),
    );
    if (result !== 1) throw new UnauthorizedException('未认证');
  }

  async revoke(sid: string): Promise<void> {
    await this.execute(() => this.redis.del(this.sessionKey(sid), this.usedKey(sid)));
  }

  /**
   * 撤销某个用户的全部设备会话，返回被撤销的数量。
   *
   * 对应 RuoYi `SysRoleServiceImpl.cleanOnlineUser`：权限快照在会话里，变更后必须踢人，
   * 否则旧权限会一直有效到会话过期。索引里残留的已过期 sid 直接删除，不单独判断。
   */
  async revokeUser(userId: string): Promise<number> {
    if (!isUserId(userId)) throw new UnauthorizedException('未认证');
    return this.execute(async () => {
      const indexKey = this.redis.key(this.userKey(userId));
      const sids = await this.redis.execute((client) => client.sMembers(indexKey));
      if (!sids.length) return 0;
      const keys = sids.flatMap((sid) => [
        this.redis.key(this.sessionKey(sid)),
        this.redis.key(this.usedKey(sid)),
      ]);
      keys.push(indexKey);
      await this.redis.execute((client) => client.unlink(keys));
      return sids.length;
    });
  }
}

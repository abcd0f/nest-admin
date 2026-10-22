/* eslint-disable perfectionist/sort-imports -- 配置 mock 必须先于 AppModule 导入。 */
import './helpers/auth-config-source.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AuthSession } from '../libs/auth/src/session.store.js';
import { createHash, randomBytes } from 'node:crypto';
import { RedisClient } from '@app/cache';
import { createFastifyAdapter } from '@app/common';
import { loggerConfig, throttlerConfig } from '@app/config';
import { PasswordHashService } from '@app/crypto';
import { PrismaService } from '@app/database';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../apps/gateway/src/app.module.js';
import { SystemAuthController } from '../apps/gateway/src/modules/system/auth/auth.controller.js';
import { LoginDto, RefreshTokenDto } from '../apps/gateway/src/modules/system/auth/dto/auth.dto.js';
import { SessionStore } from '../libs/auth/src/session.store.js';
import { loggerDomain } from '../libs/config/src/domains/logger.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';
/* eslint-enable perfectionist/sort-imports */

// Vitest 不运行 Nest 编译插件，仅补充生产编译链会生成的 DTO 参数类型。
Reflect.defineMetadata(
  'design:paramtypes',
  [LoginDto, Object],
  SystemAuthController.prototype,
  'login',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [RefreshTokenDto],
  SystemAuthController.prototype,
  'refresh',
);

const userId = 9223372036854775807n;
const rootMenu = {
  menuId: 1n,
  parentId: 0n,
  menuName: '系统',
  menuType: 'M',
  orderNum: 0,
  path: '/system',
  component: null,
  query: null,
  isFrame: '1',
  isCache: '0',
  visible: '0',
  status: '0',
  icon: 'settings',
  perms: null,
};
function role() {
  return {
    role: {
      roleKey: 'operator',
      status: '0',
      delFlag: '0',
      menus: [
        { menu: { ...rootMenu } },
        {
          menu: { ...rootMenu, menuId: 2n, parentId: 1n, menuType: 'C', perms: 'system:user:list' },
        },
        {
          menu: { ...rootMenu, menuId: 3n, parentId: 2n, menuType: 'F', perms: 'system:user:edit' },
        },
      ],
    },
  };
}

describe('认证业务 HTTP 完整流程 (e2e)', () => {
  let app: NestFastifyApplication;
  let passwordHash: string;
  let status: string;
  let delFlag: string;
  let roles: ReturnType<typeof role>[];
  let sessionUnavailable = false;
  const sessions = new Map<string, AuthSession>();
  const used = new Map<string, Set<string>>();
  const findMany = vi.fn();
  const updateMany = vi.fn();
  const findUnique = vi.fn();

  const account = () => ({
    userId,
    userName: 'alice',
    nickName: 'Alice',
    deptId: 9007199254740993n,
    password: passwordHash,
    status,
    delFlag,
    roles,
  });
  function available() {
    if (sessionUnavailable) throw new ServiceUnavailableException('认证服务不可用');
  }
  function getSession(sid: string) {
    available();
    const session = sessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) throw new UnauthorizedException('未认证');
    return { ...session };
  }

  beforeAll(async () => {
    passwordHash = await new PasswordHashService().hashPassword(' secret ');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ user: { findMany, findUnique, updateMany } })
      .overrideProvider(RedisClient)
      .useValue(new RedisClient(redisDomain.parse({ enabled: false }, { environment: 'test' })))
      .overrideProvider(SessionStore)
      .useValue({
        create: async (sid: string, session: AuthSession) => {
          available();
          sessions.set(sid, { ...session });
        },
        get: async (sid: string) => getSession(sid),
        rotate: async (sid: string, oldHash: string, newHash: string) => {
          const session = getSession(sid);
          if (session.refreshHash !== oldHash) {
            if (used.get(sid)?.has(oldHash)) sessions.delete(sid);
            throw new UnauthorizedException('未认证');
          }
          const hashes = used.get(sid) ?? new Set<string>();
          hashes.add(oldHash);
          used.set(sid, hashes);
          sessions.set(sid, { ...session, refreshHash: newHash });
        },
        revoke: async (sid: string) => {
          available();
          sessions.delete(sid);
          used.delete(sid);
        },
      })
      .overrideProvider(throttlerConfig.KEY)
      .useValue({ enabled: false, ttl: 60000, limit: 100, blockDuration: 60000 })
      .overrideProvider(loggerConfig.KEY)
      .useValue(
        loggerDomain.parse(
          { console: { enabled: true, pretty: false }, file: { enabled: false } },
          { environment: 'test' },
        ),
      )
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    status = '0';
    delFlag = '0';
    roles = [role()];
    sessionUnavailable = false;
    sessions.clear();
    used.clear();
    vi.resetAllMocks();
    findMany.mockImplementation(async ({ where }) =>
      where.userName === 'alice' && delFlag === '0' ? [account()] : [],
    );
    findUnique.mockImplementation(async () => account());
    updateMany.mockResolvedValue({ count: 1 });
  });
  afterAll(async () => app?.close());

  function login(userName = 'alice', password = ' secret ') {
    return app.inject({ method: 'POST', url: '/api/auth/login', payload: { userName, password } });
  }
  function profile(accessToken: string) {
    return app.inject({
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }
  function refresh(refreshToken: string) {
    return app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
  }

  it.each([
    { method: 'GET' as const, url: '/api/auth/profile' },
    { method: 'GET' as const, url: '/api/auth/menus' },
    { method: 'POST' as const, url: '/api/auth/logout' },
  ])('未登录请求 $url 返回统一 401', async (request) => {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 401, data: null, message: '未认证' });
  });

  it('真实 Argon2 登录、审计、脱敏资料和菜单查询贯通', async () => {
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { data } = response.json();
    expect(data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        userId: String(userId),
        userName: 'alice',
        nickName: 'Alice',
        deptId: '9007199254740993',
      },
    });
    expect(Object.keys(data.user).sort()).toEqual(['deptId', 'nickName', 'userId', 'userName']);
    expect(response.body).not.toContain(passwordHash);
    expect(updateMany.mock.lastCall?.[0].data).toMatchObject({
      loginIp: '127.0.0.1',
      loginDate: expect.any(Date),
    });
    const current = await profile(data.accessToken);
    expect(current.json()).toEqual({
      code: 0,
      message: '操作成功',
      data: {
        ...data.user,
        roles: ['operator'],
        permissions: ['system:user:edit', 'system:user:list'],
      },
    });
    const menus = await app.inject({
      url: '/api/auth/menus?userId=1',
      headers: { authorization: `Bearer ${data.accessToken}` },
    });
    expect(menus.statusCode).toBe(200);
    expect(menus.json().data).toHaveLength(1);
    expect(menus.json().data[0].children.map((item: { menuId: string }) => item.menuId)).toEqual([
      '2',
    ]);
    expect(menus.body).not.toContain('system:user:edit');
    expect(findUnique.mock.lastCall?.[0].where).toEqual({ userId });
  });

  it('不存在账号、错误密码、禁用、删除和同名歧义账号返回相同错误', async () => {
    const responses = [await login('missing'), await login('alice', 'wrong')];
    status = '1';
    responses.push(await login());
    status = '0';
    delFlag = '2';
    responses.push(await login());
    delFlag = '0';
    findMany.mockResolvedValue([account(), { ...account(), userId: 2n }]);
    responses.push(await login());
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 401, data: null, message: '账号或密码错误' });
    }
    expect(updateMany).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it('非法 DTO 返回 422，不回显密码或令牌，不调用数据库', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { userName: 'alice', password: 123456 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).not.toContain('123456');
    expect(findMany).not.toHaveBeenCalled();
    const invalidRefresh = await refresh('secret-invalid-token');
    expect(invalidRefresh.statusCode).toBe(422);
    expect(invalidRefresh.body).not.toContain('secret-invalid-token');
  });

  it('刷新保持绝对期限，旧 Access 仍有效；旧 Refresh 重放撤销当前设备', async () => {
    const original = (await login()).json().data;
    const other = (await login()).json().data;
    const sid = original.refreshToken.split('.')[0];
    const expiresAt = sessions.get(sid)!.expiresAt;
    const response = await refresh(original.refreshToken);
    expect(response.statusCode).toBe(200);
    const next = response.json().data;
    expect(next.refreshToken).not.toBe(original.refreshToken);
    expect(sessions.get(sid)!.expiresAt).toBe(expiresAt);
    expect(sessions.get(sid)!.refreshHash).toBe(
      createHash('sha256').update(next.refreshToken).digest('hex'),
    );
    expect((await profile(original.accessToken)).statusCode).toBe(200);
    expect((await profile(next.accessToken)).statusCode).toBe(200);
    expect((await refresh(original.refreshToken)).statusCode).toBe(401);
    expect((await profile(next.accessToken)).statusCode).toBe(401);
    expect((await refresh(next.refreshToken)).statusCode).toBe(401);
    expect((await profile(other.accessToken)).statusCode).toBe(200);
  });

  it('伪造 Refresh 不撤销有效会话；登出只撤销当前设备', async () => {
    const original = (await login()).json().data;
    const other = (await login()).json().data;
    const sid = original.refreshToken.split('.')[0];
    expect((await refresh(`${sid}.${randomBytes(32).toString('base64url')}`)).statusCode).toBe(401);
    expect((await profile(original.accessToken)).statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${original.accessToken}` },
      payload: { sessionId: other.refreshToken.split('.')[0] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ code: 0, data: null, message: '操作成功' });
    expect((await profile(original.accessToken)).statusCode).toBe(401);
    expect((await refresh(original.refreshToken)).statusCode).toBe(401);
    expect((await profile(other.accessToken)).statusCode).toBe(200);
  });

  it('角色菜单变化实时反映在本人权限和菜单树，禁用用户不能刷新', async () => {
    const { accessToken, refreshToken } = (await login()).json().data;
    roles[0].role.status = '1';
    expect((await profile(accessToken)).json().data.permissions).toEqual([]);
    const menus = await app.inject({
      url: '/api/auth/menus',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(menus.json().data).toEqual([]);
    status = '1';
    expect((await profile(accessToken)).statusCode).toBe(401);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });

  it('会话到期后 Access 与 Refresh 都失效', async () => {
    const { accessToken, refreshToken } = (await login()).json().data;
    sessions.get(refreshToken.split('.')[0])!.expiresAt = Date.now() - 1;
    expect((await profile(accessToken)).statusCode).toBe(401);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });

  it('同一 Refresh 并发刷新至多一次成功，重放使新令牌失效', async () => {
    const { refreshToken } = (await login()).json().data;
    const responses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const success = responses.find((response) => response.statusCode === 200)!;
    expect((await profile(success.json().data.accessToken)).statusCode).toBe(401);
  });

  it('数据库与会话故障使用统一 503，响应不泄露内部异常', async () => {
    findMany.mockRejectedValueOnce(new Error('private database detail'));
    const database = await login();
    expect(database.statusCode).toBe(503);
    expect(database.body).not.toContain('private database detail');
    const { accessToken, refreshToken } = (await login()).json().data;
    sessionUnavailable = true;
    expect((await profile(accessToken)).statusCode).toBe(503);
    expect((await refresh(refreshToken)).statusCode).toBe(503);
    expect((await login()).statusCode).toBe(503);
  });

  it('Swagger 声明 Bearer、公开接口和真实成功响应包装', () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    expect(doc.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.paths['/api/auth/profile'].get?.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/api/auth/login'].post?.security).toBeUndefined();
    expect(doc.paths['/api/auth/refresh'].post?.security).toBeUndefined();
    expect(doc.paths['/api/auth/menus'].get?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            properties: {
              code: { enum: [0] },
              data: { type: 'array', items: { $ref: '#/components/schemas/AuthMenuDto' } },
            },
          },
        },
      },
    });
  });
});

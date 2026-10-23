/* eslint-disable perfectionist/sort-imports -- 配置 mock 必须先于 AppModule 导入。 */
import './helpers/auth-config-source.js';
import type { AuthenticatedUser } from '@app/auth';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AuthSession } from '../libs/auth/src/session.store.js';
import { AuthModule, AuthService, CurrentUser } from '@app/auth';
import { RedisClient } from '@app/cache';
import { createFastifyAdapter } from '@app/common';
import { loggerConfig } from '@app/config';
import { PrismaService } from '@app/database';
import { Authenticated, Mode, Permission, PermissionService, RequirePermissions, Role } from '@app/permission';
import { Body, Controller, Get, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../apps/gateway/src/app.module.js';
import { LoginDto } from '../apps/gateway/src/modules/system/auth/dto/auth.dto.js';
import { SessionStore } from '../libs/auth/src/session.store.js';
import { loggerDomain } from '../libs/config/src/domains/logger.domain.js';
import { redisDomain } from '../libs/config/src/domains/redis.domain.js';
/* eslint-enable perfectionist/sort-imports */

@Controller('rbac-probe')
class ProbeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('profile')
  @Authenticated()
  profile(@CurrentUser() user: AuthenticatedUser) {
    return { userId: user.userId };
  }

  @Get('list')
  @RequirePermissions('system:user:list')
  list() {
    return ['allowed'];
  }

  @Get('and')
  @Permission({ value: ['system:user:list', 'system:user:edit'] })
  both() {
    return true;
  }

  @Get('or')
  @Permission({ value: ['system:user:list', 'system:user:edit'], mode: Mode.OR })
  either() {
    return true;
  }

  @Get('fallback')
  @Permission({ value: 'system:user:export', role: ['admin', 'operator'] })
  fallback() {
    return true;
  }

  @Get('role-and-permission')
  @Role('admin')
  @Permission('system:user:list')
  combined() {
    return true;
  }

  @Get('stacked')
  @Permission({ value: ['system:user:list', 'system:user:add'], mode: Mode.OR })
  @Permission('system:user:edit')
  stacked() {
    return true;
  }

  @Post('validated')
  @Authenticated()
  validated(@Body() body: LoginDto) {
    return { userName: body.userName };
  }

  @Post('unmarked')
  unmarked() {
    return true;
  }

  @Post('logout')
  @Authenticated()
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.logout(user.sessionId);
  }
}

// Vitest 不运行 Nest 的 emitDecoratorMetadata 编译链，显式保留 DTO metatype。
Reflect.defineMetadata('design:paramtypes', [LoginDto], ProbeController.prototype, 'validated');

function assignment(roleKey = 'operator', permissions = ['system:user:list']) {
  return {
    role: {
      roleKey,
      status: '0',
      delFlag: '0',
      menus: permissions.map((perms) => ({ menu: { perms, status: '0', menuType: 'F' } })),
    },
  };
}

describe('实际网关 RBAC 接入 (e2e)', () => {
  let app: NestFastifyApplication;
  let token: string;
  let active = true;
  let roles = [assignment()];
  let authorizationUnavailable = false;
  const findUnique = vi.fn(async ({ select }: { select: { roles?: unknown } }) => {
    if (authorizationUnavailable && select.roles) throw new Error('private database detail');
    return {
      userId: 2n,
      userName: 'alice',
      nickName: 'Alice',
      deptId: null,
      status: active ? '0' : '1',
      delFlag: '0',
      roles,
    };
  });
  const sessions = new Map<string, AuthSession>();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule, AuthModule],
      controllers: [ProbeController],
    })
      .overrideProvider(PrismaService)
      .useValue({ user: { findUnique } })
      .overrideProvider(RedisClient)
      .useValue(new RedisClient(redisDomain.parse({ enabled: false }, { environment: 'test' })))
      .overrideProvider(SessionStore)
      .useValue({
        create: async (sid: string, session: AuthSession) => {
          sessions.set(sid, session);
        },
        get: async (sid: string) => {
          const session = sessions.get(sid);
          if (!session) throw new UnauthorizedException();
          return session;
        },
        revoke: async (sid: string) => {
          sessions.delete(sid);
        },
        revokeUser: async (userId: string) => {
          let count = 0;
          for (const [sid, session] of sessions) {
            if (session.userId === userId) {
              sessions.delete(sid);
              count += 1;
            }
          }
          return count;
        },
      })
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
    token = await login();
  });

  /**
   * 登录一次，把当前 mock 的角色/菜单算成快照写进会话。
   *
   * 用 2 号用户而不是 1 号：1 号是超级管理员，会直接拿到 `*:*:*`，
   * 让所有权限断言失去意义。
   */
  async function login(): Promise<string> {
    const snapshot = await app.get(PermissionService).snapshot('2');
    return (await app.get(AuthService).createSession('2', snapshot)).accessToken;
  }

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    roles = [assignment()];
    active = true;
    authorizationUnavailable = false;
    // 每个用例用独立会话，避免上一个用例的踢人影响后续断言。
    token = await login();
  });

  it('健康检查公开，管理接口默认受认证保护，错误沿用统一响应', async () => {
    expect((await app.inject({ url: '/api' })).statusCode).toBe(200);
    const response = await app.inject({ url: '/api/system/user/list' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 401, data: null, message: '未认证' });
  });

  it.each([
    ['GET', '/api/system/user/list'],
    ['GET', '/api/system/role/list'],
    ['GET', '/api/system/menu/list'],
    ['GET', '/api/system/dept/list'],
    ['GET', '/api/system/role/menuTree/1'],
    ['GET', '/api/system/role/deptTree/1'],
    ['PUT', '/api/system/user/authRole/1'],
    ['PUT', '/api/system/role/menus/1'],
    ['PUT', '/api/system/role/dataScope/1'],
  ] as const)('RBAC 管理端点 $method $url 要求认证且检查独立功能权限', async (method, url) => {
    roles = [assignment('operator', [])];
    // 权限在登录时算进快照，所以要重新登录才能反映新的授权关系。
    const limited = await login();
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${limited}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 403, data: null });
  });

  it('有效 JWT、会话、用户检查后可获取可信上下文，禁用用户立即失效', async () => {
    const response = await app.inject({
      url: '/api/rbac-probe/profile',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json()).toEqual({ code: 0, data: { userId: '2' }, message: '操作成功' });
    active = false;
    expect(
      (
        await app.inject({
          url: '/api/rbac-probe/profile',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    active = true;
  });

  it('权限允许/拒绝，无策略管理操作拒绝', async () => {
    const request = { url: '/api/rbac-probe/list', headers: { authorization: `Bearer ${token}` } };
    expect((await app.inject(request)).statusCode).toBe(200);
    roles = [];
    const denied = await login();
    const rejected = await app.inject({
      ...request,
      headers: { authorization: `Bearer ${denied}` },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: 403, data: null });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/rbac-probe/unmarked',
          headers: request.headers,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('全局管道运行 DTO 校验并返回统一 422 字段错误，不泄露密码', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/rbac-probe/validated',
      headers: { authorization: `Bearer ${token}` },
    };
    const response = await app.inject({
      ...request,
      payload: { userName: 'alice', password: 123456 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 422,
      data: null,
      errors: [{ field: 'password', messages: ['字段校验失败'] }],
    });
    expect(response.body).not.toContain('123456');
    expect(
      (await app.inject({ ...request, payload: { userName: 'alice', password: 'secret' } }))
        .statusCode,
    ).toBe(201);
  });

  it('主模块直接注册两个守卫，HTTP 验证 AND/OR、角色兜底与叠加规则', async () => {
    // 每次断言前重新登录，确保快照反映当前 roles。
    const request = async (path: string) =>
      app.inject({
        url: `/api/rbac-probe/${path}`,
        headers: { authorization: `Bearer ${await login()}` },
      });
    expect((await request('and')).statusCode).toBe(403);
    roles = [assignment('operator', ['system:user:list', 'system:user:edit'])];
    expect((await request('and')).statusCode).toBe(200);
    roles = [assignment('reader')];
    expect((await request('or')).statusCode).toBe(200);
    expect((await request('fallback')).statusCode).toBe(403);
    roles = [assignment('operator', [])];
    expect((await request('fallback')).statusCode).toBe(200);
    roles = [assignment('reader')];
    expect((await request('role-and-permission')).statusCode).toBe(403);
    roles = [assignment('admin')];
    expect((await request('role-and-permission')).statusCode).toBe(200);
    roles = [assignment('admin', [])];
    expect((await request('role-and-permission')).statusCode).toBe(403);
    roles = [assignment()];
    expect((await request('stacked')).statusCode).toBe(403);
    roles = [assignment('operator', ['system:user:list', 'system:user:edit'])];
    expect((await request('stacked')).statusCode).toBe(200);
  });

  it('授权关联变化不影响已签发的会话，撤销会话后立即失效', async () => {
    const request = { url: '/api/rbac-probe/list', headers: { authorization: `Bearer ${token}` } };
    expect((await app.inject(request)).statusCode).toBe(200);
    for (const mutate of [
      () => {
        roles = [assignment()];
        roles[0].role.status = '1';
      },
      () => {
        roles = [assignment()];
        roles[0].role.delFlag = '2';
      },
      () => {
        roles = [];
      },
      () => {
        roles = [assignment()];
        roles[0].role.menus = [];
      },
      () => {
        roles = [assignment()];
        roles[0].role.menus[0].menu.status = '1';
      },
    ]) {
      mutate();
      // 快照在会话里，改库不会影响旧 token——这是与"实时查库"模型的根本差异。
      expect((await app.inject(request)).statusCode).toBe(200);
    }
    // 管理面写操作会调用 revokeUserSessions，之后旧 token 一律 401。
    await app.get(AuthService).revokeUserSessions('2');
    expect((await app.inject(request)).statusCode).toBe(401);
    // 重新登录后拿到空权限的新快照。
    const fresh = await login();
    expect(
      (await app.inject({ ...request, headers: { authorization: `Bearer ${fresh}` } })).statusCode,
    ).toBe(403);
  });

  it('多角色权限取并集；鉴权阶段不查库，只在登录时算一次', async () => {
    roles = [assignment('reader'), assignment('editor', ['system:user:edit'])];
    findUnique.mockClear();
    const fresh = await login();
    // 登录：一次用户有效性检查 + 一次授权关系查询。
    expect(findUnique.mock.calls).toHaveLength(2);
    expect(findUnique.mock.calls.filter(([query]) => query.select.roles)).toHaveLength(1);
    findUnique.mockClear();
    const response = await app.inject({
      url: '/api/rbac-probe/and',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(response.statusCode).toBe(200);
    // 鉴权：只剩认证阶段的用户有效性检查，不再读角色菜单关系。
    expect(findUnique.mock.calls).toHaveLength(1);
    expect(findUnique.mock.calls[0][0].select).not.toHaveProperty('roles');
  });

  it('请求参数中的角色/权限不能影响服务端授权', async () => {
    roles = [];
    const denied = await login();
    const response = await app.inject({
      url: '/api/rbac-probe/list?userId=2&role=admin&permissions=system:user:list',
      headers: { authorization: `Bearer ${denied}` },
    });
    expect(response.statusCode).toBe(403);
    expect(findUnique.mock.lastCall?.[0]).toMatchObject({ where: { userId: 2n } });
  });

  it('登录时授权查询故障返回统一 503，不签发降级会话', async () => {
    authorizationUnavailable = true;
    await expect(login()).rejects.toMatchObject({ status: 503 });
    // 之前的会话仍然有效，不会因为一次登录失败被清空。
    expect(
      (await app.inject({ url: '/api/rbac-probe/list', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(200);
  });

  it('撤销当前会话后 Access JWT 立即失效', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ method: 'POST', url: '/api/rbac-probe/logout', headers })).statusCode,
    ).toBe(201);
    expect((await app.inject({ url: '/api/rbac-probe/profile', headers })).statusCode).toBe(401);
  });
});

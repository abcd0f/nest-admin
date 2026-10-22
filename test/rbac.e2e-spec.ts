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
import { Authenticated, Mode, Permission, RequirePermissions, Role } from '@app/permission';
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
      userId: 1n,
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
    token = (await app.get(AuthService).createSession('1')).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    roles = [assignment()];
    active = true;
    authorizationUnavailable = false;
  });

  it('健康检查公开，示例接口默认受认证保护，错误沿用统一响应', async () => {
    expect((await app.inject({ url: '/api' })).statusCode).toBe(200);
    const response = await app.inject({ url: '/api/example' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 401, data: null, message: '未认证' });
  });

  it('有效 JWT、会话、用户检查后可获取可信上下文，禁用用户立即失效', async () => {
    const response = await app.inject({
      url: '/api/rbac-probe/profile',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json()).toEqual({ code: 0, data: { userId: '1' }, message: '操作成功' });
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
    const rejected = await app.inject(request);
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
    const request = (path: string) =>
      app.inject({
        url: `/api/rbac-probe/${path}`,
        headers: { authorization: `Bearer ${token}` },
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

  it.each([
    'role-disabled',
    'role-deleted',
    'user-role-removed',
    'role-menu-removed',
    'menu-disabled',
  ])('原 JWT 不变，授权关联变化后下一次请求拒绝：%s', async (change) => {
    const request = { url: '/api/rbac-probe/list', headers: { authorization: `Bearer ${token}` } };
    expect((await app.inject(request)).statusCode).toBe(200);
    if (change === 'role-disabled') roles[0].role.status = '1';
    if (change === 'role-deleted') roles[0].role.delFlag = '2';
    if (change === 'user-role-removed') roles = [];
    if (change === 'role-menu-removed') roles[0].role.menus = [];
    if (change === 'menu-disabled') roles[0].role.menus[0].menu.status = '1';
    expect((await app.inject(request)).statusCode).toBe(403);
  });

  it('多角色权限取并集；每次授权只执行一次角色菜单查询', async () => {
    roles = [assignment('reader'), assignment('editor', ['system:user:edit'])];
    findUnique.mockClear();
    const response = await app.inject({
      url: '/api/rbac-probe/and',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(findUnique.mock.calls.filter(([query]) => query.select.roles)).toHaveLength(1);
    expect(findUnique.mock.calls).toHaveLength(2); // 认证用户检查 + 授权查询。
  });

  it('请求参数中的角色/权限不能影响服务端授权', async () => {
    roles = [];
    const response = await app.inject({
      url: '/api/rbac-probe/list?userId=2&role=admin&permissions=system:user:list',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(findUnique.mock.lastCall?.[0]).toMatchObject({ where: { userId: 1n } });
  });

  it('权限数据库查询故障返回统一 503，不沿用之前的授权结果', async () => {
    const request = { url: '/api/rbac-probe/list', headers: { authorization: `Bearer ${token}` } };
    expect((await app.inject(request)).statusCode).toBe(200);
    authorizationUnavailable = true;
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 503, data: null });
    expect(response.body).not.toContain('private database detail');
  });

  it('撤销当前会话后 Access JWT 立即失效', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ method: 'POST', url: '/api/rbac-probe/logout', headers })).statusCode,
    ).toBe(201);
    expect((await app.inject({ url: '/api/rbac-probe/profile', headers })).statusCode).toBe(401);
  });
});

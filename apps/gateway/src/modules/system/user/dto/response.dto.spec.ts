import { toPageDto } from '@app/common';
import { instanceToPlain } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { ResponseUserDto } from './response.dto.js';

function serializeUser(overrides: object = {}) {
  return instanceToPlain(toPageDto(ResponseUserDto, {
    items: [{
      userId: 1n,
      userName: 'admin',
      nickName: '管理员',
      password: 'excluded password hash',
      createBy: 2n,
      updateBy: 3n,
      createTime: new Date('2026-10-21T00:00:00Z'),
      loginDate: new Date('2026-10-21T01:00:00Z'),
      updateTime: null,
      email: null,
      phoneNumber: null,
      loginIp: null,
      remark: null,
      unexpected: 'not exposed',
      ...overrides,
    }],
    meta: { page: 1, pageSize: 20, total: 1, totalPage: 1 },
  }));
}

describe('用户响应白名单', () => {
  it('保留分页、日期与空值，排除密码和未暴露字段', () => {
    const result = serializeUser();
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1, totalPage: 1 });
    expect(result.items[0]).toMatchObject({
      userId: '1',
      createBy: '2',
      updateBy: '3',
      userName: 'admin',
      createTime: '2026-10-21 08:00:00',
      loginDate: '2026-10-21 09:00:00',
      updateTime: null,
      email: null,
      phoneNumber: null,
      loginIp: null,
      remark: null,
    });
    expect(result.items[0]).not.toHaveProperty('password');
    expect(result.items[0]).not.toHaveProperty('unexpected');
  });

  it('可空日期、创建人和更新人保持 null', () => {
    const user = serializeUser({ loginDate: null, createBy: null, updateBy: null }).items[0];
    expect(user).toMatchObject({ loginDate: null, updateTime: null, createBy: null, updateBy: null });
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('服务器时区为 %s 时日期只格式化一次', (timezone) => {
    vi.stubEnv('TZ', timezone);
    try {
      expect(serializeUser().items[0]).toMatchObject({
        createTime: '2026-10-21 08:00:00',
        loginDate: '2026-10-21 09:00:00',
      });
    }
    finally {
      vi.unstubAllEnvs();
    }
  });

  it('超出安全整数的 ID 精确转换为字符串，并可编码为 JSON', () => {
    const user = serializeUser({
      userId: 9223372036854775807n,
      createBy: 9007199254740993n,
      updateBy: 9007199254740995n,
      updateTime: new Date('2026-10-21T02:00:00Z'),
      createDept: '研发部',
    }).items[0];
    expect(JSON.parse(JSON.stringify(user))).toMatchObject({
      userId: '9223372036854775807',
      createBy: '9007199254740993',
      updateBy: '9007199254740995',
      updateTime: '2026-10-21 10:00:00',
      createDept: '研发部',
    });
  });
});

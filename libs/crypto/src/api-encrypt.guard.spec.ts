import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it } from 'vitest';
import { API_ENCRYPT_POLICY, API_ENCRYPT_RESPONSE } from './api-encrypt.decorator.js';
import { ApiEncryptGuard } from './api-encrypt.guard.js';

class ProbeController {}

function contextFor(method: string, headers: Record<string, string> = {}) {
  const handler = () => {};
  Reflect.defineMetadata(API_ENCRYPT_POLICY, { response: true }, handler);
  const request = { method, headers };
  return new ExecutionContextHost([request], ProbeController, handler);
}

const guard = new ApiEncryptGuard(new Reflector(), { enabled: true, headerFlag: 'Encrypt-Key' });

describe('api 请求加密方法策略', () => {
  it.each(['POST', 'PUT', 'post', 'put'])('%s 缺少加密头时拒绝，有加密头时允许', (method) => {
    expect(() => guard.canActivate(contextFor(method))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor(method, { 'encrypt-key': 'encrypted key' }))).toBe(true);
  });

  it.each(['GET', 'DELETE', 'PATCH', 'get', 'delete', 'patch'])('%s 不要求请求加密，仍可以开启响应加密', (method) => {
    const context = contextFor(method);
    expect(guard.canActivate(context)).toBe(true);
    expect(context.switchToHttp().getRequest()[API_ENCRYPT_RESPONSE]).toBe(true);
  });
});

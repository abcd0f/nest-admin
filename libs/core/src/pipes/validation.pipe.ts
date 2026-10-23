import type { ArgumentMetadata } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { FieldError } from '../interfaces/index.js';
import { Injectable, ValidationPipe } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception.js';

/**
 * Nest 内置白名单之外的原生类型。
 *
 * `ValidationPipe.toValidate()` 只排除了 `String`/`Boolean`/`Number`/`Array`/`Object`/`Buffer`/`Date`，
 * 漏掉了 `BigInt` 与 `Symbol`。声明成 `bigint` 的路径参数（由 `BigIntIdPipe` 转换）
 * 会被 `forbidUnknownValues` 当成"未知对象"直接拒成 400，因此这里显式跳过。
 */
const SKIPPED_METATYPES = new Set<unknown>([BigInt, Symbol]);

function fieldErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    return [
      ...(error.constraints ? [{ field, messages: ['字段校验失败'] }] : []),
      ...fieldErrors(error.children ?? [], field),
    ];
  });
}

@Injectable()
export class DtoValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
      dismissDefaultMessages: true,
      // 不回显自定义校验消息中的密码或令牌原文。
      exceptionFactory: (errors) => BusinessException.validation(fieldErrors(errors)),
    });
  }

  override transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    // 原生类型没有 DTO 可校验，原样交给下游；非原生类型仍走完整的 class-validator 流程。
    if (SKIPPED_METATYPES.has(metadata.metatype)) return Promise.resolve(value);
    return super.transform(value, metadata);
  }
}

import type { ValidationError } from 'class-validator';
import type { FieldError } from '../interfaces/index.js';
import { Injectable, ValidationPipe } from '@nestjs/common';
import { BusinessException } from '../exceptions/business.exception.js';

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
}

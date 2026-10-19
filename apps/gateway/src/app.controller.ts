import { RawResponse } from '@app/core';
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  constructor() {}

  /**
   * 获取欢迎信息
   * @remarks 用于验证网关服务是否正常运行。
   */
  @Get()
  @RawResponse()
  getHello(): string {
    return '欢迎使用 Nest.js 构建的 API 接口服务！';
  }
}

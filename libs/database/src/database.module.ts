import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service.js';
import { PrismaService } from './prisma.service.js';

/**
 * 数据库模块。
 *
 * 为什么标 @Global：
 * 业务模块注入 PrismaService / DatabaseService 时不必逐个 import DatabaseModule，
 * 接入成本最低。代价是依赖关系不再显式。数据访问属于典型的「全局基础设施」，
 * 这里接受该取舍；若团队更偏好显式依赖，去掉 @Global 并让业务模块自行 import 即可。
 *
 * 使用方式（业务模块无需任何 import）：
 *   constructor(private readonly prisma: PrismaService) {}
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [PrismaService, DatabaseService],
  exports: [PrismaService, DatabaseService],
})
export class DatabaseModule {}

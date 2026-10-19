import type { DatabaseConfig } from '@app/config';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { databaseConfig } from '@app/config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * Prisma 客户端（由 Nest 托管生命周期）。
 *
 * 设计要点：
 * 1. Prisma 7 默认使用「查询编译器」，不再内置 Rust 引擎二进制，
 *    必须通过驱动适配器连接数据库。这里用 @prisma/adapter-pg + node-postgres，
 *    连接池参数（max / idle / connectTimeout）可直接调优，也能被 rspack 正常打包。
 * 2. 连接串来自 @app/config 的 database 命名空间，不写死在 schema 里，
 *    因此开发/正式环境切换零代码改动。
 * 3. schema 必须走 PrismaPg 的第二个参数，URL 上的 `?schema=` 只对 CLI 生效。
 * 4. 实现 OnModuleDestroy 后，配合 main.ts 的 app.enableShutdownHooks()，
 *    进程退出时自动断开连接，避免连接泄漏。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly dbConfig: DatabaseConfig;

  constructor(@Inject(databaseConfig.KEY) dbConfig: DatabaseConfig) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: dbConfig.url,
          max: dbConfig.pool.max,
          idleTimeoutMillis: dbConfig.pool.idleTimeoutMillis,
          connectionTimeoutMillis: dbConfig.pool.connectionTimeoutMillis,
        },
        { schema: dbConfig.schema },
      ),
      log: dbConfig.logQueries ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
    });

    this.dbConfig = dbConfig;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `数据库已连接（schema=${this.dbConfig.schema}, pool max=${this.dbConfig.pool.max}）`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('数据库连接已释放');
  }
}

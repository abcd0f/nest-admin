import type { ConfigKeyPaths, IDatabaseConfig } from '../../config/src/index.js';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../prisma/generated/client/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(configService: ConfigService<ConfigKeyPaths, true>) {
    const database = configService.get<IDatabaseConfig>('database', { infer: true });

    super({
      adapter: new PrismaMariaDb({
        host: database.host,
        port: database.port,
        user: database.username,
        password: database.password,
        database: database.database,
        connectionLimit: database.connectionLimit,
      }),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

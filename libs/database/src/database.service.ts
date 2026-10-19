import type { Prisma } from './generated/prisma/client.js';
import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** 事务内可用的 Prisma 客户端（不含 $transaction / $connect 等） */
export type TransactionClient = Prisma.TransactionClient;

export interface TransactionOptions {
  /** 等待获取事务连接的最长时间（毫秒） */
  maxWait?: number;
  /** 事务整体超时时间（毫秒） */
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export interface DatabaseHealth {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

/**
 * 数据库门面（Facade）。
 *
 * 职责边界：
 * - 只放「跨业务复用」的能力：事务、健康检查、原生 SQL 逃生口。
 * - 具体业务查询请注入 PrismaService，直接用类型安全的模型 API（如 `prisma.user.findMany()`）。
 *   不要把全部查询堆进这个 service——那会长成上帝对象。
 *
 * 分层建议（低耦合的关键）：
 *   业务 Service → 领域 Repository（用 PrismaService 实现）→ PrismaService
 * 只有 Repository 层直接接触 Prisma 类型，业务层依赖自定义接口，替换 ORM 时影响面可控。
 */
@Injectable()
export class DatabaseService {
  constructor(private readonly prisma: PrismaService) {}

  /** 类型安全的 Prisma 客户端，供 Repository 层做 CRUD */
  get client(): PrismaService {
    return this.prisma;
  }

  /**
   * 交互式事务。回调内必须使用传入的 tx，否则语句不会落在同一事务里。
   *
   * @example
   * await this.db.transaction(async (tx) => {
   *   await tx.user.create({ data: { ... } });
   *   await tx.account.create({ data: { ... } });
   * });
   */
  transaction<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.prisma.$transaction(fn, options);
  }

  /** 连通性探测，返回耗时，供健康检查接口使用 */
  async health(): Promise<DatabaseHealth> {
    const startedAt = Date.now();

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 原生 SQL 逃生口：遇到 Prisma 表达不了的复杂查询时使用。
   * 注意用参数占位（`${value}` 会被参数化）而不是字符串拼接，避免 SQL 注入。
   *
   * @example
   * const rows = await this.db.raw<{ count: bigint }[]>`SELECT count(*) FROM users WHERE status = ${1}`;
   */
  raw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    return this.prisma.$queryRaw<T>(query, ...values);
  }
}

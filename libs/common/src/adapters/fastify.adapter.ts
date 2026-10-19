import { FastifyAdapter } from '@nestjs/platform-fastify';

export function createFastifyAdapter(): FastifyAdapter {
  const fastifyApp = new FastifyAdapter({
    // 在此集中配置 Fastify 构造选项，例如 bodyLimit、trustProxy。
    trustProxy: true,
    logger: false,
  });

  return fastifyApp;
}

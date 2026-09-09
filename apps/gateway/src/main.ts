import type { ConfigKeyPaths } from '../../../packages/config/src/index.js';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { fastifyApp, setFastifyApp } from '../../../packages/common/src/index.js';
import { getCorsOption, getLocalIPs } from '../../../packages/utils/src/index.js';

import { AppModule } from './app.module.js';
import { setupSwagger } from './swagger.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  setFastifyApp(fastifyApp);

  const config = app.get(ConfigService<ConfigKeyPaths, true>);
  const { port, prefix } = config.get('app', { infer: true });

  app.setGlobalPrefix(prefix);
  app.enableCors(getCorsOption());

  setupSwagger(app);

  await app.listen(port, '0.0.0.0');

  setupGracefulShutdown(app);

  const localIPs = getLocalIPs();

  console.log(`\n🟢 启动成功:`);
  console.log(`\n📍 本地访问: http://localhost:${port}`);
  console.log(`📖 API 文档: http://localhost:${port}/api`);

  if (localIPs.length > 0) {
    console.log(`\n🌐 网络访问:`);
    localIPs.forEach((ip) => {
      console.log(`   http://${ip}:${port}`);
      console.log(`   http://${ip}:${port}/api`);
    });
  } else {
    console.log(`\n⚠️  未检测到可用网络接口`);
  }
}

function setupGracefulShutdown(app: NestFastifyApplication) {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);
      try {
        await app.close();
        console.log('应用已安全关闭');
        process.exit(0);
      } catch (error) {
        console.error('关闭过程出错:', error);
        process.exit(1);
      }
    });
  });
}

bootstrap().catch((error) => {
  console.error('应用启动失败:', error);
  process.exit(1);
});

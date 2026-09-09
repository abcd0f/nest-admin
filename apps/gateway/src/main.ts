import type { ConfigKeyPaths } from '../../../packages/config/src/index.js';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { fastifyApp, setFastifyApp } from '../../../packages/common/src/index.js';
import { PinoLogger } from '../../../packages/logger/src/index.js';
import { getCorsOption, getLocalIPs } from '../../../packages/utils/src/index.js';

import { AppModule } from './app.module.js';
import { setupSwagger } from './swagger.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  setFastifyApp(fastifyApp);

  const config = app.get(ConfigService<ConfigKeyPaths, true>);
  const { port, prefix, logger } = config.get('app', { infer: true });

  app.setGlobalPrefix(prefix);
  app.enableCors(getCorsOption());

    const pinoLogger = new PinoLogger({
    level: logger.level as any,
    logDir: logger.dir,
    enableConsole: logger.showConsole,
  });
  app.useLogger(pinoLogger);

  setupSwagger(app);

  await app.listen(port, '0.0.0.0');

  setupGracefulShutdown(app, pinoLogger);

  const localIPs = getLocalIPs();

  pinoLogger.log('🟢 启动成功', 'Bootstrap');
  pinoLogger.log(`📍 本地访问: http://localhost:${port}`, 'Bootstrap');
  pinoLogger.log(`📖 API 文档: http://localhost:${port}/api`, 'Bootstrap');

  if (localIPs.length > 0) {
    pinoLogger.log('🌐 网络访问:', 'Bootstrap');
    localIPs.forEach((ip) => {
      pinoLogger.log(`   http://${ip}:${port}`, 'Bootstrap');
      pinoLogger.log(`   http://${ip}:${port}/api`, 'Bootstrap');
    });
  } else {
    pinoLogger.warn('未检测到可用网络接口', 'Bootstrap');
  }
}

function setupGracefulShutdown(app: NestFastifyApplication, logger: PinoLogger) {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.log(`收到 ${signal} 信号，开始优雅关闭...`, 'Shutdown');
      try {
        await app.close();
        logger.log('应用已安全关闭', 'Shutdown');
        process.exit(0);
      } catch (error) {
        logger.error('关闭过程出错', error instanceof Error ? error.stack : String(error), 'Shutdown');
        process.exit(1);
      }
    });
  });
}

bootstrap().catch((error) => {
  const errorMessage = error instanceof Error ? error.stack : String(error);
  console.error(`应用启动失败: ${errorMessage}`);
  process.exit(1);
});

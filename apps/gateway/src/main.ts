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

  setupGracefulShutdown(app);

  const localIPs = getLocalIPs();
  const swaggerConfig = config.get('swagger', { infer: true });

  console.log('\n');
  console.log('🟢 启动成功');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 本地访问:`);
  console.log(`   http://localhost:${port}${prefix}`);
  if (swaggerConfig.enable) {
    console.log(`📖 API 文档:`);
    console.log(`   http://localhost:${port}/${swaggerConfig.path}`);
  }

  if (localIPs.length > 0) {
    console.log(`🌐 网络访问:`);
    localIPs.forEach((ip) => {
      console.log(`   http://${ip}:${port}${prefix}`);
      if (swaggerConfig.enable) {
        console.log(`   http://${ip}:${port}/${swaggerConfig.path}`);
      }
    });
  } else {
    console.log(`⚠️  未检测到可用网络接口`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n');
}

function setupGracefulShutdown(app: NestFastifyApplication) {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`收到 ${signal} 信号，开始优雅关闭...`, 'Shutdown');
      try {
        await app.close();
        console.log('应用已安全关闭', 'Shutdown');
        process.exit(0);
      } catch (error) {
        console.error('关闭过程出错', error instanceof Error ? error.stack : String(error), 'Shutdown');
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

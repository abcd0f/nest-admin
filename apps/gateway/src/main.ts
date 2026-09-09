import type { ConfigKeyPaths } from '../../../packages/config/src/index.js';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { getCorsOption, getLocalIPs } from '../../../packages/utils/src/index.js';

import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const config = app.get(ConfigService<ConfigKeyPaths, true>);
  const { port, prefix } = config.get('app', { infer: true });

  app.setGlobalPrefix(prefix);
  app.enableCors(getCorsOption());

  await app.listen(port, '0.0.0.0');

  const localIPs = getLocalIPs();

  console.log(`\n🟢 启动成功:`);
  console.log(`\n📍 本地访问: http://localhost:${port}`);

  if (localIPs.length > 0) {
    console.log(`\n🌐 网络访问:`);
    localIPs.forEach((ip) => {
      console.log(`   http://${ip}:${port}`);
    });
  } else {
    console.log(`\n⚠️  未检测到可用网络接口`);
  }
}

bootstrap();

import type { LoggerConfig } from '@app/config';
import type { Params } from 'nestjs-pino';
import { loggerConfig } from '@app/config';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { createHttpOptions, createTransportOptions } from './logger.options.js';
import { LoggerTransport } from './logger.transport.js';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      providers: [{
        provide: LoggerTransport,
        inject: [loggerConfig.KEY],
        useFactory: (config: LoggerConfig) => LoggerTransport.create(createTransportOptions(config)),
      }],
      inject: [loggerConfig.KEY, LoggerTransport],
      useFactory: (config: LoggerConfig, output: LoggerTransport): Params => ({
        pinoHttp: [createHttpOptions(config), output.stream],
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}

// 保留库的公共名称，直接复用 Nest 日志桥接，避免重复维护日志门面。
export { InjectPinoLogger, Logger as LoggerService, PinoLogger } from 'nestjs-pino';

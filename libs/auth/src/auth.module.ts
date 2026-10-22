import type { AuthConfig } from '@app/config';
import { authConfig } from '@app/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SessionStore } from './session.store.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) => ({
        secret: config.jwtSecret,
        signOptions: {
          algorithm: config.jwtAlgorithm,
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
        verifyOptions: {
          algorithms: [config.jwtAlgorithm],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
      }),
    }),
  ],
  providers: [AuthService, AuthGuard, SessionStore],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}

import { Global, Module } from '@nestjs/common';
import { SystemAuthModule } from './auth/auth.module.js';
import { ExampleModule } from './example/example.module.js';

@Global()
@Module({
  imports: [ExampleModule, SystemAuthModule],
})
export class SystemModule {}

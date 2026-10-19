import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module.js';

@Global()
@Module({
  imports: [UserModule],
})
export class SystemModule {}

import { Global, Module } from '@nestjs/common';
import { ExampleModule } from './example/example.module.js';

@Global()
@Module({
  imports: [ExampleModule],
})
export class SystemModule {}

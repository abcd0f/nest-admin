import { Module } from '@nestjs/common';
import { ExampleService } from './example.service.js';
import { ExampleController } from './example.controller.js';

@Module({
  controllers: [ExampleController],
  providers: [ExampleService],
})
export class ExampleModule {}

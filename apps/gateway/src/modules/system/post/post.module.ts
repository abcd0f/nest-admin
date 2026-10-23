import { Module } from '@nestjs/common';
import { PostController } from './post.controller.js';
import { PostService } from './post.service.js';

@Module({
  controllers: [PostController],
  providers: [PostService],
  exports: [PostService],
})
export class PostModule {}
